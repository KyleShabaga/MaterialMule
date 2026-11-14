import { createHash } from 'node:crypto';
import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  normalizeStorageUnitCode,
  type DisposalBlocker,
  type DisposalScanCheck,
  type DisposalScanCheckResponse,
  type DisposalScanIntent,
  type DisposalScanOutcome,
  type DisposalScanRecordResponse,
  type DisposalScanRequest,
  type DisposalScanUnit,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { BusinessClock } from '../retention/business-clock.js';
import { disposalStanding } from './disposal.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
type Db = Pool | PoolClient;

/** The same request hash as the single-scan route (MM-T30), so its keys replay here too. */
export function scanHash(code: string): string {
  return createHash('sha256')
    .update(JSON.stringify({ suNumber: normalizeStorageUnitCode(code) }))
    .digest('hex');
}

function outcome(
  result: DisposalScanOutcome['result'],
  unit: { id: string; readable_id: string } | null,
  blockers: DisposalBlocker[],
  message: string,
): DisposalScanOutcome {
  return {
    result,
    storageUnitId: unit?.id ?? null,
    readableId: unit?.readable_id ?? null,
    blockers,
    message,
    removedAt: null,
    removedBy: null,
    replayed: false,
  };
}

interface UnitRow {
  id: string;
  readable_id: string;
  status: string;
  project_id: string;
}

/** Standing of one unit for the standard scan: what recording would do now. */
interface Judgement {
  result: 'approved' | 'not_approved' | 'blocked';
  blockers: DisposalBlocker[];
  message: string;
  approvalId: string | null;
  standing: Awaited<ReturnType<typeof disposalStanding>> extends Map<string, infer V> ? V : never;
}

/**
 * STRATA-92 Disposal scan-out (`/disposal-retention/scan`). `check` reports what recording each
 * scan intent would do now and changes nothing (no audit, no locks); `record` records each intent
 * in its own transaction under the unit's row lock, with the MM-T30 rules unchanged: a live
 * approval under the unit's current project, then retain-until, holds, open programs and location
 * conflicts rechecked now. A tested unit (retention exempt) is never disposed here without that
 * approval: it leaves with "Confirm removal after testing" (MM-T36). Every outcome is written to
 * `disposal_scan_intent` in the same transaction, so a retried intent returns what it first did
 * and adds no second history entry. Personal accounts with `storage_unit.dispose_scan` only;
 * a LAB station is refused whoever it names (STRATA-111, kept as today). Recording never runs by
 * itself after an offline period: the page asks the person to confirm the exact ID list first
 * (STRATA-112).
 */
@Injectable()
export class DisposalScanService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
  ) {}

  private assertMayScan(user: AuthUser): void {
    if (user.accountType === 'shared_lab' || !can(user, 'storage_unit.dispose_scan')) {
      throw new ForbiddenException({ code: 'forbidden' });
    }
  }

  async check(user: AuthUser, body: DisposalScanRequest): Promise<DisposalScanCheckResponse> {
    this.assertMayScan(user);
    const asOf = this.clock.today();
    const db = this.database.pool;
    const results: DisposalScanCheck[] = [];
    for (const intent of body.intents) {
      results.push(await this.checkOne(db, user, intent, asOf));
    }
    return { asOf, results };
  }

  private async checkOne(
    db: Db,
    user: AuthUser,
    intent: DisposalScanIntent,
    asOf: string,
  ): Promise<DisposalScanCheck> {
    const base = { intentId: intent.intentId, code: intent.code };
    if (intent.scannedByUserId !== user.userId) {
      return {
        ...base,
        status: 'other_account',
        unit: null,
        blockers: [],
        message: OTHER_ACCOUNT,
        recorded: null,
      };
    }
    const earlier = await this.earlierOutcome(db, user, intent);
    if (earlier) {
      const unit = earlier.storageUnitId ? await unitView(db, earlier.storageUnitId) : null;
      return earlier.result === 'intent_reused'
        ? {
            ...base,
            status: 'intent_reused',
            unit: null,
            blockers: [],
            message: earlier.message,
            recorded: null,
          }
        : {
            ...base,
            status: 'recorded',
            unit,
            blockers: earlier.blockers,
            message: earlier.message,
            recorded: earlier,
          };
    }
    const found = await findUnit(db, intent.code);
    if (!found) {
      return {
        ...base,
        status: 'not_found',
        unit: null,
        blockers: [],
        message: notFound(intent.code),
        recorded: null,
      };
    }
    const judged = await judge(db, found, asOf, false);
    return {
      ...base,
      status: judged.result,
      unit: await unitView(db, found.id),
      blockers: judged.blockers,
      message: judged.message,
      recorded: null,
    };
  }

  async record(user: AuthUser, body: DisposalScanRequest): Promise<DisposalScanRecordResponse> {
    this.assertMayScan(user);
    const results: DisposalScanRecordResponse['results'] = [];
    // One transaction per intent, in order: a unit refused (or a failure) never undoes another
    // unit's disposal, and a request that fails part-way is safe to resend whole.
    for (const intent of body.intents) {
      const done = await this.recordOne(user, intent);
      const unit = done.storageUnitId
        ? await unitView(this.database.pool, done.storageUnitId)
        : null;
      results.push({ intentId: intent.intentId, code: intent.code, unit, outcome: done });
    }
    return { results };
  }

  /** Records one intent; a retry with the same intent ID returns what it first did. */
  async recordOne(user: AuthUser, intent: DisposalScanIntent): Promise<DisposalScanOutcome> {
    this.assertMayScan(user);
    if (intent.scannedByUserId !== user.userId) {
      return outcome('other_account', null, [], OTHER_ACCOUNT);
    }
    const hash = scanHash(intent.code);
    return withTransaction(this.database.pool, async (client) => {
      // Same-intent requests queue here, so a concurrent exact retry sees the first one's row.
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 92))', [
        intent.intentId,
      ]);
      const earlier = await this.earlierOutcome(client, user, intent);
      if (earlier) return earlier;
      const unit = await lockUnit(client, intent.code);
      if (!unit) {
        const refused = outcome('not_found', null, [], notFound(intent.code));
        await saveIntent(client, user, intent, hash, null, refused);
        return refused;
      }
      // After the lock, so a concurrent exact retry of the single-scan route is seen too.
      const legacy = await legacyReplay(client, user, intent.intentId, hash);
      if (legacy) return legacy;
      const asOf = this.clock.today();
      const judged = await judge(client, unit, asOf, true);
      if (judged.result !== 'approved') {
        const refused = outcome(judged.result, unit, judged.blockers, judged.message);
        await recordAudit(client, {
          action: 'disposal.blocked',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor: actorOf(user),
          after: {
            result: refused.result,
            blockers: refused.blockers.map((b) => b.code),
            asOf,
            intentId: intent.intentId,
            scannedAt: intent.scannedAt,
          },
        });
        await saveIntent(client, user, intent, hash, unit.id, refused);
        return refused;
      }
      const standing = judged.standing.unit;
      await client.query(
        `UPDATE storage_unit SET status = 'disposed', version = version + 1, updated_at = now(),
                disposed_at = now(), disposed_by_user_id = $2
         WHERE id = $1`,
        [unit.id, user.userId],
      );
      await client.query('UPDATE disposal_approval SET used_at = now() WHERE id = $1', [
        judged.approvalId,
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
          judged.approvalId,
          standing.project_id,
          unit.readable_id,
          standing.location_id,
          standing.location_code,
          standing.location_name,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          intent.intentId,
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
        after: {
          status: 'disposed',
          route: 'standard',
          approvalId: judged.approvalId,
          asOf,
          intentId: intent.intentId,
          scannedAt: intent.scannedAt,
        },
      });
      const disposed: DisposalScanOutcome = {
        ...outcome('disposed', unit, [], `${unit.readable_id} disposed.`),
        removedAt: removed[0]!.removed_at.toISOString(),
        removedBy: { userId: user.userId, initials: user.initials, name: user.displayName },
      };
      await saveIntent(client, user, intent, hash, unit.id, disposed);
      return disposed;
    });
  }

  /** What this intent ID already recorded (here or by the single-scan route), or null. */
  private async earlierOutcome(
    db: Db,
    user: AuthUser,
    intent: DisposalScanIntent,
  ): Promise<DisposalScanOutcome | null> {
    const hash = scanHash(intent.code);
    const { rows } = await db.query<{
      user_id: string;
      request_hash: string;
      outcome: DisposalScanOutcome;
    }>('SELECT user_id, request_hash, outcome FROM disposal_scan_intent WHERE intent_id = $1', [
      intent.intentId,
    ]);
    const row = rows[0];
    if (row) {
      if (row.user_id !== user.userId || row.request_hash !== hash) return reused();
      return { ...row.outcome, replayed: true };
    }
    return legacyReplay(db, user, intent.intentId, hash);
  }
}

const OTHER_ACCOUNT =
  'Scanned while another account was signed in. Only that account can record it.';

const notFound = (code: string) =>
  `No storage unit has the ID ${code.trim()}. Check the label and scan again.`;

const reused = () =>
  outcome('intent_reused', null, [], 'This scan’s ID was already used for another scan.');

/** A disposal recorded with this key by the single-scan route (MM-T30), or null. */
async function legacyReplay(
  db: Db,
  user: AuthUser,
  key: string,
  hash: string,
): Promise<DisposalScanOutcome | null> {
  const { rows } = await db.query<{
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
  if (row.request_hash !== hash || row.removed_by_user_id !== user.userId) return reused();
  return {
    ...outcome(
      'disposed',
      { id: row.storage_unit_id, readable_id: row.unit_readable_id_snapshot },
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

function unitWhere(code: string): { where: string; value: string } {
  const trimmed = code.trim();
  return UUID_PATTERN.test(trimmed)
    ? { where: 'id = $1', value: trimmed }
    : { where: 'readable_id = $1', value: normalizeStorageUnitCode(trimmed) };
}

async function findUnit(db: Db, code: string): Promise<UnitRow | null> {
  const { where, value } = unitWhere(code);
  const { rows } = await db.query<UnitRow>(
    `SELECT id, readable_id, status, project_id FROM storage_unit WHERE ${where}`,
    [value],
  );
  return rows[0] ?? null;
}

/**
 * The unit locked for recording: project first (FOR SHARE; a project-wide hold or extension takes
 * NO KEY UPDATE, so the two serialise), then the unit, the order retention placements use. A
 * project correction between the two reads is retried; it can't succeed with a live approval.
 */
async function lockUnit(client: PoolClient, code: string): Promise<UnitRow | null> {
  const { where, value } = unitWhere(code);
  for (let attempt = 0; attempt < 3; attempt++) {
    const found = await findUnit(client, code);
    if (!found) return null;
    await client.query('SELECT 1 FROM project WHERE id = $1 FOR SHARE', [found.project_id]);
    const { rows } = await client.query<UnitRow>(
      `SELECT id, readable_id, status, project_id FROM storage_unit WHERE ${where} FOR UPDATE`,
      [value],
    );
    const unit = rows[0]!;
    if (unit.project_id === found.project_id) return unit;
  }
  throw new ConflictException({ code: 'storage_unit_changed' });
}

/** The MM-T30 rules for one unit now: approved, not approved or blocked, with the reasons. */
async function judge(db: Db, unit: UnitRow, asOf: string, lock: boolean): Promise<Judgement> {
  const standing = (await disposalStanding(db, [unit.id], asOf, true)).get(unit.id)!;
  const { blockers } = standing;
  // Recording locks the approval (unit first, then approval, as revoke does); a check only reads.
  const forUpdate = lock ? ' FOR UPDATE' : '';
  const { rows: approvals } = await db.query<{ id: string; project_id: string }>(
    `SELECT id, project_id FROM disposal_approval
     WHERE storage_unit_id = $1 AND revoked_at IS NULL AND used_at IS NULL${forUpdate}`,
    [unit.id],
  );
  // MM-T70: an approval only counts under the project it was granted for.
  const stale = !!approvals[0] && approvals[0].project_id !== unit.project_id;
  const approval = stale ? undefined : approvals[0];
  const id = unit.readable_id;
  const no = (message: string, list: DisposalBlocker[] = []): Judgement => ({
    result: 'not_approved',
    blockers: list,
    message,
    approvalId: null,
    standing,
  });
  if (unit.status === 'disposed') return no(`${id} is already disposed.`, blockers);
  if (stale) {
    return no(
      `${id} isn’t approved for disposal: it was approved under another project. Its current project’s Lead Project Engineer or a Lab Manager must approve it again.`,
      [
        {
          code: 'approval_project_changed',
          label: 'Approved under another project: revoke it and approve again',
        },
      ],
    );
  }
  if (!approval || unit.status !== 'approved_for_disposal') {
    if (standing.unit.retention_exempt) {
      return no(
        `${id} was tested: it leaves with Confirm removal after testing on its page, not this scan. It stays in stock; put it back.`,
      );
    }
    return no(`Not approved for disposal. ${id} stays in stock; put it back.`);
  }
  if (!standing.unit.eligible || standing.unit.open_conflict) {
    return {
      result: 'blocked',
      blockers,
      message: `Blocked: ${blockers.map((b) => b.label).join('; ')}. It stays in stock; put it back.`,
      approvalId: null,
      standing,
    };
  }
  return {
    result: 'approved',
    blockers: [],
    message: 'Approved · will be disposed',
    approvalId: approval.id,
    standing,
  };
}

/** What the page shows for a unit: project, holes and its last saved location. */
async function unitView(db: Db, id: string): Promise<DisposalScanUnit | null> {
  const { rows } = await db.query<{
    readable_id: string;
    project_number: string;
    location_code: string;
    location_name: string;
    holes: string[];
  }>(
    `SELECT su.readable_id, p.project_number, l.code AS location_code, l.name AS location_name,
            coalesce((SELECT array_agg(DISTINCT th.name ORDER BY th.name)
                      FROM storage_unit_hole_summary s JOIN test_hole th ON th.id = s.test_hole_id
                      WHERE s.storage_unit_id = su.id), '{}') AS holes
     FROM storage_unit su
     JOIN project p ON p.id = su.project_id
     JOIN location l ON l.id = su.current_location_id
     WHERE su.id = $1`,
    [id],
  );
  const row = rows[0];
  if (!row) return null;
  return {
    storageUnitId: id,
    readableId: row.readable_id,
    projectNumber: row.project_number,
    holes: row.holes,
    location: { code: row.location_code, name: row.location_name },
  };
}

async function saveIntent(
  client: PoolClient,
  user: AuthUser,
  intent: DisposalScanIntent,
  hash: string,
  unitId: string | null,
  result: DisposalScanOutcome,
): Promise<void> {
  await client.query(
    `INSERT INTO disposal_scan_intent
       (intent_id, user_id, request_hash, storage_unit_id, result, outcome, scanned_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      intent.intentId,
      user.userId,
      hash,
      unitId,
      result.result,
      JSON.stringify(result),
      intent.scannedAt,
    ],
  );
}
