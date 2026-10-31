import type { EffectiveEligibility, Position, ReviewScope } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { AuditActor } from '../audit/audit.js';
import { announceActionItem } from '../notifications/action-items.js';
import { REVIEW_APPROVAL, endGrant, lockGrant } from './grant-tables.js';

type Db = Pool | PoolClient;

/**
 * MISC-08: effective review eligibility, one rule for candidates, assignment, approval,
 * authorization and access summaries (SQL `reviewer_is_eligible`, migration 0013): an active
 * individual grant or a position rule for the person's current position, and no exclusion for
 * that scope or for all scopes.
 *
 * Every change to a source (an individual grant, a position, a rule or an exclusion, or a
 * re-enable that revokes grants) and every reviewer assignment or approval takes
 * `review_eligibility_lock()`, then settles actual losses in the same transaction, so an approval
 * and a loss never interleave: the one that commits second sees the other.
 *
 * Lock order (review fix for #122): the eligibility lock comes FIRST, before any project row,
 * account, grant-review lock or grant row. Everything that takes it therefore queues for it while
 * holding nothing, and no two of them can deadlock. A change that may end approvals then locks the
 * projects of every approval it could end (`beginEligibilityChange`), in id order and before any
 * account, because ending one inserts an action request whose foreign key needs its project: taken
 * last, that project lock waited on a writer holding the project and waiting for an account or for
 * this lock. After those: the project the write is about, accounts, the grant-review lock, the
 * grant, its flag and the action item, as documented in project-access.
 */
export async function lockReviewEligibility(client: PoolClient): Promise<void> {
  await client.query('SELECT review_eligibility_lock()');
}

/** Whose approvals an eligibility change may end: some reviewers, or a position rule's holders. */
export type EligibilityChangeScope =
  { reviewers: readonly string[] } | { position: Position; scopeCode: string };

/**
 * Starts an eligibility change: the eligibility lock, then FOR KEY SHARE on the projects of every
 * active approval the change could end (id order). With the eligibility lock held no approval can
 * start, so the set can only shrink before `settleEligibilityLoss` runs; KEY SHARE is exactly what
 * that action request's foreign key takes, so it never has to wait for a project later. Call this
 * first in the transaction, before locking any account.
 */
export async function beginEligibilityChange(
  client: PoolClient,
  affected: EligibilityChangeScope,
): Promise<void> {
  await lockReviewEligibility(client);
  const { text, values } =
    'reviewers' in affected
      ? {
          text: 'a.reviewer_user_id = ANY ($1::uuid[])',
          values: [[...affected.reviewers]],
        }
      : {
          text: `a.scope_code = $2 AND EXISTS (SELECT 1 FROM app_user u
                   WHERE u.id = a.reviewer_user_id AND u.position = $1)`,
          values: [affected.position, affected.scopeCode],
        };
  await client.query(
    `SELECT p.id FROM project p
     WHERE p.id IN (SELECT a.project_id FROM project_review_approval a
                    WHERE a.ended_at IS NULL AND ${text})
     ORDER BY p.id
     FOR KEY SHARE`,
    values,
  );
}

/** The person making the change, as `endGrant` and action requests record them. */
export interface EligibilityChanger {
  by: { userId: string; initials: string | null; displayName: string };
  actor: AuditActor;
}

/**
 * Ends every active review approval whose reviewer is no longer effectively eligible for its
 * scope (`eligibility_lost`), and asks each project's lead (admins when it has none) to reassign.
 * A change that leaves another valid source in place ends nothing. Completed work keeps its
 * attribution: nothing here touches anything but the approval. Call after
 * `beginEligibilityChange` (or with the projects of every approval it could end already locked).
 */
export async function settleEligibilityLoss(
  client: PoolClient,
  change: EligibilityChanger & { reason: string },
): Promise<number> {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM project_review_approval
     WHERE ended_at IS NULL AND NOT reviewer_is_eligible(reviewer_user_id, scope_code)
     ORDER BY id`,
  );
  for (const { id } of rows) {
    const row = await lockGrant(client, REVIEW_APPROVAL, id);
    if (!row || row.endedAt) continue;
    const reason = `Review eligibility lost: ${change.reason}`.slice(0, 2000);
    await endGrant(client, REVIEW_APPROVAL, row, {
      by: change.by,
      reason,
      extra: { end_kind: 'eligibility_lost' },
      actor: change.actor,
      audit: { endKind: 'eligibility_lost' },
    });
    const { rows: items } = await client.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_user_id, target_role, entity_type, entity_id,
                                project_id, created_by_user_id, created_by_initials_snapshot,
                                created_by_name_snapshot, reason)
       SELECT 'review_approval_lost', p.lead_project_engineer_user_id,
              CASE WHEN p.lead_project_engineer_user_id IS NULL THEN 'admin' END,
              'project_review_approval', $1, p.id, $2, $3, $4,
              p.project_number || ': ' || $5 || ' can no longer review ' || s.label
                || '. Reassign or approve a reviewer.'
       FROM project p JOIN review_scope s ON s.code = $6
       WHERE p.id = $7
       RETURNING id`,
      [
        row.id,
        change.by.userId,
        change.by.initials,
        change.by.displayName,
        row.subject.name,
        row.scope,
        row.parentId,
      ],
    );
    if (items[0]) await announceActionItem(client, items[0].id);
  }
  return rows.length;
}

/** Every active scope with whether `userId` may review in it now, and why (MISC-08). */
export async function effectiveEligibility(
  db: Db,
  userId: string,
): Promise<EffectiveEligibility[]> {
  const { rows } = await db.query<{
    code: string;
    label: string;
    eligible: boolean;
    individual: boolean;
    position: boolean;
    excluded: boolean;
  }>(
    `SELECT s.code, s.label, reviewer_is_eligible($1, s.code) AS eligible,
            EXISTS (SELECT 1 FROM reviewer_eligibility e WHERE e.user_id = $1
                      AND e.scope_code = s.code AND e.revoked_at IS NULL) AS individual,
            EXISTS (SELECT 1 FROM review_position_rule r JOIN app_user u ON u.position = r.position
                    WHERE u.id = $1 AND u.account_type <> 'shared_lab' AND r.scope_code = s.code
                      AND r.revoked_at IS NULL) AS position,
            EXISTS (SELECT 1 FROM reviewer_exclusion x WHERE x.user_id = $1
                      AND x.revoked_at IS NULL
                      AND (x.scope_code IS NULL OR x.scope_code = s.code)) AS excluded
     FROM review_scope s WHERE s.active ORDER BY s.sort_order, s.code`,
    [userId],
  );
  return rows.map((row) => ({
    scope: { code: row.code, label: row.label } satisfies ReviewScope,
    eligible: row.eligible,
    individualGrant: row.individual,
    positionRule: row.position,
    excluded: row.excluded,
  }));
}
