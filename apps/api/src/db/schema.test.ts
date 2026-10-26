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

describe.runIf(testDatabaseUrl)('receiving schema (TRP-T02)', () => {
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
      'app_user',
      'audit_event',
      'identity_link',
      'location',
      'print_job',
      'print_job_item',
      'project',
      'receipt',
      'role_assignment',
      'schema_migration',
      'session',
      'storage_unit',
      'storage_unit_annual_counter',
      'storage_unit_hole_summary',
      'test_hole',
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

      // D45: correcting the type to a bulk container keeps BKT-2026-000010.
      await db.pool.query(
        `UPDATE storage_unit SET unit_type = 'bulk_container', holder_kind = 'bucket' WHERE id = $1`,
        [unitId],
      );
      const { rows } = await db.pool.query(
        'SELECT readable_id, unit_type FROM storage_unit WHERE id = $1',
        [unitId],
      );
      expect(rows[0]).toEqual({ readable_id: 'BKT-2026-000010', unit_type: 'bulk_container' });
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

  it('caps a receipt at 50 storage units (owner decision 2026-10-25)', async () => {
    const projectId = await insertProject(db.pool, 'QTY-1', userId);
    await expect(insertReceipt(db.pool, projectId, userId, 51)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(insertReceipt(db.pool, projectId, userId, 0)).rejects.toMatchObject({
      code: PG.checkViolation,
    });
  });

  it('never lets the system Receiving lab location be retired', async () => {
    await expect(
      db.pool.query(`UPDATE location SET active = false WHERE code_normalized = 'RECEIVING'`),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });
});
