import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONCRETE_STRENGTH_TESTS_MAX_SETS,
  concreteStrengthExclusionRequestSchema,
  concreteStrengthTestsQuerySchema,
  type ConcreteStrengthExclusionEvent,
  type ConcreteStrengthExclusionState,
  type ConcreteStrengthTests,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { resolveActingPerson } from '../lab/attribution.js';
import { intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { currentMethod, methodOf } from './concrete-strength.calc.js';
import { grantLoader } from './concrete-report-lifecycle.read.js';
import {
  findSet,
  lockedStrengthContext,
  strengthContext,
} from './concrete-strength-reports.read.js';
import {
  exclusionsOf,
  specimenStrengthsOf,
  strengthTestsOf,
} from './concrete-strength-tests.read.js';

type Db = Pool | PoolClient;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REVIEW = 'concrete.review' as const;
const forbidden = (code = 'forbidden') => new ForbiddenException({ code });
const invalidCursor = () =>
  new BadRequestException({
    code: 'validation_failed',
    errors: [{ field: 'after', code: 'invalid_cursor', message: 'The cursor is not a set here' }],
  });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

interface SpecimenFacts {
  id: string;
  project_id: string;
  set_id: string;
  field_report_id: string;
}

async function findSpecimen(db: Db, id: string, lock = ''): Promise<SpecimenFacts | null> {
  if (!UUID.test(id)) return null;
  const { rows } = await db.query<SpecimenFacts>(
    `SELECT sp.id, sp.project_id, sp.set_id, st.field_report_id
     FROM concrete_specimen sp JOIN concrete_specimen_set st ON st.id = sp.set_id
     WHERE sp.id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * MM-V2-C24: strength tests and reviewer exclusions (provisional method P1).
 *
 * - `tests`: the strength tests of a set, or of every live set on a project, assessed
 *   (advisory). `failed` is the computed read C25 consumes. Read like every concrete read
 *   (`inventory.read`).
 * - `exclude`: a reviewer strikes a specimen from its strength test (or reinstates it), always
 *   with a reason. Proposal: `concrete.review` for the `concrete_strength` scope (the project's
 *   Lead or a designated strength reviewer, as reviewing the strength report), never on a
 *   specimen whose result they tested or entered. Refused while a submitted, reviewed or issued
 *   strength report version reports the specimen (return, recall or revise it first), like a
 *   result correction.
 */
@Injectable()
export class ConcreteStrengthService {
  constructor(private readonly database: DatabaseService) {}

  async tests(rawQuery: unknown): Promise<ConcreteStrengthTests> {
    const query = parseBody(concreteStrengthTestsQuerySchema, rawQuery);
    const db = this.database.pool;
    let setIds: string[];
    let truncated = false;
    let nextCursor: string | null = null;
    if (query.setId) {
      const set = await findSet(db, query.setId);
      if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
      if (query.projectId && set.project_id !== query.projectId) setIds = [];
      else setIds = [set.id];
    } else {
      // Review fix: paged by set in a stable order, the cursor being the last set of the previous
      // page, so every set (and every failure) is reachable. Each page still reads the full peer
      // history for its running averages (strengthTestsOf).
      const { rows } = await db.query<{ id: string }>(
        `WITH ordered AS (
           SELECT st.id, row_number() OVER (
                    ORDER BY r.cast_at NULLS LAST, st.permanent_number NULLS LAST, st.temporary_id,
                             st.id) AS rn
           FROM concrete_specimen_set st
           JOIN concrete_field_report r ON r.id = st.field_report_id
           WHERE st.project_id = $1 AND st.voided_at IS NULL AND r.workflow_state <> 'void'),
         start AS (SELECT rn FROM ordered WHERE id = $2::uuid)
         SELECT o.id
         FROM ordered o
         WHERE $2::uuid IS NULL OR o.rn > (SELECT rn FROM start)
         ORDER BY o.rn
         LIMIT ${CONCRETE_STRENGTH_TESTS_MAX_SETS + 1}`,
        [query.projectId, query.after ?? null],
      );
      if (query.after && rows.length === 0) {
        const { rows: found } = await db.query(
          `SELECT 1 FROM concrete_specimen_set st
           JOIN concrete_field_report r ON r.id = st.field_report_id
           WHERE st.id = $1 AND st.project_id = $2 AND st.voided_at IS NULL
             AND r.workflow_state <> 'void'`,
          [query.after, query.projectId],
        );
        if (found.length === 0) throw invalidCursor();
      }
      truncated = rows.length > CONCRETE_STRENGTH_TESTS_MAX_SETS;
      setIds = rows.slice(0, CONCRETE_STRENGTH_TESTS_MAX_SETS).map((r) => r.id);
      nextCursor = truncated ? setIds.at(-1)! : null;
    }
    const { lines } = await strengthTestsOf(db, setIds);
    const method = await currentMethod(db);
    return {
      method: method ? methodOf(method) : null,
      truncated,
      nextCursor,
      tests: query.failed ? lines.filter((l) => l.failed) : lines,
    };
  }

  async exclusion(specimenId: string): Promise<ConcreteStrengthExclusionState> {
    const specimen = await findSpecimen(this.database.pool, specimenId);
    if (!specimen) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    return stateOf(this.database.pool, specimen.id);
  }

  async exclude(
    specimenId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteStrengthExclusionState> {
    const db = this.database.pool;
    // Authority first, before the body (D09).
    const found = await findSpecimen(db, specimenId);
    if (!found) {
      if (await this.couldReviewSomewhere(user)) {
        throw new NotFoundException({ code: 'concrete_specimen_not_found' });
      }
      throw forbidden();
    }
    const set = (await findSet(db, found.set_id))!;
    if (!can(user, REVIEW, await strengthContext(db, set))) throw forbidden();
    if (await ownResult(db, found.id, user.userId)) throw forbidden('own_result');
    const input = parseBody(concreteStrengthExclusionRequestSchema, body);
    const hash = intentHash({
      kind: 'strength_exclusion',
      specimenId: found.id,
      excluded: input.excluded,
      reason: input.reason,
    });
    try {
      return await withTransaction(db, async (client) => {
        // The lock order of a result save: report, set, specimen.
        await client.query('SELECT 1 FROM concrete_field_report WHERE id = $1 FOR UPDATE', [
          found.field_report_id,
        ]);
        const locked = (await findSet(client, found.set_id, 'FOR UPDATE OF st'))!;
        await findSpecimen(client, found.id, 'FOR UPDATE OF sp');
        const replay = await replayOf(client, input.idempotencyKey, found.id, hash, user);
        if (replay) return replay;
        // Review fix: the reviewer context is read after the project and the account are locked,
        // with the strength assignments and approvals locked FOR SHARE (as exception notes do),
        // so an approval ended meanwhile is honoured.
        if (
          !(await canUnderLock(client, user, REVIEW, locked.project_id, {
            context: grantLoader((c) => lockedStrengthContext(c, locked)).loader,
          }))
        ) {
          throw forbidden();
        }
        if (await ownResult(client, found.id, user.userId)) throw forbidden('own_result');
        if (locked.voided || locked.report_void) throw new ConflictException({ code: 'set_void' });
        // Review fix: only a completed result is excluded, so an exclusion never waits on a
        // specimen for a result its reviewer later tests or enters (result saves refuse that).
        if (input.excluded && !(await hasCompleteResult(client, found))) {
          throw new ConflictException({ code: 'result_not_complete' });
        }
        const person = await resolveActingPerson(client, user, undefined, {
          field: 'performedByUserId',
          invalidCode: 'invalid_performed_by',
        });
        const current = (await exclusionsOf(client, [found.id])).get(found.id) ?? null;
        if (input.excluded && current) throw new ConflictException({ code: 'already_excluded' });
        if (!input.excluded && !current) throw new ConflictException({ code: 'not_excluded' });
        const { rows } = await client.query<{ next: number }>(
          `SELECT coalesce(max(sequence_no), 0) + 1 AS next FROM concrete_strength_exclusion
           WHERE specimen_id = $1`,
          [found.id],
        );
        const action = input.excluded ? 'exclude' : 'reinstate';
        await client.query(
          `INSERT INTO concrete_strength_exclusion
             (project_id, specimen_id, sequence_no, action, reason, user_id,
              user_initials_snapshot, user_name_snapshot, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [
            found.project_id,
            found.id,
            rows[0]!.next,
            action,
            input.reason,
            person.userId,
            person.initials,
            person.name,
            input.idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: input.excluded ? 'concrete_strength.excluded' : 'concrete_strength.reinstated',
          entityType: 'concrete_specimen',
          entityId: found.id,
          actor,
          reason: input.reason,
          before: { excluded: current !== null },
          after: { excluded: input.excluded, setId: found.set_id, sequenceNo: rows[0]!.next },
          requestId,
        });
        return stateOf(client, found.id);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_strength_exclusion_reported')) {
        throw new ConflictException({ code: 'result_on_strength_report' });
      }
      if (isConstraint(error, 'concrete_strength_exclusion_idempotency_key')) {
        const replay = await withTransaction(db, (client) =>
          replayOf(client, input.idempotencyKey, found.id, hash, user),
        );
        if (replay) return replay;
      }
      if (isConstraint(error, 'concrete_strength_exclusion_sequence_key')) {
        throw new ConflictException({ code: 'version_conflict' });
      }
      throw error;
    }
  }

  private async couldReviewSomewhere(user: AuthUser): Promise<boolean> {
    if (user.accountType === 'shared_lab' || user.status !== 'active') return false;
    const { rows } = await this.database.pool.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1)
           OR EXISTS (SELECT 1 FROM project_reviewer_assignment
                      WHERE reviewer_user_id = $1 AND scope_code = 'concrete_strength'
                        AND removed_at IS NULL) AS any`,
      [user.userId],
    );
    return rows[0]?.any ?? false;
  }
}

/** The specimen's latest attempt is a complete entry. */
async function hasCompleteResult(db: Db, specimen: SpecimenFacts): Promise<boolean> {
  const strengths = await specimenStrengthsOf(db, [specimen.set_id]);
  return strengths.some((sp) => sp.specimenId === specimen.id && sp.complete);
}

/** The reviewer tested or entered the specimen's latest result (no self-review). */
async function ownResult(db: Db, specimenId: string, userId: string): Promise<boolean> {
  const { rows } = await db.query<{ own: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM concrete_test_result t
       WHERE t.specimen_id = $1 AND t.attempt_no = (
               SELECT max(x.attempt_no) FROM concrete_test_result x WHERE x.specimen_id = $1)
         AND (t.tester_user_id = $2 OR EXISTS (
               SELECT 1 FROM concrete_test_result_revision rv
               WHERE rv.result_id = t.id AND rv.entered_by_user_id = $2))) AS own`,
    [specimenId, userId],
  );
  return rows[0]?.own ?? false;
}

async function stateOf(db: Db, specimenId: string): Promise<ConcreteStrengthExclusionState> {
  const { rows } = await db.query<{
    sequence_no: number;
    action: 'exclude' | 'reinstate';
    reason: string;
    user_id: string;
    user_initials_snapshot: string | null;
    user_name_snapshot: string;
    created_at: Date;
  }>(
    `SELECT sequence_no, action, reason, user_id, user_initials_snapshot, user_name_snapshot,
            created_at
     FROM concrete_strength_exclusion WHERE specimen_id = $1 ORDER BY sequence_no`,
    [specimenId],
  );
  const history: ConcreteStrengthExclusionEvent[] = rows.map((row) => ({
    sequenceNo: row.sequence_no,
    action: row.action,
    reason: row.reason,
    by: { userId: row.user_id, initials: row.user_initials_snapshot, name: row.user_name_snapshot },
    at: row.created_at.toISOString(),
  }));
  const last = history.at(-1);
  return {
    specimenId,
    excluded:
      last && last.action === 'exclude' ? { reason: last.reason, by: last.by, at: last.at } : null,
    history,
  };
}

async function replayOf(
  client: PoolClient,
  key: string,
  specimenId: string,
  hash: string,
  user: AuthUser,
): Promise<ConcreteStrengthExclusionState | null> {
  const { rows } = await client.query<{
    specimen_id: string;
    request_hash: string;
    user_id: string;
  }>(
    `SELECT specimen_id, request_hash, user_id FROM concrete_strength_exclusion
     WHERE idempotency_key = $1`,
    [key],
  );
  const previous = rows[0];
  if (!previous) return null;
  if (
    previous.specimen_id !== specimenId ||
    previous.request_hash !== hash ||
    previous.user_id !== user.userId
  ) {
    throw new ConflictException({ code: 'idempotency_key_reused' });
  }
  return stateOf(client, specimenId);
}
