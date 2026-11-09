import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_EXCEPTION_LABEL,
  CONCRETE_REPORT_ACTIONS,
  CONCRETE_STRENGTH_REPORT_LIST_MAX,
  CONCRETE_STRENGTH_SUBMIT_BLOCKER_MESSAGE,
  concreteExceptionNoteRequestSchema,
  concreteReportIssueRequestSchema,
  concreteReportLifecycleState,
  concreteReportMayReviewRouted,
  concreteReportRoute,
  concreteReportStoredState,
  concreteReviewOpenExceptions,
  concreteStrengthCommandRequestSchema,
  concreteStrengthCommentRequiredSchema,
  concreteStrengthReportListQuerySchema,
  concreteStrengthReportNextState,
  concreteStrengthReportSnapshotSchema,
  concreteStrengthSelfReviewUserIds,
  concreteStrengthSubmitBlocker,
  concreteStrengthSubmitRequestSchema,
  type ConcreteExceptionNoteList,
  type ConcreteReportAction,
  type ConcreteReportRoute,
  type ConcreteReportVersionDetail,
  type ConcreteReportVersionList,
  type ConcreteStrengthReportDetail,
  type ConcreteStrengthReportList,
  type ConcreteStrengthReportSnapshot,
  type ConcreteStrengthReportState,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import {
  can,
  permissionSources,
  type AuthUser,
  type Permission,
  type ProjectContext,
} from '../auth/policy.js';
import { asLocked, canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf, resolveActingPerson } from '../lab/attribution.js';
import { intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import {
  latestVersion,
  peopleOf,
  transitionsOf,
  versionPeople,
  versionsOf,
  versionSummary,
  type VersionRow,
} from './concrete-report-lifecycle.read.js';
import { checklistOf, exceptionNotesOf, submittedWarnings } from './concrete-review.read.js';
import {
  buildStrengthSnapshot,
  findSet,
  findStrengthReport,
  strengthContext,
  type SetFacts,
  type StrengthReportRow,
} from './concrete-strength-reports.read.js';
import { entryCompleteSql } from './concrete-testing-table.service.js';
import {
  ConcreteReportOutputService,
  type PreparedReportIssue,
} from './reports/concrete-report-output.service.js';

type Db = Pool | PoolClient;

const ENTITY_TYPE = 'concrete_strength_report';
const COLUMN = 'strength_report_id' as const;

const AUDIT_ACTION: Record<ConcreteReportAction, string> = {
  submit: 'concrete_strength_report.submitted',
  recall: 'concrete_strength_report.recalled',
  return: 'concrete_strength_report.returned',
  resubmit: 'concrete_strength_report.resubmitted',
  review: 'concrete_strength_report.reviewed',
  issue: 'concrete_strength_report.issued',
  revise: 'concrete_strength_report.revised',
};

/**
 * The permission each command needs on a strength report. Lab staff (Lab Technician, Lab
 * Manager, LAB naming the person) submit, resubmit and recall: they entered the results. Review,
 * return and revise are `concrete.review`, issue is `report.issue`, both for the
 * `concrete_strength` scope; revise also by the version's issuer (C09's rule).
 */
const STRENGTH_ACTION_PERMISSIONS: Record<ConcreteReportAction, Permission[]> = {
  submit: ['concrete_test.enter'],
  resubmit: ['concrete_test.enter'],
  recall: ['concrete_test.enter'],
  return: ['concrete.review'],
  review: ['concrete.review'],
  issue: ['report.issue'],
  revise: ['concrete.review'],
};

const LAB_ACTIONS = new Set<ConcreteReportAction>(['submit', 'resubmit', 'recall']);

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

type Input = {
  idempotencyKey: string;
  version: number;
  comment?: string;
  performedByUserId?: string;
  includePhotos?: boolean;
  includeMachineInfo?: boolean;
};

function parseInput(action: ConcreteReportAction, body: unknown): Input {
  if (LAB_ACTIONS.has(action)) return parseBody(concreteStrengthSubmitRequestSchema, body);
  if (action === 'return' || action === 'revise') {
    return parseBody(concreteStrengthCommentRequiredSchema, body);
  }
  if (action === 'issue') return parseBody(concreteReportIssueRequestSchema, body);
  return parseBody(concreteStrengthCommandRequestSchema, body);
}

function stateOf(
  report: StrengthReportRow | null,
  latest: VersionRow | null,
): ConcreteStrengthReportState {
  if (!report) return 'not_started';
  return concreteReportLifecycleState(report.workflow_state, latest?.state ?? null) as
    'draft' | 'submitted' | 'returned' | 'reviewed' | 'issued';
}

async function storedSnapshot(db: Db, versionId: string): Promise<ConcreteStrengthReportSnapshot> {
  const { rows } = await db.query<{ snapshot: unknown }>(
    'SELECT snapshot FROM concrete_report_version WHERE id = $1',
    [versionId],
  );
  return concreteStrengthReportSnapshotSchema.parse(rows[0]!.snapshot);
}

/** Who never reviews or issues `latest` (its sole tester / entrant), from its frozen snapshot. */
async function selfReviewOf(db: Db, latest: VersionRow | null): Promise<string[]> {
  if (!latest) return [];
  return concreteStrengthSelfReviewUserIds((await storedSnapshot(db, latest.id)).results);
}

function holdsPermission(
  user: AuthUser,
  action: ConcreteReportAction,
  context: ProjectContext,
  issuedByUserId: string | null,
): boolean {
  if (STRENGTH_ACTION_PERMISSIONS[action].some((p) => can(user, p, context))) return true;
  return (
    action === 'revise' &&
    issuedByUserId !== null &&
    issuedByUserId === user.userId &&
    user.status === 'active' &&
    user.accountType !== 'shared_lab'
  );
}

const issuedByOf = (latest: VersionRow | null) =>
  latest?.state === 'issued' ? latest.issued_by_user_id : null;

/**
 * Concrete compressive strength reports (MM-V2-C39, provisional design section 4): one per
 * specimen set, cumulative, on C09's versions, transitions, audit and SHA-256 snapshots, C28's
 * queue and exception notes. Commands are checked against the report as it stands before the
 * body (D09), then in one transaction in the lock order: the set FOR UPDATE (which C07 result
 * saves also take, so no result changes while a version is frozen), the strength report FOR
 * UPDATE, its latest version FOR UPDATE, then the project and the accounts FOR SHARE.
 *
 * No self-review: the only tester, or the only person credited with entering, the results a
 * version shows never reviews, returns, documents or issues it (owner decision 2026-11-08,
 * mirrored from field reports' technician rule).
 */
@Injectable()
export class ConcreteStrengthReportsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly output: ConcreteReportOutputService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async detail(setId: string, user: AuthUser): Promise<ConcreteStrengthReportDetail> {
    const set = await findSet(this.database.pool, setId);
    if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    return this.detailOf(this.database.pool, set, user);
  }

  private async detailOf(
    db: Db,
    set: SetFacts,
    user: AuthUser,
  ): Promise<ConcreteStrengthReportDetail> {
    const report = await findStrengthReport(db, set.id);
    const versions = report ? await versionsOf(db, report.id, COLUMN) : [];
    const latest = versions.at(-1) ?? null;
    const state = stateOf(report, latest);
    const context = await strengthContext(db, set);
    const issued = [...versions].reverse().find((v) => v.state === 'issued') ?? null;
    const issuedAges = issued ? (await storedSnapshot(db, issued.id)).agesReported : [];
    const preview = await buildStrengthSnapshot(db, set, {
      reportId: report?.id ?? '',
      versionNo: (latest?.version_no ?? 0) + 1,
      revNo: report?.issue_count ?? 0,
      revision: null,
    });
    const blocker = concreteStrengthSubmitBlocker({
      setVoid: set.voided || set.report_void,
      ages: preview.ages,
      state,
      issuedAges,
    });
    const selfReview = await selfReviewOf(db, latest);
    const people = await peopleOf(db, versionPeople(latest ? [latest] : []));
    const reported = new Set(
      latest && latest.state !== 'recalled'
        ? (await storedSnapshot(db, latest.id)).results
            .filter((r) => r.reported)
            .map((r) => r.specimenId)
        : [],
    );
    const allowed = CONCRETE_REPORT_ACTIONS.filter((action) => {
      if (concreteStrengthReportNextState(state, action) === null) return false;
      if (!holdsPermission(user, action, context, issuedByOf(latest))) return false;
      if ((action === 'submit' || action === 'resubmit') && blocker !== null) return false;
      if (
        (action === 'review' || action === 'issue' || action === 'return') &&
        selfReview.includes(user.userId)
      ) {
        return false;
      }
      if ((action === 'review' || action === 'return') && latest) {
        return concreteReportMayReviewRouted(
          { kind: latest.route_kind, routedToUserId: latest.routed_to_user_id },
          user.userId,
          set.lead_project_engineer_user_id,
        );
      }
      return true;
    });
    return {
      setId: set.id,
      projectId: set.project_id,
      reportId: report?.id ?? null,
      reportNumber: report?.report_number ?? null,
      state,
      version: report?.version ?? 0,
      issueCount: report?.issue_count ?? 0,
      revised:
        (report?.issue_count ?? 0) > 1 || ((report?.issue_count ?? 0) > 0 && state !== 'issued'),
      preview,
      submitBlocker: blocker,
      newResults: preview.results.some((r) => r.reported && !reported.has(r.specimenId)),
      latestVersion: latest ? versionSummary(latest, versions, people) : null,
      latestIssuedVersionNo: report?.last_issued_version ?? null,
      selfReviewUserIds: selfReview,
      allowedActions: allowed,
    };
  }

  async list(rawQuery: unknown): Promise<ConcreteStrengthReportList> {
    const query = parseBody(concreteStrengthReportListQuerySchema, rawQuery);
    const STATE = `CASE WHEN sr.id IS NULL THEN 'not_started'
      WHEN sr.workflow_state = 'reviewed' AND v.state = 'issued' THEN 'issued'
      ELSE sr.workflow_state END`;
    const NEW_RESULTS = `EXISTS (
      SELECT 1 FROM concrete_specimen sp
      CROSS JOIN LATERAL (SELECT * FROM concrete_test_result t WHERE t.specimen_id = sp.id
                          ORDER BY t.attempt_no DESC LIMIT 1) t
      WHERE sp.set_id = st.id AND ${entryCompleteSql('t')}
        AND NOT coalesce(v.state <> 'recalled' AND v.snapshot->'results' @> jsonb_build_array(
              jsonb_build_object('specimenId', sp.id::text, 'reported', true)), false))`;
    const params: unknown[] = [];
    const where = [
      `(sr.id IS NOT NULL OR (st.voided_at IS NULL AND r.workflow_state <> 'void'
      AND ${NEW_RESULTS}))`,
    ];
    if (query.projectId) {
      params.push(query.projectId);
      where.push(`st.project_id = $${params.length}`);
    }
    if (query.state) {
      params.push(query.state);
      where.push(`${STATE} = $${params.length}`);
    }
    if (query.needsLab) {
      where.push(`(${STATE} IN ('not_started', 'draft', 'returned')
        OR (${STATE} = 'issued' AND ${NEW_RESULTS}))`);
    }
    const { rows } = await this.database.pool.query<{
      set_id: string;
      report_id: string | null;
      report_number: string | null;
      project_id: string;
      project_number: string;
      project_name: string;
      permanent_id: string | null;
      temporary_id: string | null;
      casting_date: string | null;
      state: ConcreteStrengthReportState;
      version_no: number | null;
      issue_count: number | null;
      ages_reported: number[] | null;
      new_results: boolean;
      updated_at: Date | null;
    }>(
      `SELECT st.id AS set_id, sr.id AS report_id,
              (SELECT n.report_number FROM concrete_report_number n WHERE n.report_kind = 'strength' AND n.subject_id = sr.id) AS report_number,
              st.project_id,
              p.project_number, p.name AS project_name, st.permanent_id, st.temporary_id,
              concrete_casting_date(r.cast_at)::text AS casting_date, ${STATE} AS state,
              v.version_no, sr.issue_count,
              (SELECT array_agg(x::int) FROM jsonb_array_elements_text(
                 CASE WHEN v.state = 'recalled' THEN '[]'::jsonb
                      ELSE coalesce(v.snapshot->'agesReported', '[]'::jsonb) END) x)
                AS ages_reported,
              ${NEW_RESULTS} AS new_results, sr.updated_at
       FROM concrete_specimen_set st
       JOIN concrete_field_report r ON r.id = st.field_report_id
       JOIN project p ON p.id = st.project_id
       LEFT JOIN concrete_strength_report sr ON sr.specimen_set_id = st.id
       LEFT JOIN LATERAL (
         SELECT lv.state, lv.version_no, lv.snapshot FROM concrete_report_version lv
         WHERE lv.strength_report_id = sr.id ORDER BY lv.version_no DESC LIMIT 1
       ) v ON true
       WHERE ${where.join(' AND ')}
       ORDER BY p.project_number, p.id, st.permanent_number NULLS LAST, st.temporary_id, st.id
       LIMIT ${CONCRETE_STRENGTH_REPORT_LIST_MAX + 1}`,
      params,
    );
    return {
      truncated: rows.length > CONCRETE_STRENGTH_REPORT_LIST_MAX,
      items: rows.slice(0, CONCRETE_STRENGTH_REPORT_LIST_MAX).map((row) => ({
        setId: row.set_id,
        reportId: row.report_id,
        reportNumber: row.report_number,
        projectId: row.project_id,
        projectNumber: row.project_number,
        projectName: row.project_name,
        identity: { permanentId: row.permanent_id, temporaryId: row.temporary_id },
        castingDate: row.casting_date,
        state: row.state,
        latestVersionNo: row.version_no,
        issuedRevNo: row.issue_count ? row.issue_count - 1 : null,
        agesReported: row.ages_reported ?? [],
        newResults: row.new_results,
        updatedAt: row.updated_at?.toISOString() ?? null,
      })),
    };
  }

  async versions(setId: string): Promise<ConcreteReportVersionList> {
    const report = await this.reportOrThrow(setId);
    const rows = await versionsOf(this.database.pool, report.id, COLUMN);
    const people = await peopleOf(this.database.pool, versionPeople(rows));
    return {
      reportId: report.id,
      versions: rows.map((row) => versionSummary(row, rows, people)),
      transitions: await transitionsOf(this.database.pool, report.id, rows, COLUMN),
    };
  }

  async version(setId: string, versionNo: string): Promise<ConcreteReportVersionDetail> {
    const { report, version, all } = await this.findVersion(setId, versionNo);
    const people = await peopleOf(this.database.pool, versionPeople([version]));
    return {
      ...versionSummary(version, all, people),
      reportId: report.id,
      snapshot: await storedSnapshot(this.database.pool, version.id),
    };
  }

  async notes(setId: string, versionNo: string): Promise<ConcreteExceptionNoteList> {
    const { report, version } = await this.findVersion(setId, versionNo);
    return {
      reportId: report.id,
      versionNo: version.version_no,
      notes: await exceptionNotesOf(this.database.pool, version.id, version.version_no),
    };
  }

  private async reportOrThrow(setId: string): Promise<StrengthReportRow> {
    const set = await findSet(this.database.pool, setId);
    const report = set ? await findStrengthReport(this.database.pool, set.id) : null;
    if (!report) throw new NotFoundException({ code: 'concrete_strength_report_not_found' });
    return report;
  }

  private async findVersion(setId: string, versionNo: string) {
    const report = await this.reportOrThrow(setId);
    const number = /^[1-9][0-9]{0,8}$/.test(versionNo) ? Number(versionNo) : null;
    const all = await versionsOf(this.database.pool, report.id, COLUMN);
    const version = all.find((v) => v.version_no === number);
    if (!version) throw new NotFoundException({ code: 'concrete_report_version_not_found' });
    return { report, version, all };
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async command(
    action: ConcreteReportAction,
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteStrengthReportDetail> {
    // Authority first: against the report as it stands, before the body, any lock or transaction.
    const set = await findSet(this.database.pool, setId);
    if (!set) {
      if (LAB_ACTIONS.has(action) || (await this.couldActSomewhere(user))) {
        throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
      }
      throw forbidden();
    }
    const report = await findStrengthReport(this.database.pool, set.id);
    const latest = report ? await latestVersion(this.database.pool, report.id, '', COLUMN) : null;
    const context = await strengthContext(this.database.pool, set);
    if (!holdsPermission(user, action, context, issuedByOf(latest))) throw forbidden();
    if (
      isReviewWork(action) &&
      (await selfReviewOf(this.database.pool, latest)).includes(user.userId)
    ) {
      throw forbidden('own_report');
    }
    const input = parseInput(action, body);
    const { idempotencyKey: _key, ...intent } = input;
    void _key;
    const hash = intentHash({ kind: 'strength', action, setId: set.id, ...intent });

    try {
      return await withTransaction(this.database.pool, (client) =>
        this.run(client, action, set.id, input, hash, user, actor, requestId),
      );
    } catch (error) {
      if (isConstraint(error, 'concrete_report_transition_idempotency_key')) {
        const replay = await withTransaction(this.database.pool, (client) =>
          this.replay(client, action, set.id, input.idempotencyKey, hash, user),
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async run(
    client: PoolClient,
    action: ConcreteReportAction,
    setId: string,
    input: Input,
    hash: string,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteStrengthReportDetail> {
    const set = await findSet(client, setId, 'FOR UPDATE OF st');
    if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    const report = await findStrengthReport(client, set.id, 'FOR UPDATE');
    const latest = report ? await latestVersion(client, report.id, 'FOR UPDATE', COLUMN) : null;

    const replay = await this.replay(client, action, set.id, input.idempotencyKey, hash, user);
    if (replay) return replay;

    // D09: the final check with the project and the actor's account as they stand.
    const context = await strengthContext(client, set);
    const { leadProjectEngineerUserId: _lead, ...facts } = context;
    void _lead;
    let permitted = false;
    for (const permission of STRENGTH_ACTION_PERMISSIONS[action]) {
      if (await canUnderLock(client, user, permission, set.project_id, { context: facts })) {
        permitted = true;
        break;
      }
    }
    const issuer = action === 'revise' ? issuedByOf(latest) : null;
    if (!permitted && issuer === user.userId) {
      const standing = asLocked(user, await lockStanding(client, [user.userId]));
      permitted = holdsPermission(standing, action, { leadProjectEngineerUserId: null }, issuer);
    }
    if (!permitted) throw forbidden();
    const selfReview = await selfReviewOf(client, latest);
    if (isReviewWork(action) && selfReview.includes(user.userId)) throw forbidden('own_report');
    const { rows: leadRows } = await client.query<{ lead: string | null }>(
      'SELECT lead_project_engineer_user_id AS lead FROM project WHERE id = $1',
      [set.project_id],
    );
    const lead = leadRows[0]?.lead ?? null;

    let person: PersonSnapshot | null = null;
    if (LAB_ACTIONS.has(action)) {
      person = await resolveActingPerson(client, user, input.performedByUserId, {
        field: 'performedByUserId',
        invalidCode: 'invalid_performed_by',
      });
    }

    if (input.version !== (report?.version ?? 0)) {
      throw new ConflictException({
        code: 'version_conflict',
        current: await this.detailOf(client, set, user),
      });
    }
    const from = stateOf(report, latest);
    const to = concreteStrengthReportNextState(from, action);
    if (to === null) {
      unprocessable('invalid_transition', [
        {
          field: 'action',
          message: `A ${from.replace(/_/g, ' ')} report can't be sent "${action}"`,
        },
      ]);
    }
    if ((action === 'review' || action === 'return') && latest) {
      const route = { kind: latest.route_kind, routedToUserId: latest.routed_to_user_id };
      if (!concreteReportMayReviewRouted(route, user.userId, lead)) {
        throw forbidden('routed_to_another_reviewer');
      }
    }
    if (action === 'review' && latest) {
      // C28: Mark reviewed once every exception is resolved (no longer raised live) or documented.
      const live = await buildStrengthSnapshot(client, set, {
        reportId: report!.id,
        versionNo: latest.version_no,
        revNo: report!.issue_count,
        revision: null,
      });
      const open = concreteReviewOpenExceptions(await checklistOf(client, latest, live.warnings));
      if (open.length > 0) {
        unprocessable(
          'exceptions_unresolved',
          open.map((item) => ({
            field: item.field ?? item.code,
            message: `${CONCRETE_EXCEPTION_LABEL[item.code]}: resolve it or document how it was addressed`,
          })),
        );
      }
    }

    let reportId: string;
    let versionId: string;
    let versionNo: number;
    let route: ConcreteReportRoute | null = null;
    const rowVersionBefore = report?.version ?? 0;
    let prepared: PreparedReportIssue | null = null;
    let issuedFile: { sha256: string; revisionNo: number } | null = null;
    if (action === 'submit' || action === 'resubmit') {
      const versions = report ? await versionsOf(client, report.id, COLUMN) : [];
      const issued = [...versions].reverse().find((v) => v.state === 'issued') ?? null;
      const issuedSnapshot = issued ? await storedSnapshot(client, issued.id) : null;
      reportId = report?.id ?? (await this.createReport(client, set, user));
      versionNo = (latest?.version_no ?? 0) + 1;
      const snapshot = await buildStrengthSnapshot(client, set, {
        reportId,
        versionNo,
        revNo: report?.issue_count ?? 0,
        revision: null,
      });
      const blocker = concreteStrengthSubmitBlocker({
        setVoid: set.voided || set.report_void,
        ages: snapshot.ages,
        state: from,
        issuedAges: issuedSnapshot?.agesReported ?? [],
      });
      if (blocker) {
        unprocessable(blocker, [
          { field: 'results', message: CONCRETE_STRENGTH_SUBMIT_BLOCKER_MESSAGE[blocker] },
        ]);
      }
      if (issued && issuedSnapshot) {
        snapshot.revision = {
          supersedesVersionNo: issued.version_no,
          supersedesRevNo: issuedSnapshot.revNo,
          supersedesIssuedAt: issued.issued_at!.toISOString(),
          reason: await this.revisionReason(client, reportId, issued, issuedSnapshot, snapshot),
        };
      }
      // Resubmission goes back to the reviewer who returned it (C09 / D11); never to someone
      // who may not review it (the sole tester or entrant).
      const blocked = concreteStrengthSelfReviewUserIds(snapshot.results);
      const routed = await this.route(client, action, latest, context, lead, blocked);
      if ('error' in routed) {
        unprocessable(routed.error, [
          {
            field: 'route',
            message: 'Only the Lead Project Engineer can review this, and the project has none yet',
          },
        ]);
      }
      route = routed;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO concrete_report_version
           (report_kind, project_id, strength_report_id, version_no, revision_of_version_id,
            snapshot, snapshot_sha256, report_row_version, submitted_by_user_id,
            submitted_staff_user_id, route_kind, routed_to_user_id, route_reason)
         VALUES ('strength', $1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          set.project_id,
          reportId,
          versionNo,
          issued?.id ?? null,
          JSON.stringify(snapshot),
          rowVersionBefore,
          user.userId,
          person!.userId,
          route.kind,
          route.routedToUserId,
          route.reason,
        ],
      );
      versionId = rows[0]!.id;
      if (report) {
        await client.query(
          `UPDATE concrete_strength_report
           SET workflow_state = 'submitted', submitted_at = now(), version = version + 1,
               updated_at = now()
           WHERE id = $1`,
          [reportId],
        );
      }
    } else {
      const current = latest!;
      reportId = report!.id;
      versionId = current.id;
      versionNo = current.version_no;
      if (action === 'issue' && input.includeMachineInfo === undefined) {
        // C38: omitted means the project's concrete setting as it stands (unset: left out).
        const { rows } = await client.query<{ include_machine_info: boolean | null }>(
          `SELECT include_machine_info FROM concrete_project_settings WHERE project_id = $1
           FOR SHARE`,
          [set.project_id],
        );
        input = { ...input, includeMachineInfo: rows[0]?.include_machine_info ?? false };
      }
      // MM-V2-C32: the strength template in force and the CS number (first issue only; every
      // revision keeps it), recorded on the version in the same update that issues it; then the
      // PDF is rendered from the frozen snapshot and stored, all in this transaction.
      prepared =
        action === 'issue' ? await this.output.prepareStrengthIssue(client, report!, user) : null;
      await this.transitionVersion(client, action, current, user, context, input, prepared);
      if (prepared) {
        const file = await this.output.storeStrengthIssue(
          client,
          prepared,
          report!,
          current.id,
          user,
        );
        issuedFile = { sha256: file.sha256, revisionNo: file.revisionNo };
      }
      await this.updateReport(client, action, report!, current, user, to);
    }

    const transition = await client.query<{ id: string }>(
      `INSERT INTO concrete_report_transition
         (report_kind, project_id, strength_report_id, version_id, action, from_state, to_state,
          actor_user_id, staff_user_id, comment, route_kind, routed_to_user_id, idempotency_key,
          request_hash)
       VALUES ('strength', $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        set.project_id,
        reportId,
        versionId,
        action,
        from === 'not_started' ? 'draft' : from,
        to,
        user.userId,
        user.accountType === 'shared_lab' ? (person?.userId ?? null) : null,
        input.comment ?? null,
        route?.kind ?? null,
        route?.routedToUserId ?? null,
        input.idempotencyKey,
        hash,
      ],
    );
    void transition;
    await recordAudit(client, {
      action: AUDIT_ACTION[action],
      entityType: ENTITY_TYPE,
      entityId: reportId,
      actor,
      receiver: user.accountType === 'shared_lab' && person ? receiverOf(person) : null,
      before: { version: rowVersionBefore, state: from },
      after: {
        version: rowVersionBefore + 1,
        state: to,
        setId: set.id,
        reportVersionNo: versionNo,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(action === 'issue'
          ? {
              includePhotos: input.includePhotos ?? false,
              includeMachineInfo: input.includeMachineInfo,
            }
          : {}),
        ...(prepared && issuedFile
          ? {
              reportNumber: prepared.number.reportNumber,
              reportRevisionNo: issuedFile.revisionNo,
              templateId: prepared.template.id,
              templateRevision: prepared.template.revision,
              fileSha256: issuedFile.sha256,
            }
          : {}),
        ...(route
          ? {
              routeKind: route.kind,
              routedToUserId: route.routedToUserId,
              routeReason: route.reason,
            }
          : {}),
      },
      requestId,
    });
    return this.detailOf(client, set, user);
  }

  /** The first submission creates the report row, already submitted (version 1). */
  private async createReport(client: PoolClient, set: SetFacts, user: AuthUser): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO concrete_strength_report
         (project_id, specimen_set_id, workflow_state, submitted_at, created_by_user_id)
       VALUES ($1, $2, 'submitted', now(), $3) RETURNING id`,
      [set.project_id, set.id, user.userId],
    );
    return rows[0]!.id;
  }

  /**
   * The short reason a revision prints: the revise comment(s) since the last issue (a
   * correction), and the ages added since it (the cumulative next age).
   */
  private async revisionReason(
    client: PoolClient,
    reportId: string,
    issued: VersionRow,
    issuedSnapshot: ConcreteStrengthReportSnapshot,
    snapshot: ConcreteStrengthReportSnapshot,
  ): Promise<string> {
    const { rows } = await client.query<{ comment: string }>(
      `SELECT comment FROM concrete_report_transition
       WHERE strength_report_id = $1 AND action = 'revise' AND created_at >= $2
         AND comment IS NOT NULL
       ORDER BY created_at, id`,
      [reportId, issued.issued_at],
    );
    const before = new Set(issuedSnapshot.agesReported);
    const added = snapshot.agesReported.filter((age) => !before.has(age));
    const parts = rows.map((r) => r.comment);
    if (added.length > 0) parts.push(`Added ${added.map((a) => `${a} d`).join(', ')} results`);
    return (parts.join('; ') || 'Revised').slice(0, 2000);
  }

  private async route(
    client: PoolClient,
    action: 'submit' | 'resubmit',
    latest: VersionRow | null,
    context: ProjectContext,
    lead: string | null,
    blocked: string[],
  ) {
    const original = action === 'resubmit' ? (latest?.closed_by_user_id ?? null) : null;
    let originalCanReview = false;
    if (original !== null && !blocked.includes(original)) {
      const { rows } = await client.query<{ ok: boolean }>(
        `SELECT status = 'active' AND account_type <> 'shared_lab' AS ok FROM app_user WHERE id = $1`,
        [original],
      );
      originalCanReview =
        Boolean(rows[0]?.ok) &&
        (original === lead || (context.designatedReviewerUserIds ?? []).includes(original));
    }
    return concreteReportRoute({
      action,
      labManagerCorrection: false,
      originalReviewerUserId: original,
      originalReviewerCanReview: originalCanReview,
      leadProjectEngineerUserId: lead,
      technicianUserId: lead !== null && blocked.includes(lead) ? lead : (blocked[0] ?? null),
    });
  }

  private async transitionVersion(
    client: PoolClient,
    action: ConcreteReportAction,
    version: VersionRow,
    user: AuthUser,
    context: ProjectContext,
    input: Input,
    prepared: PreparedReportIssue | null = null,
  ) {
    const comment = input.comment ?? null;
    const sources = (permission: 'concrete.review' | 'report.issue') =>
      permissionSources(user, permission, context);
    switch (action) {
      case 'recall':
        await client.query(
          `UPDATE concrete_report_version
           SET state = 'recalled', closed_by_user_id = $2, closed_at = now(), close_comment = $3
           WHERE id = $1`,
          [version.id, user.userId, comment],
        );
        return;
      case 'return':
        await client.query(
          `UPDATE concrete_report_version
           SET state = 'returned', closed_by_user_id = $2, closed_at = now(), close_comment = $3,
               review_cleared_at = CASE WHEN state = 'reviewed' THEN now() END
           WHERE id = $1`,
          [version.id, user.userId, comment],
        );
        return;
      case 'review':
        await client.query(
          `UPDATE concrete_report_version
           SET state = 'reviewed', reviewed_by_user_id = $2, reviewed_at = now(), review_source = $3
           WHERE id = $1`,
          [
            version.id,
            user.userId,
            sources('concrete.review').includes('lead_project_engineer')
              ? 'lead_project_engineer'
              : 'designated_reviewer',
          ],
        );
        return;
      case 'issue':
        await client.query(
          `UPDATE concrete_report_version
           SET state = 'issued', issued_by_user_id = $2, issued_at = now(), issue_source = $3,
               issue_include_photos = $4, issue_include_machine_info = $5,
               report_number_id = $6, report_template_id = $7
           WHERE id = $1`,
          [
            version.id,
            user.userId,
            sources('report.issue').includes('lead_project_engineer')
              ? 'lead_project_engineer'
              : 'report_issuer',
            input.includePhotos ?? false,
            input.includeMachineInfo,
            prepared!.number.id,
            prepared!.template.id,
          ],
        );
        return;
      case 'revise':
        // The issued version stays exactly as issued; the report reopens as a revision draft.
        return;
      default:
        throw new Error(`unexpected action ${action}`);
    }
  }

  private async updateReport(
    client: PoolClient,
    action: ConcreteReportAction,
    report: StrengthReportRow,
    version: VersionRow,
    user: AuthUser,
    to: NonNullable<ReturnType<typeof concreteStrengthReportNextState>>,
  ) {
    if (action === 'issue') {
      await client.query(
        `UPDATE concrete_strength_report
         SET issue_count = issue_count + 1, last_issued_version = $2, last_issued_at = now(),
             last_issued_by_user_id = $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [report.id, version.version_no, user.userId],
      );
      return;
    }
    const state = concreteReportStoredState(to);
    await client.query(
      `UPDATE concrete_strength_report
       SET workflow_state = $2,
           submitted_at = CASE WHEN $2 = 'draft' THEN NULL ELSE submitted_at END,
           version = version + 1, updated_at = now()
       WHERE id = $1`,
      [report.id, state],
    );
  }

  private async replay(
    client: PoolClient,
    action: ConcreteReportAction,
    setId: string,
    key: string,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteStrengthReportDetail | null> {
    const { rows } = await client.query<{
      report_kind: string;
      action: string;
      request_hash: string;
      actor_user_id: string;
      set_id: string | null;
    }>(
      `SELECT t.report_kind, t.action, t.request_hash, t.actor_user_id,
              sr.specimen_set_id AS set_id
       FROM concrete_report_transition t
       LEFT JOIN concrete_strength_report sr ON sr.id = t.strength_report_id
       WHERE t.idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.report_kind !== 'strength' ||
      previous.action !== action ||
      previous.set_id !== setId ||
      previous.request_hash !== hash ||
      previous.actor_user_id !== user.userId
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return this.detailOf(client, (await findSet(client, setId))!, user);
  }

  /** As C09: 404 for an unknown set only for someone who could review or issue somewhere. */
  private async couldActSomewhere(user: AuthUser): Promise<boolean> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') return false;
    const { rows } = await this.database.pool.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1)
           OR EXISTS (SELECT 1 FROM project_reviewer_assignment
                      WHERE reviewer_user_id = $1 AND scope_code = 'concrete_strength'
                        AND removed_at IS NULL)
           OR EXISTS (SELECT 1 FROM project_report_issuer_grant
                      WHERE issuer_user_id = $1 AND report_scope_code = 'concrete_strength'
                        AND revoked_at IS NULL)
           OR EXISTS (SELECT 1 FROM concrete_report_version
                      WHERE issued_by_user_id = $1 AND report_kind = 'strength')
           AS any`,
      [user.userId],
    );
    return Boolean(rows[0]?.any);
  }

  // -------------------------------------------------------------------------------------------
  // Exception notes (C28 on strength reports)
  // -------------------------------------------------------------------------------------------

  async document(
    setId: string,
    versionNo: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteExceptionNoteList> {
    const set = await findSet(this.database.pool, setId);
    if (!set) {
      if (await this.couldActSomewhere(user)) {
        throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
      }
      throw forbidden();
    }
    const context = await strengthContext(this.database.pool, set);
    if (!can(user, 'concrete.review', context)) throw forbidden();
    const report = await findStrengthReport(this.database.pool, set.id);
    const latestNow = report
      ? await latestVersion(this.database.pool, report.id, '', COLUMN)
      : null;
    if ((await selfReviewOf(this.database.pool, latestNow)).includes(user.userId)) {
      throw forbidden('own_report');
    }
    const input = parseBody(concreteExceptionNoteRequestSchema, body);

    return withTransaction(this.database.pool, async (client) => {
      const locked = (await findSet(client, set.id, 'FOR UPDATE OF st'))!;
      const found = await findStrengthReport(client, locked.id, 'FOR UPDATE');
      const latest = found ? await latestVersion(client, found.id, 'FOR UPDATE', COLUMN) : null;
      const number = Number(versionNo);
      if (!found || !latest || !/^[1-9][0-9]{0,8}$/.test(versionNo) || number > latest.version_no) {
        throw new NotFoundException({ code: 'concrete_report_version_not_found' });
      }
      const lockedContext = await strengthContext(client, locked);
      const { leadProjectEngineerUserId: _lead, ...facts } = lockedContext;
      void _lead;
      if (
        !(await canUnderLock(client, user, 'concrete.review', locked.project_id, {
          context: facts,
        }))
      ) {
        throw forbidden();
      }
      if ((await selfReviewOf(client, latest)).includes(user.userId)) {
        throw forbidden('own_report');
      }
      if (
        !concreteReportMayReviewRouted(
          { kind: latest.route_kind, routedToUserId: latest.routed_to_user_id },
          user.userId,
          locked.lead_project_engineer_user_id,
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
      const { rows: existing } = await client.query<{ note: string }>(
        `SELECT note FROM concrete_report_exception_note
         WHERE version_id = $1 AND code = $2 AND coalesce(field, '') = coalesce($3, '')`,
        [latest.id, input.code, input.field],
      );
      if (existing[0]) {
        if (existing[0].note !== input.note) {
          throw new ConflictException({ code: 'exception_already_documented' });
        }
      } else {
        await client.query(
          `INSERT INTO concrete_report_exception_note
             (project_id, strength_report_id, version_id, code, field, note, documented_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [
            locked.project_id,
            found.id,
            latest.id,
            input.code,
            input.field,
            input.note,
            user.userId,
          ],
        );
        await recordAudit(client, {
          action: 'concrete_strength_report.exception_documented',
          entityType: ENTITY_TYPE,
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
}

/** Review, return and issue are review work: never by the version's sole tester / entrant. */
function isReviewWork(action: ConcreteReportAction): boolean {
  return action === 'review' || action === 'return' || action === 'issue';
}
