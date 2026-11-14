import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  RETENTION_BAND_DAYS,
  RETENTION_PIPELINE_PAGE_SIZE,
  RETENTION_TESTED_LIMIT,
  type DisposalBlocker,
  type RetentionBand,
  type RetentionDecision,
  type RetentionDecisionResult,
  type RetentionDecisionUnits,
  type RetentionDecisionUnitsQuery,
  type RetentionPipeline,
  type RetentionPipelineCounts,
  type RetentionPipelineQuery,
  type RetentionPipelineUnit,
  type RetentionTab,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { disposalStanding, DisposalService } from '../disposal/disposal.service.js';
import { BusinessClock } from './business-clock.js';
import { earlierThanEffective, RetentionService, type Kind } from './retention.service.js';

type Db = Pool | PoolClient;
type Failure = RetentionDecisionResult['failed'][number];

/**
 * THE eligibility rule (STRATA-110, Kyle 2026-11-13: "show in both"). The Eligible tab, its count
 * and the "Eligible" tag on Overdue rows all use this one expression ($1 = today): in stock, not a
 * tested unit, retain-until reached, and the database's standard eligibility (no hold, covering
 * programs closed, no open location conflict). A unit already on the disposal list has moved on to
 * the next tab (the tab predicates below leave it out).
 */
const ELIGIBLE = `(su.status = 'in_stock' AND NOT ur.retention_exempt
  AND ur.effective_retain_until <= $1::date
  AND coalesce(unit_disposal_eligible(su.id, $1::date), false))`;

/** Units, their retention, project, place and live disposal-list entry. */
const BASE_FROM = `FROM storage_unit su
  JOIN unit_retention ur ON ur.storage_unit_id = su.id
  JOIN project p ON p.id = su.project_id
  JOIN location l ON l.id = su.current_location_id
  LEFT JOIN disposal_list_entry e ON e.storage_unit_id = su.id AND e.ended_at IS NULL
                                 AND e.project_id = su.project_id`;

const COMING_WINDOW = `$1::date + ${RETENTION_BAND_DAYS.later}`;

/** Which stage of the pipeline each tab holds ($1 = today). */
const TAB_WHERE: Record<RetentionTab | 'tested', string> = {
  coming: `su.status = 'in_stock' AND NOT ur.retention_exempt AND e.id IS NULL
           AND ur.effective_retain_until <= ${COMING_WINDOW}`,
  eligible: `e.id IS NULL AND ${ELIGIBLE}`,
  list: `su.status = 'in_stock' AND e.id IS NOT NULL`,
  approved: `su.status = 'approved_for_disposal'`,
  disposed: `su.status = 'disposed'`,
  tested: `su.status = 'in_stock' AND ur.retention_exempt`,
};

const BAND_EXPR = `CASE WHEN ur.effective_retain_until <= $1::date THEN 'overdue'
  WHEN ur.effective_retain_until <= $1::date + ${RETENTION_BAND_DAYS.month} THEN 'month'
  WHEN ur.effective_retain_until <= ${COMING_WINDOW} THEN 'later' END`;

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (c) => `\\${c}`);
}

function keyFor(key: string, projectId: string): string {
  const hex = createHash('sha256').update(`${key}:${projectId}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface DetailRow {
  id: string;
  readable_id: string;
  unit_type: string;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  version: number;
  project_id: string;
  project_number: string;
  project_name: string;
  lead_id: string | null;
  lead_initials: string | null;
  lead_name: string | null;
  holes: string[];
  location_code: string;
  location_name: string;
  received_date: string;
  minimum_retain_until: string;
  effective_retain_until: string;
  band: RetentionBand | null;
  retention_exempt: boolean;
  extension_count: number;
  hold_count: number;
  hold_until: string | null;
  hold_reason: string | null;
  request_waiting: boolean;
  eligible: boolean;
  program_open: boolean;
  entry_id: string | null;
  entry_by_id: string | null;
  entry_by_initials: string | null;
  entry_by_name: string | null;
  entry_at: Date | null;
  entry_reason: string | null;
  approval_id: string | null;
  approval_batch_id: string | null;
  approval_project_id: string | null;
  approval_by_id: string | null;
  approval_by_initials: string | null;
  approval_by_name: string | null;
  approval_at: Date | null;
  approval_retain_until: string | null;
  disposed_at: Date | null;
  disposed_by_id: string | null;
  disposed_by_initials: string | null;
  disposed_by_name: string | null;
  tested_removal: boolean;
}

/** One row per unit in `ids` ($1 = today, $2 = ids), with everything the page and drawer show. */
const DETAIL_SQL = `
  SELECT su.id, su.readable_id, su.unit_type, su.status, su.version,
         p.id AS project_id, p.project_number, p.name AS project_name,
         p.lead_project_engineer_user_id AS lead_id, lead.official_initials AS lead_initials,
         lead.display_name AS lead_name,
         ARRAY(SELECT DISTINCT th.name FROM test_hole th
               WHERE th.id IN (SELECT h.test_hole_id FROM storage_unit_hole_summary h
                               WHERE h.storage_unit_id = su.id
                               UNION SELECT su.source_test_hole_id
                               UNION SELECT g.test_hole_id FROM bulk_group g
                                     WHERE g.id = su.bulk_group_id)
               ORDER BY th.name) AS holes,
         l.code AS location_code, l.name AS location_name,
         su.received_date::text, ur.minimum_retain_until::text,
         ur.effective_retain_until::text,
         CASE WHEN su.status = 'in_stock' AND NOT ur.retention_exempt THEN ${BAND_EXPR} END AS band,
         ur.retention_exempt, ur.active_extension_count AS extension_count,
         hold.n AS hold_count, hold.until AS hold_until, hold.reason AS hold_reason,
         EXISTS (SELECT 1 FROM retention_request r
                 WHERE r.status = 'open' AND r.project_id = su.project_id
                   AND (r.scope = 'project' OR EXISTS (
                     SELECT 1 FROM retention_request_unit ru
                     WHERE ru.request_id = r.id AND ru.storage_unit_id = su.id))) AS request_waiting,
         ${ELIGIBLE} AS eligible,
         (su.status <> 'disposed'
          AND EXISTS (SELECT 1 FROM unit_open_covering_programs(su.id))) AS program_open,
         e.id AS entry_id, e.added_by_user_id AS entry_by_id,
         e.added_by_initials_snapshot AS entry_by_initials,
         e.added_by_name_snapshot AS entry_by_name, e.added_at AS entry_at,
         e.reason AS entry_reason,
         a.id AS approval_id, a.batch_id AS approval_batch_id, a.project_id AS approval_project_id,
         a.approved_by_user_id AS approval_by_id,
         a.approved_by_initials_snapshot AS approval_by_initials,
         a.approved_by_name_snapshot AS approval_by_name, a.approved_at AS approval_at,
         a.effective_retain_until::text AS approval_retain_until,
         coalesce(r.removed_at, t.removed_at, su.disposed_at) AS disposed_at,
         coalesce(r.removed_by_user_id, t.removed_by_user_id) AS disposed_by_id,
         coalesce(r.removed_by_initials_snapshot, t.removed_by_initials_snapshot)
           AS disposed_by_initials,
         coalesce(r.removed_by_name_snapshot, t.removed_by_name_snapshot) AS disposed_by_name,
         (t.id IS NOT NULL) AS tested_removal
  ${BASE_FROM}
  LEFT JOIN app_user lead ON lead.id = p.lead_project_engineer_user_id
  LEFT JOIN LATERAL (
    SELECT count(*)::int AS n,
           CASE WHEN bool_or(h.hold_until IS NULL) THEN NULL ELSE max(h.hold_until)::text END
             AS until,
           (array_agg(h.reason ORDER BY h.placed_at DESC))[1] AS reason
    FROM unit_retention_hold x JOIN retention_hold h ON h.id = x.hold_id
    WHERE x.storage_unit_id = su.id) hold ON true
  LEFT JOIN disposal_approval a ON a.storage_unit_id = su.id AND a.revoked_at IS NULL
  LEFT JOIN disposal_removal r ON r.storage_unit_id = su.id
  LEFT JOIN tested_unit_removal t ON t.storage_unit_id = su.id
  WHERE su.id = ANY($2::uuid[])`;

const person = (id: string | null, initials: string | null, name: string | null) =>
  id ? { userId: id, initials, name: name ?? '' } : null;

/**
 * The Retention page's pipeline (STRATA-90) and the decision drawer's reads and decisions
 * (STRATA-91). Every band, count, eligibility and permission is decided here; decisions recheck
 * everything under lock: holds and extensions by the project's Lead Project Engineer or a Lab
 * Manager (`retention.manage`), the disposal list by the same people (`disposal.approve`). Others
 * send a retention request instead (`POST /api/retention/requests`).
 */
@Injectable()
export class RetentionPipelineService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
    private readonly retention: RetentionService,
    private readonly disposal: DisposalService,
  ) {}

  async pipeline(user: AuthUser, query: RetentionPipelineQuery): Promise<RetentionPipeline> {
    const today = this.clock.today();
    const pool = this.database.pool;
    const params: unknown[] = [today];
    const param = (value: unknown) => {
      params.push(value);
      return `$${params.length}`;
    };
    const where: string[] = [];
    if (query.search) {
      const like = param(`%${escapeLike(query.search)}%`);
      where.push(
        `(su.readable_id ILIKE ${like} OR p.project_number ILIKE ${like}
          OR p.name ILIKE ${like} OR l.code ILIKE ${like})`,
      );
    }
    if (query.projectId) where.push(`su.project_id = ${param(query.projectId)}`);
    const filters = new Set(query.filter);
    if (filters.has('mine')) where.push(`p.lead_project_engineer_user_id = ${param(user.userId)}`);
    if (filters.has('hold')) where.push('ur.active_hold_count > 0');
    if (filters.has('extension')) where.push('ur.active_extension_count > 0');
    const bands = (['overdue', 'month', 'later'] as const).filter((b) => filters.has(b));
    const bandWhere =
      bands.length > 0 ? `(${BAND_EXPR}) IN (${bands.map((b) => `'${b}'`).join(', ')})` : null;
    // Bands narrow the date-ordered tabs only (Coming up and Eligible).
    const filtered = (
      tab: RetentionTab | 'tested',
      withBands = tab === 'coming' || tab === 'eligible',
    ) =>
      [
        // Every query binds today ($1), whether or not its tab compares dates.
        '$1::date IS NOT NULL',
        TAB_WHERE[tab],
        ...where,
        ...(withBands && bandWhere ? [bandWhere] : []),
      ]
        .map((w) => `(${w})`)
        .join(' AND ');

    const dir = query.dir === 'desc' ? 'DESC' : 'ASC';
    const byId = `su.readable_id COLLATE "C" ${query.sort === 'id' ? dir : 'ASC'}, su.id`;
    const sortKey =
      query.sort === 'project'
        ? `p.project_number COLLATE "C" ${dir}, ${byId}`
        : query.sort === 'id'
          ? byId
          : query.tab === 'disposed'
            ? `su.disposed_at ${query.dir === 'asc' ? 'DESC' : 'ASC'} NULLS LAST, ${byId}`
            : `ur.effective_retain_until ${dir}, ${byId}`;
    const order =
      query.tab === 'coming'
        ? `CASE ${BAND_EXPR} WHEN 'overdue' THEN 0 WHEN 'month' THEN 1 ELSE 2 END, ${sortKey}`
        : query.tab === 'list' || query.tab === 'approved'
          ? `p.project_number COLLATE "C", p.id, ${sortKey}`
          : sortKey;

    const pageSize = RETENTION_PIPELINE_PAGE_SIZE;
    const limit = param(pageSize);
    const offset = param((query.page - 1) * pageSize);
    const filterParams = params.slice(0, params.length - 2);

    const [page, counts, bandCounts, tested] = await Promise.all([
      pool.query<{ id: string; total: number }>(
        `SELECT su.id, count(*) OVER ()::int AS total ${BASE_FROM}
         WHERE ${filtered(query.tab)} ORDER BY ${order} LIMIT ${limit} OFFSET ${offset}`,
        params,
      ),
      this.counts(pool, today),
      query.tab === 'coming'
        ? pool.query<{ band: RetentionBand; n: number }>(
            `SELECT ${BAND_EXPR} AS band, count(*)::int AS n ${BASE_FROM}
             WHERE ${filtered('coming')} GROUP BY 1`,
            filterParams,
          )
        : Promise.resolve({ rows: [] as { band: RetentionBand; n: number }[] }),
      query.tab === 'coming'
        ? pool.query<{ id: string }>(
            `SELECT su.id ${BASE_FROM} WHERE ${filtered('tested', false)}
             ORDER BY su.readable_id COLLATE "C", su.id LIMIT ${RETENTION_TESTED_LIMIT}`,
            filterParams,
          )
        : Promise.resolve({ rows: [] as { id: string }[] }),
    ]);
    let total = page.rows[0]?.total;
    if (total === undefined) {
      total =
        query.page > 1
          ? (
              await pool.query<{ n: number }>(
                `SELECT count(*)::int AS n ${BASE_FROM} WHERE ${filtered(query.tab)}`,
                filterParams,
              )
            ).rows[0]!.n
          : 0;
    }
    const ids = page.rows.map((r) => r.id);
    const [rows, testedRows] = await Promise.all([
      this.details(pool, user, ids, today, query.tab),
      this.details(
        pool,
        user,
        tested.rows.map((r) => r.id),
        today,
        null,
      ),
    ]);
    const band = (key: RetentionBand) => bandCounts.rows.find((r) => r.band === key)?.n ?? 0;
    return {
      asOf: today,
      tab: query.tab,
      counts,
      bandCounts: { overdue: band('overdue'), month: band('month'), later: band('later') },
      rows,
      total,
      page: query.page,
      pageSize,
      tested: testedRows,
      canRequest: can(user, 'retention.request'),
    };
  }

  /** Every tab's count, unfiltered: what is in each stage now. */
  private async counts(db: Db, today: string): Promise<RetentionPipelineCounts> {
    const { rows } = await db.query<RetentionPipelineCounts>(
      `SELECT count(*) FILTER (WHERE ${TAB_WHERE.coming})::int AS coming,
              count(*) FILTER (WHERE ${TAB_WHERE.list})::int AS list,
              count(*) FILTER (WHERE ${TAB_WHERE.approved})::int AS approved,
              count(*) FILTER (WHERE ${TAB_WHERE.disposed})::int AS disposed,
              count(*) FILTER (WHERE ${TAB_WHERE.tested})::int AS tested,
              -- Only units whose retain-until is reached can be eligible: cheap pre-filter.
              count(*) FILTER (WHERE su.status = 'in_stock'
                                 AND ur.effective_retain_until <= $1::date
                                 AND ${TAB_WHERE.eligible})::int AS eligible
       ${BASE_FROM}`,
      [today],
    );
    return rows[0]!;
  }

  /** Rows for `ids` in that order; list and approved rows carry their blockers. */
  private async details(
    db: Db,
    user: AuthUser,
    ids: string[],
    today: string,
    tab: RetentionTab | null,
  ): Promise<RetentionPipelineUnit[]> {
    if (ids.length === 0) return [];
    const { rows } = await db.query<DetailRow>(DETAIL_SQL, [today, ids]);
    const byId = new Map(rows.map((r) => [r.id, r]));
    const blockers =
      tab === 'list' || tab === 'approved'
        ? await disposalStanding(db, ids, today, tab === 'approved')
        : new Map<string, { blockers: DisposalBlocker[] }>();
    return ids.flatMap((id) => {
      const row = byId.get(id);
      if (!row) return [];
      let shown = blockers.get(id)?.blockers ?? [];
      if (tab === 'approved') shown = shown.filter((b) => b.code !== 'not_in_stock');
      if (row.approval_project_id && row.approval_project_id !== row.project_id) {
        shown = [
          {
            code: 'approval_project_changed',
            label: 'Approved under another project: revoke it and approve again',
          },
          ...shown,
        ];
      }
      return [toUnit(user, row, shown)];
    });
  }

  /** STRATA-91: the drawer's units (explicit IDs from any page, or a whole project). */
  async decisionUnits(
    user: AuthUser,
    query: RetentionDecisionUnitsQuery,
  ): Promise<RetentionDecisionUnits> {
    const today = this.clock.today();
    const pool = this.database.pool;
    let ids: string[];
    if (query.projectId) {
      const { rows: project } = await pool.query('SELECT 1 FROM project WHERE id = $1', [
        query.projectId,
      ]);
      if (project.length === 0) throw new NotFoundException({ code: 'project_not_found' });
      const { rows } = await pool.query<{ id: string }>(
        `SELECT id FROM storage_unit WHERE project_id = $1 AND status <> 'disposed'
         ORDER BY readable_id COLLATE "C", id LIMIT 500`,
        [query.projectId],
      );
      ids = rows.map((r) => r.id);
    } else {
      ids = [...new Set(query.ids ?? [])];
    }
    const [units, standing] = await Promise.all([
      this.details(pool, user, ids, today, null),
      this.disposal.listStanding(pool, ids, today),
    ]);
    if (!query.projectId && units.length !== ids.length) {
      throw new NotFoundException({ code: 'storage_unit_not_found' });
    }
    return {
      asOf: today,
      projectId: query.projectId ?? null,
      canRequest: can(user, 'retention.request'),
      units: units.map((unit) => ({
        ...unit,
        listBlockers: standing.get(unit.storageUnitId)?.blockers ?? [],
      })),
    };
  }

  /**
   * STRATA-91: one decision for the ticked units, or (extend, hold) a whole project. Refused (403,
   * nothing changes) unless the person may decide for every project involved, rechecked under
   * lock. Each unit is rechecked and may fail on its own (changed, disposed, too early, not
   * eligible); the rest go ahead. Retrying with the same key repeats nothing.
   */
  async decide(user: AuthUser, body: RetentionDecision): Promise<RetentionDecisionResult> {
    if (user.accountType === 'shared_lab') throw new ForbiddenException({ code: 'forbidden' });
    if (body.action === 'dispose') return this.dispose(user, body);
    const kind: Kind = body.action === 'extend' ? 'extension' : 'hold';
    if (body.projectId) return this.decideProject(user, kind, body, body.projectId);
    return withTransaction(this.database.pool, async (client) => {
      const wanted = new Map((body.units ?? []).map((u) => [u.id, u.version]));
      const { rows: found } = await client.query<{ id: string; project_id: string }>(
        'SELECT id, project_id FROM storage_unit WHERE id = ANY($1::uuid[])',
        [[...wanted.keys()]],
      );
      const failed: Failure[] = [...wanted.keys()]
        .filter((id) => !found.some((f) => f.id === id))
        .map((id) => ({
          storageUnitId: id,
          readableId: null,
          code: 'not_found',
          message: 'Not found',
        }));
      const projects = [...new Set(found.map((f) => f.project_id))].sort();
      // D09: every project first (in id order, the lock a direct hold or extension takes), with
      // the person's authority as it stands now. One refusal refuses everything.
      for (const projectId of projects) {
        if (
          !(await canUnderLock(client, user, 'retention.manage', projectId, {
            lock: 'FOR NO KEY UPDATE',
          }))
        ) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
      }
      const done: RetentionDecisionResult['done'] = [];
      const created: RetentionDecisionResult['created'] = [];
      for (const projectId of projects) {
        const key = keyFor(body.idempotencyKey, projectId);
        const t = kind === 'hold' ? 'retention_hold' : 'retention_extension';
        const by = kind === 'hold' ? 'placed_by_user_id' : 'set_by_user_id';
        const { rows: previous } = await client.query<{ id: string; by: string }>(
          `SELECT id, ${by} AS by FROM ${t} WHERE idempotency_key = $1`,
          [key],
        );
        const { rows: units } = await client.query<{
          id: string;
          readable_id: string;
          status: string;
          version: number;
          project_id: string;
        }>(
          `SELECT id, readable_id, status, version, project_id FROM storage_unit
           WHERE id = ANY($1::uuid[]) ORDER BY id FOR SHARE`,
          [found.filter((f) => f.project_id === projectId).map((f) => f.id)],
        );
        if (previous[0]) {
          if (previous[0].by !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          done.push(...units.map((u) => ({ storageUnitId: u.id, readableId: u.readable_id })));
          created.push({ id: previous[0].id, projectId });
          continue;
        }
        const ok: typeof units = [];
        for (const unit of units) {
          const fail = (code: Failure['code'], message: string) =>
            failed.push({ storageUnitId: unit.id, readableId: unit.readable_id, code, message });
          if (unit.project_id !== projectId) fail('changed', 'It moved to another project.');
          else if (unit.status === 'disposed') fail('disposed', 'Already disposed');
          else if (unit.version !== wanted.get(unit.id)) {
            fail('changed', 'It changed after you opened it. Check it and try again.');
          } else ok.push(unit);
        }
        let go = ok;
        if (kind === 'extension' && ok.length > 0) {
          const early = await earlierThanEffective(
            client,
            {
              projectId,
              scope: 'units',
              retainUntil: body.retainUntil,
              extendMonths: body.extendMonths,
            },
            ok.map((u) => u.id),
          );
          for (const unit of early) {
            failed.push({
              storageUnitId: unit.id,
              readableId: unit.readable_id,
              code: 'retain_until_too_early',
              message: `Its retain-until is already ${unit.effective_retain_until}; an extension can only make it later.`,
            });
          }
          go = ok.filter((u) => !early.some((e) => e.id === u.id));
        }
        if (go.length === 0) continue;
        const result = await this.retention.insertDecision(
          client,
          user,
          kind,
          {
            projectId,
            scope: 'units',
            unitIds: go.map((u) => u.id),
            retainUntil: body.retainUntil,
            extendMonths: body.extendMonths,
            holdUntil: body.holdUntil,
            reason: body.reason,
          },
          {
            idempotencyKey: key,
            hash: createHash('sha256').update(JSON.stringify({ body, projectId })).digest('hex'),
            requestId: null,
          },
        );
        created.push({ id: result.id, projectId });
        done.push(...go.map((u) => ({ storageUnitId: u.id, readableId: u.readable_id })));
      }
      return { action: body.action, done, created, failed };
    });
  }

  /** Whole project: one project-scope hold or extension (STRATA-91, same drawer semantics). */
  private async decideProject(
    user: AuthUser,
    kind: Kind,
    body: RetentionDecision,
    projectId: string,
  ): Promise<RetentionDecisionResult> {
    try {
      const result =
        kind === 'hold'
          ? await this.retention.placeHold(user, {
              projectId,
              scope: 'project',
              holdUntil: body.holdUntil,
              reason: body.reason,
              idempotencyKey: body.idempotencyKey,
            })
          : await this.retention.setExtension(user, {
              projectId,
              scope: 'project',
              retainUntil: body.retainUntil,
              extendMonths: body.extendMonths,
              reason: body.reason,
              idempotencyKey: body.idempotencyKey,
            });
      return { action: body.action, done: [], created: [{ id: result.id, projectId }], failed: [] };
    } catch (error) {
      const response =
        error instanceof UnprocessableEntityException
          ? (error.getResponse() as {
              code?: string;
              units?: { storageUnitId: string; readableId: string; effectiveRetainUntil: string }[];
            })
          : null;
      if (response?.code !== 'retain_until_too_early') throw error;
      return {
        action: body.action,
        done: [],
        created: [],
        failed: (response.units ?? []).map((u) => ({
          storageUnitId: u.storageUnitId,
          readableId: u.readableId,
          code: 'retain_until_too_early',
          message: `Its retain-until is already ${u.effectiveRetainUntil}; an extension can only make it later.`,
        })),
      };
    }
  }

  /** Add to disposal list: projects FOR SHARE, then units FOR UPDATE (the approval order). */
  private dispose(user: AuthUser, body: RetentionDecision): Promise<RetentionDecisionResult> {
    const units = [...new Map((body.units ?? []).map((u) => [u.id, u])).values()].sort((a, b) =>
      a.id.localeCompare(b.id),
    );
    return withTransaction(this.database.pool, async (client) => {
      const ids = units.map((u) => u.id);
      const { rows: projects } = await client.query<{ id: string }>(
        `SELECT p.id FROM project p
         WHERE p.id IN (SELECT su.project_id FROM storage_unit su WHERE su.id = ANY($1::uuid[]))
         ORDER BY p.id`,
        [ids],
      );
      for (const { id } of projects) {
        if (!(await canUnderLock(client, user, 'disposal.approve', id))) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
      }
      await client.query(
        'SELECT id FROM storage_unit WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
        [ids],
      );
      const result = await this.disposal.addToList(
        client,
        user,
        units,
        body.reason,
        body.idempotencyKey,
      );
      return { action: 'dispose', created: [], ...result };
    });
  }
}

function toUnit(
  user: AuthUser,
  row: DetailRow,
  blockers: DisposalBlocker[],
): RetentionPipelineUnit {
  const lead = { leadProjectEngineerUserId: row.lead_id };
  return {
    storageUnitId: row.id,
    readableId: row.readable_id,
    unitType: row.unit_type,
    status: row.status,
    version: row.version,
    project: {
      id: row.project_id,
      projectNumber: row.project_number,
      name: row.project_name,
      lead: person(row.lead_id, row.lead_initials, row.lead_name),
    },
    holes: row.holes ?? [],
    location: { code: row.location_code, name: row.location_name },
    receivedDate: row.received_date,
    minimumRetainUntil: row.minimum_retain_until,
    effectiveRetainUntil: row.effective_retain_until,
    band: row.band,
    hold:
      row.hold_count > 0
        ? { count: row.hold_count, holdUntil: row.hold_until, reason: row.hold_reason ?? '' }
        : null,
    extensionCount: row.extension_count,
    requestWaiting: row.request_waiting,
    eligible: row.eligible,
    programOpen: row.program_open,
    retentionExempt: row.retention_exempt,
    blockers,
    listEntry:
      row.entry_id && row.entry_by_id && row.entry_at
        ? {
            id: row.entry_id,
            addedBy: person(row.entry_by_id, row.entry_by_initials, row.entry_by_name)!,
            addedAt: row.entry_at.toISOString(),
            reason: row.entry_reason ?? '',
          }
        : null,
    approval:
      row.approval_id && row.approval_by_id && row.approval_at
        ? {
            id: row.approval_id,
            batchId: row.approval_batch_id!,
            approvedBy: person(row.approval_by_id, row.approval_by_initials, row.approval_by_name)!,
            approvedAt: row.approval_at.toISOString(),
            effectiveRetainUntil: row.approval_retain_until!,
          }
        : null,
    disposal:
      row.status === 'disposed'
        ? {
            disposedAt: row.disposed_at?.toISOString() ?? null,
            disposedBy: person(row.disposed_by_id, row.disposed_by_initials, row.disposed_by_name),
            route: row.tested_removal ? 'tested' : 'standard',
          }
        : null,
    canDecide: can(user, 'retention.manage', lead),
    canApprove: can(user, 'disposal.approve', lead),
  };
}
