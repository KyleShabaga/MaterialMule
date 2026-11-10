import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  concreteReportCommandRequestSchema,
  concreteReportCommentRequiredSchema,
  concreteReportIssueRequestSchema,
  concreteReviewOpenExceptions,
  CONCRETE_EXCEPTION_LABEL,
  concreteReportLifecycleState,
  concreteReportMayReviewRouted,
  concreteReportNextState,
  concreteReportRoute,
  concreteReportStoredState,
  concreteReportSubmitRequestSchema,
  type ConcreteFieldReportDetail,
  type ConcreteReportAction,
  type ConcreteReportRoute,
  type ConcreteReportVersionDetail,
  type ConcreteReportVersionList,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { notifyConcreteReportReturned } from '../notifications/concrete-notifications.js';
import { permissionSources, type AuthUser, type ProjectContext } from '../auth/policy.js';
import { asLocked, canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf, resolveActingPerson } from '../lab/attribution.js';
import { intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { ConcreteSpecimenSetsService } from './concrete-specimen-sets.service.js';
import {
  ConcreteReportOutputService,
  type PreparedFieldIssue,
} from './reports/concrete-report-output.service.js';
import {
  ConcreteFieldReportsService,
  findReport,
  type ReportRow,
} from './concrete-field-reports.service.js';
import {
  ACTION_PERMISSIONS,
  FIELD_REPORT_SCOPE,
  grantLoader,
  holdsActionPermission,
  isSelfReview,
  issuedByOf,
  latestVersion,
  lifecycleContext,
  lockedLifecycleContext,
  peopleOf,
  transitionsOf,
  versionPeople,
  versionsOf,
  versionSummary,
  type VersionRow,
} from './concrete-report-lifecycle.read.js';
import { checklistOf } from './concrete-review.read.js';

const ENTITY_TYPE = 'concrete_field_report';

const AUDIT_ACTION: Record<ConcreteReportAction, string> = {
  submit: 'concrete_field_report.submitted',
  recall: 'concrete_field_report.recalled',
  return: 'concrete_field_report.returned',
  resubmit: 'concrete_field_report.resubmitted',
  review: 'concrete_field_report.reviewed',
  issue: 'concrete_field_report.issued',
  revise: 'concrete_field_report.revised',
};

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

/** The project's C02 "include testing machine information" setting; unset (or no row) is false. */
async function projectIncludesMachineInfo(client: PoolClient, projectId: string): Promise<boolean> {
  const { rows } = await client.query<{ include_machine_info: boolean | null }>(
    `SELECT include_machine_info FROM concrete_project_settings WHERE project_id = $1 FOR SHARE`,
    [projectId],
  );
  return rows[0]?.include_machine_info ?? false;
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

type Input = {
  idempotencyKey: string;
  version: number;
  comment?: string;
  technicianUserId?: string;
  /** Issue only (MM-V2-C28). */
  includePhotos?: boolean;
  includeMachineInfo?: boolean;
};

function parseInput(action: ConcreteReportAction, body: unknown): Input {
  if (action === 'submit' || action === 'resubmit') {
    return parseBody(concreteReportSubmitRequestSchema, body);
  }
  if (action === 'return' || action === 'revise') {
    return parseBody(concreteReportCommentRequiredSchema, body);
  }
  if (action === 'issue') return parseBody(concreteReportIssueRequestSchema, body);
  return parseBody(concreteReportCommandRequestSchema, body);
}

/**
 * Field-report versions and the review / issue lifecycle (MM-V2-C09). Each command is checked
 * against the report as it stands before the body, any lock or the transaction (D09), then in one
 * transaction in the lock order: the report FOR UPDATE, its latest version FOR UPDATE, the project
 * and the actor's account FOR SHARE (`canUnderLock`), the performing person FOR SHARE (LAB). Then
 * the exactly-once ledger, the version check, the transition check, the routing check, the
 * write, the transition row and the audit event, all or nothing.
 *
 * Authority (docs/permissions.md): submit and resubmit `concrete_report.draft` for the report's
 * own technician (LAB names them); recall `concrete_report.recall` (the technician, personal
 * account); return and review `concrete.review` (the lead or a designated reviewer, and for a
 * routed version only its reviewer or the lead); issue `report.issue` (the lead or an issuer
 * grant for the field scope); revise the lead, a designated reviewer or the version's issuer.
 * Nobody reviews or issues a report they are the technician of (owner decision 2026-11-08).
 */
@Injectable()
export class ConcreteReportLifecycleService {
  constructor(
    private readonly database: DatabaseService,
    private readonly reports: ConcreteFieldReportsService,
    private readonly sets: ConcreteSpecimenSetsService,
    private readonly output: ConcreteReportOutputService,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async versions(reportId: string): Promise<ConcreteReportVersionList> {
    const report = await findReport(this.database.pool, reportId);
    if (!report) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    const rows = await versionsOf(this.database.pool, report.id);
    const people = await peopleOf(this.database.pool, versionPeople(rows));
    return {
      reportId: report.id,
      versions: rows.map((row) => versionSummary(row, rows, people)),
      transitions: await transitionsOf(this.database.pool, report.id, rows),
    };
  }

  async version(reportId: string, versionNo: string): Promise<ConcreteReportVersionDetail> {
    const report = await findReport(this.database.pool, reportId);
    const number = /^[1-9][0-9]{0,8}$/.test(versionNo) ? Number(versionNo) : null;
    if (!report || number === null) {
      throw new NotFoundException({ code: 'concrete_report_version_not_found' });
    }
    const rows = await versionsOf(this.database.pool, report.id);
    const row = rows.find((v) => v.version_no === number);
    if (!row) throw new NotFoundException({ code: 'concrete_report_version_not_found' });
    const { rows: stored } = await this.database.pool.query<{ snapshot: Record<string, unknown> }>(
      'SELECT snapshot FROM concrete_report_version WHERE id = $1',
      [row.id],
    );
    const people = await peopleOf(this.database.pool, versionPeople([row]));
    return {
      ...versionSummary(row, rows, people),
      reportId: report.id,
      snapshot: stored[0]!.snapshot,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  async command(
    action: ConcreteReportAction,
    reportId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteFieldReportDetail> {
    // Authority first: against the report as it stands, before the body, any lock or transaction.
    const report = await findReport(this.database.pool, reportId);
    if (!report) {
      const drafting = action === 'submit' || action === 'resubmit';
      if (drafting || (await this.couldActOnSomeReport(user))) {
        throw new NotFoundException({ code: 'concrete_field_report_not_found' });
      }
      throw forbidden();
    }
    const context = await lifecycleContext(this.database.pool, report);
    const issuedBy = issuedByOf(await latestVersion(this.database.pool, report.id));
    if (!holdsActionPermission(user, action, context, issuedBy)) throw forbidden();
    // Owner decision 2026-11-08: never one's own report, whatever else the person holds.
    if (isSelfReview(user, action, report)) throw forbidden('own_report');
    if (
      (action === 'submit' || action === 'resubmit') &&
      user.accountType !== 'shared_lab' &&
      report.technician_user_id !== user.userId
    ) {
      throw forbidden('not_own_report');
    }
    const input = parseInput(action, body);
    const { idempotencyKey: _key, ...intent } = input;
    void _key;
    const hash = intentHash({ action, reportId: report.id, ...intent });

    try {
      return await withTransaction(this.database.pool, (client) =>
        this.run(client, action, report.id, input, hash, user, actor, requestId),
      );
    } catch (error) {
      if (isConstraint(error, 'concrete_report_transition_idempotency_key')) {
        // The same key raced itself: the other request committed first, so this is its retry.
        const replay = await withTransaction(this.database.pool, (client) =>
          this.replay(client, action, report.id, input.idempotencyKey, hash, user),
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  private async run(
    client: PoolClient,
    action: ConcreteReportAction,
    reportId: string,
    input: Input,
    hash: string,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteFieldReportDetail> {
    const found = await findReport(client, reportId, 'FOR UPDATE');
    if (!found) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    const latest = await latestVersion(client, found.id, 'FOR UPDATE');

    const replay = await this.replay(client, action, found.id, input.idempotencyKey, hash, user);
    if (replay) return replay;

    // D09: the final check with the project, the actor's account and (review fix #134) the
    // issuer and reviewer grants as they stand, all locked before they are read.
    const grants = grantLoader((c) => lockedLifecycleContext(c, found));
    let permitted = false;
    for (const permission of ACTION_PERMISSIONS[action]) {
      if (
        await canUnderLock(client, user, permission, found.project_id, { context: grants.loader })
      ) {
        permitted = true;
        break;
      }
    }
    const context = grants.held.context ?? (await lockedLifecycleContext(client, found));
    // Revise: the person who issued the version being corrected may also correct it, while
    // their account is an active personal one (as it stands under the lock).
    const issuer = action === 'revise' ? issuedByOf(latest) : null;
    if (!permitted && issuer === user.userId) {
      const standing = asLocked(user, await lockStanding(client, [user.userId]));
      permitted = holdsActionPermission(
        standing,
        action,
        { leadProjectEngineerUserId: null },
        issuer,
      );
    }
    if (!permitted) throw forbidden();
    if (isSelfReview(user, action, found)) throw forbidden('own_report');
    const lead = await this.leadOf(client, found.project_id);

    let person: PersonSnapshot | null = null;
    if (action === 'submit' || action === 'resubmit') {
      person = await resolveActingPerson(client, user, input.technicianUserId, {
        field: 'technicianUserId',
        invalidCode: 'invalid_technician',
      });
      if (found.technician_user_id !== person.userId) throw forbidden('not_own_report');
    }

    if (input.version !== found.version) {
      throw new ConflictException({
        code: 'version_conflict',
        current: await this.reports.detailOf(client, found, user),
      });
    }
    const from = concreteReportLifecycleState(found.workflow_state, latest?.state ?? null);
    const to = concreteReportNextState(from, action);
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
    // MM-V2-C28: Mark reviewed once every required exception is resolved or documented.
    if (action === 'review' && latest) {
      const live = (await this.reports.detailOf(client, found, user)).review.warnings;
      const open = concreteReviewOpenExceptions(await checklistOf(client, latest, live));
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

    let versionId: string;
    let route: ConcreteReportRoute | null = null;
    let issued: { prepared: PreparedFieldIssue; sha256: string; revisionNo: number } | null = null;
    let versionNo: number;
    if (action === 'submit' || action === 'resubmit') {
      const detail = await this.reports.detailOf(client, found, user);
      if (!detail.completeness.complete) {
        unprocessable(
          'incomplete_for_review',
          detail.completeness.missingRequired.map((field) => ({
            field,
            message: 'Required for review',
          })),
        );
      }
      const routed = await this.route(client, action, found, latest, context, lead);
      if ('error' in routed) {
        unprocessable(routed.error, [
          {
            field: 'route',
            message: 'Only the Lead Project Engineer can review this, and the project has none yet',
          },
        ]);
      }
      route = routed;
      versionNo = (latest?.version_no ?? 0) + 1;
      versionId = await this.insertVersion(client, found, versionNo, detail, user, person!, route);
      await client.query(
        `UPDATE concrete_field_report
         SET workflow_state = 'submitted', submitted_at = now(),
             lab_manager_corrected_by_user_id = NULL, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [found.id],
      );
    } else {
      // Every other command acts on the latest version, which exists in every state that allows it.
      const current = latest!;
      versionId = current.id;
      versionNo = current.version_no;
      if (action === 'issue' && input.includeMachineInfo === undefined) {
        // MM-V2-C38 (owner decision 2026-11-09): the issuer isn't forced to choose. Omitted means
        // the project's concrete setting as it stands; a project that never set it leaves the
        // machine information out. The resolved choice is what gets stored and audited.
        input = {
          ...input,
          includeMachineInfo: await projectIncludesMachineInfo(client, found.project_id),
        };
      }
      // MM-V2-C32: the template in force and the report number (first issue only; a revision
      // keeps it), recorded on the version in the same update that issues it; then the PDF is
      // rendered from the frozen snapshot and stored, all in this transaction.
      const prepared =
        action === 'issue' ? await this.output.prepareFieldIssue(client, found, user) : null;
      await this.transitionVersion(client, action, current, user, context, input, prepared);
      if (prepared) {
        const file = await this.output.storeFieldIssue(client, prepared, found, current.id, user);
        issued = { prepared, sha256: file.sha256, revisionNo: file.revisionNo };
      }
      await this.updateReport(client, action, found, current, user, to);
    }

    const transition = await client.query<{ id: string }>(
      `INSERT INTO concrete_report_transition
         (project_id, field_report_id, version_id, action, from_state, to_state, actor_user_id,
          staff_user_id, comment, route_kind, routed_to_user_id, idempotency_key, request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING id`,
      [
        found.project_id,
        found.id,
        versionId,
        action,
        from,
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
    await recordAudit(client, {
      action: AUDIT_ACTION[action],
      entityType: ENTITY_TYPE,
      entityId: found.id,
      actor,
      receiver: user.accountType === 'shared_lab' && person ? receiverOf(person) : null,
      before: { version: found.version, state: from },
      after: {
        version: found.version + 1,
        state: to,
        reportVersionNo: versionNo,
        ...(input.comment ? { comment: input.comment } : {}),
        ...(action === 'issue'
          ? {
              includePhotos: input.includePhotos ?? false,
              includeMachineInfo: input.includeMachineInfo,
            }
          : {}),
        ...(issued
          ? {
              reportNumber: issued.prepared.number.reportNumber,
              reportRevisionNo: issued.revisionNo,
              templateId: issued.prepared.template.id,
              templateRevision: issued.prepared.template.revision,
              fileSha256: issued.sha256,
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
    // C29: a return tells the technician and the Lab Manager(s), in the same transaction.
    if (action === 'return') await notifyConcreteReportReturned(client, transition.rows[0]!.id);
    return this.reports.detailOf(client, (await findReport(client, found.id))!, user);
  }

  /** Who reviews a (re)submission (D11). */
  private async route(
    client: PoolClient,
    action: 'submit' | 'resubmit',
    report: ReportRow,
    latest: VersionRow | null,
    context: ProjectContext,
    lead: string | null,
  ) {
    const original = action === 'resubmit' ? (latest?.closed_by_user_id ?? null) : null;
    let originalCanReview = false;
    if (original !== null) {
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
      labManagerCorrection: report.lab_manager_corrected_by_user_id !== null,
      originalReviewerUserId: original,
      originalReviewerCanReview: originalCanReview,
      leadProjectEngineerUserId: lead,
      technicianUserId: report.technician_user_id,
    });
  }

  private async insertVersion(
    client: PoolClient,
    report: ReportRow,
    versionNo: number,
    detail: ConcreteFieldReportDetail,
    user: AuthUser,
    person: PersonSnapshot,
    route: ConcreteReportRoute,
  ): Promise<string> {
    // Every submission after an issue is a revision of the latest issued version (AC4).
    const { rows: issued } = await client.query<{ id: string }>(
      `SELECT id FROM concrete_report_version
       WHERE field_report_id = $1 AND state = 'issued' ORDER BY version_no DESC LIMIT 1`,
      [report.id],
    );
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO concrete_report_version
         (project_id, field_report_id, version_no, revision_of_version_id, snapshot,
          snapshot_sha256, report_row_version, submitted_by_user_id, submitted_staff_user_id,
          route_kind, routed_to_user_id, route_reason)
       VALUES ($1, $2, $3, $4, $5, '', $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        report.project_id,
        report.id,
        versionNo,
        issued[0]?.id ?? null,
        JSON.stringify({
          ...snapshotOf(detail, versionNo),
          // MM-V2-C05: the sets and specimens as submitted (caller-specific edit flags left out).
          specimenSets: (await this.sets.list(report.id, user)).items.map((set) => {
            const { canEdit: _canEdit, ...frozen } = set;
            void _canEdit;
            return frozen;
          }),
        }),
        report.version,
        user.userId,
        person.userId,
        route.kind,
        route.routedToUserId,
        route.reason,
      ],
    );
    return rows[0]!.id;
  }

  private async transitionVersion(
    client: PoolClient,
    action: ConcreteReportAction,
    version: VersionRow,
    user: AuthUser,
    context: ProjectContext,
    input: Input,
    prepared: PreparedFieldIssue | null = null,
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
        // A return after review clears that review: a fresh review is needed (AC3).
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
            prepared?.number.id ?? null,
            prepared?.template.id ?? null,
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
    report: ReportRow,
    version: VersionRow,
    user: AuthUser,
    to: NonNullable<ReturnType<typeof concreteReportNextState>>,
  ) {
    const state = concreteReportStoredState(to);
    if (action === 'issue') {
      await client.query(
        `UPDATE concrete_field_report
         SET issue_count = issue_count + 1, last_issued_version = $2, last_issued_at = now(),
             last_issued_by_user_id = $3, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [report.id, version.version_no, user.userId],
      );
      return;
    }
    await client.query(
      `UPDATE concrete_field_report
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
    reportId: string,
    key: string,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteFieldReportDetail | null> {
    const { rows } = await client.query<{
      field_report_id: string;
      action: string;
      request_hash: string;
      actor_user_id: string;
    }>(
      `SELECT field_report_id, action, request_hash, actor_user_id
       FROM concrete_report_transition WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.action !== action ||
      previous.field_report_id !== reportId ||
      previous.request_hash !== hash ||
      previous.actor_user_id !== user.userId
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return this.reports.detailOf(client, (await findReport(client, reportId))!, user);
  }

  private async leadOf(client: PoolClient, projectId: string): Promise<string | null> {
    const { rows } = await client.query<{ lead_project_engineer_user_id: string | null }>(
      'SELECT lead_project_engineer_user_id FROM project WHERE id = $1',
      [projectId],
    );
    return rows[0]?.lead_project_engineer_user_id ?? null;
  }

  /**
   * Whether the caller holds review or issue authority on some project, so an unknown report is
   * 404 for them; anyone else gets the same 403 as for a real report they can't act on.
   */
  private async couldActOnSomeReport(user: AuthUser): Promise<boolean> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') return false;
    const { rows } = await this.database.pool.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1)
           OR EXISTS (SELECT 1 FROM concrete_field_report WHERE technician_user_id = $1)
           OR EXISTS (SELECT 1 FROM project_reviewer_assignment
                      WHERE reviewer_user_id = $1 AND scope_code = $2 AND removed_at IS NULL)
           OR EXISTS (SELECT 1 FROM project_report_issuer_grant
                      WHERE issuer_user_id = $1 AND report_scope_code = $2 AND revoked_at IS NULL)
           AS any`,
      [user.userId, FIELD_REPORT_SCOPE],
    );
    return Boolean(rows[0]?.any);
  }
}

/**
 * What a version freezes: the report's content and the checks as shown at submission. Live,
 * caller-specific parts (version counter, edit right, routing, lifecycle) are left out.
 */
function snapshotOf(detail: ConcreteFieldReportDetail, versionNo: number): Record<string, unknown> {
  return {
    kind: 'field',
    versionNo,
    reportId: detail.id,
    projectId: detail.projectId,
    projectNumber: detail.projectNumber,
    projectName: detail.projectName,
    client: detail.client,
    technician: detail.technician,
    createdBy: detail.createdBy,
    fields: detail.fields,
    mixSnapshot: detail.mixSnapshot,
    manualSpecChanges: detail.manualSpecChanges,
    airMeterUse: detail.airMeterUse,
    duplicateTickets: detail.duplicateTickets,
    completeness: detail.completeness,
    warnings: detail.review.warnings,
  };
}
