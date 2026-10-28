import type {
  PersonSnapshot,
  RetentionExtension,
  RetentionHold,
  RetentionRequestView,
  UnitRetention,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// MM-T29 read helpers over the unit_retention view and the hold/extension/request tables. The
// view is the only place dates are computed; inventory, detail, project and MM-T30 use it.

type Db = Pool | PoolClient;

interface RetentionRow {
  storage_unit_id: string;
  received_date: string;
  minimum_retain_until: string;
  effective_retain_until: string;
  active_hold_count: number;
  retention_exempt: boolean;
  eligible_by_date: boolean;
}

/** unit_retention for `unitIds`, with "eligible by date" as of `asOf` (YYYY-MM-DD). */
export async function loadUnitRetention(
  db: Db,
  unitIds: string[],
  asOf: string,
): Promise<Map<string, UnitRetention>> {
  const map = new Map<string, UnitRetention>();
  if (unitIds.length === 0) return map;
  const { rows } = await db.query<RetentionRow>(
    `SELECT storage_unit_id, received_date::text, minimum_retain_until::text,
            effective_retain_until::text, active_hold_count, retention_exempt,
            effective_retain_until <= $2::date AS eligible_by_date
     FROM unit_retention WHERE storage_unit_id = ANY($1::uuid[])`,
    [unitIds, asOf],
  );
  for (const row of rows) {
    map.set(row.storage_unit_id, {
      receivedDate: row.received_date,
      minimumRetainUntil: row.minimum_retain_until,
      effectiveRetainUntil: row.effective_retain_until,
      onHold: row.active_hold_count > 0,
      eligibleByDate: row.eligible_by_date,
      retentionExempt: row.retention_exempt,
      asOf,
    });
  }
  return map;
}

function person(id: string | null, initials: string | null, name: string | null) {
  return id ? ({ userId: id, initials, name: name ?? '' } satisfies PersonSnapshot) : null;
}

interface DecisionRow {
  id: string;
  project_id: string;
  scope: 'project' | 'units';
  units: { id: string; readableId: string }[] | null;
  reason: string;
  by_user_id: string;
  by_initials: string | null;
  by_name: string;
  at: Date;
  request_id: string | null;
  released_at: Date | null;
  released_by_user_id: string | null;
  released_by_initials_snapshot: string | null;
  released_by_name_snapshot: string | null;
  release_reason: string | null;
  version: number;
  retain_until?: string | null;
  extend_months?: number | null;
}

const UNITS_OF = (table: string, key: string) => `
  (SELECT json_agg(json_build_object('id', su.id, 'readableId', su.readable_id)
                   ORDER BY su.readable_id)
   FROM ${table} x JOIN storage_unit su ON su.id = x.storage_unit_id WHERE x.${key} = d.id)`;

const HOLD_SELECT = `
  SELECT d.id, d.project_id, d.scope, ${UNITS_OF('retention_hold_unit', 'hold_id')} AS units,
         d.reason, d.placed_by_user_id AS by_user_id, d.placed_by_initials_snapshot AS by_initials,
         d.placed_by_name_snapshot AS by_name, d.placed_at AS at, d.request_id, d.released_at,
         d.released_by_user_id, d.released_by_initials_snapshot, d.released_by_name_snapshot,
         d.release_reason, d.version
  FROM retention_hold d`;

const EXTENSION_SELECT = `
  SELECT d.id, d.project_id, d.scope,
         ${UNITS_OF('retention_extension_unit', 'extension_id')} AS units,
         d.reason, d.set_by_user_id AS by_user_id, d.set_by_initials_snapshot AS by_initials,
         d.set_by_name_snapshot AS by_name, d.set_at AS at, d.request_id, d.released_at,
         d.released_by_user_id, d.released_by_initials_snapshot, d.released_by_name_snapshot,
         d.release_reason, d.version, d.retain_until::text AS retain_until, d.extend_months
  FROM retention_extension d`;

function common(row: DecisionRow) {
  return {
    id: row.id,
    projectId: row.project_id,
    scope: row.scope,
    units: row.units ?? [],
    reason: row.reason,
    fromRequestId: row.request_id,
    active: row.released_at === null,
    releasedBy: person(
      row.released_by_user_id,
      row.released_by_initials_snapshot,
      row.released_by_name_snapshot,
    ),
    releasedAt: row.released_at?.toISOString() ?? null,
    releaseReason: row.release_reason,
    version: row.version,
  };
}

function toHold(row: DecisionRow): RetentionHold {
  return {
    ...common(row),
    placedBy: person(row.by_user_id, row.by_initials, row.by_name)!,
    placedAt: row.at.toISOString(),
  };
}

function toExtension(row: DecisionRow): RetentionExtension {
  return {
    ...common(row),
    retainUntil: row.retain_until ?? null,
    extendMonths: row.extend_months ?? null,
    setBy: person(row.by_user_id, row.by_initials, row.by_name)!,
    setAt: row.at.toISOString(),
  };
}

/** Every hold and extension of a project (project-wide and selected-unit), newest first. */
export async function loadProjectDecisions(db: Db, projectId: string) {
  const [holds, extensions] = await Promise.all([
    db.query<DecisionRow>(
      `${HOLD_SELECT} WHERE d.project_id = $1 ORDER BY d.placed_at DESC, d.id`,
      [projectId],
    ),
    db.query<DecisionRow>(
      `${EXTENSION_SELECT} WHERE d.project_id = $1 ORDER BY d.set_at DESC, d.id`,
      [projectId],
    ),
  ]);
  return { holds: holds.rows.map(toHold), extensions: extensions.rows.map(toExtension) };
}

/**
 * Holds and extensions that cover (or covered) one unit: its project's project-wide ones and the
 * selected-unit ones naming it. Released ones stay as history.
 */
export async function loadUnitDecisions(db: Db, unitId: string, projectId: string) {
  const where = (table: string, key: string) =>
    `WHERE (d.scope = 'project' AND d.project_id = $2)
        OR EXISTS (SELECT 1 FROM ${table} x WHERE x.${key} = d.id AND x.storage_unit_id = $1)`;
  const [holds, extensions] = await Promise.all([
    db.query<DecisionRow>(
      `${HOLD_SELECT} ${where('retention_hold_unit', 'hold_id')} ORDER BY d.placed_at DESC, d.id`,
      [unitId, projectId],
    ),
    db.query<DecisionRow>(
      `${EXTENSION_SELECT} ${where('retention_extension_unit', 'extension_id')}
       ORDER BY d.set_at DESC, d.id`,
      [unitId, projectId],
    ),
  ]);
  return { holds: holds.rows.map(toHold), extensions: extensions.rows.map(toExtension) };
}

export async function loadProjectRequests(
  db: Db,
  projectId: string,
): Promise<RetentionRequestView[]> {
  const { rows } = await db.query<{
    id: string;
    kind: 'hold' | 'extension';
    scope: 'project' | 'units';
    units: { id: string; readableId: string }[] | null;
    retain_until: string | null;
    extend_months: number | null;
    reason: string;
    requested_by_user_id: string;
    requested_by_initials_snapshot: string | null;
    requested_by_name_snapshot: string;
    requested_at: Date;
    status: 'open' | 'approved' | 'declined';
    decided_by_user_id: string | null;
    decided_by_initials: string | null;
    decided_by_name_snapshot: string | null;
    decided_at: Date | null;
    decision_reason: string | null;
  }>(
    `SELECT d.id, d.kind, d.scope, ${UNITS_OF('retention_request_unit', 'request_id')} AS units,
            d.retain_until::text AS retain_until, d.extend_months, d.reason,
            d.requested_by_user_id, d.requested_by_initials_snapshot,
            d.requested_by_name_snapshot, d.requested_at, d.status, d.decided_by_user_id,
            u.official_initials AS decided_by_initials, d.decided_by_name_snapshot, d.decided_at,
            d.decision_reason
     FROM retention_request d LEFT JOIN app_user u ON u.id = d.decided_by_user_id
     WHERE d.project_id = $1 ORDER BY d.requested_at DESC, d.id`,
    [projectId],
  );
  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    units: row.units ?? [],
    retainUntil: row.retain_until,
    extendMonths: row.extend_months,
    reason: row.reason,
    requestedBy: person(
      row.requested_by_user_id,
      row.requested_by_initials_snapshot,
      row.requested_by_name_snapshot,
    )!,
    requestedAt: row.requested_at.toISOString(),
    status: row.status,
    decidedBy: person(
      row.decided_by_user_id,
      row.decided_by_initials,
      row.decided_by_name_snapshot,
    ),
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  }));
}
