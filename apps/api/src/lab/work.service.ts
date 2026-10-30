import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  COMMENT_EDIT_WINDOW_MINUTES,
  OPEN_STATUSES,
  TEST_REQUEST_STATUSES,
  WORKLIST_PAGE_SIZE,
  isAllowedTransition,
  type AddCommentRequest,
  changePriorityRequestSchema,
  type ChangePriorityRequest,
  type ChangeTestStatusRequest,
  type EditCommentRequest,
  type LabComment,
  formatSampleIdentity,
  type ProgramWork,
  type ReviewActions,
  type SameSourceUnits,
  type TestedUnitCoverageBasis,
  type ReviewEvent,
  type ReviewState,
  nextReviewState,
  type TestRequestStatus,
  type Worklist,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { canUnderLock } from '../auth/standing.js';
import { can, type AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { parseBody } from '../validation/parse-body.js';
import { actorOf, receiverOf, resolveActingPerson } from './attribution.js';
import {
  loadProgramLifecycle,
  requestLifecycle,
  type LifecycleRequestRow,
} from './lifecycle.service.js';
import { loadSampleIdentities } from '../storage-units/sample-identity.js';
import { activeDelegateIds } from './review.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Db = Pool | PoolClient;

/** Hash of an action's intent, so a retry with the same key but different intent is refused. */
function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, code, message }] });
}

const PERSON = { field: 'actingStaffUserId', invalidCode: 'acting_staff_invalid' };

/** A unit a completion links, and why it may (MM-T73). */
interface TestedUnitRow {
  id: string;
  readable_id: string;
  project_id: string;
  basis: TestedUnitCoverageBasis;
}

interface RequestRow {
  id: string;
  program_id: string;
  line_id: string;
  status: TestRequestStatus;
  version: number;
  test_code_snapshot: string;
  program_status: string;
  program_number: string;
  project_id: string;
  lead_project_engineer_user_id: string | null;
}

/**
 * Lab work on submitted programs (MM-T24): per-test status along the one transition path with
 * exact tested-unit evidence, priority with history, comments with revisions, and the worklist.
 *
 * Authority is checked first (403), then the version (409, with the current state), then the
 * transition (422). Every
 * action carries a retry key: an exact retry returns the original result with no new history; the
 * same key with a different intent is refused (409 `idempotency_key_reused`). A shared LAB station
 * names the person acting on every request; it never gains that person's roles.
 */
@Injectable()
export class LabWorkService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Worklist
  // -------------------------------------------------------------------------------------------

  async worklist(query: {
    priority?: string;
    projectId?: string;
    openOnly?: boolean;
    testTypeId?: string;
    page?: number;
  }): Promise<Worklist> {
    /**
     * The filters as SQL after `seed` parameters (each query passes only parameters it uses, or
     * PostgreSQL can't type them); the project filter is left out for the project options.
     */
    const filters = (withProject: boolean, seed: unknown[] = []) => {
      const params: unknown[] = [...seed];
      const where = [`lp.status = 'submitted'`];
      if (query.priority === 'urgent' || query.priority === 'normal') {
        params.push(query.priority);
        where.push(`lp.priority = $${params.length}`);
      }
      if (withProject && query.projectId && UUID_PATTERN.test(query.projectId)) {
        params.push(query.projectId);
        where.push(`lp.project_id = $${params.length}`);
      }
      if (query.testTypeId && UUID_PATTERN.test(query.testTypeId)) {
        params.push(query.testTypeId);
        where.push(
          `EXISTS (SELECT 1 FROM test_request r WHERE r.program_id = lp.id AND r.test_type_id = $${params.length})`,
        );
      }
      if (query.openOnly) {
        params.push(OPEN_STATUSES);
        where.push(
          `EXISTS (SELECT 1 FROM test_request r WHERE r.program_id = lp.id AND r.status = ANY ($${params.length}::text[]))`,
        );
      }
      return { params, where: where.join(' AND ') };
    };
    // $1: the open statuses, used by the per-program counts in the list query.
    const { params, where } = filters(true, [OPEN_STATUSES]);
    const page = Math.max(1, query.page ?? 1);
    const { rows } = await this.database.pool.query<{
      id: string;
      program_number: string;
      priority: 'normal' | 'urgent';
      project_id: string;
      project_number: string;
      project_name: string;
      submitted_at: Date;
      account_type: string;
      account_name: string;
      person_initials: string | null;
      person_name: string;
      counts: Record<string, number> | null;
      open_count: number;
      oldest_open_seconds: number | null;
      total: number;
    }>(
      `SELECT count(*) OVER ()::int AS total, lp.id, lp.program_number, lp.priority, lp.project_id, p.project_number,
              p.name AS project_name, lp.submitted_at, lp.submitted_by_account_type AS account_type,
              lp.submitted_by_name_snapshot AS account_name,
              lp.submitted_for_initials_snapshot AS person_initials,
              lp.submitted_for_name_snapshot AS person_name,
              (SELECT json_object_agg(status, n) FROM (
                 SELECT status, count(*)::int AS n FROM test_request r
                 WHERE r.program_id = lp.id GROUP BY status) s) AS counts,
              (SELECT count(*)::int FROM test_request r
               WHERE r.program_id = lp.id AND r.status = ANY ($1::text[])) AS open_count,
              (SELECT extract(epoch FROM now() - min(r.created_at))::float FROM test_request r
               WHERE r.program_id = lp.id AND r.status = ANY ($1::text[])) AS oldest_open_seconds
       FROM lab_program lp JOIN project p ON p.id = lp.project_id
       WHERE ${where}
       ORDER BY (lp.priority = 'urgent') DESC, lp.submitted_at, lp.id
       LIMIT ${WORKLIST_PAGE_SIZE} OFFSET ${(page - 1) * WORKLIST_PAGE_SIZE}`,
      params,
    );
    let total = rows[0]?.total ?? 0;
    if (rows.length === 0 && page > 1) {
      // Past the last page there is no row to carry the window count.
      const counting = filters(true);
      const { rows: counted } = await this.database.pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM lab_program lp WHERE ${counting.where}`,
        counting.params,
      );
      total = counted[0]?.total ?? 0;
    }
    const others = filters(false);
    const { rows: projects } = await this.database.pool.query<{
      id: string;
      project_number: string;
      name: string;
    }>(
      `SELECT p.id, p.project_number, p.name
       FROM project p
       WHERE EXISTS (SELECT 1 FROM lab_program lp WHERE lp.project_id = p.id AND ${others.where})
       ORDER BY p.project_number, p.id`,
      others.params,
    );
    return {
      total,
      page,
      pageSize: WORKLIST_PAGE_SIZE,
      projects: projects.map((p) => ({ id: p.id, projectNumber: p.project_number, name: p.name })),
      items: rows.map((row) => ({
        programId: row.id,
        programNumber: row.program_number,
        priority: row.priority,
        project: { id: row.project_id, projectNumber: row.project_number, name: row.project_name },
        submittedAt: row.submitted_at.toISOString(),
        requestedBy:
          row.account_type === 'shared_lab'
            ? `${row.account_name} for ${row.person_initials ? `${row.person_initials} · ` : ''}${row.person_name}`
            : row.person_name,
        counts: Object.fromEntries(
          TEST_REQUEST_STATUSES.map((status) => [status, row.counts?.[status] ?? 0]),
        ) as Record<TestRequestStatus, number>,
        openCount: row.open_count,
        oldestOpenSeconds:
          row.oldest_open_seconds === null ? null : Math.round(row.oldest_open_seconds),
      })),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Program work view
  // -------------------------------------------------------------------------------------------

  async work(programId: string, user: AuthUser): Promise<ProgramWork> {
    const program = await this.findProgram(this.database.pool, programId);
    if (!program || program.status === 'draft') {
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    const delegates = await activeDelegateIds(this.database.pool, program.project_id);
    return loadWork(this.database.pool, programId, {
      canChangePriority: can(user, 'program.priority.set', {
        leadProjectEngineerUserId: program.lead_project_engineer_user_id,
      }),
      review: {
        user,
        programOpen: program.status === 'submitted',
        canAccept: can(user, 'test.accept', {
          leadProjectEngineerUserId: program.lead_project_engineer_user_id,
          acceptanceDelegateUserIds: delegates,
        }),
        leadProjectEngineerUserId: program.lead_project_engineer_user_id,
      },
    });
  }

  // -------------------------------------------------------------------------------------------
  // Status
  // -------------------------------------------------------------------------------------------

  async changeStatus(testRequestId: string, request: ChangeTestStatusRequest, user: AuthUser) {
    if (!UUID_PATTERN.test(testRequestId)) {
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    const hash = intentHash({
      testRequestId,
      to: request.to,
      version: request.version,
      person: request.actingStaffUserId ?? null,
      units: [...(request.testedStorageUnitIds ?? [])].sort(),
      // Only when used, so the intent of a request without confirmations hashes as before.
      ...(request.sameSourceConfirmedUnitIds?.length
        ? { confirmed: [...request.sameSourceConfirmedUnitIds].sort() }
        : {}),
    });
    return withTransaction(this.database.pool, async (client) => {
      const replay = await this.replayStatus(client, request.idempotencyKey, hash, user);
      if (replay) return replay;

      // Acceptance and review decisions are personal-only (MM-T25): LAB is refused outright,
      // whoever it selects; a personal account learns it isn't a move this card makes.
      const peek = await this.loadRequest(client, testRequestId, false);
      if (!peek) throw new NotFoundException({ code: 'test_request_not_found' });
      if (request.to === 'accepted') {
        if (user.accountType === 'shared_lab') throw new ForbiddenException({ code: 'forbidden' });
        unprocessable(
          'invalid_transition',
          'to',
          'acceptance is recorded with POST /api/test-requests/:id/accept (MM-T25)',
        );
      }
      const person = await resolveActingPerson(client, user, request.actingStaffUserId, PERSON);

      // Lock order: storage units first (as moves, corrections and removal do), then the request.
      // NO KEY UPDATE, not SHARE (MM-T76): two programs completing on the same Shelby tube must
      // serialise, so the second sees the first's completion and is refused; under a share lock
      // both read the tube as untested and both committed. It doesn't block foreign-key checks.
      const unitIds = request.testedStorageUnitIds ?? [];
      if (unitIds.length > 0) {
        await client.query(
          'SELECT id FROM storage_unit WHERE id = ANY ($1::uuid[]) ORDER BY id FOR NO KEY UPDATE',
          [unitIds],
        );
      }
      const current = (await this.loadRequest(client, testRequestId, true))!;
      // A concurrent delivery of the same key may have committed while this one waited (MM-T76).
      const late = await this.replayStatus(client, request.idempotencyKey, hash, user);
      if (late) return late;
      if (current.program_status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'this program is not open for lab work');
      }
      // A stale client (another station moved this test first) gets the current state to refresh;
      // a current client asking for a move the path doesn't allow gets 422.
      if (current.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { testRequestId, status: current.status, version: current.version },
        });
      }
      if (!isAllowedTransition(current.status, request.to)) {
        unprocessable(
          'invalid_transition',
          'to',
          `a ${current.status.replace('_', ' ')} test can't move to ${request.to.replace('_', ' ')}`,
        );
      }

      let tested: TestedUnitRow[] = [];
      if (request.to === 'completed') {
        tested = await this.checkTestedUnits(
          client,
          current,
          request.testedStorageUnitIds,
          request.sameSourceConfirmedUnitIds ?? [],
        );
      } else if (request.testedStorageUnitIds !== undefined) {
        unprocessable('not_allowed', 'testedStorageUnitIds', 'units are linked when completing');
      }

      const { rows: events } = await client.query<{ id: string }>(
        `INSERT INTO test_request_status_history
           (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
            account_initials_snapshot, account_name_snapshot, person_user_id,
            person_initials_snapshot, person_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) RETURNING id`,
        [
          testRequestId,
          current.program_id,
          current.status,
          request.to,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          person.userId,
          person.initials,
          person.name,
          request.idempotencyKey,
          hash,
        ],
      );
      const eventId = events[0]!.id;
      for (const unit of tested) {
        // MM-T73: a same-source unit outside coverage carries the completer's confirmation.
        const confirmed = unit.basis === 'same_source_confirmed';
        await client.query(
          `INSERT INTO test_request_unit_link (test_request_id, status_history_id, storage_unit_id,
                                               project_id, unit_readable_id_snapshot,
                                               coverage_basis, confirmed_by_account_user_id,
                                               confirmed_by_person_user_id,
                                               confirmed_by_person_initials_snapshot,
                                               confirmed_by_person_name_snapshot, confirmed_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
                   CASE WHEN $11::boolean THEN now() END)`,
          [
            testRequestId,
            eventId,
            unit.id,
            unit.project_id,
            unit.readable_id,
            unit.basis,
            confirmed ? user.userId : null,
            confirmed ? person.userId : null,
            confirmed ? person.initials : null,
            confirmed ? person.name : null,
            confirmed,
          ],
        );
      }
      await client.query(
        `UPDATE test_request
         SET status = $2, version = version + 1, status_changed_at = now(),
             -- Entering Review starts its sub-state (MM-T25).
             review_state = CASE WHEN $2 = 'review' THEN 'awaiting_review' ELSE review_state END,
             status_changed_by_account_user_id = $3, status_changed_for_user_id = $4
         WHERE id = $1`,
        [testRequestId, request.to, user.userId, person.userId],
      );
      await recordAudit(client, {
        action: 'test_request.status_changed',
        entityType: 'test_request',
        entityId: testRequestId,
        actor: actorOf(user),
        receiver: receiverOf(person),
        before: { status: current.status },
        after: {
          status: request.to,
          programNumber: current.program_number,
          code: current.test_code_snapshot,
          ...(request.to === 'completed' ? { testedUnits: tested.map((u) => u.readable_id) } : {}),
          ...(tested.some((u) => u.basis === 'same_source_confirmed')
            ? {
                sameSourceConfirmedUnits: tested
                  .filter((u) => u.basis === 'same_source_confirmed')
                  .map((u) => u.readable_id),
              }
            : {}),
        },
      });
      return statusResult(client, testRequestId);
    });
  }

  /**
   * Exact tested units for a completion. When the line's frozen coverage includes a Shelby tube
   * or a bulk-sample bucket, the caller must say which units were used (an empty list says none
   * of them). Each unit must still exist (not disposed), belong to the program's project and
   * either be in that coverage, or (MM-T73) be listed in `confirmedIds`: a Shelby tube or
   * bulk-sample bucket of the line's own source that the person completing the test confirms
   * they used. A covered unit needs no confirmation. Nothing is inferred from coverage.
   */
  private async checkTestedUnits(
    client: PoolClient,
    current: RequestRow,
    unitIds: string[] | undefined,
    confirmedIds: string[],
  ): Promise<TestedUnitRow[]> {
    const { rows: covered } = await client.query<{
      storage_unit_id: string;
      tracked: boolean;
    }>(
      `SELECT s.storage_unit_id,
              (su.unit_type = 'shelby_tube' OR su.bulk_group_id IS NOT NULL) AS tracked
       FROM program_scope_snapshot s JOIN storage_unit su ON su.id = s.storage_unit_id
       WHERE s.line_id = $1 AND s.included`,
      [current.line_id],
    );
    if (unitIds === undefined) {
      if (covered.some((unit) => unit.tracked)) {
        unprocessable(
          'tested_units_required',
          'testedStorageUnitIds',
          'this test covers Shelby tubes or bulk-sample buckets: choose the exact units used, or none',
        );
      }
      return [];
    }
    const coveredIds = new Set(covered.map((unit) => unit.storage_unit_id));
    const confirmed = new Set(confirmedIds);
    if (confirmedIds.some((id) => coveredIds.has(id))) {
      unprocessable(
        'confirmation_not_needed',
        'sameSourceConfirmedUnitIds',
        'a unit is already part of this line’s material and needs no confirmation',
      );
    }
    if (unitIds.some((id) => !coveredIds.has(id) && !confirmed.has(id))) {
      unprocessable(
        'unit_not_covered',
        'testedStorageUnitIds',
        'a unit is not part of this line’s material; confirm it if it is from the same source',
      );
    }
    if (unitIds.length === 0) return [];
    const { rows } = await client.query<{
      id: string;
      readable_id: string;
      project_id: string;
      status: string;
      destroyed_by: string | null;
      tracked: boolean;
      same_source: boolean;
    }>(
      `SELECT id, readable_id, project_id, status,
              shelby_contents_destroyed_by_program(id) AS destroyed_by,
              (unit_type = 'shelby_tube' OR bulk_group_id IS NOT NULL) AS tracked,
              storage_unit_of_line_source($2, id) AS same_source
       FROM storage_unit WHERE id = ANY ($1::uuid[])`,
      [unitIds, current.line_id],
    );
    if (rows.length !== unitIds.length) {
      unprocessable('unit_not_covered', 'testedStorageUnitIds', 'a unit doesn’t exist');
    }
    if (rows.some((unit) => unit.status === 'disposed')) {
      unprocessable('unit_disposed', 'testedStorageUnitIds', 'a unit has already been disposed');
    }
    // MM-T36: a Shelby tube's contents are destroyed by its first completed test. Tests of that
    // same program (frozen together) may still record it; no other program can test it again.
    const destroyed = rows.find(
      (unit) => unit.destroyed_by !== null && unit.destroyed_by !== current.program_id,
    );
    if (destroyed) {
      unprocessable(
        'unit_contents_destroyed',
        'testedStorageUnitIds',
        `${destroyed.readable_id}’s contents were destroyed during an earlier test`,
      );
    }
    if (rows.some((unit) => unit.project_id !== current.project_id)) {
      unprocessable('unit_not_covered', 'testedStorageUnitIds', 'a unit is in another project');
    }
    // MM-T73: a confirmed unit must be a Shelby tube or bulk-sample bucket of this line's source.
    const stranger = rows.find(
      (unit) => confirmed.has(unit.id) && (!unit.tracked || !unit.same_source),
    );
    if (stranger) {
      unprocessable(
        'unit_not_covered',
        'sameSourceConfirmedUnitIds',
        `${stranger.readable_id} is not a Shelby tube or bulk-sample bucket from this line’s source`,
      );
    }
    return rows.map((unit) => ({
      id: unit.id,
      readable_id: unit.readable_id,
      project_id: unit.project_id,
      basis: confirmed.has(unit.id) ? 'same_source_confirmed' : 'frozen_coverage',
    }));
  }

  /**
   * MM-T73: Shelby tubes and bulk-sample buckets of the line's own source, in the program's
   * project, outside its frozen coverage, that this program could still record as tested (not
   * disposed; a tube's contents not destroyed by another program). Completing with one needs an
   * explicit same-source confirmation.
   */
  async sameSourceUnits(testRequestId: string): Promise<SameSourceUnits> {
    if (!UUID_PATTERN.test(testRequestId)) {
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    const pool = this.database.pool;
    const request = await this.loadRequest(pool, testRequestId, false);
    if (!request || request.program_status === 'draft') {
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    const { rows } = await pool.query<{
      id: string;
      readable_id: string;
      unit_type: string;
      received_date: string;
    }>(
      `SELECT su.id, su.readable_id, su.unit_type,
              to_char(su.received_date, 'YYYY-MM-DD') AS received_date
       FROM storage_unit su
       WHERE su.project_id = $2 AND su.status <> 'disposed'
         AND (su.unit_type = 'shelby_tube' OR su.bulk_group_id IS NOT NULL)
         AND storage_unit_of_line_source($1, su.id)
         AND coalesce(shelby_contents_destroyed_by_program(su.id) = $3, true)
         AND NOT EXISTS (SELECT 1 FROM program_scope_snapshot s
                         WHERE s.line_id = $1 AND s.storage_unit_id = su.id AND s.included)
       ORDER BY su.received_date, su.readable_id COLLATE "C"`,
      [request.line_id, request.project_id, request.program_id],
    );
    const { rows: line } = await pool.query<{ label: string | null }>(
      'SELECT source_display_snapshot AS label FROM test_line WHERE id = $1',
      [request.line_id],
    );
    const identities = await loadSampleIdentities(
      pool,
      rows.map((row) => row.id),
    );
    return {
      testRequestId,
      sourceLabel: line[0]?.label ?? null,
      units: rows.map((row) => {
        const identity = identities.get(row.id);
        return {
          storageUnitId: row.id,
          readableId: row.readable_id,
          unitType: row.unit_type,
          contents: identity ? formatSampleIdentity(identity.sample) : null,
          receivedDate: row.received_date,
        };
      }),
    };
  }

  private async replayStatus(client: PoolClient, key: string, hash: string, user: AuthUser) {
    const { rows } = await client.query<{
      test_request_id: string;
      request_hash: string;
      account_user_id: string;
    }>(
      `SELECT test_request_id, request_hash, account_user_id FROM test_request_status_history
       WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (previous.request_hash !== hash || previous.account_user_id !== user.userId) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return statusResult(client, previous.test_request_id);
  }

  private async loadRequest(client: Db, id: string, lock: boolean) {
    const { rows } = await client.query<RequestRow>(
      `SELECT r.id, r.program_id, r.line_id, r.status, r.version, r.test_code_snapshot,
              lp.status AS program_status, lp.program_number, lp.project_id, p.lead_project_engineer_user_id
       FROM test_request r
       JOIN lab_program lp ON lp.id = r.program_id
       JOIN project p ON p.id = lp.project_id
       WHERE r.id = $1 ${lock ? 'FOR UPDATE OF r' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  // -------------------------------------------------------------------------------------------
  // Priority
  // -------------------------------------------------------------------------------------------

  async changePriority(programId: string, body: unknown, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const program = await this.findProgram(client, programId, true);
      // Authority first. A caller who could never set priority learns nothing about the program.
      if (!program) {
        if (!can(user, 'program.priority.set')) throw new ForbiddenException({ code: 'forbidden' });
        throw new NotFoundException({ code: 'lab_program_not_found' });
      }
      if (
        !can(user, 'program.priority.set', {
          leadProjectEngineerUserId: program.lead_project_engineer_user_id,
        })
      ) {
        throw new ForbiddenException({ code: 'forbidden' });
      }
      // D09: again with the project's lead and the actor's roles as they stand under lock.
      if (!(await canUnderLock(client, user, 'program.priority.set', program.project_id))) {
        throw new ForbiddenException({ code: 'forbidden' });
      }
      const request: ChangePriorityRequest = parseBody(changePriorityRequestSchema, body);
      const hash = intentHash({ programId, priority: request.priority, version: request.version });
      const { rows: previous } = await client.query<{ request_hash: string; user_id: string }>(
        'SELECT request_hash, user_id FROM program_priority_history WHERE idempotency_key = $1',
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== hash || previous[0].user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return { priority: program.priority, version: program.version };
      }
      if (program.status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'only an open program’s priority can change');
      }
      if (program.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { priority: program.priority, version: program.version },
        });
      }
      if (program.priority === request.priority) {
        unprocessable('no_changes', 'priority', `is already ${request.priority}`);
      }
      // Only priority (and the program's version) changes: never a test status (AC6).
      const { rows } = await client.query<{ version: number }>(
        `UPDATE lab_program SET priority = $2, version = version + 1, updated_at = now()
         WHERE id = $1 RETURNING version`,
        [programId, request.priority],
      );
      await client.query(
        `INSERT INTO program_priority_history (program_id, from_priority, to_priority, user_id,
                                               initials_snapshot, name_snapshot, idempotency_key,
                                               request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          programId,
          program.priority,
          request.priority,
          user.userId,
          user.initials,
          user.displayName,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'lab_program.priority_changed',
        entityType: 'lab_program',
        entityId: programId,
        actor: actorOf(user),
        before: { priority: program.priority },
        after: { priority: request.priority, programNumber: program.program_number },
      });
      return { priority: request.priority, version: rows[0]!.version };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Comments
  // -------------------------------------------------------------------------------------------

  async addComment(programId: string, request: AddCommentRequest, user: AuthUser) {
    const hash = intentHash({ programId, lineId: request.lineId, body: request.body });
    return withTransaction(this.database.pool, async (client) => {
      const { rows: previous } = await client.query<{
        id: string;
        request_hash: string;
        author_account_user_id: string;
      }>(
        'SELECT id, request_hash, author_account_user_id FROM lab_comment WHERE idempotency_key = $1',
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (
          previous[0].request_hash !== hash ||
          previous[0].author_account_user_id !== user.userId
        ) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return loadComment(client, previous[0].id);
      }
      const program = await this.findProgram(client, programId);
      if (!program || program.status === 'draft') {
        throw new NotFoundException({ code: 'lab_program_not_found' });
      }
      const person = await resolveActingPerson(client, user, request.actingStaffUserId, PERSON);
      if (request.lineId) {
        const { rows } = await client.query(
          'SELECT 1 FROM test_line WHERE id = $1 AND program_id = $2',
          [request.lineId, programId],
        );
        if (rows.length === 0) unprocessable('line_not_in_program', 'lineId', 'line not found');
      }
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO lab_comment (program_id, line_id, author_account_user_id, author_account_type,
                                  author_account_name_snapshot, author_person_user_id,
                                  author_person_initials_snapshot, author_person_name_snapshot,
                                  body, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
        [
          programId,
          request.lineId,
          user.userId,
          user.accountType,
          user.displayName,
          person.userId,
          person.initials,
          person.name,
          request.body,
          request.idempotencyKey,
          hash,
        ],
      );
      const id = rows[0]!.id;
      await client.query(
        `INSERT INTO lab_comment_revision (comment_id, revision_number, body, account_user_id,
                                           person_user_id, person_initials_snapshot,
                                           person_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          id,
          request.body,
          user.userId,
          person.userId,
          person.initials,
          person.name,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'comment.added',
        entityType: 'lab_comment',
        entityId: id,
        actor: actorOf(user),
        receiver: receiverOf(person),
        after: { programNumber: program.program_number, lineId: request.lineId },
      });
      return loadComment(client, id);
    });
  }

  /**
   * Only the comment's author edits it, within 15 minutes of the original post (server clock;
   * edits never restart the window). For LAB the author is the selected person, so another
   * operator at a LAB station can't edit it. Every edit adds a revision; nothing is deleted.
   */
  async editComment(commentId: string, request: EditCommentRequest, user: AuthUser) {
    if (!UUID_PATTERN.test(commentId)) throw new NotFoundException({ code: 'comment_not_found' });
    const hash = intentHash({ commentId, body: request.body, version: request.version });
    return withTransaction(this.database.pool, async (client) => {
      const { rows: previous } = await client.query<{
        comment_id: string;
        request_hash: string;
        account_user_id: string;
      }>(
        `SELECT comment_id, request_hash, account_user_id FROM lab_comment_revision
         WHERE idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== hash || previous[0].account_user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return loadComment(client, previous[0].comment_id);
      }
      const { rows } = await client.query<{
        id: string;
        author_account_user_id: string;
        author_person_user_id: string;
        version: number;
        body: string;
        program_status: string;
        open: boolean;
      }>(
        `SELECT c.id, c.author_account_user_id, c.author_person_user_id, c.version, c.body,
                lp.status AS program_status,
                now() < c.created_at + make_interval(mins => $2) AS open
         FROM lab_comment c JOIN lab_program lp ON lp.id = c.program_id
         WHERE c.id = $1 FOR UPDATE OF c`,
        [commentId, COMMENT_EDIT_WINDOW_MINUTES],
      );
      const comment = rows[0];
      if (!comment) throw new NotFoundException({ code: 'comment_not_found' });
      const person = await resolveActingPerson(client, user, request.actingStaffUserId, PERSON);
      if (
        comment.author_account_user_id !== user.userId ||
        comment.author_person_user_id !== person.userId
      ) {
        throw new ForbiddenException({ code: 'not_comment_author' });
      }
      if (!comment.open) {
        throw new ConflictException({ code: 'edit_window_closed' });
      }
      if (comment.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: await loadComment(client, commentId),
        });
      }
      if (comment.body === request.body) {
        unprocessable('no_changes', 'body', 'is unchanged');
      }
      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE lab_comment SET body = $2, edited_at = now(), version = version + 1
         WHERE id = $1 RETURNING version`,
        [commentId, request.body],
      );
      await client.query(
        `INSERT INTO lab_comment_revision (comment_id, revision_number, body, account_user_id,
                                           person_user_id, person_initials_snapshot,
                                           person_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          commentId,
          updated[0]!.version,
          request.body,
          user.userId,
          person.userId,
          person.initials,
          person.name,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'comment.edited',
        entityType: 'lab_comment',
        entityId: commentId,
        actor: actorOf(user),
        receiver: receiverOf(person),
        before: { revision: comment.version },
        after: { revision: updated[0]!.version },
      });
      return loadComment(client, commentId);
    });
  }

  private async findProgram(db: Db, id: string, lock = false) {
    if (!UUID_PATTERN.test(id)) return null;
    const { rows } = await db.query<{
      id: string;
      status: string;
      priority: 'normal' | 'urgent';
      version: number;
      program_number: string | null;
      project_id: string;
      lead_project_engineer_user_id: string | null;
    }>(
      `SELECT lp.id, lp.status, lp.priority, lp.version, lp.program_number, lp.project_id,
              p.lead_project_engineer_user_id
       FROM lab_program lp JOIN project p ON p.id = lp.project_id
       WHERE lp.id = $1 ${lock ? 'FOR UPDATE OF lp' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }
}

async function statusResult(db: Db, testRequestId: string) {
  const { rows } = await db.query<{ status: TestRequestStatus; version: number }>(
    'SELECT status, version FROM test_request WHERE id = $1',
    [testRequestId],
  );
  return { testRequestId, status: rows[0]!.status, version: rows[0]!.version };
}

interface CommentRow {
  id: string;
  line_id: string | null;
  author_account_user_id: string;
  author_account_type: 'personal' | 'shared_lab' | 'test';
  author_account_name_snapshot: string;
  author_person_user_id: string;
  author_person_initials_snapshot: string | null;
  author_person_name_snapshot: string;
  body: string;
  created_at: Date;
  edited_at: Date | null;
  editable_until: Date;
  version: number;
  revisions: {
    revision_number: number;
    body: string;
    person_user_id: string;
    person_initials_snapshot: string | null;
    person_name_snapshot: string;
    created_at: string;
  }[];
}

const SELECT_COMMENTS = `
  SELECT c.*, c.created_at + make_interval(mins => ${COMMENT_EDIT_WINDOW_MINUTES}) AS editable_until,
         (SELECT json_agg(rv ORDER BY rv.revision_number)
          FROM lab_comment_revision rv WHERE rv.comment_id = c.id) AS revisions
  FROM lab_comment c`;

function toComment(row: CommentRow): LabComment {
  return {
    id: row.id,
    lineId: row.line_id,
    account: {
      userId: row.author_account_user_id,
      accountType: row.author_account_type,
      initials: null,
      name: row.author_account_name_snapshot,
    },
    author: {
      userId: row.author_person_user_id,
      initials: row.author_person_initials_snapshot,
      name: row.author_person_name_snapshot,
    },
    body: row.body,
    createdAt: row.created_at.toISOString(),
    editedAt: row.edited_at?.toISOString() ?? null,
    editableUntil: row.editable_until.toISOString(),
    version: row.version,
    revisions: row.revisions.map((rv) => ({
      revisionNumber: rv.revision_number,
      body: rv.body,
      person: {
        userId: rv.person_user_id,
        initials: rv.person_initials_snapshot,
        name: rv.person_name_snapshot,
      },
      createdAt: new Date(rv.created_at).toISOString(),
    })),
  };
}

async function loadComment(db: Db, id: string): Promise<LabComment> {
  const { rows } = await db.query<CommentRow>(`${SELECT_COMMENTS} WHERE c.id = $1`, [id]);
  return toComment(rows[0]!);
}

/** Status, history, evidence, priority history and comments of one submitted program. */
export async function loadWork(
  db: Db,
  programId: string,
  options: {
    canChangePriority: boolean;
    /** The signed-in account's review/acceptance standing on this program (MM-T25). */
    review: {
      user: AuthUser;
      programOpen: boolean;
      canAccept: boolean;
      leadProjectEngineerUserId: string | null;
    };
  },
): Promise<ProgramWork> {
  const [requests, history, links, priority, comments, reviewEvents, actionItems] =
    await Promise.all([
      db.query<
        LifecycleRequestRow & {
          version: number;
          needs_units: boolean;
          accepted_at: Date | null;
          accepted_by_user_id: string | null;
          accepted_by_initials: string | null;
          accepted_by_name: string | null;
          accepted_via_delegation_id: string | null;
        }
      >(
        `SELECT r.id, r.status, r.version, r.review_state, r.accepted_at, r.accepted_by_user_id,
              r.accepted_via_delegation_id, r.cancel_reason, r.cancelled_at,
              r.cancelled_by_user_id, r.cancelled_by_initials_snapshot,
              r.cancelled_by_name_snapshot, r.repeat_of_id,
              (SELECT e.initials_snapshot FROM test_request_review_event e
               WHERE e.test_request_id = r.id AND e.kind = 'accepted'
               ORDER BY e.occurred_at DESC LIMIT 1) AS accepted_by_initials,
              (SELECT e.name_snapshot FROM test_request_review_event e
               WHERE e.test_request_id = r.id AND e.kind = 'accepted'
               ORDER BY e.occurred_at DESC LIMIT 1) AS accepted_by_name,
              EXISTS (SELECT 1 FROM program_scope_snapshot s
                      JOIN storage_unit su ON su.id = s.storage_unit_id
                      WHERE s.line_id = r.line_id AND s.included
                        AND (su.unit_type = 'shelby_tube' OR su.bulk_group_id IS NOT NULL))
                AS needs_units
       FROM test_request r WHERE r.program_id = $1 ORDER BY r.created_at, r.id`,
        [programId],
      ),
      db.query<{
        id: string;
        test_request_id: string;
        from_status: TestRequestStatus;
        to_status: TestRequestStatus;
        account_user_id: string;
        account_type: 'personal' | 'shared_lab' | 'test';
        account_initials_snapshot: string | null;
        account_name_snapshot: string;
        person_user_id: string;
        person_initials_snapshot: string | null;
        person_name_snapshot: string;
        changed_at: Date;
      }>(
        `SELECT * FROM test_request_status_history WHERE program_id = $1
       ORDER BY changed_at, id`,
        [programId],
      ),
      db.query<{
        test_request_id: string;
        storage_unit_id: string;
        unit_readable_id_snapshot: string;
        status_history_id: string;
        linked_at: Date;
        coverage_basis: TestedUnitCoverageBasis;
        confirmed_by_account_user_id: string | null;
        confirmed_by_person_user_id: string | null;
        confirmed_by_person_initials_snapshot: string | null;
        confirmed_by_person_name_snapshot: string | null;
        confirmed_at: Date | null;
      }>(
        `SELECT l.* FROM test_request_unit_link l
       JOIN test_request r ON r.id = l.test_request_id
       WHERE r.program_id = $1 ORDER BY l.linked_at, l.unit_readable_id_snapshot`,
        [programId],
      ),
      db.query<{
        id: string;
        from_priority: 'normal' | 'urgent';
        to_priority: 'normal' | 'urgent';
        user_id: string;
        initials_snapshot: string | null;
        name_snapshot: string;
        changed_at: Date;
      }>('SELECT * FROM program_priority_history WHERE program_id = $1 ORDER BY changed_at, id', [
        programId,
      ]),
      db.query<CommentRow>(
        `${SELECT_COMMENTS} WHERE c.program_id = $1 ORDER BY c.created_at, c.id`,
        [programId],
      ),
      db.query<{
        id: string;
        test_request_id: string;
        kind: ReviewEvent['kind'];
        from_review_state: ReviewState;
        to_review_state: ReviewState | null;
        comment: string | null;
        correction_cycle: number;
        user_id: string;
        initials_snapshot: string | null;
        name_snapshot: string;
        delegation_id: string | null;
        occurred_at: Date;
      }>(`SELECT * FROM test_request_review_event WHERE program_id = $1 ORDER BY occurred_at, id`, [
        programId,
      ]),
      db.query<{
        id: string;
        entity_id: string;
        status: 'open' | 'resolved';
        kind: 'correction' | 'cancellation_request' | 'closure_request';
        target_role: 'lab_manager' | null;
        created_at: Date;
        resolved_at: Date | null;
        resolution: 'correction_done' | 'cancelled' | 'closed' | null;
        comment: string;
        user_id: string;
        initials_snapshot: string | null;
        name_snapshot: string;
      }>(
        // Corrections take their comment and author from the return; requests carry their own.
        `SELECT a.id, a.entity_id, a.kind, a.status, a.target_role, a.created_at, a.resolved_at,
              a.resolution,
              coalesce(e.comment, a.reason) AS comment,
              coalesce(e.user_id, a.created_by_user_id) AS user_id,
              CASE WHEN e.id IS NULL THEN a.created_by_initials_snapshot
                   ELSE e.initials_snapshot END AS initials_snapshot,
              coalesce(e.name_snapshot, a.created_by_name_snapshot) AS name_snapshot
       FROM action_item a LEFT JOIN test_request_review_event e ON e.id = a.opened_by_event_id
       WHERE a.program_id = $1 ORDER BY a.created_at, a.id`,
        [programId],
      ),
    ]);
  const { user, programOpen, canAccept, leadProjectEngineerUserId } = options.review;
  const personal = user.accountType !== 'shared_lab';
  const repeats = new Map<string, string[]>();
  for (const row of requests.rows) {
    if (row.repeat_of_id) {
      repeats.set(row.repeat_of_id, [...(repeats.get(row.repeat_of_id) ?? []), row.id]);
    }
  }
  const lifecycle = await loadProgramLifecycle(db, programId, requests.rows, user);
  return {
    programId,
    canChangePriority: options.canChangePriority,
    requests: requests.rows.map((row) => ({
      testRequestId: row.id,
      status: row.status,
      version: row.version,
      needsTestedUnits: row.needs_units,
      reviewState: row.review_state,
      acceptedAt: row.accepted_at?.toISOString() ?? null,
      acceptedBy: row.accepted_by_user_id
        ? {
            userId: row.accepted_by_user_id,
            initials: row.accepted_by_initials,
            name: row.accepted_by_name ?? '',
          }
        : null,
      acceptedViaDelegation: row.accepted_via_delegation_id !== null,
      reviewActions: reviewActions(row.review_state, { personal, programOpen, canAccept, user }),
      lifecycle: requestLifecycle(row, repeats.get(row.id) ?? [], {
        user,
        programOpen,
        leadProjectEngineerUserId,
      }),
    })),
    statusHistory: history.rows.map((row) => ({
      id: row.id,
      testRequestId: row.test_request_id,
      fromStatus: row.from_status,
      toStatus: row.to_status,
      account: {
        userId: row.account_user_id,
        accountType: row.account_type,
        initials: row.account_initials_snapshot,
        name: row.account_name_snapshot,
      },
      person: {
        userId: row.person_user_id,
        initials: row.person_initials_snapshot,
        name: row.person_name_snapshot,
      },
      changedAt: row.changed_at.toISOString(),
    })),
    testedUnits: links.rows.map((row) => ({
      testRequestId: row.test_request_id,
      storageUnitId: row.storage_unit_id,
      readableId: row.unit_readable_id_snapshot,
      statusEventId: row.status_history_id,
      linkedAt: row.linked_at.toISOString(),
      coverageBasis: row.coverage_basis,
      confirmation:
        row.coverage_basis === 'same_source_confirmed'
          ? {
              accountUserId: row.confirmed_by_account_user_id!,
              person: {
                userId: row.confirmed_by_person_user_id!,
                initials: row.confirmed_by_person_initials_snapshot,
                name: row.confirmed_by_person_name_snapshot!,
              },
              confirmedAt: row.confirmed_at!.toISOString(),
            }
          : null,
    })),
    priorityHistory: priority.rows.map((row) => ({
      id: row.id,
      fromPriority: row.from_priority,
      toPriority: row.to_priority,
      person: { userId: row.user_id, initials: row.initials_snapshot, name: row.name_snapshot },
      changedAt: row.changed_at.toISOString(),
    })),
    comments: comments.rows.map(toComment),
    reviewEvents: reviewEvents.rows.map((row) => ({
      id: row.id,
      testRequestId: row.test_request_id,
      kind: row.kind,
      fromReviewState: row.from_review_state,
      toReviewState: row.to_review_state,
      comment: row.comment,
      correctionCycle: row.correction_cycle,
      person: { userId: row.user_id, initials: row.initials_snapshot, name: row.name_snapshot },
      viaDelegation: row.delegation_id !== null,
      occurredAt: row.occurred_at.toISOString(),
    })),
    actionItems: actionItems.rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      targetRole: row.target_role,
      testRequestId: row.kind === 'closure_request' ? null : row.entity_id,
      comment: row.comment,
      status: row.status,
      resolution: row.resolution,
      createdAt: row.created_at.toISOString(),
      createdBy: { userId: row.user_id, initials: row.initials_snapshot, name: row.name_snapshot },
      resolvedAt: row.resolved_at?.toISOString() ?? null,
    })),
    lifecycle,
  };
}

/**
 * What the signed-in account may do to a test in Review (MM-T25). Only a test in Review has a
 * review state; nothing is offered outside it. The server enforces the same rules on each action.
 */
function reviewActions(
  state: ReviewState | null,
  context: { personal: boolean; programOpen: boolean; canAccept: boolean; user: AuthUser },
): ReviewActions {
  const none: ReviewActions = {
    canReview: false,
    canCorrectionDone: false,
    canAccept: false,
    acceptBlockedReason: null,
  };
  if (state === null) return none;
  if (!context.personal) return { ...none, acceptBlockedReason: 'personal_sign_in' };
  if (!context.programOpen) return { ...none, acceptBlockedReason: 'program_not_open' };
  const canReview =
    can(context.user, 'test.review') &&
    (nextReviewState(state, 'complete') !== null || nextReviewState(state, 'return') !== null);
  const canCorrectionDone =
    can(context.user, 'test.correction_done') && nextReviewState(state, 'correction_done') !== null;
  const acceptBlockedReason = !context.canAccept
    ? 'no_authority'
    : state !== 'review_complete'
      ? 'review_not_complete'
      : null;
  return {
    canReview,
    canCorrectionDone,
    canAccept: acceptBlockedReason === null,
    acceptBlockedReason,
  };
}

/**
 * Completed-test evidence for one physical unit, for MM-T36's post-testing removal: the tests
 * completed with this exact unit linked (never coverage, source, group or receipt). A cancelled
 * test is not evidence (MM-T26, tested-bulk amendment); a test reset by an accepted-request change
 * or one with a repeat keeps its historical completion, because the physical testing happened.
 */
export async function completedTestEvidence(db: Db, storageUnitId: string) {
  const { rows } = await db.query<{
    test_request_id: string;
    program_number: string;
    test_code: string;
    completed_at: Date;
    status_history_id: string;
    /** The test's current status (MM-T25 adds accepted). Never cancelled: see below. */
    request_status: TestRequestStatus;
  }>(
    `SELECT l.test_request_id, lp.program_number, r.test_code_snapshot AS test_code,
            r.status AS request_status, h.changed_at AS completed_at, h.id AS status_history_id
     FROM test_request_unit_link l
     JOIN test_request_status_history h ON h.id = l.status_history_id
     JOIN test_request r ON r.id = l.test_request_id
     JOIN lab_program lp ON lp.id = r.program_id
     WHERE l.storage_unit_id = $1 AND h.to_status = 'completed' AND r.status <> 'cancelled'
     ORDER BY h.changed_at`,
    [storageUnitId],
  );
  return rows;
}
