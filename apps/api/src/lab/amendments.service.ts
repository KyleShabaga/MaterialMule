import { createHash } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  formatLineDepth,
  lineSubmitProblems,
  type AmendmentResult,
  type Amendment,
  type AmendProgramRequest,
  type ChangeTestRequest,
  type CoverageUnit,
  type IdentityRevision,
  type LabSourceRef,
  type LaterReceipts,
  type LineScope,
  type SampleIdentityInput,
  type TestRequestResult,
  type TestRequestStatus,
  type TestType,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from './attribution.js';
import { loadTestTypes } from './catalogue.service.js';
import { lineCoverage, resolveSource, sourceCandidates } from './coverage.js';
import { amendmentLineDiscrepancy } from './programs.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_LINES = 200;

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

interface ProgramRow {
  id: string;
  status: 'draft' | 'submitted' | 'closed';
  version: number;
  program_number: string | null;
  project_id: string;
}

interface LineRow {
  id: string;
  line_number: number;
  scope: LineScope;
  source_kind: LabSourceRef['kind'] | null;
  test_hole_id: string | null;
  source_storage_unit_id: string | null;
  source_bulk_group_id: string | null;
  sample_label: string | null;
  depth_mode: 'point' | 'interval' | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
}

function sourceOf(line: LineRow): LabSourceRef | null {
  switch (line.source_kind) {
    case 'test_hole':
      return { kind: 'test_hole', id: line.test_hole_id! };
    case 'standalone_unit':
      return { kind: 'standalone_unit', id: line.source_storage_unit_id! };
    case 'standalone_bulk_group':
      return { kind: 'standalone_bulk_group', id: line.source_bulk_group_id! };
    default:
      return null;
  }
}

const num = (value: string | null) => (value === null ? null : Number(value));

/** "B1 at 1.5–2 m", or null when there is no Specific identity. */
function sampleText(identity: {
  sampleLabel: string | null;
  depthMode: 'point' | 'interval' | null;
  depthFrom: number | null;
  depthTo: number | null;
  depthUnit: 'ft' | 'm' | null;
}): string | null {
  if (!identity.sampleLabel) return null;
  const depth = formatLineDepth(identity);
  return depth ? `${identity.sampleLabel} at ${depth}` : identity.sampleLabel;
}

/**
 * Amendments to an open program (D02) and changes to an Accepted test (D09), MM-T26.
 *
 * Personal accounts only (`lab_program.amend`); LAB is refused by the route policy whoever it
 * selects. A closed program must be reopened first. Amendments lock the program `FOR UPDATE`
 * (they change its set of tests, so they serialise with closing) and record exactly what they
 * added; frozen coverage is only ever appended to. An accepted-request change locks the program
 * `FOR SHARE` and the test `FOR UPDATE`, resets only that test to Requested and keeps its earlier
 * identity, review and acceptance as history. Exact retries return the original result.
 */
@Injectable()
export class LabAmendmentsService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Accepted-request change
  // -------------------------------------------------------------------------------------------

  async changeRequest(
    testRequestId: string,
    request: ChangeTestRequest,
    user: AuthUser,
  ): Promise<TestRequestResult> {
    if (!UUID_PATTERN.test(testRequestId)) {
      throw new NotFoundException({ code: 'test_request_not_found' });
    }
    const hash = intentHash({
      testRequestId,
      action: 'change',
      identity: request.identity ?? null,
      testTypeId: request.testTypeId ?? null,
      reason: request.reason,
      version: request.version,
    });
    return withTransaction(this.database.pool, async (client) => {
      const { rows: previous } = await client.query<{
        test_request_id: string;
        request_hash: string;
        user_id: string;
      }>(
        `SELECT test_request_id, request_hash, user_id FROM test_request_identity_revision
         WHERE idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== hash || previous[0].user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return requestResult(client, previous[0].test_request_id);
      }
      const { rows: located } = await client.query<{ program_id: string }>(
        'SELECT program_id FROM test_request WHERE id = $1',
        [testRequestId],
      );
      if (!located[0]) throw new NotFoundException({ code: 'test_request_not_found' });
      const program = (await lockProgram(client, located[0].program_id, 'FOR SHARE'))!;
      const { rows } = await client.query<
        LineRow & {
          request_id: string;
          line_id: string;
          status: TestRequestStatus;
          version: number;
          identity_revision: number;
          test_type_id: string;
          test_code_snapshot: string;
          sample_label_override: string | null;
          depth_mode_override: 'point' | 'interval' | null;
          depth_from_override: string | null;
          depth_to_override: string | null;
          depth_unit_override: 'ft' | 'm' | null;
        }
      >(
        `SELECT r.id AS request_id, r.line_id, r.status, r.version, r.identity_revision,
                r.test_type_id, r.test_code_snapshot, r.sample_label_override,
                r.depth_mode_override, r.depth_from_override, r.depth_to_override,
                r.depth_unit_override,
                l.id, l.line_number, l.scope, l.source_kind, l.test_hole_id,
                l.source_storage_unit_id, l.source_bulk_group_id, l.sample_label, l.depth_mode,
                l.depth_from, l.depth_to, l.depth_unit
         FROM test_request r JOIN test_line l ON l.id = r.line_id
         WHERE r.id = $1 FOR UPDATE OF r`,
        [testRequestId],
      );
      const current = rows[0]!;
      if (program.status !== 'submitted') {
        unprocessable('program_not_open', 'id', 'reopen this program before changing a test');
      }
      if (current.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { testRequestId, status: current.status, version: current.version },
        });
      }
      if (current.status !== 'accepted') {
        unprocessable(
          'invalid_transition',
          'id',
          'only an accepted test’s sample, depth or test is changed this way',
        );
      }
      if (request.identity && current.scope !== 'specific') {
        unprocessable(
          'not_specific',
          'identity',
          'only a test of a specific sample has its own sample and depth',
        );
      }
      const before = current.sample_label_override
        ? {
            sampleLabel: current.sample_label_override,
            depthMode: current.depth_mode_override,
            depthFrom: num(current.depth_from_override),
            depthTo: num(current.depth_to_override),
            depthUnit: current.depth_unit_override,
          }
        : {
            sampleLabel: current.sample_label,
            depthMode: current.depth_mode,
            depthFrom: num(current.depth_from),
            depthTo: num(current.depth_to),
            depthUnit: current.depth_unit,
          };
      const after = request.identity ?? before;
      const identityChanged =
        request.identity !== undefined &&
        (before.sampleLabel !== after.sampleLabel ||
          before.depthMode !== after.depthMode ||
          before.depthFrom !== after.depthFrom ||
          before.depthTo !== after.depthTo ||
          before.depthUnit !== after.depthUnit);

      let test: TestType | null = null;
      if (request.testTypeId && request.testTypeId !== current.test_type_id) {
        await client.query('SELECT 1 FROM test_type WHERE id = $1 FOR SHARE', [request.testTypeId]);
        test = (await loadTestTypes(client, [request.testTypeId]))[0] ?? null;
        if (!test) unprocessable('test_type_not_found', 'testTypeId', 'test not found');
        if (!test.active) {
          unprocessable(
            'retired_tests',
            'testTypeId',
            `${test.code} is retired and can’t be chosen`,
          );
        }
        const { rows: duplicate } = await client.query(
          `SELECT 1 FROM test_request
           WHERE line_id = $1 AND test_type_id = $2 AND repeat_of_id IS NULL AND id <> $3`,
          [current.line_id, test.id, testRequestId],
        );
        if (duplicate.length > 0) {
          unprocessable('duplicate_test', 'testTypeId', `${test.code} is already on this line`);
        }
      }
      if (!identityChanged && !test) {
        unprocessable('no_changes', 'identity', 'nothing would change');
      }

      const override = identityChanged ? (after as SampleIdentityInput) : null;
      await client.query(
        `UPDATE test_request
         SET status = 'requested', review_state = NULL, accepted_at = NULL,
             accepted_by_user_id = NULL, accepted_via_delegation_id = NULL,
             version = version + 1, identity_revision = identity_revision + 1,
             test_type_id = coalesce($2, test_type_id),
             test_code_snapshot = coalesce($3, test_code_snapshot),
             test_name_snapshot = CASE WHEN $2::uuid IS NULL THEN test_name_snapshot ELSE $4 END,
             test_description_snapshot = coalesce($5, test_description_snapshot),
             test_group_snapshot = coalesce($6, test_group_snapshot),
             test_subgroup_snapshot =
               CASE WHEN $2::uuid IS NULL THEN test_subgroup_snapshot ELSE $7 END,
             sample_label_override = CASE WHEN $8 THEN $9 ELSE sample_label_override END,
             depth_mode_override = CASE WHEN $8 THEN $10 ELSE depth_mode_override END,
             depth_from_override = CASE WHEN $8 THEN $11::numeric ELSE depth_from_override END,
             depth_to_override = CASE WHEN $8 THEN $12::numeric ELSE depth_to_override END,
             depth_unit_override = CASE WHEN $8 THEN $13 ELSE depth_unit_override END,
             status_changed_at = now(), status_changed_by_account_user_id = $14,
             status_changed_for_user_id = $14
         WHERE id = $1`,
        [
          testRequestId,
          test?.id ?? null,
          test?.code ?? null,
          test?.name ?? null,
          test?.description ?? null,
          test?.groupName ?? null,
          test?.subgroupName ?? null,
          override !== null,
          override?.sampleLabel ?? null,
          override?.depthMode ?? null,
          override?.depthFrom ?? null,
          override?.depthTo ?? null,
          override?.depthUnit ?? null,
          user.userId,
        ],
      );
      await client.query(
        `INSERT INTO test_request_status_history
           (test_request_id, program_id, from_status, to_status, account_user_id, account_type,
            account_initials_snapshot, account_name_snapshot, person_user_id,
            person_initials_snapshot, person_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, 'accepted', 'requested', $3, $4, $5, $6, $3, $5, $6, $7, $8)`,
        [
          testRequestId,
          program.id,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          request.idempotencyKey,
          hash,
        ],
      );
      const beforeRecord = {
        test: current.test_code_snapshot,
        testTypeId: current.test_type_id,
        sample: sampleText(before),
        identity: before,
      };
      const afterRecord = {
        test: test?.code ?? current.test_code_snapshot,
        testTypeId: test?.id ?? current.test_type_id,
        sample: sampleText(after),
        identity: after,
      };
      await client.query(
        `INSERT INTO test_request_identity_revision
           (test_request_id, program_id, revision_number, before, after, reason, user_id,
            account_type, initials_snapshot, name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          testRequestId,
          program.id,
          current.identity_revision + 1,
          JSON.stringify(beforeRecord),
          JSON.stringify(afterRecord),
          request.reason,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          request.idempotencyKey,
          hash,
        ],
      );
      await recordAudit(client, {
        action: 'test_request.identity_changed',
        entityType: 'test_request',
        entityId: testRequestId,
        actor: actorOf(user),
        reason: request.reason,
        before: { status: 'accepted', test: beforeRecord.test, sample: beforeRecord.sample },
        after: {
          status: 'requested',
          test: afterRecord.test,
          sample: afterRecord.sample,
          programNumber: program.program_number,
        },
      });
      return requestResult(client, testRequestId);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Amendments
  // -------------------------------------------------------------------------------------------

  /** Units each ALL/Grabs/SPT line could take in now: received since its coverage froze. */
  async laterReceipts(programId: string): Promise<LaterReceipts> {
    const program = await lockProgram(this.database.pool, programId, '');
    if (!program || program.status === 'draft') {
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    const lines = await loadLines(this.database.pool, programId);
    const result: LaterReceipts['lines'] = [];
    for (const line of lines) {
      const source = sourceOf(line);
      if (line.scope === 'specific' || !source) continue;
      const later = await laterCandidates(this.database.pool, program, line, source);
      result.push({
        lineId: line.id,
        lineNumber: line.line_number,
        scope: line.scope,
        units: later.map((c) => ({
          storageUnitId: c.storageUnitId,
          readableId: c.readableId,
          unitType: c.unitType,
          contents: c.contents,
          receivedDate: c.receivedDate,
          unknownClassification: line.scope !== 'all',
        })),
      });
    }
    return { programId, version: program.version, lines: result };
  }

  async amend(
    programId: string,
    request: AmendProgramRequest,
    user: AuthUser,
  ): Promise<AmendmentResult> {
    if (!UUID_PATTERN.test(programId))
      throw new NotFoundException({ code: 'lab_program_not_found' });
    const hash = intentHash({ programId, action: 'amend', ...request, idempotencyKey: undefined });
    try {
      return await withTransaction(this.database.pool, (client) =>
        this.amendIn(client, programId, request, hash, user),
      );
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'program_amendment_idempotency_key_key'
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      throw error;
    }
  }

  private async amendIn(
    client: PoolClient,
    programId: string,
    request: AmendProgramRequest,
    hash: string,
    user: AuthUser,
  ): Promise<AmendmentResult> {
    const { rows: previous } = await client.query<{
      id: string;
      request_hash: string;
      user_id: string;
    }>('SELECT id, request_hash, user_id FROM program_amendment WHERE idempotency_key = $1', [
      request.idempotencyKey,
    ]);
    if (previous[0]) {
      if (previous[0].request_hash !== hash || previous[0].user_id !== user.userId) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      const { rows } = await client.query<{ version: number }>(
        'SELECT version FROM lab_program WHERE id = $1',
        [programId],
      );
      return { programId, amendmentId: previous[0].id, version: rows[0]!.version };
    }
    const program = await lockProgram(client, programId, 'FOR UPDATE');
    if (!program || program.status === 'draft') {
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    if (program.status !== 'submitted') {
      unprocessable('program_not_open', 'id', 'reopen this program before amending it');
    }
    if (program.version !== request.version) {
      throw new ConflictException({
        code: 'version_conflict',
        current: { programId, status: program.status, version: program.version },
      });
    }
    const lines = await loadLines(client, programId);
    const byId = new Map(lines.map((line) => [line.id, line]));
    if (lines.length + request.addLines.length > MAX_LINES) {
      unprocessable('too_many_lines', 'addLines', `a program holds at most ${MAX_LINES} lines`);
    }

    // Catalogue: every test named anywhere must exist and be active (FOR SHARE: a concurrent
    // retirement waits, as at submission).
    const testIds = [
      ...new Set([
        ...request.addTests.flatMap((entry) => entry.testTypeIds),
        ...request.addLines.flatMap((entry) => entry.testTypeIds),
      ]),
    ];
    await client.query('SELECT 1 FROM test_type WHERE id = ANY ($1::uuid[]) FOR SHARE', [testIds]);
    const catalogue = new Map((await loadTestTypes(client, testIds)).map((t) => [t.id, t]));
    for (const id of testIds) {
      const test = catalogue.get(id);
      if (!test) unprocessable('test_type_not_found', 'testTypeIds', 'test not found');
      if (!test.active) {
        unprocessable('retired_tests', 'testTypeIds', `${test.code} is retired and can’t be added`);
      }
    }

    // New tests on existing lines.
    const seenLines = new Set<string>();
    for (const [i, entry] of request.addTests.entries()) {
      const line = byId.get(entry.lineId);
      if (!line) unprocessable('line_not_in_program', `addTests.${i}.lineId`, 'line not found');
      if (seenLines.has(entry.lineId)) {
        unprocessable('duplicate_line', `addTests.${i}.lineId`, 'list each line once');
      }
      seenLines.add(entry.lineId);
      const { rows } = await client.query<{ code: string }>(
        `SELECT test_code_snapshot AS code FROM test_request
         WHERE line_id = $1 AND test_type_id = ANY ($2::uuid[]) AND repeat_of_id IS NULL`,
        [entry.lineId, entry.testTypeIds],
      );
      if (rows.length > 0) {
        unprocessable(
          'duplicate_test',
          `addTests.${i}.testTypeIds`,
          `${rows.map((r) => r.code).join(', ')} is already on line ${line.line_number}`,
        );
      }
    }

    // Later receipts: only units received since the line froze, explicitly listed.
    const laterByLine = new Map<string, Awaited<ReturnType<typeof laterCandidates>>>();
    seenLines.clear();
    for (const [i, entry] of request.includeLaterReceipts.entries()) {
      const line = byId.get(entry.lineId);
      if (!line) {
        unprocessable('line_not_in_program', `includeLaterReceipts.${i}.lineId`, 'line not found');
      }
      if (seenLines.has(entry.lineId)) {
        unprocessable('duplicate_line', `includeLaterReceipts.${i}.lineId`, 'list each line once');
      }
      seenLines.add(entry.lineId);
      const source = sourceOf(line);
      if (line.scope === 'specific' || !source) {
        unprocessable(
          'not_extendable',
          `includeLaterReceipts.${i}.lineId`,
          'only an ALL, Grabs or SPT line takes in later receipts',
        );
      }
      const later = await laterCandidates(client, program, line, source, true);
      const available = new Set(later.map((c) => c.storageUnitId));
      if (entry.unitIds.some((id) => !available.has(id))) {
        unprocessable(
          'unit_not_later_receipt',
          `includeLaterReceipts.${i}.unitIds`,
          'a unit is not a later receipt of this line’s source (already covered, disposed or elsewhere)',
        );
      }
      laterByLine.set(
        entry.lineId,
        later.filter((c) => entry.unitIds.includes(c.storageUnitId)),
      );
    }

    // New lines: complete, with the coverage the requester reviewed.
    const newLines: {
      input: AmendProgramRequest['addLines'][number];
      display: string;
      coverage: CoverageUnit[];
    }[] = [];
    const changed: { index: number; coverage: CoverageUnit[] }[] = [];
    for (const [i, input] of request.addLines.entries()) {
      const field = `addLines.${i}`;
      const display = await resolveSource(
        client,
        program.project_id,
        input.source,
        `${field}.source`,
      );
      if (input.scope !== 'specific' && input.identity) {
        unprocessable('not_allowed', `${field}.identity`, 'is only for a specific sample');
      }
      const problems = lineSubmitProblems({
        source: input.source,
        scope: input.scope,
        sampleLabel: input.identity?.sampleLabel ?? null,
        depthMode: input.identity?.depthMode ?? null,
        depthFrom: input.identity?.depthFrom ?? null,
        depthTo: input.identity?.depthTo ?? null,
        depthUnit: input.identity?.depthUnit ?? null,
        testCount: input.testTypeIds.length,
      });
      if (problems.length > 0) {
        throw new UnprocessableEntityException({
          code: 'line_incomplete',
          errors: problems.map((p) => ({ ...p, field: `${field}.${p.field}` })),
        });
      }
      if (input.scope === 'all' && input.unitIds.length > 0) {
        unprocessable('not_allowed', `${field}.unitIds`, 'ALL covers every unit of the source');
      }
      const candidates = await sourceCandidates(client, program.project_id, input.source, {
        lock: true,
      });
      const coverage = lineCoverage(input.scope, candidates, input.unitIds);
      if (coverage.strayChoices.length > 0) {
        unprocessable(
          'unit_not_in_source',
          `${field}.unitIds`,
          'lists a unit that is not available from this source',
        );
      }
      if (input.scope !== 'specific') {
        const included = coverage.coverage.filter((c) => c.included).map((c) => c.storageUnitId);
        const reviewed = new Set(input.reviewedCoverageUnitIds);
        if (included.length !== reviewed.size || included.some((id) => !reviewed.has(id))) {
          changed.push({ index: i, coverage: coverage.coverage });
        }
      } else {
        const discrepancy = await amendmentLineDiscrepancy(client, program, {
          id: '00000000-0000-4000-8000-000000000000',
          source: input.source,
          sampleLabel: input.identity!.sampleLabel,
          depthMode: input.identity!.depthMode,
          depthFrom: input.identity!.depthFrom,
          depthTo: input.identity!.depthTo,
          depthUnit: input.identity!.depthUnit,
          acknowledgedDepths: input.acknowledgedDepths,
        });
        if (discrepancy && !discrepancy.acknowledged) {
          unprocessable(
            'depth_discrepancy',
            `${field}.acknowledgedDepths`,
            `This sample is also requested at ${discrepancy.others
              .map((other) => other.depth)
              .join(', ')}. Acknowledge the different depth to continue.`,
            { discrepancy },
          );
        }
      }
      newLines.push({ input, display, coverage: coverage.coverage });
    }
    if (changed.length > 0) {
      // The material differs from what the requester reviewed: show it again, change nothing.
      throw new ConflictException({ code: 'coverage_changed', lines: changed });
    }

    // Record the amendment, then add exactly what it lists.
    const { rows: numbers } = await client.query<{ n: number }>(
      'SELECT count(*)::int + 1 AS n FROM program_amendment WHERE program_id = $1',
      [programId],
    );
    const laterUnits = [...laterByLine.values()].flat();
    const details = {
      addTests: request.addTests.map((entry) => ({
        lineId: entry.lineId,
        lineNumber: byId.get(entry.lineId)!.line_number,
        tests: entry.testTypeIds.map((id) => catalogue.get(id)!.code),
      })),
      addLines: newLines.map((line, i) => ({
        lineNumber: lines.length + i + 1,
        scope: line.input.scope,
        source: line.display,
        sample: line.input.identity ? sampleText(line.input.identity) : null,
        tests: line.input.testTypeIds.map((id) => catalogue.get(id)!.code),
        covered: line.coverage.filter((c) => c.included).map((c) => c.readableId),
      })),
      includeLaterReceipts: [...laterByLine.entries()].map(([lineId, units]) => ({
        lineId,
        lineNumber: byId.get(lineId)!.line_number,
        units: units.map((u) => u.readableId),
      })),
    };
    const { rows: amendment } = await client.query<{ id: string }>(
      `INSERT INTO program_amendment (program_id, amendment_number, reason, details,
                                      added_unit_readable_ids, user_id, account_type,
                                      initials_snapshot, name_snapshot, idempotency_key,
                                      request_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING id`,
      [
        programId,
        numbers[0]!.n,
        request.reason,
        JSON.stringify(details),
        laterUnits.map((u) => u.readableId),
        user.userId,
        user.accountType,
        user.initials,
        user.displayName,
        request.idempotencyKey,
        hash,
      ],
    );
    const amendmentId = amendment[0]!.id;
    const created: { id: string; code: string; lineNumber: number }[] = [];
    const insertRequests = async (lineId: string, lineNumber: number, ids: string[]) => {
      const { rows: order } = await client.query<{ next: number }>(
        'SELECT coalesce(max(sort_order) + 1, 0)::int AS next FROM test_request WHERE line_id = $1',
        [lineId],
      );
      for (const [index, testTypeId] of ids.entries()) {
        const test = catalogue.get(testTypeId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                     test_name_snapshot, test_description_snapshot,
                                     test_group_snapshot, test_subgroup_snapshot, sort_order,
                                     amendment_id, created_by_user_id, created_by_name_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
          [
            programId,
            lineId,
            test.id,
            test.code,
            test.name,
            test.description,
            test.groupName,
            test.subgroupName,
            order[0]!.next + index,
            amendmentId,
            user.userId,
            user.displayName,
          ],
        );
        created.push({ id: rows[0]!.id, code: test.code, lineNumber });
      }
    };
    const insertCoverage = async (lineId: string, units: CoverageUnit[]) => {
      for (const unit of units) {
        await client.query(
          `INSERT INTO program_scope_snapshot
             (program_id, line_id, storage_unit_id, receipt_id, project_id, included,
              matching_basis, unit_readable_id_snapshot, unit_type_snapshot, contents_snapshot,
              received_date_snapshot, amendment_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            programId,
            lineId,
            unit.storageUnitId,
            unit.receiptId,
            program.project_id,
            unit.included,
            unit.matchingBasis,
            unit.readableId,
            unit.unitType,
            unit.contents,
            unit.receivedDate,
            amendmentId,
          ],
        );
      }
    };

    for (const entry of request.addTests) {
      const line = byId.get(entry.lineId)!;
      await insertRequests(line.id, line.line_number, entry.testTypeIds);
    }
    for (const [lineId, units] of laterByLine) {
      const line = byId.get(lineId)!;
      // Grabs/SPT units have no structured G/S classification: listing one is the review that
      // includes it. Units not listed stay out (and stay offered as later receipts).
      await insertCoverage(
        lineId,
        units.map((c) => ({
          storageUnitId: c.storageUnitId,
          readableId: c.readableId,
          unitType: c.unitType,
          contents: c.contents,
          receivedDate: c.receivedDate,
          receiptId: c.receiptId,
          included: true,
          matchingBasis: line.scope === 'all' ? c.basis : 'reviewed_included',
          amendmentId,
        })),
      );
    }
    for (const [i, line] of newLines.entries()) {
      const lineNumber = lines.length + i + 1;
      const source = line.input.source;
      const identity = line.input.identity;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                source_storage_unit_id, source_bulk_group_id, scope, sample_label,
                                depth_mode, depth_from, depth_to, depth_unit, acknowledged_depths,
                                source_display_snapshot, coverage_captured_at, amendment_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, now(), $16)
         RETURNING id`,
        [
          programId,
          program.project_id,
          lineNumber,
          source.kind,
          source.kind === 'test_hole' ? source.id : null,
          source.kind === 'standalone_unit' ? source.id : null,
          source.kind === 'standalone_bulk_group' ? source.id : null,
          line.input.scope,
          identity?.sampleLabel ?? null,
          identity?.depthMode ?? null,
          identity?.depthFrom ?? null,
          identity?.depthTo ?? null,
          identity?.depthUnit ?? null,
          line.input.acknowledgedDepths,
          line.display,
          amendmentId,
        ],
      );
      await insertCoverage(rows[0]!.id, line.coverage);
      await insertRequests(rows[0]!.id, lineNumber, line.input.testTypeIds);
    }

    const { rows: versions } = await client.query<{ version: number }>(
      `UPDATE lab_program SET version = version + 1, updated_at = now() WHERE id = $1
       RETURNING version`,
      [programId],
    );
    const actor = actorOf(user);
    await recordAudit(client, {
      action: 'lab_program.amended',
      entityType: 'lab_program',
      entityId: programId,
      actor,
      reason: request.reason,
      after: { programNumber: program.program_number, amendmentId, ...details },
    });
    for (const request of created) {
      await recordAudit(client, {
        action: 'test_request.created',
        entityType: 'test_request',
        entityId: request.id,
        actor,
        after: {
          programNumber: program.program_number,
          lineNumber: request.lineNumber,
          code: request.code,
          amendmentId,
        },
      });
    }
    return { programId, amendmentId, version: versions[0]!.version };
  }
}

async function lockProgram(db: Db, id: string, lock: '' | 'FOR SHARE' | 'FOR UPDATE') {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ProgramRow>(
    `SELECT id, status, version, program_number, project_id FROM lab_program WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

async function loadLines(db: Db, programId: string): Promise<LineRow[]> {
  const { rows } = await db.query<LineRow>(
    `SELECT id, line_number, scope, source_kind, test_hole_id, source_storage_unit_id,
            source_bulk_group_id, sample_label, depth_mode, depth_from, depth_to, depth_unit
     FROM test_line WHERE program_id = $1 ORDER BY line_number`,
    [programId],
  );
  return rows;
}

/** The source's current units not yet in the line's coverage (never disposed units). */
async function laterCandidates(
  db: Db,
  program: ProgramRow,
  line: LineRow,
  source: LabSourceRef,
  lock = false,
) {
  const candidates = await sourceCandidates(db, program.project_id, source, { lock });
  const { rows } = await db.query<{ storage_unit_id: string }>(
    'SELECT storage_unit_id FROM program_scope_snapshot WHERE line_id = $1',
    [line.id],
  );
  const covered = new Set(rows.map((row) => row.storage_unit_id));
  return candidates.filter((c) => !covered.has(c.storageUnitId));
}

async function requestResult(db: Db, id: string): Promise<TestRequestResult> {
  const { rows } = await db.query<{ status: string; version: number }>(
    'SELECT status, version FROM test_request WHERE id = $1',
    [id],
  );
  return { testRequestId: id, status: rows[0]!.status, version: rows[0]!.version };
}

/** Amendments of a program, oldest first, with what each added. */
export async function loadAmendments(db: Db, programId: string): Promise<Amendment[]> {
  const { rows } = await db.query<{
    id: string;
    amendment_number: number;
    reason: string | null;
    added_unit_readable_ids: string[];
    user_id: string;
    initials_snapshot: string | null;
    name_snapshot: string;
    created_at: Date;
    line_ids: string[] | null;
    request_ids: string[] | null;
  }>(
    `SELECT a.*,
            (SELECT array_agg(l.id ORDER BY l.line_number) FROM test_line l
             WHERE l.amendment_id = a.id) AS line_ids,
            (SELECT array_agg(r.id ORDER BY r.created_at, r.id) FROM test_request r
             WHERE r.amendment_id = a.id) AS request_ids
     FROM program_amendment a WHERE a.program_id = $1 ORDER BY a.amendment_number`,
    [programId],
  );
  return rows.map((row) => ({
    id: row.id,
    amendmentNumber: row.amendment_number,
    reason: row.reason,
    addedLineIds: row.line_ids ?? [],
    addedRequestIds: row.request_ids ?? [],
    addedUnitReadableIds: row.added_unit_readable_ids,
    person: { userId: row.user_id, initials: row.initials_snapshot, name: row.name_snapshot },
    createdAt: row.created_at.toISOString(),
  }));
}

/** Accepted-request changes of a program, oldest first. */
export async function loadIdentityRevisions(
  db: Db,
  programId: string,
): Promise<IdentityRevision[]> {
  const { rows } = await db.query<{
    id: string;
    test_request_id: string;
    revision_number: number;
    before: { test: string; sample: string | null };
    after: { test: string; sample: string | null };
    reason: string;
    user_id: string;
    initials_snapshot: string | null;
    name_snapshot: string;
    changed_at: Date;
  }>(
    `SELECT * FROM test_request_identity_revision WHERE program_id = $1
     ORDER BY changed_at, id`,
    [programId],
  );
  return rows.map((row) => ({
    id: row.id,
    testRequestId: row.test_request_id,
    revisionNumber: row.revision_number,
    before: { test: row.before.test, sample: row.before.sample },
    after: { test: row.after.test, sample: row.after.sample },
    reason: row.reason,
    person: { userId: row.user_id, initials: row.initials_snapshot, name: row.name_snapshot },
    changedAt: row.changed_at.toISOString(),
  }));
}
