import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_TEST_RESULT_FIELDS,
  concreteLabToday,
  concreteTestResultChanges,
  concreteTestResultSaveRequestSchema,
  type ConcreteSpecimenTestResults,
  type ConcreteTestResult,
  type ConcreteTestResultField,
  type ConcreteTestResultRevision,
  type ConcreteTestResultSaveResult,
  type ConcreteTestResultValues,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding, type Standing } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { resolveActingPerson } from '../lab/attribution.js';
import { intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { testingMachineSnapshot } from './concrete-equipment.service.js';

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTER = 'concrete_test.enter' as const;

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

interface SpecimenFacts {
  id: string;
  project_id: string;
  set_id: string;
  field_report_id: string;
  letter: string;
  temporary_id: string | null;
  permanent_id: string | null;
  set_voided: boolean;
  workflow_state: string;
}

const SELECT_SPECIMEN = `SELECT sp.id, sp.project_id, sp.set_id, st.field_report_id, sp.letter,
         st.temporary_id, st.permanent_id, st.voided_at IS NOT NULL AS set_voided,
         r.workflow_state
  FROM concrete_specimen sp
  JOIN concrete_specimen_set st ON st.id = sp.set_id
  JOIN concrete_field_report r ON r.id = st.field_report_id`;

interface ResultRow {
  id: string;
  project_id: string;
  specimen_id: string;
  attempt_no: number;
  state: 'draft';
  tested_on: string | null;
  tester_user_id: string | null;
  tester_initials_snapshot: string | null;
  tester_name_snapshot: string | null;
  max_load: string | null;
  load_unit: 'kN';
  height_readings: string[];
  diameter_readings: string[];
  dimension_unit: 'mm';
  units_provisional: boolean;
  notes: string | null;
  testing_machine_id: string | null;
  calculation_method: string | null;
  calculation_method_version: string | null;
  report_version_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
}

const SELECT_RESULT = `SELECT id, project_id, specimen_id, attempt_no, state, tested_on::text,
         tester_user_id, tester_initials_snapshot, tester_name_snapshot, max_load::text, load_unit,
         height_readings::text[], diameter_readings::text[], dimension_unit, units_provisional,
         notes, testing_machine_id, calculation_method, calculation_method_version,
         report_version_id, created_at, updated_at, version
  FROM concrete_test_result`;

function valuesOf(row: ResultRow): ConcreteTestResultValues {
  return {
    testedOn: row.tested_on,
    tester: row.tester_user_id,
    maxLoad: row.max_load === null ? null : Number(row.max_load),
    heightReadings: row.height_readings.map(Number),
    diameterReadings: row.diameter_readings.map(Number),
    notes: row.notes,
  };
}

function testerOf(row: ResultRow): PersonSnapshot | null {
  return row.tester_user_id === null
    ? null
    : {
        userId: row.tester_user_id,
        initials: row.tester_initials_snapshot,
        name: row.tester_name_snapshot!,
      };
}

/**
 * Concrete test-result drafts with tester attribution and correction history (MM-V2-C07).
 *
 * Saving needs `concrete_test.enter` (Lab Technicians, Lab Managers, LAB), checked by the route
 * guard and again under the account lock. On LAB the request names the staff member entering
 * it; they are recorded on the revision and never lend LAB their roles. The tester is a separate
 * recorded value (an active staff member with confirmed initials), defaulting to the person
 * entering a new attempt. Reads use the internal read (`inventory.read`), as every concrete read.
 *
 * Drafts only: nothing here completes a test, calculates a strength or judges pass/fail (C23).
 */
@Injectable()
export class ConcreteTestResultsService {
  constructor(private readonly database: DatabaseService) {}

  async list(specimenId: string): Promise<ConcreteSpecimenTestResults> {
    const specimen = await findSpecimen(this.database.pool, specimenId);
    if (!specimen) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    const { rows } = await this.database.pool.query<ResultRow>(
      `${SELECT_RESULT} WHERE specimen_id = $1 ORDER BY attempt_no`,
      [specimen.id],
    );
    const revisions = await revisionsFor(
      this.database.pool,
      rows.map((r) => r.id),
    );
    return {
      specimenId: specimen.id,
      identity: identityOf(specimen),
      results: rows.map((row) => toResult(row, revisions.get(row.id) ?? [])),
    };
  }

  async get(specimenId: string, resultId: string): Promise<ConcreteTestResult> {
    const specimen = await findSpecimen(this.database.pool, specimenId);
    if (!specimen) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    const result = await loadResult(this.database.pool, resultId);
    if (!result || result.specimenId !== specimen.id) {
      throw new NotFoundException({ code: 'concrete_test_result_not_found' });
    }
    return result;
  }

  async save(
    specimenId: string,
    resultId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteTestResultSaveResult> {
    const found = await findSpecimen(this.database.pool, specimenId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    if (!UUID_PATTERN.test(resultId)) {
      throw new NotFoundException({ code: 'concrete_test_result_not_found' });
    }
    const input = parseBody(concreteTestResultSaveRequestSchema, body);
    const hash = intentHash({ kind: 'test_result', specimenId: found.id, resultId, ...input });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        // D09: the report, then the set, then the specimen, then the result, then accounts.
        await client.query('SELECT 1 FROM concrete_field_report WHERE id = $1 FOR UPDATE', [
          found.field_report_id,
        ]);
        await client.query('SELECT 1 FROM concrete_specimen_set WHERE id = $1 FOR UPDATE', [
          found.set_id,
        ]);
        const specimen = (await findSpecimen(client, found.id, 'FOR UPDATE OF sp'))!;
        const { rows: existingRows } = await client.query<ResultRow>(
          `${SELECT_RESULT} WHERE id = $1 FOR UPDATE`,
          [resultId],
        );
        const existing = existingRows[0] ?? null;
        const replay = await replayOf(client, input.idempotencyKey, resultId, hash, user);
        if (replay) return replay;

        // Authority as it stands now (a role removed or an account disabled first is honoured).
        const standing = await lockStanding(
          client,
          input.testerUserId ? [user.userId, input.testerUserId] : [user.userId],
        );
        if (!can(asLocked(user, standing), ENTER)) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
        const enteredBy = await resolveActingPerson(client, user, input.enteredByUserId, {
          field: 'enteredByUserId',
          invalidCode: 'entered_by_invalid',
        });

        if (existing && existing.specimen_id !== specimen.id) {
          throw new ConflictException({ code: 'result_id_taken' });
        }
        if (input.version !== (existing?.version ?? 0)) {
          throw new ConflictException({
            code: 'version_conflict',
            current: existing ? await loadResult(client, existing.id) : null,
          });
        }
        if (specimen.workflow_state === 'void')
          throw new ConflictException({ code: 'report_void' });
        if (specimen.set_voided) throw new ConflictException({ code: 'set_void' });

        // The tester: kept on an existing attempt unless sent; on a new one, the person entering.
        let tester: PersonSnapshot | null = existing ? testerOf(existing) : enteredBy;
        if (input.testerUserId !== undefined) {
          tester =
            input.testerUserId === null
              ? null
              : activeStaff(standing, input.testerUserId, enteredBy);
        }

        const proposed: Partial<ConcreteTestResultValues> = {
          testedOn: input.testedOn,
          tester:
            existing && input.testerUserId === undefined ? undefined : (tester?.userId ?? null),
          maxLoad: input.maxLoad,
          heightReadings: input.heightReadings,
          diameterReadings: input.diameterReadings,
          notes: input.notes,
        };
        const saved = existing ? valuesOf(existing) : null;
        const { changed, corrections } = concreteTestResultChanges(saved, proposed);

        // A correction of a saved value says why; nothing is written without one (AC3).
        if (corrections.length > 0 && input.reason === undefined) {
          throw new UnprocessableEntityException({
            code: 'reason_required',
            corrections,
            errors: [
              {
                field: 'reason',
                code: 'required',
                message: 'Say why the saved value is being changed',
              },
            ],
          });
        }
        if (existing && changed.length === 0) {
          return { created: false, result: (await loadResult(client, existing.id))! };
        }

        const next = applyChanges(saved, proposed);
        const kind = existing ? (corrections.length > 0 ? 'correction' : 'entry') : 'initial';
        const revisionNo = (existing?.version ?? 0) + 1;
        const changes = Object.fromEntries(
          changed.map((field) => [
            field,
            {
              before: describe(field, saved, existing ? testerOf(existing) : null),
              after: describe(field, next, tester),
            },
          ]),
        );

        if (!existing) {
          const { rows: attempts } = await client.query<{ next: number }>(
            `SELECT coalesce(max(attempt_no), 0) + 1 AS next FROM concrete_test_result
             WHERE specimen_id = $1`,
            [specimen.id],
          );
          const machine = await testingMachineSnapshot(client, next.testedOn ?? concreteLabToday());
          await client.query(
            `INSERT INTO concrete_test_result
               (id, project_id, specimen_id, attempt_no, tested_on, tester_user_id,
                tester_initials_snapshot, tester_name_snapshot, max_load, height_readings,
                diameter_readings, notes, testing_machine_id, created_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)`,
            [
              resultId,
              specimen.project_id,
              specimen.id,
              attempts[0]!.next,
              next.testedOn,
              tester?.userId ?? null,
              tester?.initials ?? null,
              tester?.name ?? null,
              next.maxLoad,
              next.heightReadings,
              next.diameterReadings,
              next.notes,
              machine?.equipmentId ?? null,
              user.userId,
            ],
          );
        }
        await client.query(
          `INSERT INTO concrete_test_result_revision
             (project_id, result_id, revision_no, kind, changes, reason, account_user_id,
              account_type, entered_by_user_id, entered_by_initials_snapshot,
              entered_by_name_snapshot, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            specimen.project_id,
            resultId,
            revisionNo,
            kind,
            JSON.stringify(changes),
            input.reason ?? null,
            user.userId,
            user.accountType,
            enteredBy.userId,
            enteredBy.initials,
            enteredBy.name,
            input.idempotencyKey,
            hash,
          ],
        );
        if (existing) {
          await client.query(
            `UPDATE concrete_test_result
             SET tested_on = $2, tester_user_id = $3, tester_initials_snapshot = $4,
                 tester_name_snapshot = $5, max_load = $6, height_readings = $7,
                 diameter_readings = $8, notes = $9, version = $10, updated_at = now()
             WHERE id = $1`,
            [
              resultId,
              next.testedOn,
              tester?.userId ?? null,
              tester?.initials ?? null,
              tester?.name ?? null,
              next.maxLoad,
              next.heightReadings,
              next.diameterReadings,
              next.notes,
              revisionNo,
            ],
          );
        }
        await recordAudit(client, {
          action:
            kind === 'correction' ? 'concrete_test_result.corrected' : 'concrete_test_result.saved',
          entityType: 'concrete_test_result',
          entityId: resultId,
          actor,
          receiver: enteredBy,
          reason: kind === 'correction' ? input.reason : null,
          before: existing ? { version: existing.version } : null,
          after: { version: revisionNo, specimenId: specimen.id, changes },
          requestId,
        });
        return { created: !existing, result: (await loadResult(client, resultId))! };
      });
    } catch (error) {
      // An exact retry that raced the first attempt returns what the first one saved.
      if (isConstraint(error, 'concrete_test_result_revision_idempotency_key')) {
        const replay = await withTransaction(this.database.pool, (client) =>
          replayOf(client, input.idempotencyKey, resultId, hash, user),
        );
        if (replay) return replay;
      }
      // MM-V2-C39: the result is on a submitted, reviewed or issued strength report version; a
      // correction needs a recall, a return or (after issue) a revision first.
      if (isConstraint(error, 'concrete_test_result_reported')) {
        throw new ConflictException({ code: 'result_on_strength_report' });
      }
      // Two different first saves of one attempt raced: the loser sees a version conflict.
      if (isConstraint(error, 'concrete_test_result_pkey')) {
        throw new ConflictException({
          code: 'version_conflict',
          current: await loadResult(this.database.pool, resultId),
        });
      }
      throw error;
    }
  }
}

/** The same key from the same account for the same save returns the attempt as it stands. */
async function replayOf(
  client: PoolClient,
  key: string,
  resultId: string,
  hash: string,
  user: AuthUser,
): Promise<ConcreteTestResultSaveResult | null> {
  const { rows } = await client.query<{
    result_id: string;
    request_hash: string;
    account_user_id: string;
    revision_no: number;
  }>(
    `SELECT result_id, request_hash, account_user_id, revision_no
     FROM concrete_test_result_revision WHERE idempotency_key = $1`,
    [key],
  );
  const previous = rows[0];
  if (!previous) return null;
  if (
    previous.result_id !== resultId ||
    previous.request_hash !== hash ||
    previous.account_user_id !== user.userId
  ) {
    throw new ConflictException({ code: 'idempotency_key_reused' });
  }
  return { created: previous.revision_no === 1, result: (await loadResult(client, resultId))! };
}

/** A tester is an active staff member with confirmed initials (never a shared account). */
function activeStaff(
  standing: Map<string, Standing>,
  userId: string,
  enteredBy: PersonSnapshot,
): PersonSnapshot {
  if (userId === enteredBy.userId) return enteredBy;
  const person = standing.get(userId);
  if (!isActiveStaff(person) || !person.initials) {
    throw new UnprocessableEntityException({
      code: 'tester_invalid',
      errors: [
        {
          field: 'testerUserId',
          code: 'tester_invalid',
          message: 'must be an active staff member with confirmed initials',
        },
      ],
    });
  }
  return { userId: person.userId, initials: person.initials, name: person.displayName };
}

function applyChanges(
  saved: ConcreteTestResultValues | null,
  proposed: Partial<ConcreteTestResultValues>,
): ConcreteTestResultValues {
  const base: ConcreteTestResultValues = saved ?? {
    testedOn: null,
    tester: null,
    maxLoad: null,
    heightReadings: [],
    diameterReadings: [],
    notes: null,
  };
  const next = { ...base };
  for (const field of CONCRETE_TEST_RESULT_FIELDS) {
    const value = proposed[field];
    if (value !== undefined) (next as Record<string, unknown>)[field] = value;
  }
  return next;
}

/** A field's value as the history shows it (the tester as a person, not just an ID). */
function describe(
  field: ConcreteTestResultField,
  values: ConcreteTestResultValues | null,
  tester: PersonSnapshot | null,
): unknown {
  if (field === 'tester') return values?.tester ? tester : null;
  const value = values?.[field] ?? null;
  return Array.isArray(value) && value.length === 0 ? [] : value;
}

async function findSpecimen(
  db: Db,
  id: string,
  lock: '' | 'FOR UPDATE OF sp' = '',
): Promise<SpecimenFacts | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<SpecimenFacts>(`${SELECT_SPECIMEN} WHERE sp.id = $1 ${lock}`, [
    id,
  ]);
  return rows[0] ?? null;
}

function identityOf(specimen: SpecimenFacts) {
  return {
    temporaryId: specimen.temporary_id === null ? null : specimen.temporary_id + specimen.letter,
    permanentId: specimen.permanent_id === null ? null : specimen.permanent_id + specimen.letter,
  };
}

async function loadResult(db: Db, id: string): Promise<ConcreteTestResult | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ResultRow>(`${SELECT_RESULT} WHERE id = $1`, [id]);
  const row = rows[0];
  if (!row) return null;
  return toResult(row, (await revisionsFor(db, [id])).get(id) ?? []);
}

async function revisionsFor(
  db: Db,
  ids: string[],
): Promise<Map<string, ConcreteTestResultRevision[]>> {
  const map = new Map<string, ConcreteTestResultRevision[]>();
  if (ids.length === 0) return map;
  const { rows } = await db.query<{
    result_id: string;
    revision_no: number;
    kind: ConcreteTestResultRevision['kind'];
    changes: ConcreteTestResultRevision['changes'];
    reason: string | null;
    account_user_id: string;
    account_type: 'personal' | 'shared_lab' | 'test';
    entered_by_user_id: string;
    entered_by_initials_snapshot: string | null;
    entered_by_name_snapshot: string;
    created_at: Date;
  }>(
    `SELECT result_id, revision_no, kind, changes, reason, account_user_id, account_type,
            entered_by_user_id, entered_by_initials_snapshot, entered_by_name_snapshot, created_at
     FROM concrete_test_result_revision WHERE result_id = ANY($1::uuid[])
     ORDER BY result_id, revision_no`,
    [ids],
  );
  for (const row of rows) {
    const list = map.get(row.result_id) ?? [];
    list.push({
      revisionNo: row.revision_no,
      kind: row.kind,
      changes: row.changes,
      reason: row.reason,
      enteredBy: {
        userId: row.entered_by_user_id,
        initials: row.entered_by_initials_snapshot,
        name: row.entered_by_name_snapshot,
      },
      account: { userId: row.account_user_id, accountType: row.account_type },
      at: row.created_at.toISOString(),
    });
    map.set(row.result_id, list);
  }
  return map;
}

function toResult(row: ResultRow, revisions: ConcreteTestResultRevision[]): ConcreteTestResult {
  const values = valuesOf(row);
  return {
    id: row.id,
    specimenId: row.specimen_id,
    projectId: row.project_id,
    attemptNo: row.attempt_no,
    state: row.state,
    testedOn: values.testedOn,
    tester: testerOf(row),
    maxLoad: values.maxLoad,
    heightReadings: values.heightReadings,
    diameterReadings: values.diameterReadings,
    units: {
      load: row.load_unit,
      dimension: row.dimension_unit,
      provisional: row.units_provisional,
    },
    notes: row.notes,
    testingMachineId: row.testing_machine_id,
    calculationMethod: row.calculation_method,
    calculationMethodVersion: row.calculation_method_version,
    reportVersionId: row.report_version_id,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
    revisions,
  };
}
