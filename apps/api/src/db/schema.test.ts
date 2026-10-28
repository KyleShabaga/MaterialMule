import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  PG,
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { runSeed } from './seed.js';

describe.runIf(testDatabaseUrl)('receiving schema (MM-T02)', () => {
  let db: TestSchema;
  let userId: string;
  let locationId: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    userId = await insertUser(db.pool);
    locationId = await receivingLabId(db.pool);
  });

  afterAll(async () => {
    await db?.drop();
  });

  /** A project, hole, receipt and one bucket, for tests that need a unit to hang data on. */
  async function bucketSetup(projectNumber: string, readableId: string) {
    const projectId = await insertProject(db.pool, projectNumber, userId);
    const testHoleId = await insertTestHole(db.pool, projectId, 'TH26-01');
    const receiptId = await insertReceipt(db.pool, projectId, userId);
    const storageUnitId = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId },
      { readableId },
    );
    return { projectId, testHoleId, receiptId, storageUnitId };
  }

  it('AC1: creates every table and seeds Receiving lab', async () => {
    const { rows } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() ORDER BY table_name`,
    );
    expect(rows.map((r) => r.table_name)).toEqual([
      'acceptance_delegation',
      'action_item',
      'app_user',
      'audit_event',
      'bulk_group',
      'draft_auto_delete_setting',
      'identity_link',
      'lab_comment',
      'lab_comment_revision',
      'lab_program',
      'lab_program_counter',
      'local_credential',
      'location',
      'location_conflict',
      'move_action',
      'movement_event',
      'oidc_sign_in_attempt',
      'print_job',
      'print_job_item',
      'print_job_location_item',
      'printer',
      'program_amendment',
      'program_lifecycle_event',
      'program_priority_history',
      'program_scope_snapshot',
      'project',
      'receipt',
      'role_assignment',
      'schema_migration',
      'session',
      'sign_in_throttle',
      'storage_unit',
      'storage_unit_annual_counter',
      'storage_unit_hole_summary',
      'storage_unit_search',
      'test_group',
      'test_hole',
      'test_line',
      'test_line_test',
      'test_line_unit_choice',
      'test_request',
      'test_request_identity_revision',
      'test_request_review_event',
      'test_request_status_history',
      'test_request_unit_link',
      'test_subgroup',
      'test_template',
      'test_template_item',
      'test_type',
    ]);
    // No individual sample inventory at receiving.
    expect(rows.map((r) => r.table_name)).not.toContain('sample');

    await runSeed(db.pool, 'reference', 'test');
    const location = await db.pool.query(
      `SELECT name, kind, is_system FROM location WHERE code_normalized = 'RECEIVING'`,
    );
    expect(location.rows).toEqual([
      { name: 'Receiving lab', kind: 'receiving_lab', is_system: true },
    ]);
  });

  describe('AC2: project numbers', () => {
    it('rejects untrimmed and case-variant duplicates', async () => {
      await insertProject(db.pool, '67997', userId);
      await expect(insertProject(db.pool, ' 67997', userId)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(insertProject(db.pool, '67997', userId)).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });

      await insertProject(db.pool, 'JOB-A1', userId);
      await expect(insertProject(db.pool, 'job-a1', userId)).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });
    });
  });

  describe('test holes', () => {
    it('are unique per project ignoring case, but may repeat across projects', async () => {
      const a = await insertProject(db.pool, 'HOLES-A', userId);
      const b = await insertProject(db.pool, 'HOLES-B', userId);
      await insertTestHole(db.pool, a, 'TH26-01');
      await expect(insertTestHole(db.pool, a, 'th26-01')).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });
      await expect(insertTestHole(db.pool, a, ' TH26-01')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(insertTestHole(db.pool, b, 'TH26-01')).resolves.toBeTruthy();
    });
  });

  it('AC3: rejects a summary linking a unit to another project’s test hole', async () => {
    const unitProject = await bucketSetup('XPROJ-A', 'BKT-2026-000101');
    const otherProject = await insertProject(db.pool, 'XPROJ-B', userId);
    const foreignHole = await insertTestHole(db.pool, otherProject, 'TH26-01');

    // Claiming the unit's project: the hole doesn't belong to it.
    await expect(
      insertSummary(
        db.pool,
        {
          storageUnitId: unitProject.storageUnitId,
          projectId: unitProject.projectId,
          testHoleId: foreignHole,
        },
        { type: 'all' },
      ),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });

    // Claiming the hole's project: the unit doesn't belong to it.
    await expect(
      insertSummary(
        db.pool,
        {
          storageUnitId: unitProject.storageUnitId,
          projectId: otherProject,
          testHoleId: foreignHole,
        },
        { type: 'all' },
      ),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
  });

  it('AC4: allows one summary per hole on a unit, several holes per unit', async () => {
    const setup = await bucketSetup('MIXED-1', 'BKT-2026-000201');
    const secondHole = await insertTestHole(db.pool, setup.projectId, 'TH26-02');
    const ids = { storageUnitId: setup.storageUnitId, projectId: setup.projectId };

    await insertSummary(
      db.pool,
      { ...ids, testHoleId: setup.testHoleId },
      {
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'S12',
      },
    );
    await insertSummary(db.pool, { ...ids, testHoleId: secondHole }, { type: 'all' });
    await expect(
      insertSummary(db.pool, { ...ids, testHoleId: setup.testHoleId }, { type: 'all' }),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
  });

  it('T5: allows several units and receipts for the same hole', async () => {
    const setup = await bucketSetup('MULTI-1', 'BKT-2026-000301');
    const secondReceipt = await insertReceipt(db.pool, setup.projectId, userId);
    const secondUnit = await insertStorageUnit(
      db.pool,
      { projectId: setup.projectId, receiptId: secondReceipt, locationId },
      { readableId: 'BKT-2026-000302' },
    );
    const ids = { projectId: setup.projectId, testHoleId: setup.testHoleId };
    await insertSummary(
      db.pool,
      { ...ids, storageUnitId: setup.storageUnitId },
      {
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'S12',
      },
    );
    await expect(
      insertSummary(
        db.pool,
        { ...ids, storageUnitId: secondUnit },
        {
          type: 'sample_range',
          sampleFrom: 'G13',
          sampleTo: 'S32',
        },
      ),
    ).resolves.toBeTruthy();
  });

  describe('AC5: summary shapes', () => {
    let ids: { storageUnitId: string; projectId: string; testHoleId: string };
    let holeCounter = 0;

    beforeAll(async () => {
      const setup = await bucketSetup('SHAPES-1', 'BKT-2026-000401');
      ids = setup;
    });

    // Each attempt uses a new hole so the one-summary-per-hole rule doesn't interfere.
    async function attempt(summary: Parameters<typeof insertSummary>[2]) {
      holeCounter += 1;
      const testHoleId = await insertTestHole(db.pool, ids.projectId, `SH-${holeCounter}`);
      return insertSummary(db.pool, { ...ids, testHoleId }, summary);
    }

    it.each([
      ['ALL', { type: 'all' as const }],
      ['sample range', { type: 'sample_range' as const, sampleFrom: 'G1', sampleTo: 'S12' }],
      [
        'depth range in ft',
        { type: 'depth_range' as const, depthFrom: 0, depthTo: 30, depthUnit: 'ft' },
      ],
      [
        'single-depth range in m',
        { type: 'depth_range' as const, depthFrom: 10.5, depthTo: 10.5, depthUnit: 'm' },
      ],
      ['custom', { type: 'custom' as const, customText: 'T5 at 10–12 ft' }],
    ])('accepts a valid %s summary', async (_label, summary) => {
      await expect(attempt(summary)).resolves.toBeTruthy();
    });

    it.each([
      [
        'reversed depth range 30 → 0',
        { type: 'depth_range' as const, depthFrom: 30, depthTo: 0, depthUnit: 'ft' },
      ],
      ['depth range without a unit', { type: 'depth_range' as const, depthFrom: 0, depthTo: 30 }],
      [
        'negative depth',
        { type: 'depth_range' as const, depthFrom: -1, depthTo: 5, depthUnit: 'ft' },
      ],
      [
        'depth unit other than ft/m',
        { type: 'depth_range' as const, depthFrom: 0, depthTo: 5, depthUnit: 'in' },
      ],
      ['blank custom text', { type: 'custom' as const, customText: '   ' }],
      ['custom without text', { type: 'custom' as const }],
      ['sample range missing "to"', { type: 'sample_range' as const, sampleFrom: 'G1' }],
      ['ALL with extra range fields', { type: 'all' as const, sampleFrom: 'G1', sampleTo: 'S2' }],
    ])('rejects %s', async (_label, summary) => {
      await expect(attempt(summary)).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('T6: stores depths such as 2.5 and 32.5 exactly', async () => {
      const id = await attempt({
        type: 'depth_range',
        depthFrom: 2.5,
        depthTo: 32.5,
        depthUnit: 'ft',
      });
      const { rows } = await db.pool.query<{ depth_from: string; depth_to: string }>(
        'SELECT depth_from, depth_to FROM storage_unit_hole_summary WHERE id = $1',
        [id],
      );
      expect(rows[0]).toEqual({ depth_from: '2.50', depth_to: '32.50' });
    });
  });

  describe('AC8: storage unit IDs', () => {
    let ids: { projectId: string; receiptId: string; locationId: string };

    beforeAll(async () => {
      const projectId = await insertProject(db.pool, 'IDS-1', userId);
      const receiptId = await insertReceipt(db.pool, projectId, userId, 10);
      ids = { projectId, receiptId, locationId };
    });

    it('allows the same suffix under different approved prefixes in one year', async () => {
      await insertStorageUnit(db.pool, ids, { readableId: 'BKT-2026-000001' });
      await insertStorageUnit(db.pool, ids, {
        readableId: 'ST-2026-000001',
        issuedHolderKind: 'shelby_tube',
        unitType: 'shelby_tube',
      });
      await insertStorageUnit(db.pool, ids, {
        readableId: 'CT-2026-000001',
        issuedHolderKind: 'generic',
        unitType: 'bulk_container',
      });
      const { rows } = await db.pool.query(
        `SELECT count(*)::int AS n FROM storage_unit WHERE readable_id LIKE '%-2026-000001'`,
      );
      expect(rows[0]).toEqual({ n: 3 });
    });

    it('rejects a duplicate complete ID', async () => {
      await expect(
        insertStorageUnit(db.pool, ids, { readableId: 'BKT-2026-000001' }),
      ).rejects.toMatchObject({ code: PG.uniqueViolation });
    });

    it.each([
      ['the superseded SU format', { readableId: 'SU-2026-000002', prefix: 'SU' }],
      ['an unknown prefix', { readableId: 'XYZ-2026-000002', prefix: 'XYZ' }],
      ['a malformed number', { readableId: 'BKT-2026-12', prefix: 'BKT' }],
      [
        'an ID whose year disagrees with issued_year',
        { readableId: 'BKT-2026-000003', year: 2027 },
      ],
      [
        'a bucket issued with the Shelby tube prefix',
        { readableId: 'ST-2026-000004', issuedHolderKind: 'bucket' },
      ],
      [
        'a Shelby tube issued with the bucket prefix',
        { readableId: 'BKT-2026-000005', issuedHolderKind: 'shelby_tube', unitType: 'shelby_tube' },
      ],
      [
        'a unit type that disagrees with its holder',
        { readableId: 'BKT-2026-000006', unitType: 'shelby_tube' },
      ],
    ])('rejects %s', async (_label, unit) => {
      await expect(insertStorageUnit(db.pool, ids, unit)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
    });

    it('never lets an issued ID change, but allows a type correction', async () => {
      const unitId = await insertStorageUnit(db.pool, ids, { readableId: 'BKT-2026-000010' });

      await expect(
        db.pool.query(`UPDATE storage_unit SET readable_id = 'BKT-2026-000011' WHERE id = $1`, [
          unitId,
        ]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(`UPDATE storage_unit SET issued_holder_kind = 'generic' WHERE id = $1`, [
          unitId,
        ]),
      ).rejects.toMatchObject({ code: PG.checkViolation });

      // D45: correcting the type keeps BKT-2026-000010. (A bulk soil bucket now needs a bulk
      // group, MM-T36, so the example correction is to a Shelby tube.)
      await db.pool.query(
        `UPDATE storage_unit SET unit_type = 'shelby_tube', holder_kind = 'shelby_tube' WHERE id = $1`,
        [unitId],
      );
      const { rows } = await db.pool.query(
        'SELECT readable_id, unit_type FROM storage_unit WHERE id = $1',
        [unitId],
      );
      expect(rows[0]).toEqual({ readable_id: 'BKT-2026-000010', unit_type: 'shelby_tube' });
    });

    it('keeps independent annual counters per prefix', async () => {
      await db.pool.query(
        `INSERT INTO storage_unit_annual_counter (prefix, year, last_value)
         VALUES ('BKT', 2026, 5), ('ST', 2026, 1), ('BKT', 2027, 0)`,
      );
      await expect(
        db.pool.query(
          `INSERT INTO storage_unit_annual_counter (prefix, year) VALUES ('BKT', 2026)`,
        ),
      ).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(
        db.pool.query(`INSERT INTO storage_unit_annual_counter (prefix, year) VALUES ('SU', 2026)`),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(
          `UPDATE storage_unit_annual_counter SET last_value = 1000000 WHERE prefix = 'BKT' AND year = 2026`,
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });
  });

  describe('storage unit IDs are never reused (MM-T47)', () => {
    it('AC1: refuses DELETE and TRUNCATE on storage_unit with a clear error', async () => {
      const { receiptId, storageUnitId } = await bucketSetup('REUSE-1', 'BKT-2026-000501');
      await expect(
        db.pool.query('DELETE FROM storage_unit WHERE id = $1', [storageUnitId]),
      ).rejects.toMatchObject({
        code: PG.restrictViolation,
        message:
          "storage unit BKT-2026-000501 can't be deleted: issued storage unit IDs are permanent",
      });
      await expect(db.pool.query('DELETE FROM storage_unit')).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
      await expect(db.pool.query('TRUNCATE storage_unit CASCADE')).rejects.toMatchObject({
        code: PG.restrictViolation,
        message: expect.stringContaining('issued storage unit IDs are permanent'),
      });
      // Nor can the receipt that issued it go, which would orphan the ID.
      await expect(
        db.pool.query('DELETE FROM receipt WHERE id = $1', [receiptId]),
      ).rejects.toMatchObject({ code: PG.foreignKeyViolation });

      const { rows } = await db.pool.query('SELECT readable_id FROM storage_unit WHERE id = $1', [
        storageUnitId,
      ]);
      expect(rows).toEqual([{ readable_id: 'BKT-2026-000501' }]);
      // Hole summaries carry no ID, so corrections may still replace them (covered above, T12).
    });

    it('AC2: refuses lowering, deleting, truncating or moving a counter; raising works', async () => {
      await db.pool.query(
        `INSERT INTO storage_unit_annual_counter (prefix, year, last_value) VALUES ('ST', 2031, 7)`,
      );
      const counter = `prefix = 'ST' AND year = 2031`;
      await expect(
        db.pool.query(`UPDATE storage_unit_annual_counter SET last_value = 6 WHERE ${counter}`),
      ).rejects.toMatchObject({
        code: PG.restrictViolation,
        message:
          "storage unit counter ST-2031 can't go down from 7 to 6: issued IDs are never reused",
      });
      await expect(
        db.pool.query(`UPDATE storage_unit_annual_counter SET last_value = 0 WHERE ${counter}`),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query(`DELETE FROM storage_unit_annual_counter WHERE ${counter}`),
      ).rejects.toMatchObject({
        code: PG.restrictViolation,
        message: "storage unit counter ST-2031 can't be deleted: issued IDs are never reused",
      });
      await expect(db.pool.query('TRUNCATE storage_unit_annual_counter')).rejects.toMatchObject({
        code: PG.restrictViolation,
      });
      await expect(
        db.pool.query(`UPDATE storage_unit_annual_counter SET year = 2032 WHERE ${counter}`),
      ).rejects.toMatchObject({ code: PG.restrictViolation });

      // Raising (e.g. after a restore) and rewriting the same value both work.
      await db.pool.query(`UPDATE storage_unit_annual_counter SET last_value = 7 WHERE ${counter}`);
      await db.pool.query(
        `UPDATE storage_unit_annual_counter SET last_value = 42 WHERE ${counter}`,
      );
      const { rows } = await db.pool.query(
        `SELECT last_value FROM storage_unit_annual_counter WHERE ${counter}`,
      );
      expect(rows).toEqual([{ last_value: 42 }]);
    });
  });

  it('caps a receipt at 50 storage units (owner decision 2026-10-25)', async () => {
    const projectId = await insertProject(db.pool, 'QTY-1', userId);
    await expect(insertReceipt(db.pool, projectId, userId, 51)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(insertReceipt(db.pool, projectId, userId, 0)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
  });

  it('keeps each receipt line unique within its receipt (MM-T09)', async () => {
    const { projectId, receiptId, storageUnitId } = await bucketSetup('LINE-1', 'BKT-2026-000801');
    await db.pool.query('UPDATE storage_unit SET receipt_line = 1 WHERE id = $1', [storageUnitId]);
    const second = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId },
      { readableId: 'BKT-2026-000802' },
    );
    await expect(
      db.pool.query('UPDATE storage_unit SET receipt_line = 1 WHERE id = $1', [second]),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    await expect(
      db.pool.query('UPDATE storage_unit SET receipt_line = 0 WHERE id = $1', [second]),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await db.pool.query('UPDATE storage_unit SET receipt_line = 2 WHERE id = $1', [second]);
  });

  it("keeps each unit's search document current when its sources change (MM-T12)", async () => {
    const { projectId, testHoleId, storageUnitId } = await bucketSetup(
      'SEARCH-1',
      'BKT-2026-000901',
    );
    const document = async () => {
      const { rows } = await db.pool.query<{ document: string }>(
        'SELECT document FROM storage_unit_search WHERE storage_unit_id = $1',
        [storageUnitId],
      );
      return rows[0]?.document ?? null;
    };
    // Created with the unit: ID, type, project and location.
    expect(await document()).toContain('bkt-2026-000901');
    expect(await document()).toContain('search-1');
    expect(await document()).toContain('receiving lab');

    const summaryId = await insertSummary(
      db.pool,
      { storageUnitId, projectId, testHoleId },
      { type: 'custom', customText: 'Bag Of Fines' },
    );
    expect(await document()).toContain('th26-01');
    expect(await document()).toContain('bag of fines');

    await db.pool.query(`UPDATE storage_unit_hole_summary SET note = 'Seal OK' WHERE id = $1`, [
      summaryId,
    ]);
    expect(await document()).toContain('seal ok');
    await db.pool.query(`UPDATE storage_unit SET note = 'Cracked lid' WHERE id = $1`, [
      storageUnitId,
    ]);
    expect(await document()).toContain('cracked lid');
    await db.pool.query(`UPDATE project SET client = 'Renamed Client' WHERE id = $1`, [projectId]);
    expect(await document()).toContain('renamed client');
    await db.pool.query(`UPDATE test_hole SET name = 'TH26-01A' WHERE id = $1`, [testHoleId]);
    expect(await document()).toContain('th26-01a');
    await db.pool.query('DELETE FROM storage_unit_hole_summary WHERE id = $1', [summaryId]);
    expect(await document()).not.toContain('bag of fines');
  });

  it('indexes summaries as displayed, with every dash folded to a hyphen (MM-T59)', async () => {
    const { projectId, testHoleId, storageUnitId } = await bucketSetup(
      'SEARCH-2',
      'BKT-2026-000902',
    );
    const document = async () => {
      const { rows } = await db.pool.query<{ document: string }>(
        'SELECT document FROM storage_unit_search WHERE storage_unit_id = $1',
        [storageUnitId],
      );
      return rows[0]!.document;
    };
    const summaryId = await insertSummary(
      db.pool,
      { storageUnitId, projectId, testHoleId },
      { type: 'depth_range', depthFrom: 3, depthTo: 5.5, depthUnit: 'ft' },
    );
    expect(await document()).toContain('\n3 5.5 ft\n3-5.5 ft\nth26-01: 3-5.5 ft');
    await db.pool.query(
      `UPDATE storage_unit_hole_summary
       SET summary_type = 'sample_range', depth_from = NULL, depth_to = NULL, depth_unit = NULL,
           sample_from = 'G1', sample_to = 'S10', note = E'Lot A\\u2013B \\u2212 C\\u2014D'
       WHERE id = $1`,
      [summaryId],
    );
    expect(await document()).toContain('g1 s10 g1-s10\nth26-01: g1-s10');
    expect(await document()).toContain('lot a-b - c-d');
    expect(await document()).not.toMatch(/[‐-―−﹘﹣－]/);
  });

  it('never lets the system Receiving lab location be retired', async () => {
    await expect(
      db.pool.query(`UPDATE location SET active = false WHERE code_normalized = 'RECEIVING'`),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });
  describe('print queue (MM-T15)', () => {
    async function job(values: Record<string, unknown> = {}) {
      const row: Record<string, unknown> = {
        kind: 'initial',
        printer_key: 'schema-printer',
        template_version: 'sticker-v1',
        requested_by_user_id: userId,
        requested_by_initials_snapshot: 'AT',
        requested_by_name_snapshot: 'Test AT',
        ...values,
      };
      const columns = Object.keys(row);
      const params = Object.values(row);
      const placeholders = params.map((_, i) => `$${i + 1}`).join(', ');
      return db.pool.query<{ id: string }>(
        `INSERT INTO print_job (${columns.join(', ')}) VALUES (${placeholders}) RETURNING id`,
        params,
      );
    }

    beforeAll(async () => {
      await db.pool.query(
        `INSERT INTO printer (key, name, host) VALUES ('schema-printer', 'Schema', '10.0.0.5')`,
      );
    });

    it('only accepts a host name or IP address and a valid port for a printer', async () => {
      for (const host of ['http://10.0.0.5', '10.0.0.5:9100', 'a b', '-bad', '']) {
        await expect(
          db.pool.query(`INSERT INTO printer (key, name, host) VALUES ('p-bad', 'Bad', $1)`, [
            host,
          ]),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      }
      await expect(
        db.pool.query(
          `INSERT INTO printer (key, name, host, port) VALUES ('p-bad', 'Bad', '10.0.0.6', 70000)`,
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(
          `INSERT INTO printer (key, name, host) VALUES ('Bad Key', 'Bad', '10.0.0.6')`,
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('allows at most one default printer', async () => {
      await db.pool.query(
        `INSERT INTO printer (key, name, host, is_default) VALUES ('p-one', 'One', '10.0.0.7', true)`,
      );
      await expect(
        db.pool.query(
          `INSERT INTO printer (key, name, host, is_default) VALUES ('p-two', 'Two', '10.0.0.8', true)`,
        ),
      ).rejects.toMatchObject({ code: PG.uniqueViolation });
      await db.pool.query(`DELETE FROM printer WHERE key = 'p-one'`);
    });

    it('only queues jobs for configured printers', async () => {
      await expect(
        db.pool.query(
          `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                  requested_by_name_snapshot)
           VALUES ('initial', '10.0.0.5', 'sticker-v1', $1, 'Test AT')`,
          [userId],
        ),
      ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    });

    it('caps attempts at three and ties sent_at to the sent status', async () => {
      await expect(job({ attempts: 4 })).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(job({ status: 'sent' })).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(job({ status: 'failed', sent_at: new Date() })).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(job({ status: 'sent', sent_at: new Date() })).resolves.toBeTruthy();
    });

    it('only records a physical print confirmation, with who, on sent or uncertain jobs', async () => {
      const now = new Date();
      await expect(
        job({
          status: 'failed',
          physically_confirmed_at: now,
          physically_confirmed_by_user_id: userId,
        }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        job({ status: 'uncertain', physically_confirmed_at: now }),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        job({
          status: 'uncertain',
          physically_confirmed_at: now,
          physically_confirmed_by_user_id: userId,
          confirmed_by_initials_snapshot: 'AT',
          confirmed_by_name_snapshot: 'Test AT',
        }),
      ).resolves.toBeTruthy();
    });

    describe('receiver snapshots (MM-T65)', () => {
      const credited = (initials: string | null, name: string | null) =>
        job({
          receiver_user_id: userId,
          receiver_initials_snapshot: initials,
          receiver_name_snapshot: name,
        });

      it('T3/AC3: refuses a new receiver-crediting job without its name snapshot', async () => {
        await expect(job({ receiver_user_id: userId })).rejects.toMatchObject({
          code: PG.checkViolation,
        });
        await expect(credited('AT', null)).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(credited('AT', 'Test AT')).resolves.toBeTruthy();
        // A receiver without confirmed initials at the time is recorded by name.
        await expect(credited(null, 'Test AT')).resolves.toBeTruthy();
      });

      it('refuses snapshots without a receiver, malformed ones and clearing them later', async () => {
        await expect(job()).resolves.toBeTruthy();
        await expect(
          job({ receiver_initials_snapshot: 'AT', receiver_name_snapshot: 'Test AT' }),
        ).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(credited('at', 'Test AT')).rejects.toMatchObject({
          code: PG.checkViolation,
        });
        await expect(credited('AT', '  ')).rejects.toMatchObject({ code: PG.checkViolation });

        const { rows } = await credited('AT', 'Test AT');
        await expect(
          db.pool.query(`UPDATE print_job SET receiver_name_snapshot = NULL WHERE id = $1`, [
            rows[0]!.id,
          ]),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      });
    });

    describe('requested-by and confirmed-by snapshots (MM-T65, Kyle 2026-10-27)', () => {
      it('refuses a new job without the requester name snapshot', async () => {
        await expect(
          job({ requested_by_initials_snapshot: null, requested_by_name_snapshot: null }),
        ).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(job({ requested_by_name_snapshot: null })).rejects.toMatchObject({
          code: PG.checkViolation,
        });
        await expect(job({ requested_by_initials_snapshot: 'at' })).rejects.toMatchObject({
          code: PG.checkViolation,
        });
        // The shared LAB account has no initials; it is recorded by name.
        await expect(
          job({ requested_by_initials_snapshot: null, requested_by_name_snapshot: 'LAB' }),
        ).resolves.toBeTruthy();
      });

      it('refuses a confirmation without the confirmer name snapshot, or a snapshot without one', async () => {
        const { rows } = await job({ status: 'sent', sent_at: new Date() });
        const id = rows[0]!.id;
        const confirm = (initials: string | null, name: string | null) =>
          db.pool.query(
            `UPDATE print_job
             SET physically_confirmed_at = now(), physically_confirmed_by_user_id = $2,
                 confirmed_by_initials_snapshot = $3, confirmed_by_name_snapshot = $4
             WHERE id = $1`,
            [id, userId, initials, name],
          );
        await expect(confirm(null, null)).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(confirm('AT', null)).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(confirm('AT', 'Test AT')).resolves.toBeTruthy();
        await expect(
          db.pool.query(`UPDATE print_job SET confirmed_by_name_snapshot = NULL WHERE id = $1`, [
            id,
          ]),
        ).rejects.toMatchObject({ code: PG.checkViolation });
        await expect(
          job({ confirmed_by_initials_snapshot: 'AT', confirmed_by_name_snapshot: 'Test AT' }),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      });
    });
  });

  describe('staff directory (MM-T07)', () => {
    const addStaff = (values: string) =>
      db.pool.query(
        `INSERT INTO app_user (display_name, account_type, status, expected_upn, approved_by,
                               approved_at, disabled_reason)
         VALUES ${values}`,
      );

    it('keeps an expected UPN unique regardless of case', async () => {
      await addStaff(
        `('Jordan Smith', 'personal', 'active', 'jsmith@company.example', NULL, NULL, NULL)`,
      );
      await expect(
        addStaff(`('J Smith', 'personal', 'active', 'JSmith@Company.example', NULL, NULL, NULL)`),
      ).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(
        addStaff(`('Bad', 'personal', 'active', 'no-at-sign', NULL, NULL, NULL)`),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('allows duplicate official initials', async () => {
      await insertUser(db.pool, 'JS');
      await expect(insertUser(db.pool, 'JS')).resolves.toBeTruthy();
    });

    it('stores a disable reason only on a disabled account', async () => {
      await expect(
        addStaff(`('Active', 'personal', 'active', NULL, NULL, NULL, 'left')`),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        addStaff(`('Gone', 'personal', 'disabled', NULL, NULL, NULL, 'left')`),
      ).resolves.toBeTruthy();
    });

    it('records approver and approval time together', async () => {
      await expect(
        addStaff(`('Half', 'personal', 'active', NULL, NULL, now(), NULL)`),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        addStaff(`('Whole', 'personal', 'active', NULL, '${userId}', now(), NULL)`),
      ).resolves.toBeTruthy();
    });
  });

  describe('LAB credentials (MM-T06)', () => {
    const HASH =
      '$argon2id$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g';

    it('seeds the LAB account with a local_lab identity and no password', async () => {
      await runSeed(db.pool, 'reference', 'test');
      const { rows } = await db.pool.query(
        `SELECT u.display_name, u.account_type, u.status, l.subject,
                (SELECT count(*)::int FROM local_credential c WHERE c.user_id = u.id) AS passwords
         FROM app_user u JOIN identity_link l ON l.user_id = u.id AND l.provider = 'local_lab'`,
      );
      expect(rows).toEqual([
        {
          display_name: 'LAB',
          account_type: 'shared_lab',
          status: 'active',
          subject: 'LAB',
          passwords: 0,
        },
      ]);
    });

    it('stores only Argon2id hashes, and only for shared LAB accounts', async () => {
      await runSeed(db.pool, 'reference', 'test');
      const lab = '00000000-0000-4000-8000-000000000001';
      await expect(
        db.pool.query('INSERT INTO local_credential (user_id, password_hash) VALUES ($1, $2)', [
          lab,
          'plain-text-password',
        ]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query('INSERT INTO local_credential (user_id, password_hash) VALUES ($1, $2)', [
          userId,
          HASH,
        ]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query('INSERT INTO local_credential (user_id, password_hash) VALUES ($1, $2)', [
        lab,
        HASH,
      ]);
      await db.pool.query('DELETE FROM local_credential WHERE user_id = $1', [lab]);
    });
  });

  describe('Microsoft identities and profiles (MM-T05)', () => {
    const TENANT = '11111111-2222-4333-8444-555555555555';
    const oid = (n: number) => `00000000-0000-4000-8000-0000000b${String(n).padStart(4, '0')}`;

    async function personalUser(): Promise<string> {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, account_type, status)
         VALUES ('Fictional Person', 'personal', 'pending') RETURNING id`,
      );
      return rows[0]!.id;
    }

    it('keys Microsoft identities on tenant and object ID GUIDs, one per person', async () => {
      const person = await personalUser();
      const link = (userId: string, tenant: string, subject: string) =>
        db.pool.query(
          `INSERT INTO identity_link (user_id, provider, tenant_id, subject)
           VALUES ($1, 'microsoft', $2, $3)`,
          [userId, tenant, subject],
        );
      await expect(link(person, TENANT, 'person@example.test')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(link(person, '', oid(1))).rejects.toMatchObject({ code: PG.checkViolation });
      await link(person, TENANT, oid(1));
      await expect(link(person, TENANT, oid(2))).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });
      await expect(link(await personalUser(), TENANT, oid(1))).rejects.toMatchObject({
        code: PG.uniqueViolation,
      });
    });

    it('needs a position before position_set_at, and a complete initials confirmation', async () => {
      const person = await personalUser();
      await expect(
        db.pool.query('UPDATE app_user SET position_set_at = now() WHERE id = $1', [person]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query(
        `UPDATE app_user SET position = 'engineer', position_set_at = now() WHERE id = $1`,
        [person],
      );
      await expect(
        db.pool.query(
          `UPDATE app_user SET official_initials = 'KCS', initials_confirmed_at = now() WHERE id = $1`,
          [person],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(`UPDATE app_user SET profile_source = 'directory' WHERE id = $1`, [person]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('only lets a sign-in attempt return to an in-app path', async () => {
      const insert = (returnTo: string) =>
        db.pool.query(
          `INSERT INTO oidc_sign_in_attempt (provider, state_hash, browser_binding_hash, nonce,
                                             code_verifier, return_to, expires_at)
           VALUES ('microsoft', gen_random_uuid()::text::bytea, 'b'::bytea, 'n', 'v', $1,
                   now() + interval '10 minutes')`,
          [returnTo],
        );
      await insert('/projects?mine=1');
      for (const bad of ['https://evil.example', '//evil.example', 'projects']) {
        await expect(insert(bad), bad).rejects.toMatchObject({ code: PG.checkViolation });
      }
    });
  });

  describe('projects (MM-T35)', () => {
    it('locks the project number once any receipt exists; other fields stay editable', async () => {
      const projectId = await insertProject(db.pool, 'LOCK-1', userId);
      await db.pool.query(`UPDATE project SET project_number = 'LOCK-1A' WHERE id = $1`, [
        projectId,
      ]);
      await insertReceipt(db.pool, projectId, userId);
      await expect(
        db.pool.query(`UPDATE project SET project_number = 'LOCK-1B' WHERE id = $1`, [projectId]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query(
        `UPDATE project SET name = 'Renamed', server_folder_path = 'P:\\Projects\\LOCK-1A'
         WHERE id = $1`,
        [projectId],
      );
      const { rows } = await db.pool.query(
        'SELECT project_number, name FROM project WHERE id = $1',
        [projectId],
      );
      expect(rows[0]).toEqual({ project_number: 'LOCK-1A', name: 'Renamed' });
    });

    it('limits the server folder path to 500 characters', async () => {
      const projectId = await insertProject(db.pool, 'PATH-1', userId);
      await expect(
        db.pool.query('UPDATE project SET server_folder_path = $2 WHERE id = $1', [
          projectId,
          'x'.repeat(501),
        ]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });
  });

  describe('draft auto-delete setting (MM-T45)', () => {
    it('starts as one row: off, 90 days, version 1', async () => {
      const { rows } = await db.pool.query(
        'SELECT enabled, after_days, version FROM draft_auto_delete_setting',
      );
      expect(rows).toEqual([{ enabled: false, after_days: 90, version: 1 }]);
    });

    it('keeps the days within 30–365 and allows no second row', async () => {
      for (const days of [29, 366]) {
        await expect(
          db.pool.query('UPDATE draft_auto_delete_setting SET after_days = $1', [days]),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      }
      await expect(
        db.pool.query('INSERT INTO draft_auto_delete_setting DEFAULT VALUES'),
      ).rejects.toMatchObject({ code: PG.uniqueViolation });
      await expect(
        db.pool.query('INSERT INTO draft_auto_delete_setting (singleton) VALUES (false)'),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });
  });

  describe('audit receiver snapshots (MM-T56)', () => {
    const addEvent = (receiverId: string | null, initials: string | null, name: string | null) =>
      db.pool.query(
        `INSERT INTO audit_event (action, entity_type, actor_account_type, receiver_user_id,
                                  receiver_initials_snapshot, receiver_name_snapshot)
         VALUES ('receipt.confirmed', 'receipt', 'system', $1, $2, $3)`,
        [receiverId, initials, name],
      );

    it('T3/AC3: refuses a receiver event without its name snapshot', async () => {
      await expect(addEvent(userId, null, null)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(addEvent(userId, 'AT', null)).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(addEvent(userId, 'AT', 'Test AT')).resolves.toBeTruthy();
      // A receiver without confirmed initials at the time is recorded by name.
      await expect(addEvent(userId, null, 'Test AT')).resolves.toBeTruthy();
    });

    it('refuses snapshots without a receiver, and malformed snapshots', async () => {
      await expect(addEvent(null, null, null)).resolves.toBeTruthy();
      await expect(addEvent(null, 'AT', 'Test AT')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(addEvent(userId, 'at', 'Test AT')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
      await expect(addEvent(userId, 'AT', '  ')).rejects.toMatchObject({
        code: PG.checkViolation,
      });
    });
  });

  describe('storage locations and location labels (MM-T37)', () => {
    async function addLocation(code: string, name = `Location ${code}`) {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
        [code, name],
      );
      return rows[0]!.id;
    }

    async function locationJob(target = 'location') {
      await db.pool.query(
        `INSERT INTO printer (key, name, host) VALUES ('loc-printer', 'Loc', '10.0.0.9')
         ON CONFLICT DO NOTHING`,
      );
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO print_job (kind, target_type, printer_key, template_version,
                                requested_by_user_id, requested_by_name_snapshot)
         VALUES ('initial', $1, 'loc-printer', 'location-v1', $2, 'Test AT') RETURNING id`,
        [target, userId],
      );
      return rows[0]!.id;
    }

    it('keeps codes unique ignoring case', async () => {
      await addLocation('SCH-A1');
      await expect(addLocation('sch-a1')).rejects.toMatchObject({ code: PG.uniqueViolation });
    });

    it('records a reason exactly when a location is retired, and keeps area tidy', async () => {
      const id = await addLocation('SCH-R1');
      await expect(
        db.pool.query('UPDATE location SET active = false WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(`UPDATE location SET retired_at = now() WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query(
        `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Shelf removed'
         WHERE id = $1`,
        [id],
      );
      for (const area of [' Bay 1', '', 'x'.repeat(61)]) {
        await expect(
          db.pool.query(`UPDATE location SET area = $1 WHERE code_normalized = 'SCH-A1'`, [area]),
        ).rejects.toMatchObject({ code: PG.checkViolation });
      }
      await db.pool.query(
        `UPDATE location SET area = 'Warehouse C' WHERE code_normalized = 'SCH-A1'`,
      );
    });

    it('never deletes a location and keeps the system flag and kind of Receiving lab', async () => {
      const id = await addLocation('SCH-D1');
      await expect(db.pool.query('DELETE FROM location WHERE id = $1', [id])).rejects.toMatchObject(
        { code: PG.restrictViolation },
      );
      await expect(
        db.pool.query(`UPDATE location SET is_system = true WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query(`UPDATE location SET kind = 'lab' WHERE code_normalized = 'RECEIVING'`),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      // Renaming the system location for display is allowed.
      await db.pool.query(
        `UPDATE location SET name = 'Receiving bench' WHERE code_normalized = 'RECEIVING'`,
      );
      await db.pool.query(
        `UPDATE location SET name = 'Receiving lab' WHERE code_normalized = 'RECEIVING'`,
      );
    });

    it('locks the code once a label is requested and only then accepts a location label', async () => {
      const id = await addLocation('SCH-L1');
      const jobId = await locationJob();
      // No lock yet: a label can't be queued for it.
      await expect(
        db.pool.query(
          `INSERT INTO print_job_location_item (print_job_id, location_id, position, code_snapshot,
                                                name_snapshot)
           VALUES ($1, $2, 1, 'SCH-L1', 'Location SCH-L1')`,
          [jobId, id],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query('UPDATE location SET code_locked_at = now() WHERE id = $1', [id]);
      // The label must carry the location's own code.
      await expect(
        db.pool.query(
          `INSERT INTO print_job_location_item (print_job_id, location_id, position, code_snapshot,
                                                name_snapshot)
           VALUES ($1, $2, 1, 'SCH-L2', 'Location SCH-L1')`,
          [jobId, id],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await db.pool.query(
        `INSERT INTO print_job_location_item (print_job_id, location_id, position, code_snapshot,
                                              name_snapshot)
         VALUES ($1, $2, 1, 'SCH-L1', 'Location SCH-L1')`,
        [jobId, id],
      );
      // Locked: the code and the lock itself can't change; the name still can.
      await expect(
        db.pool.query(`UPDATE location SET code = 'SCH-L9' WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await expect(
        db.pool.query(`UPDATE location SET code_locked_at = NULL WHERE id = $1`, [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
      await db.pool.query(`UPDATE location SET name = 'Renamed shelf' WHERE id = $1`, [id]);
      // A physical confirmation is recorded once and never moved.
      await db.pool.query('UPDATE location SET label_printed_at = now() WHERE id = $1', [id]);
      await expect(
        db.pool.query('UPDATE location SET label_printed_at = NULL WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
    });

    it('never records a physical label without a code lock', async () => {
      const id = await addLocation('SCH-P1');
      await expect(
        db.pool.query('UPDATE location SET label_printed_at = now() WHERE id = $1', [id]),
      ).rejects.toMatchObject({ code: PG.checkViolation });
    });

    it('keeps storage-unit and location items on jobs of their own target type', async () => {
      const id = await addLocation('SCH-T1');
      await db.pool.query('UPDATE location SET code_locked_at = now() WHERE id = $1', [id]);
      const unitJob = await locationJob('storage_unit');
      const locJob = await locationJob('location');
      await expect(
        db.pool.query(
          `INSERT INTO print_job_location_item (print_job_id, location_id, position, code_snapshot,
                                                name_snapshot)
           VALUES ($1, $2, 1, 'SCH-T1', 'Location')`,
          [unitJob, id],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      const { storageUnitId } = await bucketSetup('DEMO-3701', 'BKT-2026-037001');
      await expect(
        db.pool.query(
          `INSERT INTO print_job_item (print_job_id, storage_unit_id, position) VALUES ($1, $2, 1)`,
          [locJob, storageUnitId],
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      await expect(
        db.pool.query(`UPDATE print_job SET target_type = 'storage_unit' WHERE id = $1`, [locJob]),
      ).rejects.toMatchObject({ code: PG.restrictViolation });
    });

    it('never places a storage unit in a retired location', async () => {
      const retired = await addLocation('SCH-X1');
      await db.pool.query(
        `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Gone'
         WHERE id = $1`,
        [retired],
      );
      const { storageUnitId, projectId, receiptId } = await bucketSetup(
        'DEMO-3702',
        'BKT-2026-037002',
      );
      await expect(
        db.pool.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
          storageUnitId,
          retired,
        ]),
      ).rejects.toMatchObject({
        code: PG.checkViolation,
        constraint: 'storage_unit_location_active',
      });
      await expect(
        insertStorageUnit(
          db.pool,
          { projectId, receiptId, locationId: retired },
          { readableId: 'BKT-2026-037003' },
        ),
      ).rejects.toMatchObject({ code: PG.checkViolation });
      // Other changes to a unit already somewhere are unaffected.
      await db.pool.query(`UPDATE storage_unit SET note = 'still fine' WHERE id = $1`, [
        storageUnitId,
      ]);
    });

    it('serialises retirement and an incoming unit: the move waits, then is refused', async () => {
      const target = await addLocation('SCH-C1');
      const { storageUnitId } = await bucketSetup('DEMO-3704', 'BKT-2026-037004');
      const retirer = await db.pool.connect();
      const mover = await db.pool.connect();
      try {
        await retirer.query('BEGIN');
        await retirer.query('SELECT id FROM location WHERE id = $1 FOR UPDATE', [target]);
        await mover.query('BEGIN');
        // Blocks on the retirement's row lock.
        const move = mover
          .query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
            storageUnitId,
            target,
          ])
          .then(
            () => 'moved',
            (error: { constraint?: string }) => error.constraint,
          );
        const occupants = await retirer.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM storage_unit WHERE current_location_id = $1`,
          [target],
        );
        expect(occupants.rows[0]!.count).toBe(0);
        await retirer.query(
          `UPDATE location SET active = false, retired_at = now(), retired_reason = 'Closed'
           WHERE id = $1`,
          [target],
        );
        await retirer.query('COMMIT');
        expect(await move).toBe('storage_unit_location_active');
        await mover.query('ROLLBACK');
      } finally {
        retirer.release();
        mover.release();
      }
    });

    it('serialises an incoming unit and retirement: the retirement waits and sees the unit', async () => {
      const target = await addLocation('SCH-C2');
      const { storageUnitId } = await bucketSetup('DEMO-3705', 'BKT-2026-037005');
      const retirer = await db.pool.connect();
      const mover = await db.pool.connect();
      try {
        await mover.query('BEGIN');
        await mover.query('UPDATE storage_unit SET current_location_id = $2 WHERE id = $1', [
          storageUnitId,
          target,
        ]);
        await retirer.query('BEGIN');
        // Blocks on the move's key-share lock until it commits.
        const lock = retirer.query('SELECT id FROM location WHERE id = $1 FOR UPDATE', [target]);
        await mover.query('COMMIT');
        await lock;
        const occupants = await retirer.query<{ count: number }>(
          `SELECT count(*)::int AS count FROM storage_unit WHERE current_location_id = $1`,
          [target],
        );
        expect(occupants.rows[0]!.count).toBe(1);
        await retirer.query('ROLLBACK');
      } finally {
        retirer.release();
        mover.release();
      }
    });
  });
});
