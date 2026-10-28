import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CANCELLABLE_STATUSES,
  REPEATABLE_STATUSES,
  cancelTestRequestSchema,
  closeProgramRequestSchema,
  closureEligibility,
  reopenProgramRequestSchema,
  type CloseBlockedReason,
  type LifecycleRequest,
  type LifecycleRequestResult,
  type ProgramLifecycle,
  type ProgramLifecycleResult,
  type RepeatTestRequest,
  type RequestLifecycle,
  type ReviewState,
  type TestRequestResult,
  type TestRequestStatus,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser, type ProjectContext } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { parseBody } from '../validation/parse-body.js';
import { actorOf } from './attribution.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Pool | PoolClient;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unprocessable(code: string, field: string, message: string, extra = {}): never {
  throw new UnprocessableEntityException({
    code,
    errors: [{ field, code, message }],
    ...extra,
  });
}

const forbidden = () => new ForbiddenException({ code: 'forbidden' });

interface ProgramRow {
  id: string;
  status: 'draft' | 'submitted' | 'closed';
  version: number;
  program_number: string | null;
  project_id: string;
  pm_pe_user_id: string;
}

interface RequestRow {
  id: string;
  program_id: string;
  line_id: string;
  test_type_id: string;
  status: TestRequestStatus;
  review_state: ReviewState | null;
  version: number;
  test_code_snapshot: string;
  cancel_reason: string | null;
}

/**
 * Program lifecycle, cancellation and repeats (MM-T26).
 *
 * Every action here is a personal-account action: the shared LAB account is refused (403)
 * whoever it selects, because a selected person is attribution only (its T23/T24 allow-list
 * never covers these). Close: the project's PM/PE (`program.close`; a delegate can't). Reopen and
 * cancel: the project's PM/PE or a Lab Manager. Requests and repeats: any internal personal
 * account.
 *
 * Order: 403, 404, 422 `program_not_open`, 409 (`version_conflict` with the current state,
 * `idempotency_key_reused`, `already_requested`), 422 (`invalid_transition`, `empty_program`,
 * `closure_blocked` with the blockers). Lock order: the program (FOR UPDATE for close, reopen and
 * repeat; FOR SHARE otherwise, as review does), then its tests. Closing therefore waits for any
 * cancellation, repeat or review in flight and sees its result, and none of them can slip in
 * after a close commits. Exact retries return the original result without new history.
 */
@Injectable()
export class LabLifecycleService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Program: close, reopen, request closure
  // -------------------------------------------------------------------------------------------

  async close(programId: string, body: unknown, user: AuthUser): Promise<ProgramLifecycleResult> {
    await this.authoriseProgram(programId, user, 'program.close');
    const request = parseBody(closeProgramRequestSchema, body);
    const hash = intentHash({ programId, action: 'close', version: request.version });
    return withTransaction(this.database.pool, async (client) => {
      const replay = await replayProgramEvent(client, request.idempotencyKey, hash, user);
      if (replay) return replay;
      const program = (await lockProgram(client, programId, 'FOR UPDATE'))!;
      // Authority as the project stands now (a PM/PE change since the check is honoured).
      if (!can(user, 'program.close', { pmPeUserId: program.pm_pe_user_id })) throw forbidden();
      if (program.status !== 'submitted') {
        unprocessable(
          'program_not_open',
          'id',
          program.status === 'closed'
            ? 'this program is already closed'
            : 'this program is not open',
        );
      }
      if (program.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { programId, status: program.status, version: program.version },
        });
      }
      // Lock every test so no cancellation, progress or acceptance changes them mid-check, then
      // decide on what is actually there (an empty program is never closable).
      const { rows: tests } = await client.query<{
        id: string;
        status: TestRequestStatus;
        review_state: ReviewState | null;
        cancel_reason: string | null;
      }>(
        `SELECT id, status, review_state, cancel_reason FROM test_request
         WHERE program_id = $1 ORDER BY id FOR SHARE`,
        [programId],
      );
      const closure = closureEligibility(
        tests.map((t) => ({
          id: t.id,
          status: t.status,
          reviewState: t.review_state,
          cancelReason: t.cancel_reason,
        })),
      );
      if (closure.emptyProgram) {
        unprocessable('empty_program', 'id', closure.summary, { closure });
      }
      if (!closure.eligible) {
        unprocessable('closure_blocked', 'id', closure.summary, { closure });
      }
      const { rows } = await client.query<{ version: number }>(
        `UPDATE lab_program
         SET status = 'closed', closed_at = now(), closed_by_user_id = $2,
             closed_by_initials_snapshot = $3, closed_by_name_snapshot = $4,
             version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version`,
        [programId, user.userId, user.initials, user.displayName],
      );
      await insertProgramEvent(
        client,
        programId,
        'closed',
        null,
        user,
        request.idempotencyKey,
        hash,
      );
      const resolved = await resolveItems(
        client,
        `kind = 'closure_request' AND entity_id = $1`,
        programId,
        user,
        'closed',
      );
      await recordAudit(client, {
        action: 'lab_program.closed',
        entityType: 'lab_program',
        entityId: programId,
        actor: actorOf(user),
        before: { status: 'submitted' },
        after: {
          status: 'closed',
          programNumber: program.program_number,
          accepted: tests.filter((t) => t.status === 'accepted').length,
          cancelled: tests.filter((t) => t.status === 'cancelled').length,
          ...(resolved.length > 0 ? { resolvedClosureRequests: resolved } : {}),
        },
      });
      return { programId, status: 'closed', version: rows[0]!.version };
    });
  }

  async reopen(programId: string, body: unknown, user: AuthUser): Promise<ProgramLifecycleResult> {
    await this.authoriseProgram(programId, user, 'program.reopen');
    const request = parseBody(reopenProgramRequestSchema, body);
    const hash = intentHash({
      programId,
      action: 'reopen',
      reason: request.reason,
      version: request.version,
    });
    return withTransaction(this.database.pool, async (client) => {
      const replay = await replayProgramEvent(client, request.idempotencyKey, hash, user);
      if (replay) return replay;
      const program = (await lockProgram(client, programId, 'FOR UPDATE'))!;
      if (!can(user, 'program.reopen', { pmPeUserId: program.pm_pe_user_id })) throw forbidden();
      if (program.status !== 'closed') {
        unprocessable('program_not_closed', 'id', 'only a closed program can be reopened');
      }
      if (program.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { programId, status: program.status, version: program.version },
        });
      }
      // Only the program's status changes: every test keeps its status, acceptance and history.
      const { rows } = await client.query<{ version: number }>(
        `UPDATE lab_program
         SET status = 'submitted', closed_at = NULL, closed_by_user_id = NULL,
             closed_by_initials_snapshot = NULL, closed_by_name_snapshot = NULL,
             version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version`,
        [programId],
      );
      await insertProgramEvent(
        client,
        programId,
        'reopened',
        request.reason,
        user,
        request.idempotencyKey,
        hash,
      );
      await recordAudit(client, {
        action: 'lab_program.reopened',
        entityType: 'lab_program',
        entityId: programId,
        actor: actorOf(user),
        reason: request.reason,
        before: { status: 'closed' },
        after: { status: 'submitted', programNumber: program.program_number },
      });
      return { programId, status: 'submitted', version: rows[0]!.version };
    });
  }

  /** Any internal personal account asks the PM/PE to close; the program stays open. */
  async requestClose(
    programId: string,
    request: LifecycleRequest,
    user: AuthUser,
  ): Promise<LifecycleRequestResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    if (!UUID_PATTERN.test(programId))
      throw new NotFoundException({ code: 'lab_program_not_found' });
    const hash = intentHash({ programId, action: 'close_request', reason: request.reason });
    return this.withRequestKey(request.idempotencyKey, hash, user, async (client) => {
      const program = await lockProgram(client, programId, 'FOR SHARE');
      if (!program || program.status === 'draft') {
        throw new NotFoundException({ code: 'lab_program_not_found' });
      }
      if (program.status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'this program is not open');
      }
      await refuseDuplicateRequest(client, 'closure_request', programId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_user_id, entity_type, entity_id, program_id,
                                  created_by_user_id, created_by_initials_snapshot,
                                  created_by_name_snapshot, reason, idempotency_key, request_hash)
         VALUES ('closure_request', $1, 'lab_program', $2, $2, $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          program.pm_pe_user_id,
          programId,
          user.userId,
          user.initials,
          user.displayName,
          request.reason,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'lab_program.closure_requested',
        entityType: 'lab_program',
        entityId: programId,
        actor: actorOf(user),
        reason: request.reason,
        after: { programNumber: program.program_number, actionItemId: rows[0]!.id },
      });
      return { actionItemId: rows[0]!.id };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Tests: cancel, request cancellation, repeat
  // -------------------------------------------------------------------------------------------

  async cancel(testRequestId: string, body: unknown, user: AuthUser): Promise<TestRequestResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    const peek = await this.peekRequest(testRequestId);
    if (!peek) {
      if (!can(user, 'test.cancel')) throw forbidden();
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    if (!can(user, 'test.cancel', { pmPeUserId: peek.pm_pe_user_id })) throw forbidden();
    const request = parseBody(cancelTestRequestSchema, body);
    const hash = intentHash({
      testRequestId,
      action: 'cancel',
      reason: request.reason,
      version: request.version,
    });
    return withTransaction(this.database.pool, async (client) => {
      const { rows: previous } = await client.query<{
        test_request_id: string;
        request_hash: string;
        account_user_id: string;
      }>(
        `SELECT test_request_id, request_hash, account_user_id FROM test_request_status_history
         WHERE idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== hash || previous[0].account_user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return requestResult(client, previous[0].test_request_id);
      }
      const program = (await lockProgram(client, peek.program_id, 'FOR SHARE'))!;
      if (!can(user, 'test.cancel', { pmPeUserId: program.pm_pe_user_id })) throw forbidden();
      const current = (await lockRequest(client, testRequestId, 'FOR UPDATE'))!;
      if (program.status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'reopen this program first');
      }
      if (current.version !== request.version) {
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
      if (!CANCELLABLE_STATUSES.includes(current.status)) {
        unprocessable(
          'invalid_transition',
          'id',
          current.status === 'cancelled'
            ? 'this test is already cancelled'
            : 'an accepted test can’t be cancelled',
        );
      }
      await client.query(
        `UPDATE test_request
         SET status = 'cancelled', review_state = NULL, version = version + 1,
             cancel_reason = $2, cancelled_at = now(), cancelled_by_user_id = $3,
             cancelled_by_initials_snapshot = $4, cancelled_by_name_snapshot = $5,
             status_changed_at = now(), status_changed_by_account_user_id = $3,
             status_changed_for_user_id = $3
         WHERE id = $1`,
        [testRequestId, request.reason, user.userId, user.initials, user.displayName],
      );
      await client.query(
        `INSERT INTO test_request_status_history
           (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
            account_initials_snapshot, account_name_snapshot, person_user_id,
            person_initials_snapshot, person_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, 'cancelled', $4, $5, $6, $7, $4, $6, $7, $8, $9)`,
        [
          testRequestId,
          current.program_id,
          current.status,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          request.idempotencyKey,
          hash,
        ],
      );
      // Nothing is left to correct or decide: an outstanding correction and any cancellation
      // request are resolved by this cancellation (their history stays).
      const resolved = await resolveItems(
        client,
        `kind IN ('correction', 'cancellation_request') AND entity_id = $1`,
        testRequestId,
        user,
        'cancelled',
      );
      await recordAudit(client, {
        action: 'test_request.cancelled',
        entityType: 'test_request',
        entityId: testRequestId,
        actor: actorOf(user),
        reason: request.reason,
        before: { status: current.status, reviewState: current.review_state },
        after: {
          status: 'cancelled',
          programNumber: program.program_number,
          code: current.test_code_snapshot,
          ...(resolved.length > 0 ? { resolvedActionItems: resolved } : {}),
        },
      });
      return requestResult(client, testRequestId);
    });
  }

  /** Any internal personal account asks for a cancellation; the test is unchanged. */
  async requestCancel(
    testRequestId: string,
    request: LifecycleRequest,
    user: AuthUser,
  ): Promise<LifecycleRequestResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    const peek = await this.peekRequest(testRequestId);
    if (!peek) throw new NotFoundException({ code: 'test_request_not_found' });
    const hash = intentHash({ testRequestId, action: 'cancel_request', reason: request.reason });
    return this.withRequestKey(request.idempotencyKey, hash, user, async (client) => {
      const program = (await lockProgram(client, peek.program_id, 'FOR SHARE'))!;
      const current = (await lockRequest(client, testRequestId, 'FOR UPDATE'))!;
      if (program.status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'this program is not open');
      }
      if (!CANCELLABLE_STATUSES.includes(current.status)) {
        unprocessable(
          'invalid_transition',
          'id',
          current.status === 'cancelled'
            ? 'this test is already cancelled'
            : 'an accepted test can’t be cancelled',
        );
      }
      await refuseDuplicateRequest(client, 'cancellation_request', testRequestId);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_role, target_user_id, entity_type, entity_id,
                                  program_id, created_by_user_id, created_by_initials_snapshot,
                                  created_by_name_snapshot, reason, idempotency_key, request_hash)
         VALUES ('cancellation_request', 'lab_manager', $1, 'test_request', $2, $3, $4, $5, $6,
                 $7, $8, $9)
         RETURNING id`,
        [
          program.pm_pe_user_id,
          testRequestId,
          program.id,
          user.userId,
          user.initials,
          user.displayName,
          request.reason,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'test_request.cancellation_requested',
        entityType: 'test_request',
        entityId: testRequestId,
        actor: actorOf(user),
        reason: request.reason,
        after: {
          programNumber: program.program_number,
          code: current.test_code_snapshot,
          actionItemId: rows[0]!.id,
        },
      });
      return { actionItemId: rows[0]!.id };
    });
  }

  /**
   * A genuine repeat of an Accepted test: a new Requested request on the same line and test,
   * linked to the original, which is unchanged. No material is allocated here; completing the
   * repeat names its exact units (T24), which never accepts disposed or removed units.
   */
  async repeat(
    testRequestId: string,
    request: RepeatTestRequest,
    user: AuthUser,
  ): Promise<TestRequestResult> {
    if (user.accountType === 'shared_lab') throw forbidden();
    const peek = await this.peekRequest(testRequestId);
    if (!peek) throw new NotFoundException({ code: 'test_request_not_found' });
    const hash = intentHash({ testRequestId, action: 'repeat', version: request.version });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows: previous } = await client.query<{
          id: string;
          create_request_hash: string;
          created_by_user_id: string;
        }>(
          `SELECT id, create_request_hash, created_by_user_id FROM test_request
           WHERE create_idempotency_key = $1`,
          [request.idempotencyKey],
        );
        if (previous[0]) {
          if (
            previous[0].create_request_hash !== hash ||
            previous[0].created_by_user_id !== user.userId
          ) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return requestResult(client, previous[0].id);
        }
        // FOR UPDATE: a repeat changes the program's set of tests, so it serialises with close.
        const program = (await lockProgram(client, peek.program_id, 'FOR UPDATE'))!;
        const original = (await lockRequest(client, testRequestId, 'FOR SHARE'))!;
        if (program.status !== 'submitted') {
          unprocessable('program_not_open', 'id', 'reopen this program before adding a repeat');
        }
        if (original.version !== request.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: {
              testRequestId,
              status: original.status,
              reviewState: original.review_state,
              version: original.version,
            },
          });
        }
        if (!REPEATABLE_STATUSES.includes(original.status)) {
          unprocessable('invalid_transition', 'id', 'only an accepted test can be repeated');
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                     test_name_snapshot, test_description_snapshot,
                                     test_group_snapshot, test_subgroup_snapshot, sort_order,
                                     repeat_of_id, created_by_user_id, created_by_name_snapshot,
                                     create_idempotency_key, create_request_hash)
           SELECT program_id, line_id, test_type_id, test_code_snapshot, test_name_snapshot,
                  test_description_snapshot, test_group_snapshot, test_subgroup_snapshot,
                  sort_order, id, $2, $3, $4, $5
           FROM test_request WHERE id = $1
           RETURNING id`,
          [testRequestId, user.userId, user.displayName, request.idempotencyKey, hash],
        );
        const repeatId = rows[0]!.id;
        await client.query(
          'UPDATE lab_program SET version = version + 1, updated_at = now() WHERE id = $1',
          [program.id],
        );
        await recordAudit(client, {
          action: 'test_request.repeat_created',
          entityType: 'test_request',
          entityId: repeatId,
          actor: actorOf(user),
          after: {
            programNumber: program.program_number,
            code: original.test_code_snapshot,
            repeatOfId: testRequestId,
          },
        });
        return requestResult(client, repeatId);
      });
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'test_request_create_idempotency_key_key'
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  /** 403 before 404: a caller who could never do this learns nothing about the program. */
  private async authoriseProgram(
    programId: string,
    user: AuthUser,
    permission: 'program.close' | 'program.reopen',
  ) {
    if (user.accountType === 'shared_lab') throw forbidden();
    const program = await lockProgram(this.database.pool, programId, '');
    if (!program || program.status === 'draft') {
      if (!can(user, permission)) throw forbidden();
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    if (!can(user, permission, { pmPeUserId: program.pm_pe_user_id })) throw forbidden();
  }

  private async peekRequest(testRequestId: string) {
    if (!UUID_PATTERN.test(testRequestId)) return null;
    const { rows } = await this.database.pool.query<{ program_id: string; pm_pe_user_id: string }>(
      `SELECT r.program_id, p.pm_pe_user_id FROM test_request r
       JOIN lab_program lp ON lp.id = r.program_id JOIN project p ON p.id = lp.project_id
       WHERE r.id = $1`,
      [testRequestId],
    );
    return rows[0] ?? null;
  }

  /** Runs a request-creating action under its retry key: an exact retry returns the same item. */
  private async withRequestKey(
    key: string,
    hash: string,
    user: AuthUser,
    action: (client: PoolClient) => Promise<LifecycleRequestResult>,
  ): Promise<LifecycleRequestResult> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { rows } = await client.query<{
          id: string;
          request_hash: string;
          created_by_user_id: string;
        }>(
          'SELECT id, request_hash, created_by_user_id FROM action_item WHERE idempotency_key = $1',
          [key],
        );
        if (rows[0]) {
          if (rows[0].request_hash !== hash || rows[0].created_by_user_id !== user.userId) {
            throw new ConflictException({ code: 'idempotency_key_reused' });
          }
          return { actionItemId: rows[0].id };
        }
        return action(client);
      });
    } catch (error) {
      if (error instanceof DatabaseError && error.code === '23505') {
        if (error.constraint === 'action_item_idempotency_key_key') {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        if (error.constraint === 'action_item_open_request_key') {
          throw new ConflictException({ code: 'already_requested' });
        }
      }
      throw error;
    }
  }
}

async function lockProgram(db: Db, id: string, lock: '' | 'FOR SHARE' | 'FOR UPDATE') {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ProgramRow>(
    `SELECT lp.id, lp.status, lp.version, lp.program_number, lp.project_id, p.pm_pe_user_id
     FROM lab_program lp JOIN project p ON p.id = lp.project_id
     WHERE lp.id = $1 ${lock ? `${lock} OF lp` : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function lockRequest(client: PoolClient, id: string, lock: 'FOR SHARE' | 'FOR UPDATE') {
  const { rows } = await client.query<RequestRow>(
    `SELECT id, program_id, line_id, test_type_id, status, review_state, version,
            test_code_snapshot, cancel_reason
     FROM test_request WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

async function requestResult(db: Db, id: string): Promise<TestRequestResult> {
  const { rows } = await db.query<{ status: string; version: number }>(
    'SELECT status, version FROM test_request WHERE id = $1',
    [id],
  );
  return { testRequestId: id, status: rows[0]!.status, version: rows[0]!.version };
}

async function replayProgramEvent(
  client: PoolClient,
  key: string,
  hash: string,
  user: AuthUser,
): Promise<ProgramLifecycleResult | null> {
  const { rows } = await client.query<{
    program_id: string;
    request_hash: string;
    user_id: string;
  }>(
    'SELECT program_id, request_hash, user_id FROM program_lifecycle_event WHERE idempotency_key = $1',
    [key],
  );
  const previous = rows[0];
  if (!previous) return null;
  if (previous.request_hash !== hash || previous.user_id !== user.userId) {
    throw new ConflictException({ code: 'idempotency_key_reused' });
  }
  const { rows: program } = await client.query<{ status: 'submitted' | 'closed'; version: number }>(
    'SELECT status, version FROM lab_program WHERE id = $1',
    [previous.program_id],
  );
  return { programId: previous.program_id, ...program[0]! };
}

async function insertProgramEvent(
  client: PoolClient,
  programId: string,
  kind: 'closed' | 'reopened',
  reason: string | null,
  user: AuthUser,
  key: string,
  hash: string,
) {
  await client.query(
    `INSERT INTO program_lifecycle_event (program_id, kind, reason, user_id, account_type,
                                          initials_snapshot, name_snapshot, idempotency_key,
                                          request_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
    [
      programId,
      kind,
      reason,
      user.userId,
      user.accountType,
      user.initials,
      user.displayName,
      key,
      hash,
    ],
  );
}

async function refuseDuplicateRequest(client: PoolClient, kind: string, entityId: string) {
  const { rows } = await client.query<{ id: string }>(
    `SELECT id FROM action_item WHERE kind = $1 AND entity_id = $2 AND status = 'open'`,
    [kind, entityId],
  );
  if (rows[0]) throw new ConflictException({ code: 'already_requested', actionItemId: rows[0].id });
}

async function resolveItems(
  client: PoolClient,
  where: string,
  entityId: string,
  user: AuthUser,
  resolution: 'cancelled' | 'closed',
): Promise<string[]> {
  const { rows } = await client.query<{ id: string }>(
    `UPDATE action_item SET status = 'resolved', resolved_at = now(), resolved_by_user_id = $2,
            resolution = $3
     WHERE ${where} AND status = 'open' RETURNING id`,
    [entityId, user.userId, resolution],
  );
  return rows.map((row) => row.id);
}

// ---------------------------------------------------------------------------------------------
// Work view: lifecycle standing for the signed-in account
// ---------------------------------------------------------------------------------------------

export interface LifecycleRequestRow {
  id: string;
  status: TestRequestStatus;
  review_state: ReviewState | null;
  cancel_reason: string | null;
  cancelled_at: Date | null;
  cancelled_by_user_id: string | null;
  cancelled_by_initials_snapshot: string | null;
  cancelled_by_name_snapshot: string | null;
  repeat_of_id: string | null;
}

/** Program lifecycle, closure eligibility and history as `user` sees it. */
export async function loadProgramLifecycle(
  db: Db,
  programId: string,
  requests: LifecycleRequestRow[],
  user: AuthUser,
): Promise<ProgramLifecycle> {
  const [program, events] = await Promise.all([
    db.query<{
      status: 'submitted' | 'closed';
      version: number;
      closed_at: Date | null;
      closed_by_user_id: string | null;
      closed_by_initials_snapshot: string | null;
      closed_by_name_snapshot: string | null;
      pm_pe_user_id: string;
    }>(
      `SELECT lp.status, lp.version, lp.closed_at, lp.closed_by_user_id,
              lp.closed_by_initials_snapshot, lp.closed_by_name_snapshot, p.pm_pe_user_id
       FROM lab_program lp JOIN project p ON p.id = lp.project_id WHERE lp.id = $1`,
      [programId],
    ),
    db.query<{
      id: string;
      kind: 'closed' | 'reopened';
      reason: string | null;
      user_id: string;
      initials_snapshot: string | null;
      name_snapshot: string;
      occurred_at: Date;
    }>(
      `SELECT id, kind, reason, user_id, initials_snapshot, name_snapshot, occurred_at
       FROM program_lifecycle_event WHERE program_id = $1 ORDER BY occurred_at, id`,
      [programId],
    ),
  ]);
  const row = program.rows[0]!;
  const context: ProjectContext = { pmPeUserId: row.pm_pe_user_id };
  const personal = user.accountType !== 'shared_lab';
  const open = row.status === 'submitted';
  const closure = closureEligibility(
    requests.map((r) => ({
      id: r.id,
      status: r.status,
      reviewState: r.review_state,
      cancelReason: r.cancel_reason,
    })),
  );
  const closeBlockedReason: CloseBlockedReason | null = !personal
    ? 'personal_sign_in'
    : !can(user, 'program.close', context)
      ? 'not_pm_pe'
      : !open
        ? 'not_open'
        : closure.emptyProgram
          ? 'empty_program'
          : !closure.eligible
            ? 'unresolved'
            : null;
  return {
    status: row.status,
    version: row.version,
    closedAt: row.closed_at?.toISOString() ?? null,
    closedBy: row.closed_by_user_id
      ? {
          userId: row.closed_by_user_id,
          initials: row.closed_by_initials_snapshot,
          name: row.closed_by_name_snapshot ?? '',
        }
      : null,
    events: events.rows.map((e) => ({
      id: e.id,
      kind: e.kind,
      reason: e.reason,
      person: { userId: e.user_id, initials: e.initials_snapshot, name: e.name_snapshot },
      occurredAt: e.occurred_at.toISOString(),
    })),
    closure: { ...closure, counts: closure.counts as Record<string, number> },
    canClose: closeBlockedReason === null,
    closeBlockedReason,
    canRequestClose: personal && open && can(user, 'program.close_request'),
    canReopen: personal && !open && can(user, 'program.reopen', context),
  };
}

/** One test's cancellation, repeat links and allowed lifecycle actions. */
export function requestLifecycle(
  row: LifecycleRequestRow,
  repeats: string[],
  context: { user: AuthUser; programOpen: boolean; pmPeUserId: string },
): RequestLifecycle {
  const personal = context.user.accountType !== 'shared_lab';
  const live = personal && context.programOpen;
  const cancellable = CANCELLABLE_STATUSES.includes(row.status);
  return {
    cancelReason: row.cancel_reason,
    cancelledAt: row.cancelled_at?.toISOString() ?? null,
    cancelledBy: row.cancelled_by_user_id
      ? {
          userId: row.cancelled_by_user_id,
          initials: row.cancelled_by_initials_snapshot,
          name: row.cancelled_by_name_snapshot ?? '',
        }
      : null,
    repeatOfId: row.repeat_of_id,
    repeatIds: repeats,
    canCancel:
      live && cancellable && can(context.user, 'test.cancel', { pmPeUserId: context.pmPeUserId }),
    canRequestCancel: live && cancellable && can(context.user, 'test.cancel_request'),
    canRepeat:
      live && REPEATABLE_STATUSES.includes(row.status) && can(context.user, 'lab_program.amend'),
  };
}
