import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  PersonSnapshot,
  ReceiptDraftCloseReason,
  ReceiptDraftClosed,
  ReceiptDraftDeleteReason,
  ReceiptDraftDeleted,
  ReceiptDraftOwnership,
  ReceiptDraftOwnershipList,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { asLocked, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf, receiverOf, resolveActingPerson } from '../lab/attribution.js';

// STRATA-108: the receiving draft registry (migration 0044). It records who started each draft
// on this site's browsers so that only that person or a verified Lab Manager may delete it. It
// never receives or stores a draft's contents: drafts stay in the browser that saved them.
//
// A personal account is its own starter. A LAB station names the person it is working as
// (attribution only: it grants nothing, and their roles are never borrowed); a LAB draft can be
// deleted only on that LAB account, with its starter picked again. A Lab Manager is verified
// from the account as it stands inside the transaction (role and status), never from the
// browser. A draft saved before the registry has no owner, and only a Lab Manager may delete it.

/** A registry row with the starter's current name. */
export interface DraftRegistryRow {
  draftId: string;
  legacy: boolean;
  accountUserId: string | null;
  accountIsStation: boolean;
  starter: PersonSnapshot | null;
  createdAt: Date | null;
  deletedAt: Date | null;
}

export interface DeleteDecision {
  canDelete: boolean;
  reason: ReceiptDraftDeleteReason;
}

/**
 * Who may delete a draft (pure, so it is tested without a database). `actor` must be the account
 * as it stands under lock; `picked` is the LAB station's picked person (null when none, or for a
 * personal account). Never trusts anything the browser says about the draft.
 */
export function decideDraftDelete(
  actor: AuthUser,
  picked: PersonSnapshot | null,
  row: DraftRegistryRow | null,
): DeleteDecision {
  const no = (reason: ReceiptDraftDeleteReason): DeleteDecision => ({ canDelete: false, reason });
  const registered = row !== null && !row.legacy;
  if (actor.status !== 'active') return no(registered ? 'not_starter' : 'unregistered');
  if (actor.accountType === 'shared_lab') {
    // LAB never holds a role: an unregistered draft is never LAB's to delete.
    if (!registered) return no('unregistered');
    if (row.accountUserId !== actor.userId) return no('other_account');
    if (!picked) return no('pick_person');
    if (picked.userId !== row.starter?.userId) return no('not_starter');
    return { canDelete: true, reason: 'starter' };
  }
  if (registered && row.accountUserId === actor.userId && row.starter?.userId === actor.userId) {
    return { canDelete: true, reason: 'starter' };
  }
  if (actor.roles.includes('lab_manager')) return { canDelete: true, reason: 'lab_manager' };
  if (!registered) return no('unregistered');
  return no(row.accountIsStation ? 'other_account' : 'not_starter');
}

interface RowRecord {
  draft_id: string;
  legacy: boolean;
  account_user_id: string | null;
  account_type: string | null;
  starter_user_id: string | null;
  starter_name: string | null;
  starter_initials: string | null;
  created_at: Date | null;
  deleted_at: Date | null;
}

async function loadRows(
  client: PoolClient,
  draftIds: readonly string[],
  lock = false,
): Promise<Map<string, DraftRegistryRow>> {
  const { rows } = await client.query<RowRecord>(
    `SELECT r.draft_id, r.legacy, r.account_user_id, a.account_type, r.starter_user_id,
            s.display_name AS starter_name, s.official_initials AS starter_initials,
            r.created_at, r.deleted_at
     FROM receipt_draft_registry r
     LEFT JOIN app_user a ON a.id = r.account_user_id
     LEFT JOIN app_user s ON s.id = r.starter_user_id
     WHERE r.draft_id = ANY($1::uuid[])
     ${lock ? 'FOR UPDATE OF r' : ''}`,
    [draftIds],
  );
  return new Map(
    rows.map((row) => [
      row.draft_id,
      {
        draftId: row.draft_id,
        legacy: row.legacy,
        accountUserId: row.account_user_id,
        accountIsStation: row.account_type === 'shared_lab',
        starter:
          row.starter_user_id && row.starter_name
            ? {
                userId: row.starter_user_id,
                initials: row.starter_initials,
                name: row.starter_name,
              }
            : null,
        createdAt: row.created_at,
        deletedAt: row.deleted_at,
      },
    ]),
  );
}

function ownershipOf(
  draftId: string,
  row: DraftRegistryRow | null,
  decision: DeleteDecision,
): ReceiptDraftOwnership {
  const registered = row !== null && !row.legacy;
  return {
    draftId,
    registered,
    starter: registered ? row.starter : null,
    startedOnStation: registered ? row.accountIsStation : false,
    createdAt: registered && row.createdAt ? row.createdAt.toISOString() : null,
    deletedAt: row?.deletedAt ? row.deletedAt.toISOString() : null,
    canDelete: decision.canDelete,
    reason: decision.reason,
  };
}

const ATTRIBUTION = { field: 'personUserId', invalidCode: 'invalid_person' };

/**
 * LAB's picked person, when one was sent (checked as an active staff member); a personal account
 * is always itself and may not name anyone else (400 `not_allowed`).
 */
async function pickedPerson(
  client: PoolClient,
  user: AuthUser,
  personUserId: string | undefined,
): Promise<PersonSnapshot | null> {
  if (user.accountType === 'shared_lab' && personUserId === undefined) return null;
  return resolveActingPerson(client, user, personUserId, ATTRIBUTION);
}

/**
 * Closes this account's open registry row for a draft (migration 0049): `confirmed` when its
 * receipt is confirmed (called inside the receipt's transaction), `expired` when the browser's
 * automatic clean-up deleted it. Only a row the account itself registered (LAB's for LAB, one's
 * own for a personal account) that is not legacy, deleted or already closed is touched; anything
 * else is left alone and answers null, the same for an unknown and another account's draft.
 * Audits `receipt_draft.closed` when it closes. The close time is never before the row's
 * creation (a transaction may have started just before the row was registered).
 */
export async function closeOwnDraft(
  client: PoolClient,
  user: AuthUser,
  draftId: string,
  reason: ReceiptDraftCloseReason,
  requestId: string | null,
): Promise<Date | null> {
  const { rows } = await client.query<{ closed_at: Date }>(
    `UPDATE receipt_draft_registry
     SET closed_at = GREATEST(now(), created_at), closed_reason = $3
     WHERE draft_id = $1 AND account_user_id = $2 AND NOT legacy
       AND deleted_at IS NULL AND closed_at IS NULL
     RETURNING closed_at`,
    [draftId, user.userId, reason],
  );
  if (rows.length === 0) return null;
  await recordAudit(client, {
    action: 'receipt_draft.closed',
    entityType: 'receipt_draft',
    entityId: draftId,
    actor: actorOf(user),
    after: { reason },
    requestId,
  });
  return rows[0]!.closed_at;
}

/**
 * The receipt confirmation's close (MM-T09 + 0049): best effort inside the receipt's transaction.
 * A savepoint keeps any failure here from failing the receipt; a missing or foreign draft ID
 * changes nothing and says nothing.
 */
export async function closeDraftOnConfirm(
  client: PoolClient,
  user: AuthUser,
  draftId: string | undefined,
): Promise<void> {
  if (!draftId) return;
  await client.query('SAVEPOINT receipt_draft_close');
  try {
    await closeOwnDraft(client, user, draftId, 'confirmed', null);
    await client.query('RELEASE SAVEPOINT receipt_draft_close');
  } catch {
    await client.query('ROLLBACK TO SAVEPOINT receipt_draft_close');
  }
}

@Injectable()
export class ReceiptDraftsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Registers a draft the first time it is saved. Idempotent per draft and account: a repeat
   * answers with the starter recorded first, whoever is picked now. Another account's draft (or
   * a deleted one) is 409. LAB must name its picked person (400 `personUserId`/required).
   */
  register(
    user: AuthUser,
    draftId: string,
    personUserId: string | undefined,
    requestId: string | null,
  ): Promise<ReceiptDraftOwnership> {
    return withTransaction(this.database.pool, async (client) => {
      const starter = await resolveActingPerson(client, user, personUserId, ATTRIBUTION);
      const inserted = await client.query(
        `INSERT INTO receipt_draft_registry (draft_id, account_user_id, starter_user_id)
         VALUES ($1, $2, $3) ON CONFLICT (draft_id) DO NOTHING RETURNING draft_id`,
        [draftId, user.userId, starter.userId],
      );
      if (inserted.rowCount === 1) {
        await recordAudit(client, {
          action: 'receipt_draft.registered',
          entityType: 'receipt_draft',
          entityId: draftId,
          actor: actorOf(user),
          receiver: user.accountType === 'shared_lab' ? receiverOf(starter) : null,
          after: { starterUserId: starter.userId },
          requestId,
        });
      }
      const row = (await loadRows(client, [draftId])).get(draftId)!;
      if (row.legacy || row.deletedAt) {
        throw new ConflictException({ code: 'draft_deleted' });
      }
      if (row.accountUserId !== user.userId) {
        throw new ConflictException({ code: 'draft_registered_elsewhere' });
      }
      const picked = user.accountType === 'shared_lab' ? starter : null;
      return ownershipOf(draftId, row, decideDraftDelete(user, picked, row));
    });
  }

  /** Ownership of each named draft for the current actor, in the order asked for. Writes nothing. */
  ownership(
    user: AuthUser,
    draftIds: readonly string[],
    personUserId: string | undefined,
  ): Promise<ReceiptDraftOwnershipList> {
    return withTransaction(this.database.pool, async (client) => {
      const actor = asLocked(user, await lockStanding(client, [user.userId]));
      const person = await pickedPerson(client, user, personUserId);
      const picked = user.accountType === 'shared_lab' ? person : null;
      const rows = await loadRows(client, draftIds);
      const unique = [...new Set(draftIds)];
      return {
        items: unique.map((id) => {
          const row = rows.get(id) ?? null;
          return ownershipOf(id, row, decideDraftDelete(actor, picked, row));
        }),
      };
    });
  }

  /**
   * Authorizes and records a deletion. The browser deletes its copy only after a 200. A repeat by
   * someone still allowed answers 200 with the first deletion and records nothing more; anyone
   * not allowed gets 403 `draft_delete_forbidden` with the reason and the starter, and nothing is
   * written.
   */
  delete(
    user: AuthUser,
    draftId: string,
    personUserId: string | undefined,
    requestId: string | null,
  ): Promise<ReceiptDraftDeleted> {
    return withTransaction(this.database.pool, async (client) => {
      // Two deletions of the same unregistered draft have no row to lock; serialize on its ID.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 108))`, [draftId]);
      const row = (await loadRows(client, [draftId], true)).get(draftId) ?? null;
      const actor = asLocked(user, await lockStanding(client, [user.userId]));
      if (!can(actor, 'receipt.draft')) throw new ForbiddenException({ code: 'forbidden' });
      // LAB names who is deleting (required); a personal account is itself.
      const person = await resolveActingPerson(client, user, personUserId, ATTRIBUTION);
      const picked = user.accountType === 'shared_lab' ? person : null;
      const decision = decideDraftDelete(actor, picked, row);
      if (!decision.canDelete) {
        throw new ForbiddenException({
          code: 'draft_delete_forbidden',
          reason: decision.reason,
          starter: row && !row.legacy ? row.starter : null,
        });
      }
      const reason = decision.reason as ReceiptDraftDeleted['reason'];
      if (row?.deletedAt) {
        return { draftId, deletedAt: row.deletedAt.toISOString(), reason };
      }
      const { rows } = row
        ? await client.query<{ deleted_at: Date }>(
            `UPDATE receipt_draft_registry
             SET deleted_at = now(), deleted_by_account_user_id = $2, deleted_by_user_id = $3
             WHERE draft_id = $1 RETURNING deleted_at`,
            [draftId, user.userId, person.userId],
          )
        : await client.query<{ deleted_at: Date }>(
            `INSERT INTO receipt_draft_registry
               (draft_id, legacy, deleted_at, deleted_by_account_user_id, deleted_by_user_id)
             VALUES ($1, true, now(), $2, $3) RETURNING deleted_at`,
            [draftId, user.userId, person.userId],
          );
      await recordAudit(client, {
        action: 'receipt_draft.deleted',
        entityType: 'receipt_draft',
        entityId: draftId,
        actor: actorOf(user),
        receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
        after: {
          reason,
          registered: row !== null,
          starterUserId: row?.starter?.userId ?? null,
        },
        requestId,
      });
      return { draftId, deletedAt: rows[0]!.deleted_at.toISOString(), reason };
    });
  }
  /**
   * The browser's automatic clean-up (MM-T45) deleted this draft: closes this account's open row
   * as `expired`. Idempotent: a closed row keeps its first close and answers it. A draft that is
   * not this account's (unknown, another account's, legacy or deleted) answers `closed: false`
   * with nothing written and nothing about the row revealed.
   */
  close(user: AuthUser, draftId: string, requestId: string | null): Promise<ReceiptDraftClosed> {
    return withTransaction(this.database.pool, async (client) => {
      const closedAt = await closeOwnDraft(client, user, draftId, 'expired', requestId);
      if (closedAt) {
        return { draftId, closed: true, closedAt: closedAt.toISOString(), reason: 'expired' };
      }
      const { rows } = await client.query<{
        closed_at: Date;
        closed_reason: ReceiptDraftCloseReason;
      }>(
        `SELECT closed_at, closed_reason FROM receipt_draft_registry
         WHERE draft_id = $1 AND account_user_id = $2 AND NOT legacy AND deleted_at IS NULL
           AND closed_at IS NOT NULL`,
        [draftId, user.userId],
      );
      const row = rows[0];
      return row
        ? {
            draftId,
            closed: true,
            closedAt: row.closed_at.toISOString(),
            reason: row.closed_reason,
          }
        : { draftId, closed: false, closedAt: null, reason: null };
    });
  }
}
