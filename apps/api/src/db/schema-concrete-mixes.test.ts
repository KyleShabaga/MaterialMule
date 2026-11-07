import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { CONCRETE_MIX_SPEC_DEFAULTS } from '@materialmule/shared';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C03 (migration 0017): project concrete mixes and their revisions, proven in the database.
// Fictional data only (DEMO- projects, invented suppliers and people).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

const COMPLETE = {
  specified_strength_mpa: 32,
  slump_target_mm: 80,
  slump_tolerance_mm: 30,
  air_min_percent: 5,
  air_max_percent: 8,
  max_aggregate_size_mm: 20,
  cement_type: 'GU',
};

describe.runIf(testDatabaseUrl)('concrete mixes (MM-V2-C03, migration 0017)', () => {
  let db: TestSchema;
  let lead: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await insertUser(db.pool, 'PE');
    projectA = await insertProject(db.pool, 'DEMO-2601', lead);
    projectB = await insertProject(db.pool, 'DEMO-2602', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function addRevision(
    client: PoolClient | Pool,
    mixId: string,
    project: string,
    number: number,
    values: Record<string, unknown> = {},
    id = randomUUID(),
  ) {
    const row = { supplier_name: 'Example Ready-Mix', mix_number: '0042', ...values };
    const columns = [
      'id',
      'mix_id',
      'project_id',
      'revision_number',
      'created_by_user_id',
      'created_by_name_snapshot',
      ...Object.keys(row),
    ];
    const params = [id, mixId, project, number, lead, 'Test PE', ...Object.values(row)];
    await client.query(
      `INSERT INTO concrete_mix_revision (${columns.join(', ')})
       VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
      params,
    );
    return id;
  }

  /** A mix with one draft revision (Unapproved), committed. */
  async function newMix(
    options: { project?: string; supplier?: string; number?: string; values?: object } = {},
  ) {
    const project = options.project ?? projectA;
    const supplier = options.supplier ?? `Supplier ${randomUUID().slice(0, 8)}`;
    const number = options.number ?? '0042';
    const mixId = randomUUID();
    const revisionId = randomUUID();
    await tx(async (client) => {
      await client.query(
        `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                   created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, $3, $4, $5, $6, 'Test PE')`,
        [mixId, project, supplier, number, revisionId, lead],
      );
      await addRevision(
        client,
        mixId,
        project,
        1,
        { supplier_name: supplier, mix_number: number, ...options.values },
        revisionId,
      );
    });
    return { mixId, revisionId, supplier, number, project };
  }

  /** Approves the mix's draft (superseding any approved revision), committed. */
  async function approve(mixId: string, revisionId: string, previous: string | null = null) {
    await tx(async (client) => {
      if (previous) {
        await client.query(
          `UPDATE concrete_mix_revision SET state = 'superseded', superseded_at = now()
           WHERE id = $1`,
          [previous],
        );
      }
      await client.query(
        `UPDATE concrete_mix_revision SET state = 'approved', approved_at = now(),
                approved_by_user_id = $2, approved_by_name_snapshot = 'Test PE'
         WHERE id = $1`,
        [revisionId, lead],
      );
      await client.query(
        `UPDATE concrete_mix SET effective_revision_id = $2, draft_revision_id = NULL,
                version = version + 1
         WHERE id = $1`,
        [mixId, revisionId],
      );
    });
  }

  async function approvedMix() {
    const mix = await newMix({ values: COMPLETE });
    await approve(mix.mixId, mix.revisionId);
    return mix;
  }

  it('defaults: test ages 7/28/28/HOLD (as the shared contract), no admixture answer, empty ticket defaults', async () => {
    const { revisionId } = await newMix();
    const { rows } = await db.pool.query(
      `SELECT state, test_ages, spec_admixtures, ticket_defaults, plant_names,
              specified_strength_age_days
       FROM concrete_mix_revision WHERE id = $1`,
      [revisionId],
    );
    expect(rows[0]).toEqual({
      state: 'draft',
      test_ages: CONCRETE_MIX_SPEC_DEFAULTS.testAges.map(String),
      spec_admixtures: { declaration: null, items: [] },
      ticket_defaults: {},
      plant_names: [],
      specified_strength_age_days: null,
    });
  });

  it('a draft may leave the specification empty; approval needs it complete except the strength age', async () => {
    const empty = await newMix();
    await expect(approve(empty.mixId, empty.revisionId)).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_mix_revision_approval_check',
    });
    const complete = await newMix({ values: COMPLETE });
    await approve(complete.mixId, complete.revisionId);
    const { rows } = await db.pool.query(
      'SELECT state, specified_strength_age_days FROM concrete_mix_revision WHERE id = $1',
      [complete.revisionId],
    );
    expect(rows[0]).toEqual({ state: 'approved', specified_strength_age_days: null });
  });

  it('value checks: tolerance ≥ 0, air 0–100 with min ≤ max, positive strength and aggregate, valid ages', async () => {
    const cases: [Record<string, unknown>, string][] = [
      [{ slump_tolerance_mm: -1 }, 'concrete_mix_revision_slump_tolerance_check'],
      [{ slump_target_mm: -1 }, 'concrete_mix_revision_slump_check'],
      [{ air_min_percent: 8, air_max_percent: 5 }, 'concrete_mix_revision_air_range_check'],
      [{ air_max_percent: 101 }, 'concrete_mix_revision_air_max_check'],
      [{ specified_strength_mpa: 0 }, 'concrete_mix_revision_strength_check'],
      [{ specified_strength_age_days: 0 }, 'concrete_mix_revision_strength_age_check'],
      [{ max_aggregate_size_mm: 0 }, 'concrete_mix_revision_aggregate_check'],
      [{ test_ages: [] }, 'concrete_mix_revision_ages_check'],
      [{ test_ages: ['28', 'hold'] }, 'concrete_mix_revision_ages_check'],
      [{ plant_names: [null] }, 'concrete_mix_revision_plants_check'],
      [{ spec_admixtures: '[]' }, 'concrete_mix_revision_admixtures_check'],
    ];
    for (const [values, constraint] of cases) {
      await expect(newMix({ values }), constraint).rejects.toMatchObject({ ...REJECT, constraint });
    }
    // Repeated ages and HOLD stay distinct entries; no hardcoded slump/air limits.
    const ok = await newMix({
      values: {
        test_ages: ['7', '28', '28', '56', 'HOLD', 'HOLD'],
        slump_target_mm: 250,
        slump_tolerance_mm: 0,
        air_min_percent: 0,
        air_max_percent: 100,
      },
    });
    const { rows } = await db.pool.query(
      'SELECT test_ages FROM concrete_mix_revision WHERE id = $1',
      [ok.revisionId],
    );
    expect(rows[0]!.test_ages).toEqual(['7', '28', '28', '56', 'HOLD', 'HOLD']);
  });

  it('a mix always has a revision, and its pointers name its own approved revision and open draft', async () => {
    // No revision at all.
    await expect(
      db.pool.query(
        `INSERT INTO concrete_mix (project_id, supplier_name, mix_number, created_by_user_id,
                                   created_by_name_snapshot)
         VALUES ($1, 'Lonely Supplier', '1', $2, 'Test PE')`,
        [projectA, lead],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_has_revision_check' });
    // A pointer to a revision that never arrives fails at commit.
    await expect(
      tx((client) =>
        client.query(
          `INSERT INTO concrete_mix (project_id, supplier_name, mix_number, draft_revision_id,
                                     created_by_user_id, created_by_name_snapshot)
           VALUES ($1, 'Ghost Supplier', '1', $2, $3, 'Test PE')`,
          [projectA, randomUUID(), lead],
        ),
      ),
    ).rejects.toMatchObject(FOREIGN);
    // The "effective" pointer can't name a draft.
    const mix = await newMix();
    await expect(
      tx((client) =>
        client.query(
          `UPDATE concrete_mix SET effective_revision_id = draft_revision_id,
                  draft_revision_id = NULL, version = version + 1 WHERE id = $1`,
          [mix.mixId],
        ),
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_pointers' });
    // Another mix's revision can't be pointed at.
    const other = await newMix();
    await expect(
      tx((client) =>
        client.query(
          'UPDATE concrete_mix SET draft_revision_id = $2, version = version + 1 WHERE id = $1',
          [mix.mixId, other.revisionId],
        ),
      ),
    ).rejects.toMatchObject(FOREIGN);
    // The mix is named as its latest revision.
    await expect(
      tx((client) =>
        client.query(
          `UPDATE concrete_mix SET mix_number = 'renamed', version = version + 1 WHERE id = $1`,
          [mix.mixId],
        ),
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_identity' });
  });

  it('revisions stay in their mix’s project', async () => {
    const mix = await approvedMix();
    await expect(tx((client) => addRevision(client, mix.mixId, projectB, 2))).rejects.toMatchObject(
      { ...FOREIGN, constraint: 'concrete_mix_revision_mix_fkey' },
    );
    await expect(
      db.pool.query(
        'UPDATE concrete_mix SET project_id = $2, version = version + 1 WHERE id = $1',
        [mix.mixId, projectB],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_fixed' });
  });

  it('revisions are numbered 1, 2, 3 without gaps and start as drafts; one open draft per mix', async () => {
    const mix = await approvedMix();
    await expect(tx((client) => addRevision(client, mix.mixId, projectA, 3))).rejects.toMatchObject(
      { ...REJECT, constraint: 'concrete_mix_revision_sequence' },
    );
    await expect(
      tx((client) =>
        addRevision(client, mix.mixId, projectA, 2, {
          ...COMPLETE,
          state: 'approved',
          approved_at: new Date(),
          approved_by_user_id: lead,
          approved_by_name_snapshot: 'Test PE',
        }),
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_starts_draft' });
    const draft = await newMix();
    await expect(
      tx(async (client) => {
        await client.query(`SET CONSTRAINTS ALL IMMEDIATE`);
        await addRevision(client, draft.mixId, projectA, 2, {
          supplier_name: draft.supplier,
        });
      }),
    ).rejects.toMatchObject({ ...UNIQUE, constraint: 'concrete_mix_revision_one_draft_key' });
  });

  it('D14: an approved revision never changes; a new draft revision is made and approval supersedes it', async () => {
    const mix = await approvedMix();
    await expect(
      db.pool.query('UPDATE concrete_mix_revision SET specified_strength_mpa = 35 WHERE id = $1', [
        mix.revisionId,
      ]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_immutable' });
    await expect(
      db.pool.query(
        `UPDATE concrete_mix_revision SET state = 'draft', approved_at = NULL,
                       approved_by_user_id = NULL, approved_by_name_snapshot = NULL
                     WHERE id = $1`,
        [mix.revisionId],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_immutable' });

    // Revision 2: a draft beside the approved revision 1, which stays in effect.
    const second = randomUUID();
    await tx(async (client) => {
      await addRevision(
        client,
        mix.mixId,
        projectA,
        2,
        { ...COMPLETE, supplier_name: mix.supplier, specified_strength_mpa: 35 },
        second,
      );
      await client.query(
        'UPDATE concrete_mix SET draft_revision_id = $2, version = version + 1 WHERE id = $1',
        [mix.mixId, second],
      );
    });
    const { rows: pending } = await db.pool.query(
      'SELECT effective_revision_id, draft_revision_id FROM concrete_mix WHERE id = $1',
      [mix.mixId],
    );
    expect(pending[0]).toEqual({
      effective_revision_id: mix.revisionId,
      draft_revision_id: second,
    });

    // Approving 2 without superseding 1 would leave two approved revisions.
    await expect(approve(mix.mixId, second)).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_mix_revision_one_approved_key',
    });
    await approve(mix.mixId, second, mix.revisionId);
    const { rows } = await db.pool.query(
      `SELECT revision_number, state, specified_strength_mpa::float AS mpa
       FROM concrete_mix_revision WHERE mix_id = $1 ORDER BY revision_number`,
      [mix.mixId],
    );
    expect(rows).toEqual([
      { revision_number: 1, state: 'superseded', mpa: 32 },
      { revision_number: 2, state: 'approved', mpa: 35 },
    ]);
    // A superseded revision is final too.
    await expect(
      db.pool.query(
        `UPDATE concrete_mix_revision SET state = 'approved', superseded_at = NULL
                     WHERE id = $1`,
        [mix.revisionId],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_immutable' });
  });

  it('a draft is approved before it can be superseded, and keeps its number and creator', async () => {
    const mix = await newMix({ values: COMPLETE });
    await expect(
      db.pool.query(
        `UPDATE concrete_mix_revision SET state = 'superseded', superseded_at = now(),
                approved_at = now(), approved_by_user_id = $2, approved_by_name_snapshot = 'x'
         WHERE id = $1`,
        [mix.revisionId, lead],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_transition' });
    await expect(
      db.pool.query('UPDATE concrete_mix_revision SET revision_number = 9 WHERE id = $1', [
        mix.revisionId,
      ]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_fixed' });
    // A draft's specification may change.
    await db.pool.query('UPDATE concrete_mix_revision SET cement_type = $2 WHERE id = $1', [
      mix.revisionId,
      'HE',
    ]);
  });

  it('one mix per supplier and mix number in a project, ignoring case; other projects may reuse it', async () => {
    await newMix({ supplier: 'Example Ready-Mix', number: 'M-100' });
    await expect(newMix({ supplier: 'example ready-mix', number: 'm-100' })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_mix_project_supplier_number_key',
    });
    await newMix({ supplier: 'Other Supplier', number: 'M-100' });
    await newMix({ project: projectB, supplier: 'Example Ready-Mix', number: 'M-100' });
    // Leading zeros are part of the number.
    await newMix({ supplier: 'Example Ready-Mix', number: '0100' });
    await newMix({ supplier: 'Example Ready-Mix', number: '100' });
  });

  it('copy provenance is fixed; a mix keeps its project and creator and steps its version', async () => {
    const source = await approvedMix();
    const copy = await newMix({ project: projectB });
    await expect(
      db.pool.query(
        `UPDATE concrete_mix SET copied_from_revision_id = $2, version = version + 1 WHERE id = $1`,
        [copy.mixId, source.revisionId],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_fixed' });
    await expect(
      db.pool.query(`UPDATE concrete_mix SET updated_at = now() WHERE id = $1`, [copy.mixId]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_version_step' });
  });

  it('mixes, revisions and commands are never deleted or truncated', async () => {
    const mix = await newMix();
    await db.pool.query(
      `INSERT INTO concrete_mix_command (idempotency_key, mix_id, kind, request_hash, user_id)
       VALUES ($1, $2, 'create', 'h', $3)`,
      [randomUUID(), mix.mixId, lead],
    );
    await expect(
      db.pool.query('DELETE FROM concrete_mix_revision WHERE id = $1', [mix.revisionId]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_mix_revision_no_delete' });
    await expect(
      db.pool.query('DELETE FROM concrete_mix WHERE id = $1', [mix.mixId]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_mix_no_delete' });
    await expect(
      db.pool.query('DELETE FROM concrete_mix_command WHERE mix_id = $1', [mix.mixId]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_mix_command_append_only' });
    for (const table of ['concrete_mix', 'concrete_mix_revision']) {
      await expect(db.pool.query(`TRUNCATE ${table} CASCADE`)).rejects.toMatchObject(RESTRICT);
    }
  });
});

describe.runIf(testDatabaseUrl)(
  'migration 0017 on a populated database (MM-V2-C03)',
  { timeout: 60_000 },
  () => {
    let db: TestSchema | undefined;

    afterEach(async () => {
      await db?.drop();
      db = undefined;
    });

    async function snapshot(pool: Pool): Promise<Record<string, unknown[]>> {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migration'
         ORDER BY table_name`,
      );
      const out: Record<string, unknown[]> = {};
      for (const { table_name } of tables) {
        const { rows } = await pool.query(
          `SELECT row_to_json(t)::text AS row FROM "${table_name}" t ORDER BY 1`,
        );
        out[table_name] = rows.map((r: { row: string }) => r.row);
      }
      return out;
    }

    it('adds empty tables and changes no project, concrete record or setting', async () => {
      db = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        db.pool,
        all.filter((m) => m.version < '0017'),
      );
      await runSeed(db.pool, 'reference', 'test');
      await runSeed(db.pool, 'dev', 'test');
      const { rows: projects } = await db.pool.query<{ id: string }>(
        'SELECT id FROM project ORDER BY id LIMIT 1',
      );
      const { rows: users } = await db.pool.query<{ id: string }>(
        `SELECT id FROM app_user WHERE account_type <> 'shared_lab' ORDER BY id LIMIT 1`,
      );
      await db.pool.query(
        `INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)`,
        [projects[0]!.id, users[0]!.id],
      );
      await db.pool.query(
        `INSERT INTO concrete_project_settings
           (project_id, default_specimen_ages, updated_by_user_id, updated_by_name_snapshot)
         VALUES ($1, '{7,28,56,HOLD}', $2, 'Test PE')`,
        [projects[0]!.id, users[0]!.id],
      );
      const before = await snapshot(db.pool);

      expect(
        (
          await migrate(
            db.pool,
            all.filter((m) => m.version < '0018'),
          )
        ).applied,
      ).toEqual(['0017_concrete_mixes']);

      const after = await snapshot(db.pool);
      for (const table of ['concrete_mix', 'concrete_mix_revision', 'concrete_mix_command']) {
        expect(after[table]).toEqual([]);
        delete after[table];
      }
      expect(after).toEqual(before);
    });
  },
);
