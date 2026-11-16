import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DISPOSAL_PAGE_SIZE,
  DISPOSAL_READY_PAGE_SIZE,
  type ApproveDisposal,
  type ApproveDisposalResult,
  type DisposalBlocker,
  type DisposalCandidates,
  type DisposalReady,
  type RemoveFromDisposalList,
  type RemoveFromDisposalListResult,
  type RetentionDecisionResult,
  type RevokeDisposal,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { BusinessClock } from '../retention/business-clock.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db = Pool | PoolClient;

/** MM-T70: the live approval was granted under the unit's earlier project. */
const projectChanged = (): DisposalBlocker => ({
  code: 'approval_project_changed',
  label: 'Approved under another project: revoke it and approve again',
});

/**
 * MISC-13: units standard disposal can take now ($1 = today). In stock, or approved under a live
 * approval for the unit's current project (MM-T70); never a tested (retention exempt) unit.
 */
const READY_FROM = `FROM storage_unit su
       JOIN unit_retention ur ON ur.storage_unit_id = su.id
       JOIN project p ON p.id = su.project_id
       JOIN location l ON l.id = su.current_location_id
       WHERE su.status IN ('in_stock', 'approved_for_disposal')
         -- Cheap pre-filter: nothing is eligible before its one-year minimum.
         AND retention_minimum(su.received_date) <= $1::date
         AND NOT ur.retention_exempt
         AND unit_disposal_eligible(su.id, $1::date, true)
         AND (su.status = 'in_stock' OR EXISTS (
               SELECT 1 FROM disposal_approval a
               WHERE a.storage_unit_id = su.id AND a.project_id = su.project_id
                 AND a.revoked_at IS NULL AND a.used_at IS NULL))`;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export type ListFailure = RetentionDecisionResult['failed'][number];

export interface ListStanding {
  unit: Standing;
  version: number;
  listed: boolean;
  blockers: DisposalBlocker[];
}

export interface Standing {
  id: string;
  readable_id: string;
  unit_type: string;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  received_date: string;
  effective_retain_until: string;
  location_id: string;
  location_code: string;
  location_name: string;
  project_id: string;
  lead_project_engineer_user_id: string | null;
  eligible: boolean;
  open_conflict: boolean;
  retention_exempt: boolean;
}

/**
 * Standard eligibility and its reasons for `unitIds` as of `asOf`. Eligibility itself is the
 * database's (unit_disposal_eligible, on MM-T29's unit_retention); the reasons explain it.
 * `forRemoval` rechecks an approved unit (status approved_for_disposal is then expected).
 */
export async function disposalStanding(
  db: Db,
  unitIds: string[],
  asOf: string,
  forRemoval = false,
): Promise<Map<string, { unit: Standing; blockers: DisposalBlocker[] }>> {
  const result = new Map<string, { unit: Standing; blockers: DisposalBlocker[] }>();
  if (unitIds.length === 0) return result;
  const [units, holds, programs] = await Promise.all([
    db.query<Standing>(
      `SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text,
              ur.effective_retain_until::text, l.id AS location_id, l.code AS location_code,
              l.name AS location_name, su.project_id, p.lead_project_engineer_user_id, ur.retention_exempt,
              coalesce(unit_disposal_eligible(su.id, $2::date, $3), false) AS eligible,
              EXISTS (SELECT 1 FROM location_conflict c
                      WHERE c.storage_unit_id = su.id AND c.status = 'open') AS open_conflict
       FROM storage_unit su
       JOIN unit_retention ur ON ur.storage_unit_id = su.id
       JOIN location l ON l.id = su.current_location_id
       JOIN project p ON p.id = su.project_id
       WHERE su.id = ANY($1::uuid[])`,
      [unitIds, asOf, forRemoval],
    ),
    db.query<{ storage_unit_id: string; reason: string }>(
      `SELECT x.storage_unit_id, h.reason FROM unit_retention_hold x
       JOIN retention_hold h ON h.id = x.hold_id
       WHERE x.storage_unit_id = ANY($1::uuid[]) ORDER BY h.placed_at`,
      [unitIds],
    ),
    db.query<{ id: string; program_number: string | null }>(
      `SELECT u.id, c.program_number
       FROM unnest($1::uuid[]) AS u(id)
       CROSS JOIN LATERAL unit_open_covering_programs(u.id) c
       ORDER BY c.program_number NULLS LAST`,
      [unitIds],
    ),
  ]);
  for (const unit of units.rows) {
    const blockers: DisposalBlocker[] = [];
    if (unit.status === 'disposed') {
      blockers.push({ code: 'disposed', label: 'Already disposed' });
    } else if (!forRemoval && unit.status !== 'in_stock') {
      blockers.push({ code: 'not_in_stock', label: 'Already approved for disposal' });
    }
    if (unit.effective_retain_until > asOf) {
      blockers.push({
        code: 'retention_not_reached',
        label: `Retain until ${unit.effective_retain_until}`,
      });
    }
    for (const hold of holds.rows.filter((h) => h.storage_unit_id === unit.id)) {
      blockers.push({ code: 'on_hold', label: `On hold: ${hold.reason}` });
    }
    for (const program of programs.rows.filter((p) => p.id === unit.id)) {
      blockers.push({
        code: 'program_open',
        label: `Program ${program.program_number ?? '(draft)'} open`,
      });
    }
    if (unit.open_conflict) {
      blockers.push({
        code: 'location_conflict',
        label: 'Location conflict open: confirm the location first',
      });
    }
    // The database decides eligibility; the reasons only explain it.
    if (!unit.eligible && blockers.length === 0) {
      blockers.push({ code: 'not_in_stock', label: 'Not eligible' });
    }
    result.set(unit.id, { unit, blockers });
  }
  return result;
}

/**
 * Standard disposal (MM-T30): eligible list, batch approval and revocation (the project's Lead Project Engineer
 * or a Lab Manager, `disposal.approve`), and the online-only disposal scan (personal accounts,
 * `storage_unit.dispose_scan`). Approval never disposes; removal rechecks everything under the
 * unit's row lock (DisposalScanService). The MM-T36 post-testing route is separate.
 */
@Injectable()
export class DisposalService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
  ) {}

  /** 403 before a body is read unless `user` could approve somewhere (Lab Manager or a Lead Project Engineer). */
  async assertMayApprove(user: AuthUser): Promise<void> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') {
      throw new ForbiddenException({ code: 'forbidden' });
    }
    if (can(user, 'disposal.approve')) return;
    const { rows } = await this.database.pool.query(
      'SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1 LIMIT 1',
      [user.userId],
    );
    if (rows.length === 0) throw new ForbiddenException({ code: 'forbidden' });
  }

  async candidates(user: AuthUser, projectId: string, page = 1): Promise<DisposalCandidates> {
    if (!UUID_PATTERN.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const { rows: project } = await this.database.pool.query<{
      lead_project_engineer_user_id: string | null;
    }>('SELECT lead_project_engineer_user_id FROM project WHERE id = $1', [projectId]);
    if (!project[0]) throw new NotFoundException({ code: 'project_not_found' });
    // Every current unit is reachable: a total and pages, never a silent cut-off (MM-T71).
    const { rows } = await this.database.pool.query<{ id: string; total: number }>(
      `SELECT id, count(*) OVER ()::int AS total FROM storage_unit
       WHERE project_id = $1 AND status <> 'disposed'
       ORDER BY readable_id COLLATE "C", id LIMIT $2 OFFSET $3`,
      [projectId, DISPOSAL_PAGE_SIZE, (page - 1) * DISPOSAL_PAGE_SIZE],
    );
    const total =
      rows[0]?.total ??
      (
        await this.database.pool.query<{ n: number }>(
          `SELECT count(*)::int AS n FROM storage_unit WHERE project_id = $1 AND status <> 'disposed'`,
          [projectId],
        )
      ).rows[0]!.n;
    const asOf = this.clock.today();
    const ids = rows.map((r) => r.id);
    const standing = await disposalStanding(this.database.pool, ids, asOf);
    const approvals = await this.liveApprovals(this.database.pool, ids);
    return {
      projectId,
      asOf,
      canApprove: can(user, 'disposal.approve', {
        leadProjectEngineerUserId: project[0].lead_project_engineer_user_id,
      }),
      total,
      page,
      pageSize: DISPOSAL_PAGE_SIZE,
      units: ids.map((id) => {
        const { unit, blockers } = standing.get(id)!;
        const live = approvals.get(id) ?? null;
        const approval = live ? live.approval : null;
        // An approved unit lists what would block its removal now.
        let shown = approval ? blockers.filter((b) => b.code !== 'not_in_stock') : blockers;
        // MM-T70: an approval from before a project correction doesn't authorise removal.
        if (live && live.projectId !== unit.project_id) shown = [projectChanged(), ...shown];
        // A tested unit is removed after testing (MM-T36): holds, dates and open programs don't
        // block that route, so only what does (an open location conflict) is listed (MM-T71).
        // An approved unit keeps what would block its standard scan.
        if (unit.retention_exempt && !approval) {
          shown = shown.filter((b) => b.code === 'location_conflict');
        }
        return {
          storageUnitId: id,
          readableId: unit.readable_id,
          unitType: unit.unit_type,
          status: unit.status,
          location: { code: unit.location_code, name: unit.location_name },
          receivedDate: unit.received_date,
          effectiveRetainUntil: unit.effective_retain_until,
          eligible: unit.eligible,
          blockers: shown,
          approval,
          retentionExempt: unit.retention_exempt,
        };
      }),
    };
  }

  /**
   * MISC-13: units in every project that standard disposal can take now, oldest retain-until
   * first. Readable by anyone with inventory.read, as the per-project list is; `canApprove` says
   * whether the viewer may approve for each unit's project. Eligibility is the database's
   * (unit_disposal_eligible): no hold, retain-until (extensions included) reached, covering
   * programs closed, no open location conflict. An approved unit counts only under a live approval
   * for its current project (MM-T70). Tested units are left out: they leave through their own
   * removal (MM-T36/T71). The approve and scan routes recheck everything when submitted.
   */
  async ready(user: AuthUser, page = 1): Promise<DisposalReady> {
    const asOf = this.clock.today();
    const { rows } = await this.database.pool.query<{
      id: string;
      readable_id: string;
      unit_type: string;
      status: 'in_stock' | 'approved_for_disposal';
      received_date: string;
      minimum_retain_until: string;
      effective_retain_until: string;
      project_id: string;
      project_number: string;
      project_name: string;
      lead_project_engineer_user_id: string | null;
      location_code: string;
      location_name: string;
      total: number;
    }>(
      `SELECT su.id, su.readable_id, su.unit_type, su.status, su.received_date::text,
              ur.minimum_retain_until::text, ur.effective_retain_until::text,
              p.id AS project_id, p.project_number, p.name AS project_name,
              p.lead_project_engineer_user_id, l.code AS location_code, l.name AS location_name,
              count(*) OVER ()::int AS total
       ${READY_FROM}
       ORDER BY ur.effective_retain_until, su.readable_id COLLATE "C", su.id
       LIMIT $2 OFFSET $3`,
      [asOf, DISPOSAL_READY_PAGE_SIZE, (page - 1) * DISPOSAL_READY_PAGE_SIZE],
    );
    const total =
      rows[0]?.total ??
      (page > 1
        ? (
            await this.database.pool.query<{ n: number }>(
              `SELECT count(*)::int AS n ${READY_FROM}`,
              [asOf],
            )
          ).rows[0]!.n
        : 0);
    const clear = 'no hold, open program or location conflict';
    return {
      asOf,
      total,
      page,
      pageSize: DISPOSAL_READY_PAGE_SIZE,
      units: rows.map((row) => {
        const extended = row.effective_retain_until > row.minimum_retain_until;
        return {
          storageUnitId: row.id,
          readableId: row.readable_id,
          unitType: row.unit_type,
          project: {
            id: row.project_id,
            projectNumber: row.project_number,
            name: row.project_name,
          },
          location: { code: row.location_code, name: row.location_name },
          effectiveRetainUntil: row.effective_retain_until,
          stage: row.status === 'in_stock' ? 'awaiting_approval' : 'approved',
          reason: extended
            ? {
                code: 'extension_ended',
                label: `Extended retention ended ${row.effective_retain_until}; ${clear}`,
              }
            : {
                code: 'retention_ended',
                label: `Retention ended ${row.effective_retain_until} (1 year after receipt ${row.received_date}); ${clear}`,
              },
          canApprove: can(user, 'disposal.approve', {
            leadProjectEngineerUserId: row.lead_project_engineer_user_id,
          }),
        };
      }),
    };
  }

  /** Approves eligible units (all or none); a unit that isn't eligible names why. */
  async approve(user: AuthUser, body: ApproveDisposal): Promise<ApproveDisposalResult> {
    if (user.accountType === 'shared_lab') throw new ForbiddenException({ code: 'forbidden' });
    const unitIds = [...new Set(body.unitIds)].sort();
    const hash = intentHash({ unitIds });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const earlier = await previousBatch(client, body.idempotencyKey, hash, user);
        if (earlier) return earlier;
        // Projects first (FOR SHARE, in id order), then the units (FOR UPDATE, in id order): the
        // order removal and retention placements use, so overlapping batches, a lead change
        // (project FOR UPDATE) and a new hold (project NO KEY UPDATE) can't deadlock with this,
        // and a lead change that committed first is honoured (D09, MM-AO03).
        await client.query(
          `SELECT p.id FROM project p
           WHERE p.id IN (SELECT su.project_id FROM storage_unit su WHERE su.id = ANY($1::uuid[]))
           ORDER BY p.id FOR SHARE`,
          [unitIds],
        );
        const { rows: locked } = await client.query<{ id: string }>(
          `SELECT su.id FROM storage_unit su WHERE su.id = ANY($1::uuid[])
           ORDER BY su.id FOR UPDATE`,
          [unitIds],
        );
        // A concurrent exact retry waited on these locks: it returns the batch that committed.
        const committed = await previousBatch(client, body.idempotencyKey, hash, user);
        if (committed) return committed;
        if (locked.length !== unitIds.length) {
          throw new NotFoundException({ code: 'storage_unit_not_found' });
        }
        const asOf = this.clock.today();
        const standing = await disposalStanding(client, unitIds, asOf);
        // Each unit's current project, locked (already, unless a correction moved the unit since),
        // and the actor's roles and status as they stand.
        for (const { unit } of standing.values()) {
          if (!(await canUnderLock(client, user, 'disposal.approve', unit.project_id))) {
            throw new ForbiddenException({ code: 'forbidden' });
          }
        }
        const refused = [...standing.values()].filter((s) => !s.unit.eligible);
        if (refused.length > 0) {
          throw new UnprocessableEntityException({
            code: 'not_eligible',
            units: refused.map((s) => ({
              storageUnitId: s.unit.id,
              readableId: s.unit.readable_id,
              blockers: s.blockers,
            })),
          });
        }
        const batchId = randomUUID();
        const approvals: ApproveDisposalResult['approvals'] = [];
        for (const id of unitIds) {
          const { unit } = standing.get(id)!;
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO disposal_approval
               (storage_unit_id, project_id, batch_id, approved_by_user_id,
                approved_by_initials_snapshot, approved_by_name_snapshot, effective_retain_until,
                idempotency_key, request_hash)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
            [
              id,
              unit.project_id,
              batchId,
              user.userId,
              user.initials,
              user.displayName,
              unit.effective_retain_until,
              body.idempotencyKey,
              hash,
            ],
          );
          await client.query(
            `UPDATE storage_unit SET status = 'approved_for_disposal', version = version + 1,
                    updated_at = now()
             WHERE id = $1`,
            [id],
          );
          // STRATA-90: the unit leaves the disposal list for Approved.
          await client.query(
            `UPDATE disposal_list_entry
             SET ended_at = now(), end_kind = 'approved', ended_by_user_id = $2,
                 ended_by_name_snapshot = $3, approval_id = $4
             WHERE storage_unit_id = $1 AND ended_at IS NULL`,
            [id, user.userId, user.displayName, rows[0]!.id],
          );
          await recordAudit(client, {
            action: 'disposal.approved',
            entityType: 'storage_unit',
            entityId: id,
            actor: actorOf(user),
            before: { status: 'in_stock' },
            after: {
              status: 'approved_for_disposal',
              approvalId: rows[0]!.id,
              batchId,
              effectiveRetainUntil: unit.effective_retain_until,
              asOf,
            },
          });
          approvals.push({ id: rows[0]!.id, storageUnitId: id });
        }
        return { batchId, approvals };
      });
    } catch (error) {
      if (error instanceof DatabaseError && error.code === '23505') {
        throw new ConflictException({ code: 'already_approved' });
      }
      throw error;
    }
  }

  async revoke(user: AuthUser, approvalId: string, body: RevokeDisposal): Promise<{ id: string }> {
    if (user.accountType === 'shared_lab') throw new ForbiddenException({ code: 'forbidden' });
    if (!UUID_PATTERN.test(approvalId)) throw new NotFoundException({ code: 'approval_not_found' });
    return withTransaction(this.database.pool, async (client) => {
      const { rows: found } = await client.query<{ storage_unit_id: string }>(
        'SELECT storage_unit_id FROM disposal_approval WHERE id = $1',
        [approvalId],
      );
      if (!found[0]) throw new NotFoundException({ code: 'approval_not_found' });
      const unitId = found[0].storage_unit_id;
      // Project, unit, then approval: the order removal uses. Authority follows the unit's
      // current project, as removal does, checked under lock (D09).
      await client.query(
        `SELECT p.id FROM project p JOIN storage_unit su ON su.project_id = p.id
         WHERE su.id = $1 FOR SHARE OF p`,
        [unitId],
      );
      const { rows: units } = await client.query<{ status: string; project_id: string }>(
        'SELECT status, project_id FROM storage_unit WHERE id = $1 FOR UPDATE',
        [unitId],
      );
      const unit = units[0]!;
      if (!(await canUnderLock(client, user, 'disposal.approve', unit.project_id))) {
        throw new ForbiddenException({ code: 'forbidden' });
      }
      const { rows: current } = await client.query<{
        revoked_at: Date | null;
        used_at: Date | null;
        revoke_idempotency_key: string | null;
        revoked_by_user_id: string | null;
      }>(
        `SELECT revoked_at, used_at, revoke_idempotency_key, revoked_by_user_id
         FROM disposal_approval WHERE id = $1 FOR UPDATE`,
        [approvalId],
      );
      const now = current[0]!;
      if (now.revoked_at) {
        if (
          now.revoke_idempotency_key === body.idempotencyKey &&
          now.revoked_by_user_id === user.userId
        ) {
          return { id: approvalId };
        }
        throw new ConflictException({ code: 'approval_revoked' });
      }
      if (now.used_at || unit.status === 'disposed') {
        throw new ConflictException({ code: 'storage_unit_disposed' });
      }
      await client.query(
        `UPDATE disposal_approval SET revoked_at = now(), revoked_by_user_id = $2,
                revoked_by_name_snapshot = $3, revoke_reason = $4, revoke_idempotency_key = $5
         WHERE id = $1`,
        [approvalId, user.userId, user.displayName, body.reason, body.idempotencyKey],
      );
      await client.query(
        `UPDATE storage_unit SET status = 'in_stock', version = version + 1, updated_at = now()
         WHERE id = $1 AND status = 'approved_for_disposal'`,
        [unitId],
      );
      // STRATA-90: a revoked approval puts the unit back on the disposal list to wait for
      // approval again (nothing has left the shelf).
      await client.query(
        `INSERT INTO disposal_list_entry
           (storage_unit_id, project_id, added_by_user_id, added_by_initials_snapshot,
            added_by_name_snapshot, reason, from_approval_id, idempotency_key, request_hash)
         SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9
         WHERE NOT EXISTS (SELECT 1 FROM disposal_list_entry
                           WHERE storage_unit_id = $1 AND ended_at IS NULL)`,
        [
          unitId,
          unit.project_id,
          user.userId,
          user.initials,
          user.displayName,
          body.reason,
          approvalId,
          body.idempotencyKey,
          intentHash({ revoke: approvalId }),
        ],
      );
      await recordAudit(client, {
        action: 'disposal.approval_revoked',
        entityType: 'storage_unit',
        entityId: unitId,
        actor: actorOf(user),
        reason: body.reason,
        before: { status: unit.status, approvalId },
        after: { status: 'in_stock' },
      });
      return { id: approvalId };
    });
  }

  /**
   * STRATA-90: why each unit can't go on the disposal list now (an empty list = it can). The
   * standard eligibility (unit_disposal_eligible) plus: a tested unit leaves through "Confirm
   * removal after testing", and a unit already on the list stays there once.
   */
  async listStanding(db: Db, unitIds: string[], asOf: string): Promise<Map<string, ListStanding>> {
    const result = new Map<string, ListStanding>();
    if (unitIds.length === 0) return result;
    // One query at a time: `db` may be a transaction's client.
    const standing = await disposalStanding(db, unitIds, asOf);
    const extra = await db.query<{ id: string; version: number; listed: boolean }>(
      `SELECT su.id, su.version,
                EXISTS (SELECT 1 FROM disposal_list_entry e
                        WHERE e.storage_unit_id = su.id AND e.ended_at IS NULL
                          AND e.project_id = su.project_id) AS listed
       FROM storage_unit su WHERE su.id = ANY($1::uuid[])`,
      [unitIds],
    );
    for (const row of extra.rows) {
      const found = standing.get(row.id);
      if (!found) continue;
      const blockers: DisposalBlocker[] = [];
      if (found.unit.retention_exempt) {
        blockers.push({
          code: 'retention_exempt',
          label: 'Tested: use “Confirm removal after testing” on its page',
        });
      }
      if (row.listed) {
        blockers.push({ code: 'on_disposal_list', label: 'Already on the disposal list' });
      }
      if (!found.unit.eligible) blockers.push(...found.blockers);
      result.set(row.id, { unit: found.unit, version: row.version, listed: row.listed, blockers });
    }
    return result;
  }

  /**
   * STRATA-90: puts units on the disposal list inside the caller's transaction (projects FOR
   * SHARE and units FOR UPDATE already locked, authority already checked under lock). Each unit is
   * rechecked now and fails on its own: changed since it was read, not eligible, tested, or
   * already listed. Retrying with the same key returns what that key listed.
   */
  async addToList(
    client: PoolClient,
    user: AuthUser,
    units: { id: string; version: number }[],
    reason: string,
    idempotencyKey: string,
  ): Promise<{ done: { storageUnitId: string; readableId: string }[]; failed: ListFailure[] }> {
    const hash = intentHash({ list: units.map((u) => u.id).sort(), reason });
    const { rows: earlier } = await client.query<{
      storage_unit_id: string;
      added_by_user_id: string;
      request_hash: string;
      readable_id: string;
    }>(
      `SELECT e.storage_unit_id, e.added_by_user_id, e.request_hash, su.readable_id
       FROM disposal_list_entry e JOIN storage_unit su ON su.id = e.storage_unit_id
       WHERE e.idempotency_key = $1 AND e.from_approval_id IS NULL`,
      [idempotencyKey],
    );
    if (earlier.some((e) => e.added_by_user_id !== user.userId || e.request_hash !== hash)) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    if (earlier.length > 0) {
      return {
        done: earlier.map((e) => ({ storageUnitId: e.storage_unit_id, readableId: e.readable_id })),
        failed: [],
      };
    }
    const asOf = this.clock.today();
    const standing = await this.listStanding(
      client,
      units.map((u) => u.id),
      asOf,
    );
    const done: { storageUnitId: string; readableId: string }[] = [];
    const failed: ListFailure[] = [];
    for (const { id, version } of units) {
      const found = standing.get(id);
      if (!found) {
        failed.push({
          storageUnitId: id,
          readableId: null,
          code: 'not_found',
          message: 'Not found',
        });
        continue;
      }
      const readableId = found.unit.readable_id;
      const fail = (code: ListFailure['code'], message: string) =>
        failed.push({ storageUnitId: id, readableId, code, message });
      if (found.unit.status === 'disposed') fail('disposed', 'Already disposed');
      else if (found.version !== version) {
        fail('changed', 'It changed after you opened it. Check it and try again.');
      } else if (found.listed) fail('already_on_list', 'Already on the disposal list');
      else if (found.blockers.length > 0) {
        fail('not_eligible', found.blockers.map((b) => b.label).join('; '));
      } else {
        // A live entry from before a project correction no longer counts: it is closed first.
        await client.query(
          `UPDATE disposal_list_entry SET ended_at = now(), end_kind = 'closed'
           WHERE storage_unit_id = $1 AND ended_at IS NULL`,
          [id],
        );
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO disposal_list_entry
             (storage_unit_id, project_id, added_by_user_id, added_by_initials_snapshot,
              added_by_name_snapshot, reason, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            id,
            found.unit.project_id,
            user.userId,
            user.initials,
            user.displayName,
            reason,
            idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'disposal.listed',
          entityType: 'storage_unit',
          entityId: id,
          actor: actorOf(user),
          reason,
          before: null,
          after: {
            listEntryId: rows[0]!.id,
            effectiveRetainUntil: found.unit.effective_retain_until,
            asOf,
          },
        });
        done.push({ storageUnitId: id, readableId });
      }
    }
    return { done, failed };
  }

  /**
   * STRATA-90: takes units off the disposal list, with a reason (the project's Lead Project
   * Engineer or a Lab Manager, checked under lock for every unit's project; one refusal refuses
   * all). A unit no longer on the list (approved meanwhile, already removed) is reported, not an
   * error. Retrying with the same key returns the same result.
   */
  async removeFromList(
    user: AuthUser,
    body: RemoveFromDisposalList,
  ): Promise<RemoveFromDisposalListResult> {
    if (user.accountType === 'shared_lab') throw new ForbiddenException({ code: 'forbidden' });
    const unitIds = [...new Set(body.unitIds)].sort();
    return withTransaction(this.database.pool, async (client) => {
      await client.query(
        `SELECT p.id FROM project p
         WHERE p.id IN (SELECT su.project_id FROM storage_unit su WHERE su.id = ANY($1::uuid[]))
         ORDER BY p.id FOR SHARE`,
        [unitIds],
      );
      const { rows: units } = await client.query<{
        id: string;
        readable_id: string;
        project_id: string;
      }>(
        `SELECT id, readable_id, project_id FROM storage_unit WHERE id = ANY($1::uuid[])
         ORDER BY id FOR UPDATE`,
        [unitIds],
      );
      if (units.length !== unitIds.length) {
        throw new NotFoundException({ code: 'storage_unit_not_found' });
      }
      for (const projectId of new Set(units.map((u) => u.project_id))) {
        if (!(await canUnderLock(client, user, 'disposal.approve', projectId))) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
      }
      const { rows: earlier } = await client.query<{ storage_unit_id: string; by: string }>(
        `SELECT storage_unit_id, ended_by_user_id AS by FROM disposal_list_entry
         WHERE end_idempotency_key = $1`,
        [body.idempotencyKey],
      );
      if (earlier.some((e) => e.by !== user.userId)) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      const already = new Set(earlier.map((e) => e.storage_unit_id));
      const removed: RemoveFromDisposalListResult['removed'] = [];
      const notOnList: RemoveFromDisposalListResult['notOnList'] = [];
      for (const unit of units) {
        const item = { storageUnitId: unit.id, readableId: unit.readable_id };
        if (already.has(unit.id)) {
          removed.push(item);
          continue;
        }
        const { rows } = await client.query<{ id: string }>(
          `UPDATE disposal_list_entry
           SET ended_at = now(), end_kind = 'removed', ended_by_user_id = $2,
               ended_by_name_snapshot = $3, end_reason = $4, end_idempotency_key = $5
           WHERE storage_unit_id = $1 AND ended_at IS NULL RETURNING id`,
          [unit.id, user.userId, user.displayName, body.reason, body.idempotencyKey],
        );
        if (!rows[0]) {
          notOnList.push(item);
          continue;
        }
        await recordAudit(client, {
          action: 'disposal.list_removed',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor: actorOf(user),
          reason: body.reason,
          before: { listEntryId: rows[0].id },
          after: null,
        });
        removed.push(item);
      }
      return { removed, notOnList };
    });
  }

  private async liveApprovals(db: Db, unitIds: string[]) {
    const { rows } = await db.query<{
      id: string;
      storage_unit_id: string;
      project_id: string;
      batch_id: string;
      approved_by_user_id: string;
      approved_by_initials_snapshot: string | null;
      approved_by_name_snapshot: string;
      approved_at: Date;
      effective_retain_until: string;
    }>(
      `SELECT id, storage_unit_id, project_id, batch_id, approved_by_user_id,
              approved_by_initials_snapshot,
              approved_by_name_snapshot, approved_at, effective_retain_until::text
       FROM disposal_approval
       WHERE storage_unit_id = ANY($1::uuid[]) AND revoked_at IS NULL AND used_at IS NULL`,
      [unitIds],
    );
    return new Map(
      rows.map((row) => [
        row.storage_unit_id,
        {
          projectId: row.project_id,
          approval: {
            id: row.id,
            batchId: row.batch_id,
            approvedBy: {
              userId: row.approved_by_user_id,
              initials: row.approved_by_initials_snapshot,
              name: row.approved_by_name_snapshot,
            },
            approvedAt: row.approved_at.toISOString(),
            effectiveRetainUntil: row.effective_retain_until,
          },
        },
      ]),
    );
  }
}

/** The batch an earlier request with this key approved, or null. */
async function previousBatch(
  client: PoolClient,
  key: string,
  hash: string,
  user: AuthUser,
): Promise<ApproveDisposalResult | null> {
  const { rows } = await client.query<{
    id: string;
    storage_unit_id: string;
    batch_id: string;
    request_hash: string;
    approved_by_user_id: string;
  }>(
    `SELECT id, storage_unit_id, batch_id, request_hash, approved_by_user_id
     FROM disposal_approval WHERE idempotency_key = $1 ORDER BY storage_unit_id`,
    [key],
  );
  if (rows.length === 0) return null;
  if (rows.some((p) => p.request_hash !== hash || p.approved_by_user_id !== user.userId)) {
    throw new ConflictException({ code: 'idempotency_key_reused' });
  }
  return {
    batchId: rows[0]!.batch_id,
    approvals: rows.map((p) => ({ id: p.id, storageUnitId: p.storage_unit_id })),
  };
}
