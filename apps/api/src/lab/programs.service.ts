import {
  ConflictException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  depthKey,
  formatLineDepth,
  lineSubmitProblems,
  testDisplayName,
  type CoverageUnit,
  type CreateLabProgramRequest,
  type DepthDiscrepancy,
  type DraftLineInput,
  type FieldError,
  type LabLine,
  type LabProgram,
  type LabProgramList,
  type LabProgramReview,
  type LabProgramStatus,
  type LabSource,
  type LabSourceRef,
  type LabSourceUnit,
  type LineReview,
  type LineScope,
  type LineTest,
  type PersonSnapshot,
  type SubmitLabProgramRequest,
  type TestRequest,
  type UpdateLabProgramRequest,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { validationError } from '../validation/parse-body.js';
import { actorOf, receiverOf, resolveActingPerson } from './attribution.js';
import { loadTestTypes } from './catalogue.service.js';
import {
  lineCoverage,
  listSources,
  resolveSource,
  sourceCandidates,
  type Candidate,
} from './coverage.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;

type Db = Pool | PoolClient;

interface ProgramRow {
  id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  program_number: string | null;
  status: LabProgramStatus;
  priority: 'normal' | 'urgent';
  notes: string | null;
  created_by_account_user_id: string;
  created_by_account_type: 'personal' | 'shared_lab' | 'test';
  created_by_name: string;
  created_by_initials: string | null;
  requested_by_user_id: string;
  requested_by_initials_snapshot: string | null;
  requested_by_name_snapshot: string;
  create_idempotency_key: string;
  created_at: Date;
  updated_at: Date;
  version: number;
  submitted_at: Date | null;
  submitted_by_account_user_id: string | null;
  submitted_by_account_type: 'personal' | 'shared_lab' | 'test' | null;
  submitted_by_initials_snapshot: string | null;
  submitted_by_name_snapshot: string | null;
  submitted_for_user_id: string | null;
  submitted_for_initials_snapshot: string | null;
  submitted_for_name_snapshot: string | null;
  submit_idempotency_key: string | null;
}

const SELECT_PROGRAM = `
  SELECT lp.*, p.project_number, p.name AS project_name,
         cu.display_name AS created_by_name, cu.official_initials AS created_by_initials
  FROM lab_program lp
  JOIN project p ON p.id = lp.project_id
  JOIN app_user cu ON cu.id = lp.created_by_account_user_id`;

interface LineRow {
  id: string;
  line_number: number;
  source_kind: LabSourceRef['kind'] | null;
  test_hole_id: string | null;
  source_storage_unit_id: string | null;
  source_bulk_group_id: string | null;
  scope: LineScope;
  sample_label: string | null;
  depth_mode: 'point' | 'interval' | null;
  depth_from: string | null;
  depth_to: string | null;
  depth_unit: 'ft' | 'm' | null;
  acknowledged_depths: string[];
  source_display_snapshot: string | null;
  coverage_captured_at: Date | null;
}

const num = (value: string | null) => (value === null ? null : Number(value));

function sourceOf(row: LineRow): LabSourceRef | null {
  switch (row.source_kind) {
    case 'test_hole':
      return { kind: 'test_hole', id: row.test_hole_id! };
    case 'standalone_unit':
      return { kind: 'standalone_unit', id: row.source_storage_unit_id! };
    case 'standalone_bulk_group':
      return { kind: 'standalone_bulk_group', id: row.source_bulk_group_id! };
    default:
      return null;
  }
}

function lineDepth(row: LineRow): string | null {
  return formatLineDepth({
    depthMode: row.depth_mode,
    depthFrom: num(row.depth_from),
    depthTo: num(row.depth_to),
    depthUnit: row.depth_unit,
  });
}

function conflict(code: string, extra: Record<string, unknown> = {}): never {
  throw new ConflictException({ code, ...extra });
}

function unprocessable(
  code: string,
  errors: FieldError[],
  extra: Record<string, unknown> = {},
): never {
  throw new UnprocessableEntityException({ code, errors, ...extra });
}

/**
 * Testing programs (MM-T23): drafts, the pre-submission review and submission.
 *
 * Drafts belong to the account that created them; the shared LAB account's drafts are worked on
 * from any LAB station, but each draft is its own row with its own version, so two stations never
 * share or overwrite "the" draft. Every LAB create/edit/submit names a valid Requested by person
 * (attribution only, checked on every request). Edits and submission are optimistic (`version`);
 * submission is idempotent on its key and freezes coverage and catalogue snapshots in one
 * transaction.
 */
@Injectable()
export class LabProgramsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(
    user: AuthUser,
    query: { status?: string; projectId?: string; page?: number },
  ): Promise<LabProgramList> {
    const params: unknown[] = [user.userId];
    // Submitted and closed programs are shared; drafts only for the account that owns them.
    const where = [`(lp.status <> 'draft' OR lp.created_by_account_user_id = $1)`];
    if (query.status && ['draft', 'submitted', 'closed'].includes(query.status)) {
      params.push(query.status);
      where.push(`lp.status = $${params.length}`);
    }
    if (query.projectId && UUID_PATTERN.test(query.projectId)) {
      params.push(query.projectId);
      where.push(`lp.project_id = $${params.length}`);
    }
    const page = Math.max(1, query.page ?? 1);
    const { rows } = await this.database.pool.query<
      ProgramRow & { line_count: number; test_count: number; total: number }
    >(
      `${SELECT_PROGRAM.replace(
        'SELECT lp.*',
        `SELECT lp.*, count(*) OVER ()::int AS total,
                (SELECT count(*)::int FROM test_line l WHERE l.program_id = lp.id) AS line_count,
                (SELECT count(*)::int FROM test_line l
                 JOIN test_line_test t ON t.line_id = l.id WHERE l.program_id = lp.id
                 AND lp.status = 'draft')
                + (SELECT count(*)::int FROM test_request r WHERE r.program_id = lp.id)
                  AS test_count`,
      )}
       WHERE ${where.join(' AND ')}
       ORDER BY (lp.status = 'draft') DESC, coalesce(lp.submitted_at, lp.updated_at) DESC, lp.id
       LIMIT ${PAGE_SIZE} OFFSET ${(page - 1) * PAGE_SIZE}`,
      params,
    );
    return {
      total: rows[0]?.total ?? 0,
      items: rows.map((row) => ({
        id: row.id,
        programNumber: row.program_number,
        status: row.status,
        priority: row.priority,
        project: { id: row.project_id, projectNumber: row.project_number, name: row.project_name },
        createdBy: createdByOf(row),
        requestedBy: requestedByOf(row),
        createdAt: row.created_at.toISOString(),
        updatedAt: row.updated_at.toISOString(),
        submittedAt: row.submitted_at?.toISOString() ?? null,
        lineCount: row.line_count,
        testCount: row.test_count,
      })),
    };
  }

  async get(id: string, user: AuthUser): Promise<LabProgram> {
    const row = await this.findVisible(this.database.pool, id, user);
    return loadProgram(this.database.pool, row);
  }

  async sources(projectId: string): Promise<LabSource[]> {
    if (!UUID_PATTERN.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const { rows } = await this.database.pool.query('SELECT 1 FROM project WHERE id = $1', [
      projectId,
    ]);
    if (rows.length === 0) throw new NotFoundException({ code: 'project_not_found' });
    return listSources(this.database.pool, projectId);
  }

  async sourceUnits(projectId: string, source: LabSourceRef): Promise<LabSourceUnit[]> {
    if (!UUID_PATTERN.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    await resolveSource(this.database.pool, projectId, source);
    const candidates = await sourceCandidates(this.database.pool, projectId, source);
    return candidates.map((c) => ({
      storageUnitId: c.storageUnitId,
      readableId: c.readableId,
      unitType: c.unitType,
      contents: c.contents,
      receivedDate: c.receivedDate,
    }));
  }

  async review(id: string, user: AuthUser): Promise<LabProgramReview> {
    const row = await this.findVisible(this.database.pool, id, user);
    if (row.status !== 'draft') conflict('not_draft');
    return buildReview(this.database.pool, row);
  }

  // -------------------------------------------------------------------------------------------
  // Drafts
  // -------------------------------------------------------------------------------------------

  async create(
    request: CreateLabProgramRequest,
    user: AuthUser,
  ): Promise<{ program: LabProgram; created: boolean }> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const existing = await this.byCreateKey(client, request.idempotencyKey);
        if (existing)
          return {
            program: await this.replayCreate(client, existing, request, user),
            created: false,
          };

        const person = await resolveActingPerson(client, user, request.requestedByUserId, {
          field: 'requestedByUserId',
          invalidCode: 'requested_by_invalid',
        });
        const { rows: projects } = await client.query('SELECT 1 FROM project WHERE id = $1', [
          request.projectId,
        ]);
        if (projects.length === 0) {
          throw validationError([
            { field: 'projectId', code: 'not_found', message: 'project not found' },
          ]);
        }
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO lab_program (project_id, notes, created_by_account_user_id,
                                    created_by_account_type, requested_by_user_id,
                                    requested_by_initials_snapshot, requested_by_name_snapshot,
                                    create_idempotency_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            request.projectId,
            request.notes,
            user.userId,
            user.accountType,
            person.userId,
            person.initials,
            person.name,
            request.idempotencyKey,
          ],
        );
        const id = rows[0]!.id;
        const program = (await this.lock(client, id))!;
        await saveLines(client, program, request.lines);
        await recordAudit(client, {
          action: 'lab_program.created',
          entityType: 'lab_program',
          entityId: id,
          actor: actorOf(user),
          receiver: receiverOf(person),
          after: { projectId: request.projectId, lineCount: request.lines.length },
        });
        return {
          program: await loadProgram(client, (await this.lock(client, id))!),
          created: true,
        };
      });
    } catch (error) {
      // Two identical creates raced: the loser returns the winner's draft.
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'lab_program_create_idempotency_key_key'
      ) {
        const existing = await this.byCreateKey(this.database.pool, request.idempotencyKey);
        if (existing) {
          return {
            program: await this.replayCreate(this.database.pool, existing, request, user),
            created: false,
          };
        }
      }
      throw error;
    }
  }

  /** A retried create returns the original draft; the same key for something else is refused. */
  private async replayCreate(
    db: Db,
    existing: ProgramRow,
    request: CreateLabProgramRequest,
    user: AuthUser,
  ): Promise<LabProgram> {
    if (
      existing.created_by_account_user_id !== user.userId ||
      existing.project_id !== request.projectId
    ) {
      conflict('idempotency_key_reused');
    }
    return loadProgram(db, existing);
  }

  async update(id: string, request: UpdateLabProgramRequest, user: AuthUser): Promise<LabProgram> {
    return withTransaction(this.database.pool, async (client) => {
      const program = await this.lockVisible(client, id, user);
      if (program.status !== 'draft')
        conflict('not_draft', { current: await loadProgram(client, program) });
      if (program.version !== request.version) {
        conflict('version_conflict', { current: await loadProgram(client, program) });
      }
      const person = await resolveActingPerson(client, user, request.requestedByUserId, {
        field: 'requestedByUserId',
        invalidCode: 'requested_by_invalid',
      });
      if (request.lines) await saveLines(client, program, request.lines);
      await client.query(
        `UPDATE lab_program
         SET notes = $2, requested_by_user_id = $3, requested_by_initials_snapshot = $4,
             requested_by_name_snapshot = $5, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [
          id,
          request.notes !== undefined ? request.notes : program.notes,
          person.userId,
          person.initials,
          person.name,
        ],
      );
      await recordAudit(client, {
        action: 'lab_program.draft_saved',
        entityType: 'lab_program',
        entityId: id,
        actor: actorOf(user),
        receiver: receiverOf(person),
        ...(person.userId !== program.requested_by_user_id
          ? {
              before: { requestedBy: program.requested_by_name_snapshot },
              after: { requestedBy: person.name },
            }
          : {}),
      });
      return loadProgram(client, (await this.lock(client, id))!);
    });
  }

  /** Throws away a draft (never a submitted program). */
  async discard(id: string, version: number, personUserId: string | undefined, user: AuthUser) {
    await withTransaction(this.database.pool, async (client) => {
      const program = await this.lockVisible(client, id, user);
      if (program.status !== 'draft') conflict('not_draft');
      if (program.version !== version) {
        conflict('version_conflict', { current: await loadProgram(client, program) });
      }
      const person = await resolveActingPerson(client, user, personUserId, {
        field: 'requestedByUserId',
        invalidCode: 'requested_by_invalid',
      });
      await client.query('DELETE FROM test_line WHERE program_id = $1', [id]);
      await client.query('DELETE FROM lab_program WHERE id = $1', [id]);
      await recordAudit(client, {
        action: 'lab_program.discarded',
        entityType: 'lab_program',
        entityId: id,
        actor: actorOf(user),
        receiver: receiverOf(person),
        before: { projectId: program.project_id },
      });
    });
  }

  // -------------------------------------------------------------------------------------------
  // Submission
  // -------------------------------------------------------------------------------------------

  async submit(
    id: string,
    request: SubmitLabProgramRequest,
    user: AuthUser,
  ): Promise<{ program: LabProgram; replayed: boolean }> {
    try {
      return await withTransaction(this.database.pool, (client) =>
        this.submitIn(client, id, request, user),
      );
    } catch (error) {
      if (
        error instanceof DatabaseError &&
        error.code === '23505' &&
        error.constraint === 'lab_program_submit_idempotency_key_key'
      ) {
        conflict('idempotency_key_reused');
      }
      throw error;
    }
  }

  private async submitIn(
    client: PoolClient,
    id: string,
    request: SubmitLabProgramRequest,
    user: AuthUser,
  ): Promise<{ program: LabProgram; replayed: boolean }> {
    // FOR UPDATE serialises concurrent submissions (and edits) of this draft.
    const program = await this.lockVisible(client, id, user);
    if (program.status !== 'draft') {
      // An exact retry after a lost response gets the original result, never a second program.
      if (
        program.submit_idempotency_key === request.idempotencyKey &&
        program.submitted_by_account_user_id === user.userId
      ) {
        return { program: await loadProgram(client, program), replayed: true };
      }
      conflict('not_draft', { current: await loadProgram(client, program) });
    }
    if (program.version !== request.version) {
      conflict('version_conflict', { current: await loadProgram(client, program) });
    }
    const person = await resolveActingPerson(client, user, request.requestedByUserId, {
      field: 'requestedByUserId',
      invalidCode: 'requested_by_invalid',
    });
    if (user.accountType === 'shared_lab' && person.userId !== program.requested_by_user_id) {
      // The station must be submitting for the person the draft names (another station may have
      // changed it); a version bump would normally catch this first.
      unprocessable('requested_by_mismatch', [
        {
          field: 'requestedByUserId',
          code: 'requested_by_mismatch',
          message: 'is not who this draft is requested by; refresh and check',
        },
      ]);
    }

    const review = await buildReview(client, program, { lock: true });
    if (!review.ready) unprocessable('not_ready', [], { review });
    const seen = new Map(request.coverage.map((entry) => [entry.lineId, new Set(entry.unitIds)]));
    const lines = await loadLineRows(client, id);
    for (const line of lines) {
      if (line.scope === 'specific') continue;
      const current = review.lines
        .find((l) => l.lineId === line.id)!
        .coverage.map((c) => c.storageUnitId);
      const reviewed = seen.get(line.id);
      if (!reviewed || reviewed.size !== current.length || current.some((u) => !reviewed.has(u))) {
        conflict('coverage_changed', { review });
      }
    }

    const { rows: numbers } = await client.query<{ year: number; last_value: number }>(
      `INSERT INTO lab_program_counter (year, last_value)
       VALUES (extract(year FROM now() AT TIME ZONE $1)::int, 1)
       ON CONFLICT (year) DO UPDATE SET last_value = lab_program_counter.last_value + 1
       RETURNING year, last_value`,
      [this.config.BUSINESS_TIME_ZONE],
    );
    const programNumber = `LP-${numbers[0]!.year}-${String(numbers[0]!.last_value).padStart(4, '0')}`;

    // Freeze coverage and catalogue snapshots while the program is still a draft (the database
    // only accepts them then), then mark it submitted.
    const testIds = new Set<string>();
    const lineTests = new Map<string, string[]>();
    const { rows: picked } = await client.query<{ line_id: string; test_type_id: string }>(
      `SELECT t.line_id, t.test_type_id FROM test_line_test t
       JOIN test_line l ON l.id = t.line_id
       WHERE l.program_id = $1 ORDER BY t.sort_order, t.test_type_id`,
      [id],
    );
    for (const row of picked) {
      testIds.add(row.test_type_id);
      lineTests.set(row.line_id, [...(lineTests.get(row.line_id) ?? []), row.test_type_id]);
    }
    // FOR SHARE: a concurrent retirement waits, so no request is made for a test retired mid-way.
    await client.query('SELECT 1 FROM test_type WHERE id = ANY ($1::uuid[]) FOR SHARE', [
      [...testIds],
    ]);
    const catalogue = new Map(
      (await loadTestTypes(client, [...testIds])).map((test) => [test.id, test]),
    );
    const retired = [...catalogue.values()].filter((test) => !test.active);
    if (retired.length > 0) {
      unprocessable('retired_tests', [], {
        review: await buildReview(client, program),
        retired: retired.map((test) => test.code),
      });
    }

    const requestIds: { id: string; code: string; lineNumber: number }[] = [];
    for (const line of lines) {
      const lineReview = review.lines.find((l) => l.lineId === line.id)!;
      const source = sourceOf(line)!;
      const display = await resolveSource(client, program.project_id, source);
      await client.query(
        `UPDATE test_line SET source_display_snapshot = $2, coverage_captured_at = now(),
                              updated_at = now()
         WHERE id = $1`,
        [line.id, display],
      );
      for (const unit of lineReview.coverage) {
        await client.query(
          `INSERT INTO program_scope_snapshot
             (program_id, line_id, storage_unit_id, receipt_id, project_id, included,
              matching_basis, unit_readable_id_snapshot, unit_type_snapshot, contents_snapshot,
              received_date_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            id,
            line.id,
            unit.storageUnitId,
            unit.receiptId,
            program.project_id,
            unit.included,
            unit.matchingBasis,
            unit.readableId,
            unit.unitType,
            unit.contents,
            unit.receivedDate,
          ],
        );
      }
      for (const [index, testTypeId] of (lineTests.get(line.id) ?? []).entries()) {
        const test = catalogue.get(testTypeId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO test_request (program_id, line_id, test_type_id, test_code_snapshot,
                                     test_name_snapshot, test_description_snapshot,
                                     test_group_snapshot, test_subgroup_snapshot, sort_order)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
          [
            id,
            line.id,
            test.id,
            test.code,
            test.name,
            test.description,
            test.groupName,
            test.subgroupName,
            index,
          ],
        );
        requestIds.push({ id: rows[0]!.id, code: test.code, lineNumber: line.line_number });
      }
    }

    await client.query(
      `UPDATE lab_program
       SET status = 'submitted', program_number = $2, submitted_at = now(),
           submitted_by_account_user_id = $3, submitted_by_account_type = $4,
           submitted_by_initials_snapshot = $5, submitted_by_name_snapshot = $6,
           submitted_for_user_id = $7, submitted_for_initials_snapshot = $8,
           submitted_for_name_snapshot = $9, submit_idempotency_key = $10,
           version = version + 1, updated_at = now()
       WHERE id = $1`,
      [
        id,
        programNumber,
        user.userId,
        user.accountType,
        user.initials,
        user.displayName,
        person.userId,
        person.initials,
        person.name,
        request.idempotencyKey,
      ],
    );

    const actor = actorOf(user);
    const receiver = receiverOf(person);
    await recordAudit(client, {
      action: 'lab_program.submitted',
      entityType: 'lab_program',
      entityId: id,
      actor,
      receiver,
      after: {
        programNumber,
        lines: review.lines.map((line) => ({
          lineNumber: line.lineNumber,
          covered: line.coverage.filter((c) => c.included).map((c) => c.readableId),
          excluded: line.coverage.filter((c) => !c.included).map((c) => c.readableId),
        })),
      },
    });
    for (const created of requestIds) {
      await recordAudit(client, {
        action: 'test_request.created',
        entityType: 'test_request',
        entityId: created.id,
        actor,
        receiver,
        after: { programNumber, lineNumber: created.lineNumber, code: created.code },
      });
    }
    return { program: await loadProgram(client, (await this.lock(client, id))!), replayed: false };
  }

  // -------------------------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------------------------

  private async byCreateKey(db: Db, key: string): Promise<ProgramRow | null> {
    const { rows } = await db.query<ProgramRow>(
      `${SELECT_PROGRAM} WHERE lp.create_idempotency_key = $1`,
      [key],
    );
    return rows[0] ?? null;
  }

  private async lock(client: PoolClient, id: string): Promise<ProgramRow | null> {
    const { rows } = await client.query<ProgramRow>(
      `${SELECT_PROGRAM} WHERE lp.id = $1 FOR UPDATE OF lp`,
      [id],
    );
    return rows[0] ?? null;
  }

  private async lockVisible(client: PoolClient, id: string, user: AuthUser): Promise<ProgramRow> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'lab_program_not_found' });
    const row = await this.lock(client, id);
    if (!row || !visible(row, user)) {
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    return row;
  }

  private async findVisible(db: Db, id: string, user: AuthUser): Promise<ProgramRow> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'lab_program_not_found' });
    const { rows } = await db.query<ProgramRow>(`${SELECT_PROGRAM} WHERE lp.id = $1`, [id]);
    const row = rows[0];
    if (!row || !visible(row, user)) {
      throw new NotFoundException({ code: 'lab_program_not_found' });
    }
    return row;
  }
}

/** A draft is seen only by its account (any LAB station for LAB's drafts); others by everyone. */
function visible(row: ProgramRow, user: AuthUser): boolean {
  return row.status !== 'draft' || row.created_by_account_user_id === user.userId;
}

function createdByOf(row: ProgramRow) {
  return {
    userId: row.created_by_account_user_id,
    accountType: row.created_by_account_type,
    initials: row.created_by_initials,
    name: row.created_by_name,
  };
}

function requestedByOf(row: ProgramRow): PersonSnapshot {
  return {
    userId: row.requested_by_user_id,
    initials: row.requested_by_initials_snapshot,
    name: row.requested_by_name_snapshot,
  };
}

async function loadLineRows(db: Db, programId: string): Promise<LineRow[]> {
  const { rows } = await db.query<LineRow>(
    `SELECT id, line_number, source_kind, test_hole_id, source_storage_unit_id,
            source_bulk_group_id, scope, sample_label, depth_mode, depth_from, depth_to,
            depth_unit, acknowledged_depths, source_display_snapshot, coverage_captured_at
     FROM test_line WHERE program_id = $1 ORDER BY line_number`,
    [programId],
  );
  return rows;
}

/**
 * Replaces a draft's lines with `lines` (in order): existing lines named by `id` are updated in
 * place, others are added, and lines left out are removed. Sources, tests and chosen units are
 * validated against the program's project.
 */
async function saveLines(client: PoolClient, program: ProgramRow, lines: DraftLineInput[]) {
  const existing = await loadLineRows(client, program.id);
  const existingIds = new Set(existing.map((line) => line.id));
  const errors: FieldError[] = [];
  lines.forEach((line, i) => {
    if (line.id !== undefined && !existingIds.has(line.id)) {
      errors.push({
        field: `lines.${i}.id`,
        code: 'not_found',
        message: 'is not a line of this draft',
      });
    }
    if (line.source === null && line.unitIds.length > 0) {
      errors.push({ field: `lines.${i}.unitIds`, code: 'not_allowed', message: 'needs a source' });
    }
  });
  if (errors.length > 0) throw validationError(errors);

  const allTests = [...new Set(lines.flatMap((line) => line.testTypeIds))];
  const tests = new Map((await loadTestTypes(client, allTests)).map((test) => [test.id, test]));
  const alreadyPicked = new Set(
    (
      await client.query<{ key: string }>(
        `SELECT t.line_id || ':' || t.test_type_id AS key FROM test_line_test t
         JOIN test_line l ON l.id = t.line_id WHERE l.program_id = $1`,
        [program.id],
      )
    ).rows.map((row) => row.key),
  );
  for (const [i, line] of lines.entries()) {
    if (line.source)
      await resolveSource(client, program.project_id, line.source, `lines.${i}.source`);
    for (const testTypeId of line.testTypeIds) {
      const test = tests.get(testTypeId);
      if (!test) {
        unprocessable('test_type_not_found', [
          {
            field: `lines.${i}.testTypeIds`,
            code: 'test_type_not_found',
            message: 'test not found',
          },
        ]);
      }
      // A test retired after it was picked may stay (submission reports it); new picks can't be.
      if (!test.active && !alreadyPicked.has(`${line.id}:${testTypeId}`)) {
        unprocessable('retired_tests', [
          {
            field: `lines.${i}.testTypeIds`,
            code: 'retired_tests',
            message: `${test.code} is retired and can’t be added`,
          },
        ]);
      }
    }
    if (line.source && line.unitIds.length > 0) {
      const candidates = new Set(
        (await sourceCandidates(client, program.project_id, line.source)).map(
          (c) => c.storageUnitId,
        ),
      );
      if (line.unitIds.some((unitId) => !candidates.has(unitId))) {
        unprocessable('unit_not_in_source', [
          {
            field: `lines.${i}.unitIds`,
            code: 'unit_not_in_source',
            message: 'lists a unit that is not available from this source',
          },
        ]);
      }
    }
  }

  const keep = new Set(lines.map((line) => line.id).filter(Boolean));
  await client.query(
    'DELETE FROM test_line WHERE program_id = $1 AND NOT (id = ANY ($2::uuid[]))',
    [program.id, [...keep]],
  );
  for (const [i, line] of lines.entries()) {
    const values = [
      line.source?.kind ?? null,
      line.source?.kind === 'test_hole' ? line.source.id : null,
      line.source?.kind === 'standalone_unit' ? line.source.id : null,
      line.source?.kind === 'standalone_bulk_group' ? line.source.id : null,
      line.scope,
      line.sampleLabel,
      line.depthMode,
      line.depthFrom,
      line.depthTo,
      line.depthUnit,
      line.acknowledgedDepths.map(depthKey),
    ];
    let lineId: string;
    if (line.id) {
      lineId = line.id;
      await client.query(
        `UPDATE test_line
         SET line_number = $2, source_kind = $3, test_hole_id = $4, source_storage_unit_id = $5,
             source_bulk_group_id = $6, scope = $7, sample_label = $8, depth_mode = $9,
             depth_from = $10, depth_to = $11, depth_unit = $12, acknowledged_depths = $13,
             updated_at = now()
         WHERE id = $1`,
        [lineId, i + 1, ...values],
      );
    } else {
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO test_line (program_id, project_id, line_number, source_kind, test_hole_id,
                                source_storage_unit_id, source_bulk_group_id, scope, sample_label,
                                depth_mode, depth_from, depth_to, depth_unit, acknowledged_depths)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) RETURNING id`,
        [program.id, program.project_id, i + 1, ...values],
      );
      lineId = rows[0]!.id;
    }
    await client.query('DELETE FROM test_line_test WHERE line_id = $1', [lineId]);
    if (line.testTypeIds.length > 0) {
      await client.query(
        `INSERT INTO test_line_test (line_id, test_type_id, sort_order)
         SELECT $1, id, ord::int FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)`,
        [lineId, line.testTypeIds],
      );
    }
    await client.query('DELETE FROM test_line_unit_choice WHERE line_id = $1', [lineId]);
    if (line.unitIds.length > 0) {
      await client.query(
        `INSERT INTO test_line_unit_choice (line_id, project_id, storage_unit_id)
         SELECT $1, $2, unnest($3::uuid[])`,
        [lineId, program.project_id, line.unitIds],
      );
    }
  }
}

/** Depth discrepancies of a Specific line against every submitted request and its own draft. */
async function discrepancyFor(
  db: Db,
  program: ProgramRow,
  line: LineRow,
): Promise<DepthDiscrepancy | null> {
  const source = sourceOf(line);
  const depth = lineDepth(line);
  if (line.scope !== 'specific' || !source || !line.sample_label || !depth) return null;
  const { rows } = await db.query<LineRow & { program_id: string; program_number: string | null }>(
    `SELECT l.*, p.program_number
     FROM test_line l JOIN lab_program p ON p.id = l.program_id
     WHERE l.project_id = $1 AND l.scope = 'specific' AND l.id <> $2
       AND upper(l.sample_label) = upper($3) AND l.source_kind = $4
       AND coalesce(l.test_hole_id, l.source_storage_unit_id, l.source_bulk_group_id) = $5
       AND (p.status <> 'draft' OR p.id = $6)
     ORDER BY p.submitted_at NULLS LAST, l.line_number`,
    [program.project_id, line.id, line.sample_label, source.kind, source.id, program.id],
  );
  const others = rows
    .map((row) => ({ row, depth: lineDepth(row) }))
    .filter((other) => other.depth !== null && depthKey(other.depth) !== depthKey(depth));
  if (others.length === 0) return null;
  const acknowledged = new Set(line.acknowledged_depths.map(depthKey));
  return {
    depths: [...new Set([depth, ...others.map((other) => other.depth!)])],
    others: others.map((other) => ({
      programId: other.row.program_id,
      programNumber: other.row.program_number,
      lineNumber: other.row.line_number,
      depth: other.depth!,
    })),
    acknowledged: others.every((other) => acknowledged.has(depthKey(other.depth!))),
  };
}

async function loadLineTests(db: Db, programId: string): Promise<Map<string, LineTest[]>> {
  const { rows } = await db.query<{
    line_id: string;
    test_type_id: string;
    code: string;
    name: string | null;
    description: string;
    group_name: string;
    subgroup_name: string | null;
    active: boolean;
  }>(
    `SELECT lt.line_id, t.id AS test_type_id, t.code, t.name, t.description,
            g.name AS group_name, s.name AS subgroup_name, t.active
     FROM test_line_test lt
     JOIN test_line l ON l.id = lt.line_id
     JOIN test_type t ON t.id = lt.test_type_id
     JOIN test_group g ON g.id = t.group_id
     LEFT JOIN test_subgroup s ON s.id = t.subgroup_id
     WHERE l.program_id = $1
     ORDER BY lt.sort_order, t.code`,
    [programId],
  );
  const byLine = new Map<string, LineTest[]>();
  for (const row of rows) {
    const test: LineTest = {
      testTypeId: row.test_type_id,
      code: row.code,
      displayName: testDisplayName(row),
      description: row.description,
      groupName: row.group_name,
      subgroupName: row.subgroup_name,
      active: row.active,
    };
    byLine.set(row.line_id, [...(byLine.get(row.line_id) ?? []), test]);
  }
  return byLine;
}

async function loadChoices(db: Db, programId: string): Promise<Map<string, string[]>> {
  const { rows } = await db.query<{ line_id: string; storage_unit_id: string }>(
    `SELECT c.line_id, c.storage_unit_id FROM test_line_unit_choice c
     JOIN test_line l ON l.id = c.line_id WHERE l.program_id = $1
     ORDER BY c.storage_unit_id`,
    [programId],
  );
  const byLine = new Map<string, string[]>();
  for (const row of rows) {
    byLine.set(row.line_id, [...(byLine.get(row.line_id) ?? []), row.storage_unit_id]);
  }
  return byLine;
}

/** What submitting `program` now would record, line by line, and whether anything blocks it. */
export async function buildReview(
  db: Db,
  program: ProgramRow,
  options: { lock?: boolean } = {},
): Promise<LabProgramReview> {
  const lines = await loadLineRows(db, program.id);
  const tests = await loadLineTests(db, program.id);
  const choices = await loadChoices(db, program.id);
  const reviews: LineReview[] = [];
  if (lines.length === 0) {
    return { programId: program.id, version: program.version, lines: [], ready: false };
  }
  for (const line of lines) {
    const source = sourceOf(line);
    const lineTests = tests.get(line.id) ?? [];
    const problems: FieldError[] = lineSubmitProblems({
      source,
      scope: line.scope,
      sampleLabel: line.sample_label,
      depthMode: line.depth_mode,
      depthFrom: num(line.depth_from),
      depthTo: num(line.depth_to),
      depthUnit: line.depth_unit,
      testCount: lineTests.length,
    });
    let candidates: Candidate[] = [];
    if (source) {
      try {
        await resolveSource(db, program.project_id, source);
        candidates = await sourceCandidates(db, program.project_id, source, options);
      } catch (error) {
        if (!(error instanceof UnprocessableEntityException)) throw error;
        problems.push({
          field: 'source',
          code: 'source_not_in_project',
          message: 'This sampling source is no longer part of the project.',
        });
      }
    }
    const coverage = lineCoverage(line.scope, candidates, choices.get(line.id) ?? []);
    if (coverage.strayChoices.length > 0) {
      problems.push({
        field: 'unitIds',
        code: 'unit_not_in_source',
        message: 'A chosen unit is no longer available from this source; review the units again.',
      });
    }
    const retiredTests = lineTests.filter((test) => !test.active);
    if (retiredTests.length > 0) {
      problems.push({
        field: 'testTypeIds',
        code: 'retired_tests',
        message: `Remove or replace retired tests: ${retiredTests.map((t) => t.code).join(', ')}.`,
      });
    }
    const discrepancy = await discrepancyFor(db, program, line);
    if (discrepancy && !discrepancy.acknowledged) {
      problems.push({
        field: 'acknowledgedDepths',
        code: 'depth_discrepancy',
        message: `This sample is also requested at ${discrepancy.others
          .map((other) => other.depth)
          .join(', ')}. Acknowledge the different depth to continue.`,
      });
    }
    reviews.push({
      lineId: line.id,
      lineNumber: line.line_number,
      coverage: coverage.coverage,
      unknownClassificationCount: coverage.unknownClassificationCount,
      discrepancy,
      retiredTests,
      problems,
    });
  }
  return {
    programId: program.id,
    version: program.version,
    lines: reviews,
    ready: reviews.every((line) => line.problems.length === 0),
  };
}

/** The program as the API returns it: drafts with current catalogue values, submitted frozen. */
export async function loadProgram(db: Db, row: ProgramRow): Promise<LabProgram> {
  const lineRows = await loadLineRows(db, row.id);
  const tests = row.status === 'draft' ? await loadLineTests(db, row.id) : new Map();
  const choices = row.status === 'draft' ? await loadChoices(db, row.id) : new Map();
  const requests = new Map<string, TestRequest[]>();
  const coverage = new Map<string, CoverageUnit[]>();
  if (row.status !== 'draft') {
    const { rows: requestRows } = await db.query<{
      id: string;
      line_id: string;
      test_type_id: string;
      test_code_snapshot: string;
      test_name_snapshot: string | null;
      test_description_snapshot: string;
      test_group_snapshot: string;
      test_subgroup_snapshot: string | null;
      status: TestRequest['status'];
      version: number;
    }>(
      `SELECT id, line_id, test_type_id, test_code_snapshot, test_name_snapshot,
              test_description_snapshot, test_group_snapshot, test_subgroup_snapshot, status,
              version
       FROM test_request WHERE program_id = $1 ORDER BY sort_order, test_code_snapshot`,
      [row.id],
    );
    for (const r of requestRows) {
      requests.set(r.line_id, [
        ...(requests.get(r.line_id) ?? []),
        {
          id: r.id,
          testTypeId: r.test_type_id,
          code: r.test_code_snapshot,
          name: r.test_name_snapshot,
          description: r.test_description_snapshot,
          groupName: r.test_group_snapshot,
          subgroupName: r.test_subgroup_snapshot,
          status: r.status,
          version: r.version,
        },
      ]);
    }
    const { rows: snapshotRows } = await db.query<{
      line_id: string;
      storage_unit_id: string;
      receipt_id: string;
      included: boolean;
      matching_basis: CoverageUnit['matchingBasis'];
      unit_readable_id_snapshot: string;
      unit_type_snapshot: string;
      contents_snapshot: string | null;
      received_date_snapshot: string;
    }>(
      `SELECT line_id, storage_unit_id, receipt_id, included, matching_basis,
              unit_readable_id_snapshot, unit_type_snapshot, contents_snapshot,
              to_char(received_date_snapshot, 'YYYY-MM-DD') AS received_date_snapshot
       FROM program_scope_snapshot WHERE program_id = $1
       ORDER BY included DESC, received_date_snapshot, unit_readable_id_snapshot COLLATE "C"`,
      [row.id],
    );
    for (const s of snapshotRows) {
      coverage.set(s.line_id, [
        ...(coverage.get(s.line_id) ?? []),
        {
          storageUnitId: s.storage_unit_id,
          readableId: s.unit_readable_id_snapshot,
          unitType: s.unit_type_snapshot,
          contents: s.contents_snapshot,
          receivedDate: s.received_date_snapshot,
          receiptId: s.receipt_id,
          included: s.included,
          matchingBasis: s.matching_basis,
        },
      ]);
    }
  }

  const lines: LabLine[] = [];
  for (const line of lineRows) {
    const source = sourceOf(line);
    let label: string | null = line.source_display_snapshot;
    if (source && label === null) {
      label = await resolveSource(db, row.project_id, source).catch(
        () => 'Source no longer in project',
      );
    }
    lines.push({
      id: line.id,
      lineNumber: line.line_number,
      source: source ? { ...source, label: label! } : null,
      scope: line.scope,
      sampleLabel: line.sample_label,
      depthMode: line.depth_mode,
      depthFrom: num(line.depth_from),
      depthTo: num(line.depth_to),
      depthUnit: line.depth_unit,
      acknowledgedDepths: line.acknowledged_depths,
      tests: (tests.get(line.id) as LineTest[] | undefined) ?? [],
      unitIds: (choices.get(line.id) as string[] | undefined) ?? [],
      requests: requests.get(line.id) ?? [],
      coverage: coverage.get(line.id) ?? [],
      coverageCapturedAt: line.coverage_captured_at?.toISOString() ?? null,
    });
  }

  const submittedBy =
    row.submitted_by_account_user_id === null
      ? null
      : {
          userId: row.submitted_by_account_user_id,
          accountType: row.submitted_by_account_type!,
          initials: row.submitted_by_initials_snapshot,
          name: row.submitted_by_name_snapshot!,
        };
  return {
    id: row.id,
    programNumber: row.program_number,
    status: row.status,
    priority: row.priority,
    notes: row.notes,
    project: { id: row.project_id, projectNumber: row.project_number, name: row.project_name },
    createdBy: createdByOf(row),
    requestedBy: requestedByOf(row),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    submittedBy,
    submittedFor:
      row.submitted_for_user_id === null
        ? null
        : {
            userId: row.submitted_for_user_id,
            initials: row.submitted_for_initials_snapshot,
            name: row.submitted_for_name_snapshot!,
          },
    lines,
  };
}
