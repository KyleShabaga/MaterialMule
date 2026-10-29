import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type DecideRetentionRequest,
  type PlaceHold,
  type ProjectRetention,
  type ReleaseRetention,
  type RetentionMutationResult,
  type RetentionRequestInput,
  type RetentionRequestResult,
  type SetExtension,
  type StorageUnitRetention,
} from '@materialmule/shared';
import { DatabaseError, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { canUnderLock } from '../auth/standing.js';
import { can, type AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { enqueueActionItemEmails } from '../notifications/action-items.js';
import { BusinessClock } from './business-clock.js';
import {
  loadProjectDecisions,
  loadProjectRequests,
  loadUnitDecisions,
  loadUnitRetention,
} from './retention.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

const forbidden = () => new ForbiddenException({ code: 'forbidden' });

type Kind = 'hold' | 'extension';
const TABLE: Record<Kind, { table: string; units: string; key: string; by: string; at: string }> = {
  hold: {
    table: 'retention_hold',
    units: 'retention_hold_unit',
    key: 'hold_id',
    by: 'placed_by',
    at: 'placed_at',
  },
  extension: {
    table: 'retention_extension',
    units: 'retention_extension_unit',
    key: 'extension_id',
    by: 'set_by',
    at: 'set_at',
  },
};

interface Scope {
  projectId: string;
  scope: 'project' | 'units';
  unitIds?: string[];
  retainUntil?: string;
  extendMonths?: number;
  reason: string;
}

/**
 * Retention holds, extensions and requests (MM-T29). Placing, extending, releasing and deciding
 * requests: the project's Lead Project Engineer or a Lab Manager, checked here per project (`retention.manage`).
 * Others ask (`retention.request`). LAB does neither, whoever its station selects. Every change
 * locks what it changes, rechecks it and keeps its own attributable history row.
 */
@Injectable()
export class RetentionService {
  constructor(
    private readonly database: DatabaseService,
    private readonly clock: BusinessClock,
  ) {}

  /**
   * Refuses (403) before a body is read when `user` can't manage retention anywhere: not LAB, a
   * Lab Manager, or the Lead Project Engineer of at least one project. Each handler still checks the project.
   */
  async assertMayManage(user: AuthUser): Promise<void> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') throw forbidden();
    if (can(user, 'retention.manage')) return;
    const { rows } = await this.database.pool.query(
      'SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1 LIMIT 1',
      [user.userId],
    );
    if (rows.length === 0) {
      throw forbidden();
    }
  }

  async unit(user: AuthUser, idOrCode: string): Promise<StorageUnitRetention> {
    const { rows } = await this.database.pool.query<{
      id: string;
      project_id: string;
      lead_project_engineer_user_id: string | null;
    }>(
      `SELECT su.id, su.project_id, p.lead_project_engineer_user_id FROM storage_unit su
       JOIN project p ON p.id = su.project_id
       WHERE ${UUID_PATTERN.test(idOrCode) ? 'su.id = $1' : 'su.readable_id = upper(btrim($1))'}`,
      [idOrCode],
    );
    const unit = rows[0];
    if (!unit) throw new NotFoundException({ code: 'storage_unit_not_found' });
    const today = this.clock.today();
    const [retention, decisions] = await Promise.all([
      loadUnitRetention(this.database.pool, [unit.id], today),
      loadUnitDecisions(this.database.pool, unit.id, unit.project_id),
    ]);
    return {
      storageUnitId: unit.id,
      projectId: unit.project_id,
      retention: retention.get(unit.id)!,
      ...decisions,
      canManage: can(user, 'retention.manage', {
        leadProjectEngineerUserId: unit.lead_project_engineer_user_id,
      }),
      canRequest: can(user, 'retention.request'),
    };
  }

  async project(user: AuthUser, projectId: string): Promise<ProjectRetention> {
    const project = await this.projectFacts(this.database.pool, projectId);
    const [decisions, requests, counts] = await Promise.all([
      loadProjectDecisions(this.database.pool, projectId),
      loadProjectRequests(this.database.pool, projectId),
      this.database.pool.query<{ current: number; on_hold: number }>(
        `SELECT count(*)::int AS current,
                count(*) FILTER (WHERE ur.active_hold_count > 0)::int AS on_hold
         FROM storage_unit su JOIN unit_retention ur ON ur.storage_unit_id = su.id
         WHERE su.project_id = $1 AND su.status <> 'disposed'`,
        [projectId],
      ),
    ]);
    return {
      projectId,
      ...decisions,
      requests,
      counts: { current: counts.rows[0]!.current, onHold: counts.rows[0]!.on_hold },
      canManage: can(user, 'retention.manage', {
        leadProjectEngineerUserId: project.lead_project_engineer_user_id,
      }),
      canRequest: can(user, 'retention.request'),
    };
  }

  placeHold(user: AuthUser, body: PlaceHold): Promise<RetentionMutationResult> {
    return this.create(user, 'hold', body, null);
  }

  setExtension(user: AuthUser, body: SetExtension): Promise<RetentionMutationResult> {
    return this.create(user, 'extension', body, null);
  }

  /** Releases a hold or extension once, with a reason; a stale `version` gets 409. */
  async release(
    user: AuthUser,
    kind: Kind,
    id: string,
    body: ReleaseRetention,
  ): Promise<RetentionMutationResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: `${kind}_not_found` });
    const t = TABLE[kind];
    const hash = intentHash({ id, kind, reason: body.reason, version: body.version });
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{
        project_id: string;
        version: number;
        released_at: Date | null;
        release_idempotency_key: string | null;
        release_request_hash: string | null;
        released_by_user_id: string | null;
        lead_project_engineer_user_id: string | null;
        scope: string;
      }>(
        `SELECT d.project_id, d.version, d.released_at, d.release_idempotency_key,
                d.release_request_hash, d.released_by_user_id, p.lead_project_engineer_user_id, d.scope
         FROM ${t.table} d JOIN project p ON p.id = d.project_id
         WHERE d.id = $1 FOR UPDATE OF d`,
        [id],
      );
      const row = rows[0];
      if (!row) throw new NotFoundException({ code: `${kind}_not_found` });
      // D09: the decision row, then the project and the actor's account (FOR SHARE).
      if (!(await canUnderLock(client, user, 'retention.manage', row.project_id)))
        throw forbidden();
      if (row.released_at) {
        if (
          row.release_idempotency_key === body.idempotencyKey &&
          row.release_request_hash === hash &&
          row.released_by_user_id === user.userId
        ) {
          return { id, version: row.version };
        }
        throw new ConflictException({ code: 'already_released' });
      }
      if (row.version !== body.version) {
        throw new ConflictException({ code: 'stale_retention', current: { version: row.version } });
      }
      try {
        await client.query(
          `UPDATE ${t.table}
           SET released_at = now(), released_by_user_id = $2, released_by_initials_snapshot = $3,
               released_by_name_snapshot = $4, release_reason = $5, version = version + 1,
               release_idempotency_key = $6, release_request_hash = $7
           WHERE id = $1`,
          [
            id,
            user.userId,
            user.initials,
            user.displayName,
            body.reason,
            body.idempotencyKey,
            hash,
          ],
        );
      } catch (error) {
        throw keyConflict(error) ?? error;
      }
      await recordAudit(client, {
        action: kind === 'hold' ? 'retention.hold_released' : 'retention.extension_released',
        entityType: t.table,
        entityId: id,
        actor: actorOf(user),
        reason: body.reason,
        before: { active: true, scope: row.scope },
        after: { active: false, projectId: row.project_id },
      });
      return { id, version: row.version + 1 };
    });
  }

  /** Any internal personal account asks; the decision makers get one shared action item. */
  async request(user: AuthUser, body: RetentionRequestInput): Promise<RetentionRequestResult> {
    if (!can(user, 'retention.request')) throw forbidden();
    const hash = intentHash({ ...body, idempotencyKey: undefined });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows: previous } = await client.query<{
          id: string;
          request_hash: string;
          requested_by_user_id: string;
        }>(
          `SELECT id, request_hash, requested_by_user_id FROM retention_request
           WHERE idempotency_key = $1`,
          [body.idempotencyKey],
        );
        if (previous[0]) {
          if (
            previous[0].request_hash !== hash ||
            previous[0].requested_by_user_id !== user.userId
          ) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          const { rows: item } = await client.query<{ id: string }>(
            `SELECT id FROM action_item WHERE kind = 'retention_request' AND entity_id = $1`,
            [previous[0].id],
          );
          return { requestId: previous[0].id, actionItemId: item[0]!.id };
        }
        const project = await this.projectFacts(client, body.projectId, 'FOR SHARE');
        const unitIds = await this.checkUnits(client, body);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO retention_request
             (project_id, kind, scope, retain_until, extend_months, reason, requested_by_user_id,
              requested_by_initials_snapshot, requested_by_name_snapshot, idempotency_key,
              request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
          [
            body.projectId,
            body.kind,
            body.scope,
            body.retainUntil ?? null,
            body.extendMonths ?? null,
            body.reason,
            user.userId,
            user.initials,
            user.displayName,
            body.idempotencyKey,
            hash,
          ],
        );
        const requestId = rows[0]!.id;
        for (const unitId of unitIds) {
          await client.query(
            'INSERT INTO retention_request_unit (request_id, storage_unit_id) VALUES ($1, $2)',
            [requestId, unitId],
          );
        }
        const { rows: items } = await client.query<{ id: string }>(
          `INSERT INTO action_item (kind, target_role, target_user_id, entity_type, entity_id,
                                    project_id, created_by_user_id, created_by_initials_snapshot,
                                    created_by_name_snapshot, reason, idempotency_key,
                                    request_hash)
           VALUES ('retention_request', 'lab_manager', $1, 'retention_request', $2, $3, $4, $5,
                   $6, $7, $8, $9)
           RETURNING id`,
          [
            project.lead_project_engineer_user_id,
            requestId,
            body.projectId,
            user.userId,
            user.initials,
            user.displayName,
            body.reason,
            body.idempotencyKey,
            hash,
          ],
        );
        const actionItemId = items[0]!.id;
        await recordAudit(client, {
          action: 'retention.requested',
          entityType: 'retention_request',
          entityId: requestId,
          actor: actorOf(user),
          reason: body.reason,
          after: {
            kind: body.kind,
            scope: body.scope,
            unitIds,
            retainUntil: body.retainUntil ?? null,
            extendMonths: body.extendMonths ?? null,
            actionItemId,
          },
        });
        await enqueueActionItemEmails(client, actionItemId);
        return { requestId, actionItemId };
      });
    } catch (error) {
      throw keyConflict(error) ?? error;
    }
  }

  /**
   * Approves (creating the hold/extension as the decider) or declines (with a reason) an open
   * request, and resolves its action item for everyone in the same transaction.
   */
  async decide(
    user: AuthUser,
    id: string,
    decision: 'approved' | 'declined',
    body: DecideRetentionRequest,
  ): Promise<RetentionMutationResult & { requestId: string }> {
    if (user.accountType === 'shared_lab') throw forbidden();
    if (!UUID_PATTERN.test(id))
      throw new NotFoundException({ code: 'retention_request_not_found' });
    if (decision === 'declined' && !body.reason) {
      throw new BadRequestException({
        code: 'validation_failed',
        errors: [{ field: 'reason', code: 'too_small', message: 'A reason is required' }],
      });
    }
    const hash = intentHash({ id, decision, reason: body.reason ?? null });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows } = await client.query<{
          project_id: string;
          kind: Kind;
          scope: 'project' | 'units';
          retain_until: string | null;
          extend_months: number | null;
          reason: string;
          status: string;
          decision_idempotency_key: string | null;
          decision_request_hash: string | null;
          decided_by_user_id: string | null;
          hold_id: string | null;
          extension_id: string | null;
          lead_project_engineer_user_id: string | null;
        }>(
          `SELECT d.project_id, d.kind, d.scope, d.retain_until::text AS retain_until,
                  d.extend_months, d.reason, d.status, d.decision_idempotency_key,
                  d.decision_request_hash, d.decided_by_user_id, d.hold_id, d.extension_id,
                  p.lead_project_engineer_user_id
           FROM retention_request d JOIN project p ON p.id = d.project_id
           WHERE d.id = $1 FOR UPDATE OF d`,
          [id],
        );
        const request = rows[0];
        if (!request) throw new NotFoundException({ code: 'retention_request_not_found' });
        // D09: the request, then the project (NO KEY UPDATE, the lock an approval needs anyway to
        // place a hold or extension) and the actor's account.
        if (
          !(await canUnderLock(client, user, 'retention.manage', request.project_id, {
            lock: 'FOR NO KEY UPDATE',
          }))
        ) {
          throw forbidden();
        }
        if (request.status !== 'open') {
          if (
            request.decision_idempotency_key === body.idempotencyKey &&
            request.decision_request_hash === hash &&
            request.decided_by_user_id === user.userId
          ) {
            return { requestId: id, id: request.hold_id ?? request.extension_id ?? id, version: 1 };
          }
          throw new ConflictException({ code: 'request_decided', status: request.status });
        }
        // Approval places a hold/extension: the project is already locked as a direct placement
        // locks it (above).
        let created: RetentionMutationResult | null = null;
        if (decision === 'approved') {
          const { rows: units } = await client.query<{ storage_unit_id: string }>(
            'SELECT storage_unit_id FROM retention_request_unit WHERE request_id = $1',
            [id],
          );
          created = await this.insertDecision(
            client,
            user,
            request.kind,
            {
              projectId: request.project_id,
              scope: request.scope,
              unitIds: units.map((u) => u.storage_unit_id),
              retainUntil: request.retain_until ?? undefined,
              extendMonths: request.extend_months ?? undefined,
              reason: request.reason,
            },
            { idempotencyKey: body.idempotencyKey, hash, requestId: id },
          );
        }
        await client.query(
          `UPDATE retention_request
           SET status = $2, decided_at = now(), decided_by_user_id = $3,
               decided_by_name_snapshot = $4, decision_reason = $5, hold_id = $6,
               extension_id = $7, decision_idempotency_key = $8, decision_request_hash = $9
           WHERE id = $1`,
          [
            id,
            decision,
            user.userId,
            user.displayName,
            body.reason ?? null,
            request.kind === 'hold' ? (created?.id ?? null) : null,
            request.kind === 'extension' ? (created?.id ?? null) : null,
            body.idempotencyKey,
            hash,
          ],
        );
        const { rows: resolved } = await client.query<{ id: string }>(
          `UPDATE action_item SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2,
                  resolution = $3
           WHERE kind = 'retention_request' AND entity_id = $1 AND status = 'open' RETURNING id`,
          [id, user.userId, decision],
        );
        await recordAudit(client, {
          action:
            decision === 'approved' ? 'retention.request_approved' : 'retention.request_declined',
          entityType: 'retention_request',
          entityId: id,
          actor: actorOf(user),
          reason: body.reason ?? null,
          before: { status: 'open' },
          after: {
            status: decision,
            createdId: created?.id ?? null,
            resolvedActionItems: resolved.map((r) => r.id),
          },
        });
        return { requestId: id, id: created?.id ?? id, version: created?.version ?? 1 };
      });
    } catch (error) {
      throw keyConflict(error) ?? error;
    }
  }

  private async create(
    user: AuthUser,
    kind: Kind,
    body: Scope & { idempotencyKey: string },
    requestId: string | null,
  ): Promise<RetentionMutationResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    const t = TABLE[kind];
    const hash = intentHash({ kind, ...body, idempotencyKey: undefined });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows: previous } = await client.query<{
          id: string;
          request_hash: string;
          by: string;
          version: number;
        }>(
          `SELECT id, request_hash, ${t.by}_user_id AS by, version FROM ${t.table}
           WHERE idempotency_key = $1`,
          [body.idempotencyKey],
        );
        if (previous[0]) {
          if (previous[0].request_hash !== hash || previous[0].by !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return { id: previous[0].id, version: previous[0].version };
        }
        // NO KEY UPDATE conflicts with a disposal removal's FOR SHARE on the project (MM-T30):
        // a new project-wide hold and a removal that didn't see it can't both commit.
        const project = await this.projectFacts(client, body.projectId, 'FOR NO KEY UPDATE');
        // D09: the lead is fixed by the lock above; the actor's roles and status are rechecked
        // under their own lock.
        if (!(await canUnderLock(client, user, 'retention.manage', project.id))) throw forbidden();
        return this.insertDecision(client, user, kind, body, {
          idempotencyKey: body.idempotencyKey,
          hash,
          requestId,
        });
      });
    } catch (error) {
      throw keyConflict(error) ?? error;
    }
  }

  private async insertDecision(
    client: PoolClient,
    user: AuthUser,
    kind: Kind,
    body: Scope,
    keys: { idempotencyKey: string; hash: string; requestId: string | null },
  ): Promise<RetentionMutationResult> {
    const t = TABLE[kind];
    const unitIds = await this.checkUnits(client, body);
    const extra = kind === 'extension' ? ', retain_until, extend_months' : '';
    const extraValues = kind === 'extension' ? ', $10, $11' : '';
    const { rows } = await client.query<{ id: string; version: number }>(
      `INSERT INTO ${t.table} (project_id, scope, reason, ${t.by}_user_id,
                               ${t.by}_initials_snapshot, ${t.by}_name_snapshot, request_id,
                               idempotency_key, request_hash ${extra})
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9 ${extraValues}) RETURNING id, version`,
      [
        body.projectId,
        body.scope,
        body.reason,
        user.userId,
        user.initials,
        user.displayName,
        keys.requestId,
        keys.idempotencyKey,
        keys.hash,
        ...(kind === 'extension' ? [body.retainUntil ?? null, body.extendMonths ?? null] : []),
      ],
    );
    const created = rows[0]!;
    for (const unitId of unitIds) {
      await client.query(`INSERT INTO ${t.units} (${t.key}, storage_unit_id) VALUES ($1, $2)`, [
        created.id,
        unitId,
      ]);
    }
    await recordAudit(client, {
      action: kind === 'hold' ? 'retention.hold_placed' : 'retention.extended',
      entityType: t.table,
      entityId: created.id,
      actor: actorOf(user),
      reason: body.reason,
      before: null,
      after: {
        projectId: body.projectId,
        scope: body.scope,
        unitIds,
        ...(kind === 'extension'
          ? { retainUntil: body.retainUntil ?? null, extendMonths: body.extendMonths ?? null }
          : {}),
        ...(keys.requestId ? { requestId: keys.requestId } : {}),
      },
    });
    return created;
  }

  /** Selected units must be current (not disposed) units of the project. */
  private async checkUnits(client: PoolClient, body: Scope): Promise<string[]> {
    if (body.scope === 'project') return [];
    const ids = [...new Set(body.unitIds ?? [])];
    const { rows } = await client.query<{ id: string; status: string }>(
      `SELECT id, status FROM storage_unit WHERE id = ANY($1::uuid[]) AND project_id = $2
       FOR SHARE`,
      [ids, body.projectId],
    );
    if (rows.length !== ids.length) {
      throw new UnprocessableEntityException({ code: 'unit_not_in_project', field: 'unitIds' });
    }
    if (rows.some((row) => row.status === 'disposed')) {
      throw new UnprocessableEntityException({ code: 'storage_unit_disposed', field: 'unitIds' });
    }
    return ids.sort();
  }

  private async projectFacts(
    db: Pick<PoolClient, 'query'>,
    projectId: string,
    lock: '' | 'FOR SHARE' | 'FOR NO KEY UPDATE' = '',
  ): Promise<{ id: string; lead_project_engineer_user_id: string | null }> {
    if (!UUID_PATTERN.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const { rows } = await db.query<{ id: string; lead_project_engineer_user_id: string | null }>(
      `SELECT id, lead_project_engineer_user_id FROM project WHERE id = $1 ${lock}`,
      [projectId],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'project_not_found' });
    return rows[0];
  }
}

function keyConflict(error: unknown): ConflictException | null {
  if (
    error instanceof DatabaseError &&
    error.code === '23505' &&
    /idempotency_key/.test(error.constraint ?? '')
  ) {
    return new ConflictException({ code: 'idempotency_key_reused' });
  }
  return null;
}
