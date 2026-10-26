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
      'local_credential',
      'location',
      'oidc_sign_in_attempt',
      'print_job',
      'print_job_item',
      'printer',
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

  it('keeps each receipt line unique within its receipt (TRP-T09)', async () => {
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

  it("keeps each unit's search document current when its sources change (TRP-T12)", async () => {
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

  it('never lets the system Receiving lab location be retired', async () => {
    await expect(
      db.pool.query(`UPDATE location SET active = false WHERE code_normalized = 'RECEIVING'`),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });
  describe('print queue (TRP-T15)', () => {
    async function job(values: Record<string, unknown> = {}) {
      const columns = ['kind', 'printer_key', 'template_version', 'requested_by_user_id'];
      const params: unknown[] = ['initial', 'schema-printer', 'sticker-v1', userId];
      for (const [column, value] of Object.entries(values)) {
        columns.push(column);
        params.push(value);
      }
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
          `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id)
           VALUES ('initial', '10.0.0.5', 'sticker-v1', $1)`,
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
        }),
      ).resolves.toBeTruthy();
    });
  });

  describe('staff directory (TRP-T07)', () => {
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

  describe('LAB credentials (TRP-T06)', () => {
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

  describe('Microsoft identities and profiles (TRP-T05)', () => {
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

  describe('projects (TRP-T35)', () => {
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
});
