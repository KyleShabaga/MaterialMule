import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  concreteExceptionNoteRequestSchema,
  concreteReportMayReviewRouted,
  concreteReviewQueueQuerySchema,
  CONCRETE_REVIEW_QUEUE_STATUSES,
  type ConcreteExceptionNoteList,
  type ConcreteReportExceptionCode,
  type ConcreteStrengthResultRow,
  concreteStrengthSelfReviewUserIds,
  type ConcreteReviewQueue,
  type ConcreteReviewQueueQuery,
  type ConcreteReviewQueueRow,
  type ConcreteReviewQueueStatus,
  type ConcreteWorkflowState,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type ProjectContext } from '../auth/policy.js';
import { canUnderLock } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { parseBody } from '../validation/parse-body.js';
import { findReport } from './concrete-field-reports.service.js';
import {
  actionAllowed,
  FIELD_REPORT_SCOPE,
  grantLoader,
  holdsActionPermission,
  latestVersion,
  lifecycleContext,
  lockedLifecycleContext,
  peopleOf,
  versionsOf,
  type VersionRow,
} from './concrete-report-lifecycle.read.js';
import { exceptionNotesOf, submittedWarnings } from './concrete-review.read.js';
import { strengthContext } from './concrete-strength-reports.read.js';

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

/** Which reports each queue status holds: the report's state and its latest version's. */
const STATUS_SQL: Record<ConcreteReviewQueueStatus, string> = {
  awaiting_review: `r.workflow_state = 'submitted' AND v.state = 'submitted'`,
  returned: `r.workflow_state = 'returned' AND v.state = 'returned'`,
  reviewed_awaiting_issue: `r.workflow_state = 'reviewed' AND v.state = 'reviewed'`,
  issued: `r.workflow_state = 'reviewed' AND v.state = 'issued'`,
};

const STATUS_CASE = `CASE
  WHEN ${STATUS_SQL.awaiting_review} THEN 'awaiting_review'
  WHEN ${STATUS_SQL.returned} THEN 'returned'
  WHEN ${STATUS_SQL.reviewed_awaiting_issue} THEN 'reviewed_awaiting_issue'
  WHEN ${STATUS_SQL.issued} THEN 'issued'
END`;

/** Oldest first where someone is waiting to act; newest first for the history-like lists. */
const ORDER_SQL: Record<ConcreteReviewQueueStatus, string> = {
  awaiting_review: 'v.submitted_at ASC, r.id',
  returned: 'v.closed_at DESC, r.id',
  reviewed_awaiting_issue: 'v.reviewed_at ASC, r.id',
  issued: 'v.issued_at DESC, r.id',
};

/**
 * Field reports and (MM-V2-C39) strength reports, one row per report with its latest version.
 * A strength report has no technician: its "technician" column is the latest version's credited
 * submitter (lab staff), and it opens by its specimen set.
 */
const FROM_SQL = `FROM (
    SELECT 'field'::text AS kind, fr.id, fr.project_id, fr.technician_user_id, fr.report_date,
           fr.workflow_state, fr.issue_count, NULL::uuid AS set_id, NULL::text AS set_label
    FROM concrete_field_report fr
    UNION ALL
    SELECT 'strength', sr.id, sr.project_id, NULL::uuid, NULL::date, sr.workflow_state,
           sr.issue_count, sr.specimen_set_id, coalesce(st.permanent_id, st.temporary_id)
    FROM concrete_strength_report sr JOIN concrete_specimen_set st ON st.id = sr.specimen_set_id
  ) r
  JOIN project p ON p.id = r.project_id
  JOIN LATERAL (
    (SELECT * FROM concrete_report_version lv
     WHERE r.kind = 'field' AND lv.field_report_id = r.id ORDER BY lv.version_no DESC LIMIT 1)
    UNION ALL
    (SELECT * FROM concrete_report_version lv
     WHERE r.kind = 'strength' AND lv.strength_report_id = r.id
     ORDER BY lv.version_no DESC LIMIT 1)
  ) v ON true`;

interface QueueRow {
  id: string;
  kind: 'field' | 'strength';
  set_id: string | null;
  set_label: string | null;
  /** Strength: the latest version's rows, for its no-self-review rule. */
  results: Pick<ConcreteStrengthResultRow, 'reported' | 'testedBy' | 'enteredBy'>[] | null;
  submitted_staff_user_id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  lead_project_engineer_user_id: string | null;
  technician_user_id: string | null;
  report_date: string | null;
  workflow_state: ConcreteWorkflowState;
  issue_count: number;
  status: ConcreteReviewQueueStatus;
  version_id: string;
  version_no: number;
  version_state: VersionRow['state'];
  revision_of_version_no: number | null;
  submitted_at: Date;
  route_kind: VersionRow['route_kind'];
  routed_to_user_id: string | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_cleared_at: Date | null;
  closed_by_user_id: string | null;
  closed_at: Date | null;
  issued_by_user_id: string | null;
  issued_at: Date | null;
  warnings: { code: ConcreteReportExceptionCode }[] | null;
  documented: number;
}

const SELECT_SQL = `SELECT r.id, r.kind, r.set_id, r.set_label,
    CASE WHEN r.kind = 'strength' THEN v.snapshot->'results' END AS results,
    v.submitted_staff_user_id, r.project_id, p.project_number, p.name AS project_name,
    p.lead_project_engineer_user_id,
    coalesce(r.technician_user_id, v.submitted_staff_user_id) AS technician_user_id, r.report_date::text AS report_date,
    r.workflow_state, r.issue_count, ${STATUS_CASE} AS status,
    v.id AS version_id, v.version_no, v.state AS version_state,
    (SELECT o.version_no FROM concrete_report_version o WHERE o.id = v.revision_of_version_id)
      AS revision_of_version_no,
    v.submitted_at, v.route_kind, v.routed_to_user_id, v.reviewed_by_user_id, v.reviewed_at,
    v.review_cleared_at, v.closed_by_user_id, v.closed_at, v.issued_by_user_id, v.issued_at,
    v.snapshot->'warnings' AS warnings,
    (SELECT count(*)::int FROM concrete_report_exception_note n WHERE n.version_id = v.id)
      AS documented`;

/**
 * The review queue and exception notes (MM-V2-C28, field reports). The queue reads like C04's
 * report reads (`inventory.read`, every project): navigation and lists never grant anything, and
 * each row says whether the caller could act on it now. Documenting an exception is part of
 * review: `concrete.review` with C09's routing, a personal account, never on one's own report
 * (owner decision 2026-11-08), checked before the body and again under the D09 locks.
 */
@Injectable()
export class ConcreteReviewService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Queue
  // -------------------------------------------------------------------------------------------

  async queue(rawQuery: unknown, user: AuthUser): Promise<ConcreteReviewQueue> {
    const query = parseBody(concreteReviewQueueQuerySchema, rawQuery);
    const { where, params } = filtersOf(query);
    const contexts = new Map<string, Promise<ProjectContext>>();
    const canAct = async (row: QueueRow) => this.canAct(row, user, contexts);

    let items: QueueRow[];
    let total: number;
    const counts = Object.fromEntries(CONCRETE_REVIEW_QUEUE_STATUSES.map((s) => [s, 0])) as Record<
      ConcreteReviewQueueStatus,
      number
    >;
    const offset = (query.page - 1) * query.pageSize;

    if (query.mine) {
      // Rows the caller could act on: worked out per row (project authority, routing, own
      // report), so all candidate rows are read. Issued reports wait on nobody.
      const { rows } = await this.database.pool.query<QueueRow>(
        `${SELECT_SQL} ${FROM_SQL}
         WHERE ${where.join(' AND ')} AND ${STATUS_CASE} IN ('awaiting_review', 'returned',
           'reviewed_awaiting_issue')`,
        params,
      );
      const actionable: QueueRow[] = [];
      for (const row of rows) {
        if (await canAct(row)) {
          counts[row.status] += 1;
          if (row.status === query.status) actionable.push(row);
        }
      }
      actionable.sort(orderOf(query.status));
      total = actionable.length;
      items = actionable.slice(offset, offset + query.pageSize);
    } else {
      const { rows: grouped } = await this.database.pool.query<{
        status: ConcreteReviewQueueStatus | null;
        n: number;
      }>(
        `SELECT ${STATUS_CASE} AS status, count(*)::int AS n ${FROM_SQL}
         WHERE ${where.join(' AND ')} GROUP BY 1`,
        params,
      );
      for (const g of grouped) if (g.status) counts[g.status] = g.n;
      total = counts[query.status];
      const { rows } = await this.database.pool.query<QueueRow>(
        `${SELECT_SQL} ${FROM_SQL}
         WHERE ${where.join(' AND ')} AND ${STATUS_SQL[query.status]}
         ORDER BY ${ORDER_SQL[query.status]}
         LIMIT ${query.pageSize} OFFSET ${offset}`,
        params,
      );
      items = rows;
    }

    const people = await peopleOf(
      this.database.pool,
      items.flatMap((r) => [
        r.technician_user_id,
        r.routed_to_user_id,
        r.reviewed_by_user_id,
        r.closed_by_user_id,
        r.issued_by_user_id,
      ]),
    );
    const person = (id: string | null) =>
      id === null ? null : (people.get(id) ?? { userId: id, initials: null, name: 'Unknown' });
    const out: ConcreteReviewQueueRow[] = [];
    for (const row of items) {
      const byCode = new Map<ConcreteReportExceptionCode, number>();
      for (const w of row.warnings ?? []) byCode.set(w.code, (byCode.get(w.code) ?? 0) + 1);
      out.push({
        reportId: row.id,
        reportType: row.kind,
        setId: row.set_id,
        setLabel: row.set_label,
        projectId: row.project_id,
        projectNumber: row.project_number,
        projectName: row.project_name,
        reportDate: row.report_date,
        technician: person(row.technician_user_id),
        status: row.status,
        versionNo: row.version_no,
        revisionOfVersionNo: row.revision_of_version_no,
        revised: row.issue_count > 1 || (row.issue_count > 0 && row.status !== 'issued'),
        submittedAt: row.submitted_at.toISOString(),
        route: { kind: row.route_kind, routedTo: person(row.routed_to_user_id) },
        reviewedBy: row.review_cleared_at ? null : person(row.reviewed_by_user_id),
        reviewedAt: row.review_cleared_at ? null : (row.reviewed_at?.toISOString() ?? null),
        returnedBy: row.version_state === 'returned' ? person(row.closed_by_user_id) : null,
        returnedAt:
          row.version_state === 'returned' ? (row.closed_at?.toISOString() ?? null) : null,
        issuedBy: person(row.issued_by_user_id),
        issuedAt: row.issued_at?.toISOString() ?? null,
        exceptions: [...byCode].map(([code, count]) => ({ code, count })),
        documentedCount: row.documented,
        canAct: await canAct(row),
      });
    }
    return { items: out, total, page: query.page, pageSize: query.pageSize, counts };
  }

  /** Whether the caller could take the row's next step now (the commands check it all again). */
  private async canAct(
    row: QueueRow,
    user: AuthUser,
    contexts: Map<string, Promise<ProjectContext>>,
  ): Promise<boolean> {
    if (row.status === 'issued') return false;
    if (row.kind === 'strength') return this.canActOnStrength(row, user, contexts);
    if (row.status === 'returned') {
      // Only the technician corrects a returned report (owner decision 2026-11-08).
      return user.accountType !== 'shared_lab' && row.technician_user_id === user.userId;
    }
    // A technician never reviews or issues their own report (owner decision 2026-11-08).
    if (row.technician_user_id === user.userId) return false;
    const facts = {
      id: row.id,
      project_id: row.project_id,
      lead_project_engineer_user_id: row.lead_project_engineer_user_id,
      technician_user_id: row.technician_user_id,
      workflow_state: row.workflow_state,
    };
    let context = contexts.get(`field|${row.project_id}`);
    if (!context) {
      context = lifecycleContext(this.database.pool, facts);
      contexts.set(`field|${row.project_id}`, context);
    }
    const latest = {
      state: row.version_state,
      route_kind: row.route_kind,
      routed_to_user_id: row.routed_to_user_id,
    } as VersionRow;
    const resolved = { ...(await context), recordTechnicianUserId: row.technician_user_id };
    const action = row.status === 'awaiting_review' ? 'review' : 'issue';
    return actionAllowed(user, action, facts, latest, resolved);
  }

  /** MM-V2-C39: lab staff correct a returned strength report; reviewers / issuers the rest. */
  private async canActOnStrength(
    row: QueueRow,
    user: AuthUser,
    contexts: Map<string, Promise<ProjectContext>>,
  ): Promise<boolean> {
    if (row.status === 'returned') return can(user, 'concrete_test.enter');
    if (concreteStrengthSelfReviewUserIds(row.results ?? []).includes(user.userId)) return false;
    const key = `strength|${row.project_id}`;
    let context = contexts.get(key);
    if (!context) {
      context = strengthContext(this.database.pool, row);
      contexts.set(key, context);
    }
    const resolved = await context;
    if (row.status === 'awaiting_review') {
      return (
        can(user, 'concrete.review', resolved) &&
        concreteReportMayReviewRouted(
          { kind: row.route_kind, routedToUserId: row.routed_to_user_id },
          user.userId,
          row.lead_project_engineer_user_id,
        )
      );
    }
    return can(user, 'report.issue', resolved);
  }

  // -------------------------------------------------------------------------------------------
  // Exception notes
  // -------------------------------------------------------------------------------------------

  async notes(reportId: string, versionNo: string): Promise<ConcreteExceptionNoteList> {
    const { version } = await this.findVersion(reportId, versionNo);
    return {
      reportId,
      versionNo: version.version_no,
      notes: await exceptionNotesOf(this.database.pool, version.id, version.version_no),
    };
  }

  async document(
    reportId: string,
    versionNo: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteExceptionNoteList> {
    // Authority first: against the report as it stands, before the body or any lock (D09).
    const report = await findReport(this.database.pool, reportId);
    if (!report) {
      // As C09: 404 only for someone who could review somewhere; anyone else the same 403.
      if (await this.couldReviewSomewhere(user)) {
        throw new NotFoundException({ code: 'concrete_field_report_not_found' });
      }
      throw forbidden();
    }
    const context = await lifecycleContext(this.database.pool, report);
    if (!holdsActionPermission(user, 'review', context)) throw forbidden();
    if (report.technician_user_id === user.userId) throw forbidden('own_report');
    const input = parseBody(concreteExceptionNoteRequestSchema, body);

    return withTransaction(this.database.pool, async (client) => {
      const found = await findReport(client, report.id, 'FOR UPDATE');
      if (!found) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
      const latest = await latestVersion(client, found.id, 'FOR UPDATE');
      const number = Number(versionNo);
      if (!latest || !/^[1-9][0-9]{0,8}$/.test(versionNo) || number > latest.version_no) {
        throw new NotFoundException({ code: 'concrete_report_version_not_found' });
      }
      // Review fix #134: the reviewer grants are locked and read after the project and account.
      if (
        !(await canUnderLock(client, user, 'concrete.review', found.project_id, {
          context: grantLoader((c) => lockedLifecycleContext(c, found)).loader,
        }))
      ) {
        throw forbidden();
      }
      if (
        !concreteReportMayReviewRouted(
          { kind: latest.route_kind, routedToUserId: latest.routed_to_user_id },
          user.userId,
          found.lead_project_engineer_user_id,
        )
      ) {
        throw forbidden('routed_to_another_reviewer');
      }
      if (number !== latest.version_no || latest.state !== 'submitted') {
        unprocessable('version_not_awaiting_review', [
          { field: 'versionNo', message: 'Only the version awaiting review can be documented' },
        ]);
      }
      const warnings = await submittedWarnings(client, latest.id);
      if (!warnings.some((w) => w.code === input.code && w.field === input.field)) {
        unprocessable('unknown_exception', [
          { field: 'code', message: 'This version has no such exception' },
        ]);
      }
      const existing = await this.existingNote(client, latest.id, input.code, input.field);
      if (existing) {
        // A retry of the same note is answered as it stands; another note is refused.
        if (existing.note !== input.note) {
          throw new ConflictException({ code: 'exception_already_documented' });
        }
      } else {
        await client.query(
          `INSERT INTO concrete_report_exception_note
             (project_id, field_report_id, version_id, code, field, note, documented_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [found.project_id, found.id, latest.id, input.code, input.field, input.note, user.userId],
        );
        await recordAudit(client, {
          action: 'concrete_field_report.exception_documented',
          entityType: 'concrete_field_report',
          entityId: found.id,
          actor,
          before: null,
          after: {
            reportVersionNo: latest.version_no,
            code: input.code,
            field: input.field,
            note: input.note,
          },
          requestId,
        });
      }
      return {
        reportId: found.id,
        versionNo: latest.version_no,
        notes: await exceptionNotesOf(client, latest.id, latest.version_no),
      };
    });
  }

  private async existingNote(
    client: PoolClient,
    versionId: string,
    code: string,
    field: string | null,
  ): Promise<{ note: string } | null> {
    const { rows } = await client.query<{ note: string }>(
      `SELECT note FROM concrete_report_exception_note
       WHERE version_id = $1 AND code = $2 AND coalesce(field, '') = coalesce($3, '')`,
      [versionId, code, field],
    );
    return rows[0] ?? null;
  }

  private async couldReviewSomewhere(user: AuthUser): Promise<boolean> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') return false;
    const { rows } = await this.database.pool.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1)
           OR EXISTS (SELECT 1 FROM project_reviewer_assignment
                      WHERE reviewer_user_id = $1 AND scope_code = $2 AND removed_at IS NULL)
           AS any`,
      [user.userId, FIELD_REPORT_SCOPE],
    );
    return Boolean(rows[0]?.any);
  }

  private async findVersion(reportId: string, versionNo: string) {
    const report = await findReport(this.database.pool, reportId);
    const number = /^[1-9][0-9]{0,8}$/.test(versionNo) ? Number(versionNo) : null;
    if (!report || number === null) {
      throw new NotFoundException({ code: 'concrete_report_version_not_found' });
    }
    const version = (await versionsOf(this.database.pool, report.id)).find(
      (v) => v.version_no === number,
    );
    if (!version) throw new NotFoundException({ code: 'concrete_report_version_not_found' });
    return { report, version };
  }
}

function filtersOf(query: ConcreteReviewQueueQuery) {
  const params: unknown[] = [];
  const where = ['true'];
  const add = (sql: (n: number) => string, value: unknown) => {
    params.push(value);
    where.push(sql(params.length));
  };
  if (query.projectId) add((n) => `r.project_id = $${n}`, query.projectId);
  if (query.technicianUserId) {
    add(
      (n) => `coalesce(r.technician_user_id, v.submitted_staff_user_id) = $${n}`,
      query.technicianUserId,
    );
  }
  if (query.reportType) add((n) => `r.kind = $${n}`, query.reportType);
  if (query.submittedFrom) {
    add(
      (n) => `(v.submitted_at AT TIME ZONE 'America/Edmonton')::date >= $${n}::date`,
      query.submittedFrom,
    );
  }
  if (query.submittedTo) {
    add(
      (n) => `(v.submitted_at AT TIME ZONE 'America/Edmonton')::date <= $${n}::date`,
      query.submittedTo,
    );
  }
  const exceptionCount = `jsonb_array_length(coalesce(v.snapshot->'warnings', '[]'::jsonb))`;
  if (query.exceptions === 'with') where.push(`${exceptionCount} > 0`);
  if (query.exceptions === 'without') where.push(`${exceptionCount} = 0`);
  return { where, params };
}

function orderOf(status: ConcreteReviewQueueStatus) {
  const time = (row: QueueRow) =>
    (status === 'returned'
      ? row.closed_at
      : status === 'reviewed_awaiting_issue'
        ? row.reviewed_at
        : row.submitted_at
    )?.getTime() ?? 0;
  const descending = status === 'returned';
  return (a: QueueRow, b: QueueRow) =>
    (descending ? time(b) - time(a) : time(a) - time(b)) || a.id.localeCompare(b.id);
}
