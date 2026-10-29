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
  normalizeStorageUnitCode,
  type ApproveDisposal,
  type ApproveDisposalResult,
  type DisposalBlocker,
  type DisposalCandidates,
  type DisposalScanResult,
  type RemoveDisposal,
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

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

interface Standing {
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
  lead_project_engineer_user_id: string;
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
 * unit's row lock. The MM-T36 post-testing route is separate.
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
      lead_project_engineer_user_id: string;
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
   * One Disposal scan. Locks the unit, needs a live approval and rechecks standard eligibility
   * now (a hold placed after approval blocks it). A refusal is audited (`disposal.blocked`) and
   * returned with its reasons; success records the disposition atomically. Retrying with the
   * same key returns the recorded result.
   */
  async remove(user: AuthUser, body: RemoveDisposal): Promise<DisposalScanResult> {
    if (!can(user, 'storage_unit.dispose_scan')) {
      throw new ForbiddenException({ code: 'forbidden' });
    }
    const code = body.suNumber.trim();
    const hash = intentHash({ suNumber: normalizeStorageUnitCode(code) });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const where = UUID_PATTERN.test(code) ? 'id = $1' : 'readable_id = $1';
        const value = UUID_PATTERN.test(code) ? code : normalizeStorageUnitCode(code);
        const { rows: found } = await client.query<{ project_id: string }>(
          `SELECT project_id FROM storage_unit WHERE ${where}`,
          [value],
        );
        if (!found[0]) {
          return scan('not_found', null, null, [], `No storage unit found for ${code}.`);
        }
        // Project first (FOR SHARE; a new project-wide hold or extension takes NO KEY UPDATE, so
        // the two serialise), then the unit: the order retention placements use.
        await client.query('SELECT 1 FROM project WHERE id = $1 FOR SHARE', [found[0].project_id]);
        const { rows } = await client.query<{
          id: string;
          readable_id: string;
          status: string;
          project_id: string;
        }>(
          `SELECT id, readable_id, status, project_id FROM storage_unit WHERE ${where} FOR UPDATE`,
          [value],
        );
        const unit = rows[0]!;
        if (unit.project_id !== found[0].project_id) {
          throw new ConflictException({ code: 'storage_unit_changed' });
        }
        // After the lock, so a concurrent exact retry returns the disposition that committed.
        const replay = await this.replay(client, body.idempotencyKey, hash, user);
        if (replay) return replay;
        const asOf = this.clock.today();
        const { blockers, unit: standing } = (
          await disposalStanding(client, [unit.id], asOf, true)
        ).get(unit.id)!;
        const { rows: approvals } = await client.query<{ id: string; project_id: string }>(
          `SELECT id, project_id FROM disposal_approval
           WHERE storage_unit_id = $1 AND revoked_at IS NULL AND used_at IS NULL FOR UPDATE`,
          [unit.id],
        );
        // MM-T70: an approval only counts under the project it was granted for (D19). One from
        // before a project correction leaves the unit Not approved until the new project's Lead Project Engineer
        // or a Lab Manager approves it (unit locked first, then the approval, as revoke does).
        const stale = approvals[0] && approvals[0].project_id !== unit.project_id;
        const approval = stale ? undefined : approvals[0];
        let outcome: DisposalScanResult | null = null;
        if (unit.status === 'disposed') {
          outcome = scan(
            'not_approved',
            unit.id,
            unit.readable_id,
            blockers,
            `${unit.readable_id} is already disposed.`,
          );
        } else if (stale) {
          outcome = scan(
            'not_approved',
            unit.id,
            unit.readable_id,
            [projectChanged()],
            `${unit.readable_id} isn’t approved for disposal: it was approved under another project. Its current project’s Lead Project Engineer or a Lab Manager must approve it again.`,
          );
        } else if (!approval || unit.status !== 'approved_for_disposal') {
          outcome = scan(
            'not_approved',
            unit.id,
            unit.readable_id,
            [],
            `${unit.readable_id} isn’t approved for disposal.`,
          );
        } else if (!standing.eligible || standing.open_conflict) {
          outcome = scan(
            'blocked',
            unit.id,
            unit.readable_id,
            blockers,
            `Blocked: ${blockers.map((b) => b.label).join('; ')}`,
          );
        }
        if (outcome) {
          await recordAudit(client, {
            action: 'disposal.blocked',
            entityType: 'storage_unit',
            entityId: unit.id,
            actor: actorOf(user),
            after: { result: outcome.result, blockers: outcome.blockers.map((b) => b.code), asOf },
          });
          return outcome;
        }
        await client.query(
          `UPDATE storage_unit SET status = 'disposed', version = version + 1, updated_at = now(),
                  disposed_at = now(), disposed_by_user_id = $2
           WHERE id = $1`,
          [unit.id, user.userId],
        );
        await client.query('UPDATE disposal_approval SET used_at = now() WHERE id = $1', [
          approval!.id,
        ]);
        const { rows: removed } = await client.query<{ removed_at: Date }>(
          `INSERT INTO disposal_removal
             (storage_unit_id, approval_id, project_id, unit_readable_id_snapshot, location_id,
              location_code_snapshot, location_name_snapshot, removed_by_user_id,
              removed_by_account_type, removed_by_initials_snapshot, removed_by_name_snapshot,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING removed_at`,
          [
            unit.id,
            approval!.id,
            standing.project_id,
            unit.readable_id,
            standing.location_id,
            standing.location_code,
            standing.location_name,
            user.userId,
            user.accountType,
            user.initials,
            user.displayName,
            body.idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'disposal.removed',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor: actorOf(user),
          before: {
            status: 'approved_for_disposal',
            locationCode: standing.location_code,
            locationName: standing.location_name,
          },
          after: { status: 'disposed', route: 'standard', approvalId: approval!.id, asOf },
        });
        return {
          ...scan('disposed', unit.id, unit.readable_id, [], `${unit.readable_id} disposed.`),
          removedAt: removed[0]!.removed_at.toISOString(),
          removedBy: { userId: user.userId, initials: user.initials, name: user.displayName },
        };
      });
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'disposal_removal_idempotency_key_key'
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      throw error;
    }
  }

  private async replay(
    client: PoolClient,
    key: string,
    hash: string,
    user: AuthUser,
  ): Promise<DisposalScanResult | null> {
    const { rows } = await client.query<{
      storage_unit_id: string;
      unit_readable_id_snapshot: string;
      request_hash: string;
      removed_by_user_id: string;
      removed_by_initials_snapshot: string | null;
      removed_by_name_snapshot: string;
      removed_at: Date;
    }>('SELECT * FROM disposal_removal WHERE idempotency_key = $1', [key]);
    const row = rows[0];
    if (!row) return null;
    if (row.request_hash !== hash || row.removed_by_user_id !== user.userId) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return {
      ...scan(
        'disposed',
        row.storage_unit_id,
        row.unit_readable_id_snapshot,
        [],
        `${row.unit_readable_id_snapshot} disposed.`,
      ),
      removedAt: row.removed_at.toISOString(),
      removedBy: {
        userId: row.removed_by_user_id,
        initials: row.removed_by_initials_snapshot,
        name: row.removed_by_name_snapshot,
      },
      replayed: true,
    };
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

function scan(
  result: DisposalScanResult['result'],
  storageUnitId: string | null,
  readableId: string | null,
  blockers: DisposalBlocker[],
  message: string,
): DisposalScanResult {
  return {
    result,
    storageUnitId,
    readableId,
    blockers,
    message,
    removedAt: null,
    removedBy: null,
    replayed: false,
  };
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
