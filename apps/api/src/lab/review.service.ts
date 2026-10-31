import { createHash, randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  REVIEW_STATE_LABEL,
  acceptTestRequestSchema,
  endGrantRequestSchema,
  grantDelegationRequestSchema,
  nextReviewState,
  type AcceptanceDelegates,
  type AcceptanceDelegation,
  type CorrectionDoneRequest,
  type ReviewAction,
  type ReviewDecisionRequest,
  type ReviewResult,
  type ReviewState,
  type TestRequestStatus,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { announceActionItem } from '../notifications/action-items.js';
import { lockGrantReviews } from '../project-access/grant-tables.js';
import { parseBody } from '../validation/parse-body.js';
import { actorOf } from './attribution.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Pool | PoolClient;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, code, message }] });
}

const forbidden = () => new ForbiddenException({ code: 'forbidden' });

interface RequestRow {
  id: string;
  program_id: string;
  status: TestRequestStatus;
  review_state: ReviewState | null;
  version: number;
  test_code_snapshot: string;
  program_status: string;
  program_number: string;
  project_id: string;
}

type EventKind = 'review_completed' | 'returned' | 'correction_done' | 'accepted';

/** The active acceptance delegates of a project. */
export async function activeDelegateIds(db: Db, projectId: string): Promise<string[]> {
  const { rows } = await db.query<{ delegate_user_id: string }>(
    `SELECT delegate_user_id FROM acceptance_delegation
     WHERE project_id = $1 AND revoked_at IS NULL`,
    [projectId],
  );
  return rows.map((row) => row.delegate_user_id);
}

/**
 * Review corrections and delegated acceptance (MM-T25).
 *
 * Every action is a personal-account action: the shared LAB account is refused (403) whoever it
 * selects, because a selected person is attribution only. Review decisions need `test.review`
 * (any internal personal account), marking a correction done needs `test.correction_done` (Lab
 * Manager role only), acceptance needs `test.accept` for this project (its Lead Project Engineer or an active
 * delegate; never the Lab Manager or admin role alone).
 *
 * Order: 403, 404, 422 `program_not_open`, 409 (`version_conflict` with the current state,
 * `idempotency_key_reused`, `correction_superseded`), 422 `invalid_transition`. Within one
 * transaction the program is locked (share), then the test (update), then, for acceptance, the
 * project, the actor's account and the actor's delegation (share; D09 lock order). Revocation locks the delegation for update, so an
 * acceptance and a revocation always commit in one order: an acceptance that committed first
 * keeps its attribution, one ordered after the revocation is refused. An exact retry (same key
 * and intent, same account) returns the current result without a second event or action item.
 */
@Injectable()
export class LabReviewService {
  constructor(private readonly database: DatabaseService) {}

  review(testRequestId: string, request: ReviewDecisionRequest, user: AuthUser) {
    if (user.accountType === 'shared_lab') throw forbidden();
    const action: ReviewAction = request.action;
    return this.decide(testRequestId, user, {
      kind: action === 'return' ? 'returned' : 'review_completed',
      action,
      version: request.version,
      idempotencyKey: request.idempotencyKey,
      comment: request.comment,
      hash: intentHash({
        testRequestId,
        action,
        comment: request.comment,
        version: request.version,
      }),
    });
  }

  correctionDone(testRequestId: string, request: CorrectionDoneRequest, user: AuthUser) {
    if (user.accountType === 'shared_lab' || !can(user, 'test.correction_done')) throw forbidden();
    return this.decide(testRequestId, user, {
      kind: 'correction_done',
      action: 'correction_done',
      version: request.version,
      idempotencyKey: request.idempotencyKey,
      comment: request.note,
      actionItemId: request.actionItemId,
      hash: intentHash({
        testRequestId,
        action: 'correction_done',
        note: request.note,
        version: request.version,
        actionItemId: request.actionItemId ?? null,
      }),
    });
  }

  /** Authority is checked before the body: a caller who can't accept here learns nothing more. */
  async accept(testRequestId: string, body: unknown, user: AuthUser) {
    if (user.accountType === 'shared_lab') throw forbidden();
    const peek = UUID_PATTERN.test(testRequestId)
      ? (
          await this.database.pool.query<{
            project_id: string;
            lead_project_engineer_user_id: string | null;
          }>(
            `SELECT lp.project_id, p.lead_project_engineer_user_id FROM test_request r
             JOIN lab_program lp ON lp.id = r.program_id JOIN project p ON p.id = lp.project_id
             WHERE r.id = $1`,
            [testRequestId],
          )
        ).rows[0]
      : undefined;
    if (!peek) {
      if (!can(user, 'test.accept')) throw forbidden();
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    const context = {
      leadProjectEngineerUserId: peek.lead_project_engineer_user_id,
      acceptanceDelegateUserIds: await activeDelegateIds(this.database.pool, peek.project_id),
    };
    if (!can(user, 'test.accept', context)) throw forbidden();
    const request = parseBody(acceptTestRequestSchema, body);
    return this.decide(testRequestId, user, {
      kind: 'accepted',
      action: 'accept',
      version: request.version,
      idempotencyKey: request.idempotencyKey,
      comment: null,
      hash: intentHash({ testRequestId, action: 'accept', version: request.version }),
    });
  }

  private decide(
    testRequestId: string,
    user: AuthUser,
    intent: {
      kind: EventKind;
      action: ReviewAction | 'accept';
      version: number;
      idempotencyKey: string;
      comment: string | null;
      actionItemId?: string;
      hash: string;
    },
  ): Promise<ReviewResult> {
    if (!UUID_PATTERN.test(testRequestId)) {
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    return withTransaction(this.database.pool, async (client) => {
      const { rows: previous } = await client.query<{
        test_request_id: string;
        request_hash: string;
        user_id: string;
      }>(
        `SELECT test_request_id, request_hash, user_id FROM test_request_review_event
         WHERE idempotency_key = $1`,
        [intent.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== intent.hash || previous[0].user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return reviewResult(client, previous[0].test_request_id);
      }

      const { rows: located } = await client.query<{ program_id: string }>(
        'SELECT program_id FROM test_request WHERE id = $1',
        [testRequestId],
      );
      if (!located[0]) throw new NotFoundException({ code: 'test_request_not_found' });
      await client.query('SELECT id FROM lab_program WHERE id = $1 FOR SHARE', [
        located[0].program_id,
      ]);
      const current = (await loadRequest(client, testRequestId))!;

      // Acceptance authority is rechecked under lock: the Lead Project Engineer as the project now stands, or the
      // actor's own still-active grant (held so a revocation waits for this transaction).
      let delegationId: string | null = null;
      if (intent.kind === 'accepted') {
        const { rows: project } = await client.query<{
          lead_project_engineer_user_id: string | null;
        }>('SELECT lead_project_engineer_user_id FROM project WHERE id = $1 FOR SHARE', [
          current.project_id,
        ]);
        // D09: the account too, so a disable that committed first is honoured.
        if (asLocked(user, await lockStanding(client, [user.userId])).status !== 'active') {
          throw forbidden();
        }
        if (project[0]!.lead_project_engineer_user_id !== user.userId) {
          const { rows: grant } = await client.query<{ id: string }>(
            `SELECT id FROM acceptance_delegation
             WHERE project_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL
             FOR SHARE`,
            [current.project_id, user.userId],
          );
          if (!grant[0]) throw forbidden();
          delegationId = grant[0].id;
        }
      }

      if (current.program_status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'this program is not open');
      }
      if (current.version !== intent.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: {
            testRequestId,
            status: current.status,
            reviewState: current.review_state,
            version: current.version,
          },
        });
      }
      if (current.status !== 'review' || current.review_state === null) {
        unprocessable(
          'invalid_transition',
          'id',
          current.status === 'accepted'
            ? 'this test is already accepted'
            : 'this test is not in review',
        );
      }
      const from = current.review_state;
      let to: ReviewState | null;
      if (intent.kind === 'accepted') {
        if (from !== 'review_complete') {
          unprocessable('review_not_complete', 'id', 'Review not complete');
        }
        to = null;
      } else {
        to = nextReviewState(from, intent.action as ReviewAction);
        if (!to) {
          unprocessable(
            'invalid_transition',
            'action',
            `a test that is ${REVIEW_STATE_LABEL[from].toLowerCase()} can't be ${
              intent.kind === 'returned'
                ? 'returned for correction'
                : intent.kind === 'correction_done'
                  ? 'marked correction done'
                  : 'marked review complete'
            }`,
          );
        }
      }

      const { rows: openItems } = await client.query<{ id: string }>(
        `SELECT id FROM action_item
         WHERE kind = 'correction' AND entity_id = $1 AND status = 'open' FOR UPDATE`,
        [testRequestId],
      );
      const openItem = openItems[0] ?? null;
      if (intent.kind === 'correction_done') {
        if (!openItem || (intent.actionItemId && intent.actionItemId !== openItem.id)) {
          throw new ConflictException({ code: 'correction_superseded' });
        }
      }
      const { rows: cycles } = await client.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM test_request_review_event
         WHERE test_request_id = $1 AND kind = 'returned'`,
        [testRequestId],
      );
      const cycle = cycles[0]!.n + (intent.kind === 'returned' ? 1 : 0);

      const { rows: events } = await client.query<{ id: string }>(
        `INSERT INTO test_request_review_event
           (test_request_id, program_id, kind, from_review_state, to_review_state, comment,
            correction_cycle, user_id, account_type, initials_snapshot, name_snapshot,
            delegation_id, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [
          testRequestId,
          current.program_id,
          intent.kind,
          from,
          to,
          intent.comment,
          cycle,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          delegationId,
          intent.idempotencyKey,
          intent.hash,
        ],
      );
      const eventId = events[0]!.id;

      let actionItemId: string | null = null;
      if (intent.kind === 'returned') {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO action_item (kind, target_role, entity_type, entity_id, program_id,
                                    opened_by_event_id, created_by_user_id)
           VALUES ('correction', 'lab_manager', 'test_request', $1, $2, $3, $4) RETURNING id`,
          [testRequestId, current.program_id, eventId, user.userId],
        );
        actionItemId = rows[0]!.id;
        await announceActionItem(client, actionItemId);
      } else if (intent.kind === 'correction_done') {
        actionItemId = openItem!.id;
        await client.query(
          `UPDATE action_item SET status = 'resolved', resolved_at = now(),
                  resolved_by_user_id = $2, resolved_by_event_id = $3
           WHERE id = $1`,
          [actionItemId, user.userId, eventId],
        );
      }

      if (intent.kind === 'accepted') {
        await client.query(
          `UPDATE test_request
           SET status = 'accepted', review_state = NULL, version = version + 1,
               accepted_at = now(), accepted_by_user_id = $2, accepted_via_delegation_id = $3,
               status_changed_at = now(), status_changed_by_account_user_id = $2,
               status_changed_for_user_id = $2
           WHERE id = $1`,
          [testRequestId, user.userId, delegationId],
        );
        // The progress timeline shows acceptance too (own key: it is a different table).
        await client.query(
          `INSERT INTO test_request_status_history
             (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
              account_initials_snapshot, account_name_snapshot, person_user_id,
              person_initials_snapshot, person_name_snapshot, idempotency_key, request_hash)
           VALUES ($1, $2, 'review', 'accepted', $3, $4, $5, $6, $3, $5, $6, $7, $8)`,
          [
            testRequestId,
            current.program_id,
            user.userId,
            user.accountType,
            user.initials,
            user.displayName,
            randomUUID(),
            `review-event:${eventId}`,
          ],
        );
      } else {
        await client.query(
          'UPDATE test_request SET review_state = $2, version = version + 1 WHERE id = $1',
          [testRequestId, to],
        );
      }

      await recordAudit(client, {
        action: `test_request.${
          intent.kind === 'review_completed'
            ? 'review_completed'
            : intent.kind === 'returned'
              ? 'returned_for_correction'
              : intent.kind
        }`,
        entityType: 'test_request',
        entityId: testRequestId,
        actor: actorOf(user),
        reason: intent.comment,
        before: { status: current.status, reviewState: from },
        after: {
          status: intent.kind === 'accepted' ? 'accepted' : 'review',
          reviewState: to,
          programNumber: current.program_number,
          code: current.test_code_snapshot,
          correctionCycle: cycle,
          ...(actionItemId ? { actionItemId } : {}),
          ...(intent.kind === 'accepted' ? { viaDelegationId: delegationId } : {}),
        },
      });
      return reviewResult(client, testRequestId);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Acceptance delegation (project page)
  // -------------------------------------------------------------------------------------------

  async delegates(projectId: string, user: AuthUser): Promise<AcceptanceDelegates> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return loadDelegates(this.database.pool, projectId, {
      canManage: can(user, 'acceptance_delegation.manage', {
        leadProjectEngineerUserId: project.lead_project_engineer_user_id,
      }),
    });
  }

  /**
   * Only the project's Lead Project Engineer grants, with a reason (D15). A repeated grant can't
   * stack a second active one. Lock order: the project (FOR UPDATE), then the lead's and the
   * delegate's accounts (FOR SHARE), so a lead change, role change or disable that committed first
   * is honoured (D09).
   */
  async grant(projectId: string, body: unknown, user: AuthUser): Promise<AcceptanceDelegates> {
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR UPDATE');
      if (!project) {
        if (!can(user, 'acceptance_delegation.manage')) throw forbidden();
        throw new NotFoundException({ code: 'project_not_found' });
      }
      const context = { leadProjectEngineerUserId: project.lead_project_engineer_user_id };
      if (!can(user, 'acceptance_delegation.manage', context)) {
        throw forbidden();
      }
      const request = parseBody(grantDelegationRequestSchema, body);
      const standing = await lockStanding(client, [user.userId, request.delegateUserId]);
      if (!can(asLocked(user, standing), 'acceptance_delegation.manage', context)) {
        throw forbidden();
      }
      const hash = intentHash({
        projectId,
        delegateUserId: request.delegateUserId,
        reason: request.reason,
      });
      const { rows: previous } = await client.query<{
        grant_request_hash: string;
        granted_by_user_id: string;
      }>(
        `SELECT grant_request_hash, granted_by_user_id FROM acceptance_delegation
         WHERE grant_idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (
          previous[0].grant_request_hash !== hash ||
          previous[0].granted_by_user_id !== user.userId
        ) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return loadDelegates(client, projectId, { canManage: true });
      }
      const delegate = standing.get(request.delegateUserId);
      if (!isActiveStaff(delegate)) {
        unprocessable('invalid_delegate', 'delegateUserId', 'must be an active staff member');
      }
      if (delegate.userId === project.lead_project_engineer_user_id) {
        unprocessable(
          'invalid_delegate',
          'delegateUserId',
          'the project’s Lead Project Engineer already accepts on this project',
        );
      }
      const { rows: active } = await client.query(
        `SELECT 1 FROM acceptance_delegation
         WHERE project_id = $1 AND delegate_user_id = $2 AND revoked_at IS NULL`,
        [projectId, delegate.userId],
      );
      if (active.length > 0) {
        unprocessable('already_delegated', 'delegateUserId', 'already an acceptance delegate');
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO acceptance_delegation
           (project_id, delegate_user_id, delegate_initials_snapshot, delegate_name_snapshot,
            granted_by_user_id, granted_by_initials_snapshot, granted_by_name_snapshot,
            grant_reason, grant_idempotency_key, grant_request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
        [
          projectId,
          delegate.userId,
          delegate.initials,
          delegate.displayName,
          user.userId,
          user.initials,
          user.displayName,
          request.reason,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'acceptance_delegation.granted',
        entityType: 'acceptance_delegation',
        entityId: rows[0]!.id,
        actor: actorOf(user),
        reason: request.reason,
        after: {
          projectId,
          projectNumber: project.project_number,
          delegateUserId: delegate.userId,
          delegateName: delegate.displayName,
        },
      });
      return loadDelegates(client, projectId, { canManage: true });
    });
  }

  /**
   * Only the project's Lead Project Engineer revokes, with a reason (D15). Blocks new acceptances
   * at once; acceptances already made keep their attribution. Revoking an already revoked grant
   * changes nothing.
   */
  async revoke(projectId: string, delegationId: string, body: unknown, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR SHARE');
      if (!project) {
        if (!can(user, 'acceptance_delegation.manage')) throw forbidden();
        throw new NotFoundException({ code: 'project_not_found' });
      }
      const context = { leadProjectEngineerUserId: project.lead_project_engineer_user_id };
      if (!can(user, 'acceptance_delegation.manage', context)) {
        throw forbidden();
      }
      const { reason } = parseBody(endGrantRequestSchema, body);
      const standing = await lockStanding(client, [user.userId]);
      if (!can(asLocked(user, standing), 'acceptance_delegation.manage', context)) {
        throw forbidden();
      }
      if (!UUID_PATTERN.test(delegationId)) {
        throw new NotFoundException({ code: 'delegation_not_found' });
      }
      // Revoking settles the delegation's review flag (MTR-25): lock order as every grant ending.
      await lockGrantReviews(client, [projectId]);
      const { rows } = await client.query<{
        id: string;
        revoked_at: Date | null;
        delegate_user_id: string;
        delegate_name_snapshot: string;
      }>(
        `SELECT id, revoked_at, delegate_user_id, delegate_name_snapshot
         FROM acceptance_delegation WHERE id = $1 AND project_id = $2 FOR UPDATE`,
        [delegationId, projectId],
      );
      const grant = rows[0];
      if (!grant) throw new NotFoundException({ code: 'delegation_not_found' });
      if (!grant.revoked_at) {
        await client.query(
          `UPDATE acceptance_delegation
           SET revoked_at = now(), revoked_by_user_id = $2, revoked_by_initials_snapshot = $3,
               revoked_by_name_snapshot = $4, revoke_reason = $5
           WHERE id = $1`,
          [delegationId, user.userId, user.initials, user.displayName, reason],
        );
        await recordAudit(client, {
          action: 'acceptance_delegation.revoked',
          entityType: 'acceptance_delegation',
          entityId: delegationId,
          actor: actorOf(user),
          reason,
          before: { active: true },
          after: {
            active: false,
            projectId,
            projectNumber: project.project_number,
            delegateUserId: grant.delegate_user_id,
            delegateName: grant.delegate_name_snapshot,
          },
        });
      }
      return loadDelegates(client, projectId, { canManage: true });
    });
  }
}

async function loadRequest(client: PoolClient, id: string) {
  const { rows } = await client.query<RequestRow>(
    `SELECT r.id, r.program_id, r.status, r.review_state, r.version, r.test_code_snapshot,
            lp.status AS program_status, lp.program_number, lp.project_id
     FROM test_request r JOIN lab_program lp ON lp.id = r.program_id
     WHERE r.id = $1 FOR UPDATE OF r`,
    [id],
  );
  return rows[0] ?? null;
}

async function reviewResult(db: Db, testRequestId: string): Promise<ReviewResult> {
  const { rows } = await db.query<{
    status: 'review' | 'accepted';
    review_state: ReviewState | null;
    version: number;
  }>('SELECT status, review_state, version FROM test_request WHERE id = $1', [testRequestId]);
  const row = rows[0]!;
  return { testRequestId, status: row.status, reviewState: row.review_state, version: row.version };
}

async function findProject(db: Db, id: string, lock: '' | 'FOR SHARE' | 'FOR UPDATE' = '') {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<{
    id: string;
    lead_project_engineer_user_id: string | null;
    project_number: string;
  }>(
    `SELECT id, lead_project_engineer_user_id, project_number FROM project WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadDelegates(
  db: Db,
  projectId: string,
  options: { canManage: boolean },
): Promise<AcceptanceDelegates> {
  const { rows } = await db.query<{
    id: string;
    delegate_user_id: string;
    delegate_initials_snapshot: string | null;
    delegate_name_snapshot: string;
    granted_by_user_id: string;
    granted_by_initials_snapshot: string | null;
    granted_by_name_snapshot: string;
    granted_at: Date;
    grant_reason: string | null;
    revoke_reason: string | null;
    revoked_by_user_id: string | null;
    revoked_by_initials_snapshot: string | null;
    revoked_by_name_snapshot: string | null;
    revoked_at: Date | null;
  }>(
    `SELECT * FROM acceptance_delegation WHERE project_id = $1
     ORDER BY granted_at DESC, id`,
    [projectId],
  );
  const all: AcceptanceDelegation[] = rows.map((row) => ({
    id: row.id,
    delegate: {
      userId: row.delegate_user_id,
      initials: row.delegate_initials_snapshot,
      name: row.delegate_name_snapshot,
    },
    grantedBy: {
      userId: row.granted_by_user_id,
      initials: row.granted_by_initials_snapshot,
      name: row.granted_by_name_snapshot,
    },
    grantedAt: row.granted_at.toISOString(),
    grantReason: row.grant_reason,
    revokeReason: row.revoke_reason,
    revokedBy: row.revoked_by_user_id
      ? {
          userId: row.revoked_by_user_id,
          initials: row.revoked_by_initials_snapshot,
          name: row.revoked_by_name_snapshot ?? '',
        }
      : null,
    revokedAt: row.revoked_at?.toISOString() ?? null,
  }));
  return {
    projectId,
    canManage: options.canManage,
    active: all.filter((grant) => grant.revokedAt === null),
    history: all.filter((grant) => grant.revokedAt !== null),
  };
}
