import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  type ActionRequest,
  type ActionRequestAssignees,
  type ActionRequestCount,
  type ActionRequestList,
  type ActionRequestScope,
  type NotificationPreferences,
  type PersonSnapshot,
  type ReassignActionRequest,
  type UpdateNotificationPreferences,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { announceActionItem, loadItemRows, toActionRequest } from './action-items.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Pool | PoolClient;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

/**
 * The Action requests inbox (MM-T27). Every route is personal-only (`action_item.read`): a LAB
 * station has no inbox, and the person it selects for lab work never lends theirs. The inbox only
 * shows and links; resolving an item is the underlying workflow action's job.
 */
@Injectable()
export class ActionItemsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * Items routed to `user`. Resolved items also include the ones they resolved. `scope=all` (Lab
   * Manager/admin, to reassign) lists every item.
   */
  async list(
    user: AuthUser,
    status: 'open' | 'resolved',
    scope: ActionRequestScope = 'mine',
  ): Promise<ActionRequestList> {
    if (scope !== 'mine' && !can(user, 'action_item.reassign')) {
      throw new ForbiddenException({ code: 'forbidden' });
    }
    const mine =
      status === 'open'
        ? 'action_item_routed_to(a.id, $2)'
        : '(action_item_routed_to(a.id, $2) OR a.resolved_by_user_id = $2)';
    // D10 (MM-AO07): the unresolved queue is the open items nobody can act on now.
    const filter =
      scope === 'all'
        ? '$2::uuid IS NOT NULL'
        : scope === 'unresolved'
          ? "$2::uuid IS NOT NULL AND a.status = 'open' AND NOT action_item_has_recipient(a.id)"
          : mine;
    const rows = await loadItemRows(
      this.database.pool,
      `a.status = $1 AND ${filter}`,
      [status, user.userId],
      status === 'open'
        ? 'ORDER BY a.created_at DESC, a.id LIMIT 500'
        : 'ORDER BY a.resolved_at DESC, a.id LIMIT 200',
      scope !== 'mine',
    );
    const leadProjectEngineer = await this.leadProjectEngineerOf(rows.map((row) => row.project_id));
    return {
      items: rows.map((row) =>
        toActionRequest(row, this.mayReassign(user, row, leadProjectEngineer.get(row.project_id))),
      ),
    };
  }

  async count(user: AuthUser): Promise<ActionRequestCount> {
    const { rows } = await this.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM action_item a
       WHERE a.status = 'open' AND action_item_routed_to(a.id, $1)`,
      [user.userId],
    );
    return { open: rows[0]!.n };
  }

  async assignees(user: AuthUser, id: string): Promise<ActionRequestAssignees> {
    if (!can(user, 'action_item.reassign')) throw new ForbiddenException({ code: 'forbidden' });
    const item = await this.item(this.database.pool, id, '');
    return { people: await eligiblePeople(this.database.pool, item) };
  }

  /**
   * Gives an open item to one eligible person (Lab Manager or admin, with a reason). Recipients
   * can't pass on their own items. Retrying with the same key returns the current item.
   */
  async reassign(user: AuthUser, id: string, body: ReassignActionRequest): Promise<ActionRequest> {
    if (!can(user, 'action_item.reassign')) throw new ForbiddenException({ code: 'forbidden' });
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'action_item_not_found' });
    const hash = intentHash({ id, toUserId: body.toUserId, reason: body.reason });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        /** True when this key already did this reassignment; throws when it was used otherwise. */
        const replayed = async () => {
          const { rows: previous } = await client.query<{
            action_item_id: string;
            request_hash: string;
            assigned_by_user_id: string;
          }>(
            `SELECT action_item_id, request_hash, assigned_by_user_id FROM action_item_assignment
             WHERE idempotency_key = $1`,
            [body.idempotencyKey],
          );
          if (!previous[0]) return false;
          if (
            previous[0].request_hash !== hash ||
            previous[0].assigned_by_user_id !== user.userId ||
            previous[0].action_item_id !== id
          ) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return true;
        };
        if (await replayed()) return this.view(client, user, id);
        const item = await this.item(client, id, 'FOR UPDATE');
        // A same-key retry may have waited on this lock while the first request committed
        // (MM-T71): check again now that the lock is held, so it gets the saved result.
        if (await replayed()) return this.view(client, user, id);
        if (item.status !== 'open') {
          throw new ConflictException({ code: 'action_item_resolved' });
        }
        if (this.isPersonalRecipient(user, item, item.lead_project_engineer_user_id)) {
          throw new ForbiddenException({ code: 'recipient_cannot_reassign' });
        }
        if (item.assigned_user_id === body.toUserId) {
          throw new UnprocessableEntityException({ code: 'already_assigned' });
        }
        const target = (await eligiblePeople(client, item)).find(
          (person) => person.userId === body.toUserId,
        );
        if (!target) throw new UnprocessableEntityException({ code: 'assignee_not_eligible' });

        await client.query(
          `UPDATE action_item SET assigned_user_id = $2, assigned_at = now() WHERE id = $1`,
          [id, target.userId],
        );
        await client.query(
          `INSERT INTO action_item_assignment
             (action_item_id, from_user_id, to_user_id, to_name_snapshot, reason,
              assigned_by_user_id, assigned_by_initials_snapshot, assigned_by_name_snapshot,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            id,
            item.assigned_user_id,
            target.userId,
            target.name,
            body.reason,
            user.userId,
            user.initials,
            user.displayName,
            body.idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'action_item.reassigned',
          entityType: 'action_item',
          entityId: id,
          actor: actorOf(user),
          reason: body.reason,
          before: { assignedUserId: item.assigned_user_id },
          after: { assignedUserId: target.userId, assignedName: target.name, kind: item.kind },
        });
        await announceActionItem(client, id);
        return this.view(client, user, id);
      });
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'action_item_assignment_idempotency_key_key'
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      throw error;
    }
  }

  async preferences(user: AuthUser): Promise<NotificationPreferences> {
    const { rows } = await this.database.pool.query<{
      email_action_requests: boolean | null;
      version: number | null;
      work_email: string | null;
    }>(
      `SELECT np.email_action_requests, np.version, u.work_email
       FROM app_user u LEFT JOIN notification_preference np ON np.user_id = u.id
       WHERE u.id = $1`,
      [user.userId],
    );
    const row = rows[0];
    return {
      emailActionRequests: row?.email_action_requests ?? false,
      emailSendingEnabled: this.config.EMAIL_ENABLED,
      hasWorkEmail: Boolean(row?.work_email),
      version: row?.version ?? 0,
    };
  }

  /** Saves the person's own preferences; a stale `version` gets 409 `stale_preferences`. */
  async updatePreferences(
    user: AuthUser,
    body: UpdateNotificationPreferences,
  ): Promise<NotificationPreferences> {
    await withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{ email_action_requests: boolean; version: number }>(
        'SELECT email_action_requests, version FROM notification_preference WHERE user_id = $1 FOR UPDATE',
        [user.userId],
      );
      const current = rows[0];
      if ((current?.version ?? 0) !== body.version) {
        throw new ConflictException({ code: 'stale_preferences' });
      }
      if (current?.email_action_requests === body.emailActionRequests) return;
      if (current) {
        await client.query(
          `UPDATE notification_preference
           SET email_action_requests = $2, version = version + 1, updated_at = now()
           WHERE user_id = $1`,
          [user.userId, body.emailActionRequests],
        );
      } else {
        const inserted = await client.query(
          `INSERT INTO notification_preference (user_id, email_action_requests) VALUES ($1, $2)
           ON CONFLICT (user_id) DO NOTHING`,
          [user.userId, body.emailActionRequests],
        );
        if (inserted.rowCount === 0) throw new ConflictException({ code: 'stale_preferences' });
      }
      await recordAudit(client, {
        action: 'notification_preference.changed',
        entityType: 'app_user',
        entityId: user.userId,
        actor: actorOf(user),
        before: { emailActionRequests: current?.email_action_requests ?? false },
        after: { emailActionRequests: body.emailActionRequests },
      });
    });
    return this.preferences(user);
  }

  private async view(client: PoolClient, user: AuthUser, id: string): Promise<ActionRequest> {
    const [row] = await loadItemRows(client, 'a.id = $1', [id], '', true);
    const leadProjectEngineer = await this.leadProjectEngineerOf([row!.project_id], client);
    return toActionRequest(
      row!,
      this.mayReassign(user, row!, leadProjectEngineer.get(row!.project_id)),
    );
  }

  private async item(db: Db, id: string, lock: '' | 'FOR UPDATE') {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'action_item_not_found' });
    const { rows } = await db.query<ItemFacts>(
      `SELECT a.id, a.kind, a.status, a.target_role, a.project_id, a.assigned_user_id,
              p.lead_project_engineer_user_id,
              CASE WHEN a.assigned_user_id IS NOT NULL
                   THEN action_item_person_eligible(a.id, a.assigned_user_id) END
                AS assignee_eligible
       FROM action_item a JOIN project p ON p.id = a.project_id
       WHERE a.id = $1 ${lock ? 'FOR UPDATE OF a' : ''}`,
      [id],
    );
    if (!rows[0]) throw new NotFoundException({ code: 'action_item_not_found' });
    return rows[0];
  }

  private async leadProjectEngineerOf(projectIds: string[], db: Db = this.database.pool) {
    const unique = [...new Set(projectIds)];
    const map = new Map<string, string | null>();
    if (unique.length === 0) return map;
    const { rows } = await db.query<{ id: string; lead_project_engineer_user_id: string | null }>(
      'SELECT id, lead_project_engineer_user_id FROM project WHERE id = ANY($1::uuid[])',
      [unique],
    );
    for (const row of rows) map.set(row.id, row.lead_project_engineer_user_id);
    return map;
  }

  /**
   * The item is personally theirs: assigned to them (while that assignment holds), or a Lead
   * Project Engineer-only request on their project. A lapsed assignment (D10) is nobody's.
   */
  private isPersonalRecipient(
    user: AuthUser,
    item: { kind: string; assigned_user_id: string | null; assignee_eligible: boolean | null },
    leadProjectEngineerUserId: string | null | undefined,
  ): boolean {
    if (item.assigned_user_id && item.assignee_eligible !== false) {
      return item.assigned_user_id === user.userId;
    }
    return (
      (item.kind === 'closure_request' ||
        item.kind === 'grant_review' ||
        item.kind === 'team_join_request') &&
      leadProjectEngineerUserId === user.userId
    );
  }

  private mayReassign(
    user: AuthUser,
    row: {
      kind: string;
      status: string;
      assigned_user_id: string | null;
      assignee_eligible: boolean | null;
    },
    leadProjectEngineerUserId: string | null | undefined,
  ): boolean {
    return (
      row.status === 'open' &&
      can(user, 'action_item.reassign') &&
      !this.isPersonalRecipient(user, row, leadProjectEngineerUserId)
    );
  }
}

interface ItemFacts {
  id: string;
  kind: string;
  status: 'open' | 'resolved';
  target_role: string | null;
  project_id: string;
  assigned_user_id: string | null;
  lead_project_engineer_user_id: string | null;
  assignee_eligible: boolean | null;
}

/**
 * Who can act on the item through its workflow: Lab Managers for a correction; Lab Managers and
 * the project's Lead Project Engineer for a cancellation or retention request; the project's Lead Project Engineer for a closure
 * request.
 * Active personal (or fixture) accounts only, never LAB; the current assignee is left out.
 */
async function eligiblePeople(db: Db, item: ItemFacts): Promise<PersonSnapshot[]> {
  // MM-AO04: a lead appointment goes to admins only.
  // MISC-07: a team join request goes to the lead and admins.
  const joining = item.kind === 'team_join_request';
  const admins = item.kind === 'lead_appointment' || joining;
  // MTR-25: inherited grants go to the project's lead only, like a closure request.
  const leadOnly = item.kind === 'closure_request' || item.kind === 'grant_review';
  const lm = !leadOnly && !admins;
  const leadProjectEngineer = item.kind !== 'correction' && item.kind !== 'lead_appointment';
  const { rows } = await db.query<{
    id: string;
    official_initials: string | null;
    display_name: string;
  }>(
    `SELECT u.id, u.official_initials, u.display_name
     FROM app_user u
     WHERE u.status = 'active' AND u.account_type IN ('personal', 'test')
       AND u.id IS DISTINCT FROM $4
       AND (($1 AND EXISTS (SELECT 1 FROM role_assignment r
                            WHERE r.user_id = u.id AND r.role = 'lab_manager'))
            OR ($2 AND u.id = $3)
            OR ($5 AND EXISTS (SELECT 1 FROM role_assignment r
                               WHERE r.user_id = u.id AND r.role = 'admin')))
     ORDER BY u.display_name, u.id`,
    [lm, leadProjectEngineer, item.lead_project_engineer_user_id, item.assigned_user_id, admins],
  );
  return rows.map((row) => ({
    userId: row.id,
    initials: row.official_initials,
    name: row.display_name,
  }));
}
