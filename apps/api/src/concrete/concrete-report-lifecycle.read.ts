import {
  concreteReportLifecycleState,
  concreteReportMayReviewRouted,
  concreteReportNextState,
  CONCRETE_REPORT_ACTIONS,
  type ConcreteReportAction,
  type ConcreteReportFile,
  type ConcreteReportLifecycle,
  type ConcreteReportRouteKind,
  type ConcreteReportRouteReason,
  type ConcreteReportTransition,
  type ConcreteReportVersionState,
  type ConcreteReportVersionSummary,
  type ConcreteWorkflowState,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { can, type AuthUser, type Permission, type ProjectContext } from '../auth/policy.js';
import { lockProjectGrants } from '../auth/standing.js';
import { projectContext } from '../project-access/project-access.service.js';
import { reportFileStore } from './reports/report-file-store.js';

// MM-V2-C09: reading report versions and the caller's allowed lifecycle commands. Shared by the
// field-report detail (C04) and the lifecycle commands, so both show the same server state.

type Db = Pool | PoolClient;

/** The review and issue scope of a field report (MISC-08 / AO03 scope codes). */
export const FIELD_REPORT_SCOPE = 'concrete_field';

/**
 * The column a version, transition or exception note names its report by (MM-V2-C39: field or
 * strength report, exactly one per row).
 */
export type ReportColumn = 'field_report_id' | 'strength_report_id';

export interface VersionRow {
  id: string;
  field_report_id: string | null;
  strength_report_id: string | null;
  version_no: number;
  revision_of_version_id: string | null;
  snapshot_sha256: string;
  report_row_version: number;
  state: ConcreteReportVersionState;
  submitted_by_user_id: string;
  submitted_staff_user_id: string;
  submitted_at: Date;
  route_kind: ConcreteReportRouteKind;
  routed_to_user_id: string | null;
  route_reason: ConcreteReportRouteReason | null;
  reviewed_by_user_id: string | null;
  reviewed_at: Date | null;
  review_source: 'lead_project_engineer' | 'designated_reviewer' | null;
  review_cleared_at: Date | null;
  closed_by_user_id: string | null;
  closed_at: Date | null;
  close_comment: string | null;
  issued_by_user_id: string | null;
  issued_at: Date | null;
  issue_source: 'lead_project_engineer' | 'report_issuer' | null;
  /** MM-V2-C28: the issuer's choices (null before issue). */
  issue_include_photos: boolean | null;
  issue_include_machine_info: boolean | null;
  /** MM-V2-C32: set at issue (null before, and on versions issued before C32). */
  report_number_id: string | null;
  /** MM-V2-C32: attached by versionsOf (the number's text and the stored file). */
  report_number?: string | null;
  file?: ConcreteReportFile | null;
}

const VERSION_COLUMNS = `id, field_report_id, strength_report_id, version_no, revision_of_version_id, snapshot_sha256,
  report_row_version, state, submitted_by_user_id, submitted_staff_user_id, submitted_at,
  route_kind, routed_to_user_id, route_reason, reviewed_by_user_id, reviewed_at, review_source,
  review_cleared_at, closed_by_user_id, closed_at, close_comment, issued_by_user_id, issued_at,
  issue_source, issue_include_photos, issue_include_machine_info, report_number_id`;

export async function versionsOf(
  db: Db,
  reportId: string,
  column: ReportColumn = 'field_report_id',
): Promise<VersionRow[]> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM concrete_report_version
     WHERE ${column} = $1 ORDER BY version_no`,
    [reportId],
  );
  // MM-V2-C32: the report number and the file stored at issue, for the issued versions.
  const issued = rows.filter((row) => row.report_number_id !== null);
  if (issued.length > 0) {
    const { rows: files } = await db.query<{ id: string; report_version_id: string }>(
      `SELECT id, report_version_id FROM concrete_report_file
       WHERE report_version_id = ANY($1::uuid[])`,
      [issued.map((row) => row.id)],
    );
    const records = await reportFileStore.records(
      db,
      files.map((f) => f.id),
    );
    for (const row of issued) {
      const fileId = files.find((f) => f.report_version_id === row.id)?.id;
      row.file = fileId ? (records.get(fileId) ?? null) : null;
      row.report_number = row.file?.reportNumber ?? null;
    }
  }
  return rows;
}

/** The latest version, locked FOR UPDATE inside a command (after the report row, D09). */
export async function latestVersion(
  db: Db,
  reportId: string,
  lock: '' | 'FOR UPDATE' = '',
  column: ReportColumn = 'field_report_id',
): Promise<VersionRow | null> {
  const { rows } = await db.query<VersionRow>(
    `SELECT ${VERSION_COLUMNS} FROM concrete_report_version
     WHERE ${column} = $1 ORDER BY version_no DESC LIMIT 1 ${lock}`,
    [reportId],
  );
  return rows[0] ?? null;
}

export async function peopleOf(
  db: Db,
  ids: (string | null)[],
): Promise<Map<string, PersonSnapshot>> {
  const unique = [...new Set(ids.filter((id): id is string => id !== null))];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query<{
    id: string;
    display_name: string;
    official_initials: string | null;
  }>('SELECT id, display_name, official_initials FROM app_user WHERE id = ANY($1::uuid[])', [
    unique,
  ]);
  return new Map(
    rows.map((row) => [
      row.id,
      { userId: row.id, initials: row.official_initials, name: row.display_name },
    ]),
  );
}

export function versionPeople(rows: VersionRow[]): (string | null)[] {
  return rows.flatMap((v) => [
    v.submitted_by_user_id,
    v.submitted_staff_user_id,
    v.routed_to_user_id,
    v.reviewed_by_user_id,
    v.closed_by_user_id,
    v.issued_by_user_id,
  ]);
}

export function versionSummary(
  row: VersionRow,
  all: VersionRow[],
  people: Map<string, PersonSnapshot>,
): ConcreteReportVersionSummary {
  const person = (id: string) => people.get(id) ?? { userId: id, initials: null, name: 'Unknown' };
  return {
    id: row.id,
    versionNo: row.version_no,
    state: row.state,
    revisionOfVersionNo: row.revision_of_version_id
      ? (all.find((v) => v.id === row.revision_of_version_id)?.version_no ?? null)
      : null,
    snapshotSha256: row.snapshot_sha256,
    submittedAt: row.submitted_at.toISOString(),
    submittedBy: person(row.submitted_by_user_id),
    submittedStaff: person(row.submitted_staff_user_id),
    route: {
      kind: row.route_kind,
      routedTo: row.routed_to_user_id ? person(row.routed_to_user_id) : null,
      reason: row.route_reason,
    },
    review:
      row.reviewed_at && row.reviewed_by_user_id && row.review_source
        ? {
            reviewedBy: person(row.reviewed_by_user_id),
            reviewedAt: row.reviewed_at.toISOString(),
            source: row.review_source,
            counted: row.review_cleared_at === null,
            clearedAt: row.review_cleared_at?.toISOString() ?? null,
          }
        : null,
    closed:
      row.closed_at &&
      row.closed_by_user_id &&
      (row.state === 'recalled' || row.state === 'returned')
        ? {
            kind: row.state,
            by: person(row.closed_by_user_id),
            at: row.closed_at.toISOString(),
            comment: row.close_comment,
          }
        : null,
    issued:
      row.issued_at && row.issued_by_user_id && row.issue_source
        ? {
            by: person(row.issued_by_user_id),
            at: row.issued_at.toISOString(),
            source: row.issue_source,
            includePhotos: row.issue_include_photos,
            includeMachineInfo: row.issue_include_machine_info,
            reportNumber: row.report_number ?? null,
            file: row.file ?? null,
          }
        : null,
  };
}

export async function transitionsOf(
  db: Db,
  reportId: string,
  versions: VersionRow[],
  column: ReportColumn = 'field_report_id',
): Promise<ConcreteReportTransition[]> {
  const { rows } = await db.query<{
    id: string;
    version_id: string;
    action: ConcreteReportAction;
    from_state: string;
    to_state: string;
    actor_user_id: string;
    staff_user_id: string | null;
    comment: string | null;
    route_kind: ConcreteReportRouteKind | null;
    routed_to_user_id: string | null;
    created_at: Date;
  }>(
    `SELECT id, version_id, action, from_state, to_state, actor_user_id, staff_user_id, comment,
            route_kind, routed_to_user_id, created_at
     FROM concrete_report_transition WHERE ${column} = $1 ORDER BY created_at, id`,
    [reportId],
  );
  const people = await peopleOf(
    db,
    rows.flatMap((r) => [r.actor_user_id, r.staff_user_id, r.routed_to_user_id]),
  );
  const person = (id: string) => people.get(id) ?? { userId: id, initials: null, name: 'Unknown' };
  return rows.map((r) => ({
    id: r.id,
    versionNo: versions.find((v) => v.id === r.version_id)?.version_no ?? 0,
    action: r.action,
    fromState: r.from_state,
    toState: r.to_state,
    actor: person(r.actor_user_id),
    staff: r.staff_user_id ? person(r.staff_user_id) : null,
    comment: r.comment,
    routeKind: r.route_kind,
    routedTo: r.routed_to_user_id ? person(r.routed_to_user_id) : null,
    at: r.created_at.toISOString(),
  }));
}

/** The report facts a lifecycle permission needs. */
export interface LifecycleFacts {
  id: string;
  project_id: string;
  lead_project_engineer_user_id: string | null;
  technician_user_id: string | null;
  workflow_state: ConcreteWorkflowState;
}

/**
 * The project context for one field report's lifecycle checks: its lead, the designated
 * reviewers and issuers for the field scope (read live), and the report's technician (C10).
 */
export async function lifecycleContext(db: Db, report: LifecycleFacts): Promise<ProjectContext> {
  const context = await projectContext(
    db,
    {
      id: report.project_id,
      lead_project_engineer_user_id: report.lead_project_engineer_user_id,
      project_number: '',
    },
    FIELD_REPORT_SCOPE,
    FIELD_REPORT_SCOPE,
  );
  return { ...context, recordTechnicianUserId: report.technician_user_id };
}

/**
 * Review fix (#134): `lifecycleContext` for a final check, with the field-scope issuer grants,
 * reviewer assignments and approvals locked FOR SHARE first, so a revocation commits wholly
 * before or after the command. Pass it to `canUnderLock` as the `context` loader (after the
 * project and account locks).
 */
export async function lockedLifecycleContext(
  client: PoolClient,
  report: LifecycleFacts,
): Promise<ProjectContext> {
  await lockProjectGrants(client, report.project_id, {
    reportScope: FIELD_REPORT_SCOPE,
    reviewScope: FIELD_REPORT_SCOPE,
  });
  return lifecycleContext(client, report);
}

/** A context loader for `canUnderLock` that also keeps the full context it read. */
export function grantLoader(load: (client: PoolClient) => Promise<ProjectContext>) {
  const held: { context: ProjectContext | null } = { context: null };
  const loader = async (client: PoolClient) => {
    held.context = await load(client);
    const { leadProjectEngineerUserId: _lead, ...facts } = held.context;
    void _lead;
    return facts;
  };
  return { loader, held };
}

/**
 * The permission each lifecycle command needs. Revise (owner decision 2026-11-08): the lead or a
 * designated concrete_field reviewer (`concrete.review`), or the person who issued the version
 * being corrected (`issuedByUserId`, below); an issuer grant alone is not enough.
 */
export const ACTION_PERMISSIONS: Record<ConcreteReportAction, Permission[]> = {
  submit: ['concrete_report.draft'],
  resubmit: ['concrete_report.draft'],
  recall: ['concrete_report.recall'],
  return: ['concrete.review'],
  review: ['concrete.review'],
  issue: ['report.issue'],
  revise: ['concrete.review'],
};

/** Who issued the latest issued version (revise: the issuer of record may correct it). */
export function issuedByOf(latest: VersionRow | null): string | null {
  return latest?.state === 'issued' ? latest.issued_by_user_id : null;
}

export function holdsActionPermission(
  user: AuthUser,
  action: ConcreteReportAction,
  context: ProjectContext,
  issuedByUserId: string | null = null,
): boolean {
  if (ACTION_PERMISSIONS[action].some((permission) => can(user, permission, context))) return true;
  return (
    action === 'revise' &&
    issuedByUserId !== null &&
    issuedByUserId === user.userId &&
    user.status === 'active' &&
    user.accountType !== 'shared_lab'
  );
}

/**
 * Owner decision 2026-11-08: nobody reviews or issues a report they are the technician of, even
 * as a designated reviewer or the project's lead.
 */
export function isSelfReview(
  user: AuthUser,
  action: ConcreteReportAction,
  report: Pick<LifecycleFacts, 'technician_user_id'>,
): boolean {
  return (
    (action === 'review' || action === 'issue') &&
    report.technician_user_id !== null &&
    report.technician_user_id === user.userId
  );
}

/**
 * Whether `user` may send `action` now, judged on permission, state, own-report and routing. The
 * command checks all of it again under the locks.
 */
export function actionAllowed(
  user: AuthUser,
  action: ConcreteReportAction,
  report: LifecycleFacts,
  latest: VersionRow | null,
  context: ProjectContext,
): boolean {
  const state = concreteReportLifecycleState(report.workflow_state, latest?.state ?? null);
  if (concreteReportNextState(state, action) === null) return false;
  if (!holdsActionPermission(user, action, context, issuedByOf(latest))) return false;
  if (isSelfReview(user, action, report)) return false;
  if (action === 'submit' || action === 'resubmit') {
    // A personal account submits only its own report; LAB for the report's technician.
    return (
      report.technician_user_id !== null &&
      (user.accountType === 'shared_lab' || report.technician_user_id === user.userId)
    );
  }
  if ((action === 'review' || action === 'return') && latest) {
    return concreteReportMayReviewRouted(
      { kind: latest.route_kind, routedToUserId: latest.routed_to_user_id },
      user.userId,
      report.lead_project_engineer_user_id,
    );
  }
  return true;
}

export async function reportLifecycle(
  db: Db,
  report: LifecycleFacts & {
    issue_count: number;
    last_issued_version: number | null;
    lab_manager_corrected_by_user_id: string | null;
  },
  user: AuthUser,
): Promise<ConcreteReportLifecycle> {
  const versions = await versionsOf(db, report.id);
  const latest = versions.at(-1) ?? null;
  const people = await peopleOf(db, versionPeople(latest ? [latest] : []));
  const context = await lifecycleContext(db, report);
  const state = concreteReportLifecycleState(report.workflow_state, latest?.state ?? null);
  return {
    state,
    // "Revised": issued before, and now either a correction is under way or a revision was issued.
    revised: report.issue_count > 1 || (report.issue_count > 0 && state !== 'issued'),
    latestVersion: latest ? versionSummary(latest, versions, people) : null,
    latestIssuedVersionNo: report.last_issued_version,
    reviewCounted:
      latest !== null &&
      (latest.state === 'reviewed' || latest.state === 'issued') &&
      latest.review_cleared_at === null,
    labManagerCorrection: report.lab_manager_corrected_by_user_id !== null,
    allowedActions: CONCRETE_REPORT_ACTIONS.filter((action) =>
      actionAllowed(user, action, report, latest, context),
    ),
  };
}
