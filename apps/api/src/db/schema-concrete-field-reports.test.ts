import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C04 (migration 0019): field-report detail, fresh-test readings and the draft command
// ledger, each rule proven in the database. Fictional data only (DEMO- projects, invented
// suppliers, people and tickets).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

describe.runIf(testDatabaseUrl)('concrete field reports (MM-V2-C04, migration 0019)', () => {
  let db: TestSchema;
  let tech: string;
  let projectA: string;
  let projectB: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    tech = await insertUser(db.pool, 'AT');
    projectA = await insertProject(db.pool, 'DEMO-2601', tech);
    projectB = await insertProject(db.pool, 'DEMO-2602', tech);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function report(values: Record<string, unknown> = {}, project = projectA) {
    const row: Record<string, unknown> = {
      project_id: project,
      created_by_user_id: tech,
      technician_user_id: tech,
      ...values,
    };
    const columns = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_report (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  async function reading(
    reportId: string,
    values: Record<string, unknown> = {},
    project = projectA,
  ) {
    const row: Record<string, unknown> = {
      project_id: project,
      field_report_id: reportId,
      test: 'slump',
      context: 'initial',
      position: 1,
      ...values,
    };
    const columns = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_field_reading (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  async function mix(project = projectA) {
    const mixId = randomUUID();
    const revisionId = randomUUID();
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(
        `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                   created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, 'Example Ready-Mix', $3, $4, $5, 'Test PE')`,
        [mixId, project, `M-${mixId.slice(0, 6)}`, revisionId, tech],
      );
      await client.query(
        `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, $3, 1, 'Example Ready-Mix', $4, $5, 'Test PE')`,
        [revisionId, mixId, project, `M-${mixId.slice(0, 6)}`, tech],
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    return mixId;
  }

  async function equipment(kind: 'air_meter' | 'testing_machine') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_equipment (kind, identifier, created_by_user_id, created_by_name_snapshot,
                                       create_idempotency_key, create_request_hash,
                                       updated_by_user_id, updated_by_name_snapshot)
       VALUES ($1, $2, $3, 'Test LM', $4, 'h', $3, 'Test LM') RETURNING id`,
      [kind, kind === 'air_meter' ? `AM-${randomUUID().slice(0, 6)}` : null, tech, randomUUID()],
    );
    return rows[0]!.id;
  }

  it('AC1: a draft with no detail saves, with blanks as NULL and empty lists', async () => {
    const id = await report();
    const { rows } = await db.pool.query(
      `SELECT report_date, supplier_name, ticket_number, load_volume_m3, time_limit_exceeded,
              load_rejected, water_added, specimens_cast, material, location_elements,
              placement_methods, project_spec, ticket_spec, attachment_refs, mix_id, mix_snapshot
       FROM concrete_field_report WHERE id = $1`,
      [id],
    );
    expect(rows[0]).toEqual({
      report_date: null,
      supplier_name: null,
      ticket_number: null,
      load_volume_m3: null,
      time_limit_exceeded: null,
      load_rejected: null,
      water_added: null,
      specimens_cast: null,
      // No default answers: the form preselects Concrete / Yes, the database stores none.
      material: null,
      location_elements: [],
      placement_methods: [],
      project_spec: {},
      ticket_spec: {},
      attachment_refs: [],
      mix_id: null,
      mix_snapshot: null,
    });
  });

  it('refuses values outside the field map (choices, ranges, blanks)', async () => {
    await expect(report({ sampling_location: 'bucket' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_sampling_location_check',
    });
    await expect(report({ placement_methods: ['chute', 'teleport'] })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_placement_methods_check',
    });
    await expect(report({ material: 'asphalt' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_material_check',
    });
    await expect(report({ superplasticizer_added: 'maybe' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_superplasticizer_added_check',
    });
    await expect(report({ load_volume_m3: -1 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_load_volume_check',
    });
    await expect(report({ ambient_temp_c: -61 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_ambient_temp_check',
    });
    await expect(report({ unit_weight_kg_m3: 0 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_unit_weight_check',
    });
    // Blank text is stored as NULL by the API, never as an empty string.
    await expect(report({ ticket_number: '' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_ticket_number_check',
    });
    await expect(report({ project_spec: '[]' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_project_spec_check',
    });
    // Temperatures may be negative.
    await expect(report({ ambient_temp_c: -25.5, concrete_temp_c: 12 })).resolves.toBeTruthy();
  });

  it('CD-18: the same supplier and ticket may be on several reports (no uniqueness)', async () => {
    const values = { supplier_name: 'Example Ready-Mix', ticket_number: '000123' };
    await report(values);
    await report(values);
    await report(values, projectB);
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM concrete_field_report
       WHERE ticket_number = '000123'`,
    );
    // Leading zeros are kept (text).
    expect(rows[0]).toEqual({ n: 3 });
  });

  it('a registry mix belongs to the report project, and its snapshot names it', async () => {
    const mixA = await mix(projectA);
    const snapshot = JSON.stringify({ mixId: mixA, revisionId: randomUUID() });
    await expect(report({ mix_id: mixA, mix_snapshot: snapshot })).resolves.toBeTruthy();
    // Another project's mix.
    await expect(report({ mix_id: mixA, mix_snapshot: snapshot }, projectB)).rejects.toMatchObject({
      ...FOREIGN,
      constraint: 'concrete_field_report_mix_fkey',
    });
    // A mix without its snapshot, a snapshot without a mix, or a snapshot of another mix.
    await expect(report({ mix_id: mixA })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_mix_snapshot_check',
    });
    await expect(report({ mix_snapshot: snapshot })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_mix_snapshot_check',
    });
    await expect(
      report({ mix_id: mixA, mix_snapshot: JSON.stringify({ mixId: randomUUID() }) }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_field_report_mix_snapshot_check' });
  });

  it('the air meter is an air meter, and its evaluation needs it', async () => {
    const meter = await equipment('air_meter');
    const machine = await equipment('testing_machine');
    const use = JSON.stringify({ equipmentId: meter, flags: [] });
    await expect(
      report({ air_meter_equipment_id: meter, air_meter_use: use }),
    ).resolves.toBeTruthy();
    await expect(report({ air_meter_equipment_id: machine })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_air_meter_kind',
    });
    const id = await report();
    await expect(
      db.pool.query('UPDATE concrete_field_report SET air_meter_equipment_id = $2 WHERE id = $1', [
        id,
        machine,
      ]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_field_report_air_meter_kind' });
    await expect(report({ air_meter_use: use })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_air_meter_use_check',
    });
  });

  it('AC3: readings keep one initial per test, ordered retests, and their identity', async () => {
    const id = await report();
    const initial = await reading(id, { value: 80 });
    await reading(id, { context: 'retest', position: 2, value: 120 });
    await reading(id, { context: 'retest', position: 3, value: 100 });
    await reading(id, { context: 'after_superplasticizer', position: 4, value: 160 });
    await reading(id, { test: 'air', value: 5.5 });
    // A second initial slump, or two readings at one position.
    await expect(reading(id, { position: 9 })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_field_reading_one_initial',
    });
    await expect(reading(id, { context: 'retest', position: 2 })).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_field_reading_position_key',
    });
    // A retest never becomes the initial reading, and no reading moves report or test.
    for (const change of ["context = 'retest'", "test = 'air'"]) {
      await expect(
        db.pool.query(`UPDATE concrete_field_reading SET ${change} WHERE id = $1`, [initial]),
      ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_field_reading_identity' });
    }
    const other = await report();
    await expect(
      db.pool.query('UPDATE concrete_field_reading SET field_report_id = $2 WHERE id = $1', [
        initial,
        other,
      ]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_field_reading_identity' });
    // The value, its time and position may change in a draft.
    await expect(
      db.pool.query(
        'UPDATE concrete_field_reading SET value = 85, measured_at = now() WHERE id = $1',
        [initial],
      ),
    ).resolves.toBeTruthy();
    // Blank readings are NULL, never 0.
    const blank = await reading(id, { test: 'air', context: 'retest', position: 2 });
    const { rows } = await db.pool.query('SELECT value FROM concrete_field_reading WHERE id = $1', [
      blank,
    ]);
    expect(rows[0]).toEqual({ value: null });
  });

  it('readings: values in range, same project as the report, no truncate', async () => {
    const id = await report();
    await expect(reading(id, { test: 'air', value: 100.1 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_reading_air_percent',
    });
    await expect(reading(id, { value: -1 })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_reading_value_check',
    });
    await expect(reading(id, { context: 'guess' })).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_reading_context_check',
    });
    await expect(reading(id, {}, projectB)).rejects.toMatchObject({
      ...FOREIGN,
      constraint: 'concrete_field_reading_report_fkey',
    });
    await expect(db.pool.query('TRUNCATE concrete_field_reading')).rejects.toMatchObject(RESTRICT);
  });

  it('a report project correction carries its readings', async () => {
    const id = await report();
    const r = await reading(id, { value: 70 });
    await db.pool.query('UPDATE concrete_field_report SET project_id = $2 WHERE id = $1', [
      id,
      projectB,
    ]);
    const { rows } = await db.pool.query(
      'SELECT project_id FROM concrete_field_reading WHERE id = $1',
      [r],
    );
    expect(rows[0]).toEqual({ project_id: projectB });
  });

  it('AC2: the draft command ledger is append-only, one row per key', async () => {
    const id = await report();
    const key = randomUUID();
    await db.pool.query(
      `INSERT INTO concrete_field_report_command (idempotency_key, report_id, kind, request_hash, user_id)
       VALUES ($1, $2, 'create', 'h', $3)`,
      [key, id, tech],
    );
    await expect(
      db.pool.query(
        `INSERT INTO concrete_field_report_command (idempotency_key, report_id, kind, request_hash, user_id)
         VALUES ($1, $2, 'save', 'h2', $3)`,
        [key, id, tech],
      ),
    ).rejects.toMatchObject({ ...UNIQUE, constraint: 'concrete_field_report_command_pkey' });
    await expect(
      db.pool.query(
        `UPDATE concrete_field_report_command SET request_hash = 'x' WHERE idempotency_key = $1`,
        [key],
      ),
    ).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_field_report_command_append_only',
    });
    await expect(
      db.pool.query('DELETE FROM concrete_field_report_command WHERE idempotency_key = $1', [key]),
    ).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_field_report_command_append_only',
    });
    await expect(
      db.pool.query(
        `INSERT INTO concrete_field_report_command (idempotency_key, report_id, kind, request_hash, user_id)
         VALUES ($1, $2, 'submit', 'h', $3)`,
        [randomUUID(), id, tech],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_field_report_command_kind_check' });
  });

  it('LAB never becomes the technician (C01 trigger still applies)', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `SELECT id FROM app_user WHERE account_type = 'shared_lab' LIMIT 1`,
    );
    const lab =
      rows[0]?.id ??
      (
        await db.pool.query<{ id: string }>(
          `INSERT INTO app_user (display_name, account_type, status) VALUES ('LAB', 'shared_lab', 'active')
           RETURNING id`,
        )
      ).rows[0]!.id;
    await expect(
      report({ created_by_user_id: lab, technician_user_id: lab }),
    ).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_field_report_technician_check',
    });
    // LAB may be the creating account, with a person credited.
    await expect(
      report({ created_by_user_id: lab, technician_user_id: tech }),
    ).resolves.toBeTruthy();
  });

  describe('migration on a populated database', () => {
    let fresh: TestSchema;

    afterAll(async () => {
      await fresh?.drop();
    });

    async function snapshot(pool: Pool) {
      const { rows: tables } = await pool.query<{ table_name: string }>(
        `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migration' ORDER BY table_name`,
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

    it('existing reports gain blank detail; nothing else changes', async () => {
      fresh = await createTestSchema();
      const all = await readMigrations();
      await migrate(
        fresh.pool,
        all.filter((m) => m.version < '0019'),
      );
      await runSeed(fresh.pool, 'reference', 'test');
      await runSeed(fresh.pool, 'dev', 'test');
      const user = await insertUser(fresh.pool, 'MG');
      const project = await insertProject(fresh.pool, 'DEMO-2699', user);
      await fresh.pool.query(
        'INSERT INTO concrete_field_report (project_id, created_by_user_id) VALUES ($1, $2)',
        [project, user],
      );
      const before = await snapshot(fresh.pool);

      expect(
        (
          await migrate(
            fresh.pool,
            all.filter((m) => m.version < '0020'),
          )
        ).applied,
      ).toEqual(['0019_concrete_field_report_detail']);

      const after = await snapshot(fresh.pool);
      expect(after.concrete_field_reading).toEqual([]);
      expect(after.concrete_field_report_command).toEqual([]);
      delete after.concrete_field_reading;
      delete after.concrete_field_report_command;
      const [old] = after.concrete_field_report as string[];
      const parsed = JSON.parse(old!) as Record<string, unknown>;
      expect(parsed).toMatchObject({
        report_date: null,
        location_elements: [],
        placement_methods: [],
        project_spec: {},
        ticket_spec: {},
        attachment_refs: [],
      });
      // The C01 columns are unchanged.
      const [oldBefore] = before.concrete_field_report as string[];
      expect(parsed).toMatchObject(JSON.parse(oldBefore!) as Record<string, unknown>);
      delete after.concrete_field_report;
      delete before.concrete_field_report;
      expect(after).toEqual(before);
    });
  });
});
