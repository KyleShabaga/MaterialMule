import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
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
import { migrate, readMigrations } from './migrator.js';

// MM-T36 integrity rules (migration 0029), proven in the database itself, and the upgrade of a
// database that already holds buckets from before 0029. Fictional data only.

describe.runIf(testDatabaseUrl)('bulk groups and sampling sources schema (MM-T36)', () => {
  let db: TestSchema;
  let userId: string;
  let locationId: string;
  let projectId: string;
  let otherProjectId: string;
  let holeId: string;
  let otherHoleId: string;
  let receiptId: string;
  let legacyBucket: string;
  let sequence = 100;

  const search = async (id: string) =>
    (
      await db.pool.query<{ document: string }>(
        'SELECT document FROM storage_unit_search WHERE storage_unit_id = $1',
        [id],
      )
    ).rows[0]?.document;

  async function group(values: Record<string, unknown> = {}): Promise<string> {
    const row = {
      project_id: projectId,
      source_type: 'test_hole',
      test_hole_id: holeId,
      source_location_reference: null,
      sample_reference: 'B1',
      depth_from: 1.5,
      depth_to: 2,
      depth_unit: 'm',
      created_by_user_id: userId,
      ...values,
    };
    const keys = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO bulk_group (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  async function unit(values: Record<string, unknown>): Promise<string> {
    sequence += 1;
    const prefix = values.holder_kind === 'shelby_tube' ? 'ST' : 'BKT';
    const row = {
      readable_id: `${prefix}-2026-${String(sequence).padStart(6, '0')}`,
      id_prefix: prefix,
      issued_year: 2026,
      issued_holder_kind: values.holder_kind ?? 'bucket',
      receipt_id: receiptId,
      project_id: projectId,
      unit_type: 'bucket',
      holder_kind: 'bucket',
      current_location_id: locationId,
      received_date: '2026-10-23',
      ...values,
    };
    const keys = Object.keys(row);
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO storage_unit (${keys.join(', ')})
       VALUES (${keys.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(row),
    );
    return rows[0]!.id;
  }

  beforeAll(async () => {
    // Migrate to 0028 only, add a bucket as receiving made them before MM-T36, then upgrade.
    db = await createTestSchema();
    const all = await readMigrations();
    await migrate(
      db.pool,
      all.filter((m) => m.version < '0029'),
    );
    userId = await insertUser(db.pool);
    locationId = await receivingLabId(db.pool);
    projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    otherProjectId = await insertProject(db.pool, 'DEMO-2602', userId);
    holeId = await insertTestHole(db.pool, projectId, 'TH26-21');
    otherHoleId = await insertTestHole(db.pool, otherProjectId, 'TH26-21');
    receiptId = await insertReceipt(db.pool, projectId, userId);
    legacyBucket = await insertStorageUnit(
      db.pool,
      { projectId, receiptId, locationId },
      { readableId: 'BKT-2026-000001' },
    );
    await insertSummary(
      db.pool,
      { storageUnitId: legacyBucket, projectId, testHoleId: holeId },
      { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S10' },
    );
    await migrate(db.pool, all);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps a pre-0029 bucket and every 0027 search form', async () => {
    const { rows } = await db.pool.query(
      `SELECT unit_type, source_type, bulk_group_id FROM storage_unit WHERE id = $1`,
      [legacyBucket],
    );
    expect(rows[0]).toEqual({ unit_type: 'bucket', source_type: null, bulk_group_id: null });
    const document = await search(legacyBucket);
    for (const form of ['g1 s10 g1-s10', 'th26-21: g1-s10', 'bkt-2026-000001', 'receiving lab']) {
      expect(document).toContain(form);
    }
    const origin = await db.pool.query('SELECT storage_unit_origin_names($1) AS names', [
      legacyBucket,
    ]);
    expect(origin.rows[0].names).toEqual(['TH26-21']);
  });

  it('a bulk group needs its source, sample reference, depth and units; intervals run forwards', async () => {
    await expect(group({ test_hole_id: null })).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      group({ source_type: 'standalone_location', test_hole_id: null }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      group({ source_type: 'standalone_location', source_location_reference: 'Stockpile 2' }),
    ).rejects.toMatchObject({ code: PG.checkViolation }); // both kinds of source
    await expect(group({ sample_reference: ' B1' })).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(group({ depth_unit: null })).rejects.toMatchObject({ code: '23502' });
    await expect(group({ depth_to: 1 })).rejects.toMatchObject({ code: PG.checkViolation });
    // Its hole must be in its own project.
    await expect(group({ test_hole_id: otherHoleId })).rejects.toMatchObject({
      code: PG.foreignKeyViolation,
    });
    // Valid: a single depth, a standalone source, a non-B reference.
    await group({ depth_to: null });
    await group({
      source_type: 'standalone_location',
      test_hole_id: null,
      source_location_reference: 'Embankment Location 03',
      sample_reference: 'Bag 7',
    });
  });

  it('only a bulk soil bucket (holder bucket) joins a group, and only within its project', async () => {
    const groupId = await group();
    await unit({ unit_type: 'bulk_container', bulk_group_id: groupId });
    // An ordinary bucket or a Shelby tube can't be a member.
    await expect(unit({ bulk_group_id: groupId })).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(
      unit({
        unit_type: 'shelby_tube',
        holder_kind: 'shelby_tube',
        bulk_group_id: groupId,
        source_type: 'test_hole',
        source_test_hole_id: holeId,
      }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    // A bulk bucket always has a group.
    await expect(unit({ unit_type: 'bulk_container' })).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    // Cross-project membership is impossible: the FK carries the project.
    const otherReceipt = await insertReceipt(db.pool, otherProjectId, userId);
    await expect(
      unit({
        unit_type: 'bulk_container',
        bulk_group_id: groupId,
        project_id: otherProjectId,
        receipt_id: otherReceipt,
      }),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    // A group never moves project.
    await expect(
      db.pool.query('UPDATE bulk_group SET project_id = $2 WHERE id = $1', [
        groupId,
        otherProjectId,
      ]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('a Shelby tube has exactly one source kind, a same-project hole, and depth with units', async () => {
    const tube = (values: Record<string, unknown>) =>
      unit({ unit_type: 'shelby_tube', holder_kind: 'shelby_tube', ...values });
    await tube({ source_type: 'test_hole', source_test_hole_id: holeId, sample_reference: 'T5' });
    await tube({
      source_type: 'standalone_location',
      source_location_reference: 'Embankment Location 03',
      sample_depth_from: 10,
      sample_depth_to: 12,
      sample_depth_unit: 'ft',
    });
    await expect(
      tube({ source_type: 'standalone_location', source_location_reference: '' }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      tube({
        source_type: 'test_hole',
        source_test_hole_id: holeId,
        source_location_reference: 'Embankment Location 03',
      }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    await expect(
      tube({ source_type: 'test_hole', source_test_hole_id: otherHoleId }),
    ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
    await expect(
      tube({ source_type: 'test_hole', source_test_hole_id: holeId, sample_depth_from: 3 }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
    // No sample identity without a source; an ordinary bucket never has one.
    await expect(tube({ sample_reference: 'T5' })).rejects.toMatchObject({
      code: PG.checkViolation,
    });
    await expect(
      unit({ source_type: 'test_hole', source_test_hole_id: holeId }),
    ).rejects.toMatchObject({ code: PG.checkViolation });
  });

  it('a unit with a sample identity never also has hole summaries (either order)', async () => {
    const tube = await unit({
      unit_type: 'shelby_tube',
      holder_kind: 'shelby_tube',
      source_type: 'test_hole',
      source_test_hole_id: holeId,
    });
    await expect(
      insertSummary(
        db.pool,
        { storageUnitId: tube, projectId, testHoleId: holeId },
        { type: 'all' },
      ),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_one_contents_summary',
    });

    const legacyTube = await unit({ unit_type: 'shelby_tube', holder_kind: 'shelby_tube' });
    await insertSummary(
      db.pool,
      { storageUnitId: legacyTube, projectId, testHoleId: holeId },
      { type: 'all' },
    );
    await expect(
      db.pool.query(
        `UPDATE storage_unit SET source_type = 'test_hole', source_test_hole_id = $2 WHERE id = $1`,
        [legacyTube, holeId],
      ),
    ).rejects.toMatchObject({
      code: PG.checkViolation,
      constraint: 'storage_unit_one_contents_summary',
    });
  });

  it('search and the sticker origin follow the group: correction and hole rename refresh members', async () => {
    const groupId = await group({ sample_reference: 'B4', depth_from: 3, depth_to: 4.5 });
    const member = await unit({ unit_type: 'bulk_container', bulk_group_id: groupId });
    expect(await search(member)).toContain('th26-21: b4 at 3-4.5 m');
    expect(await search(member)).toContain('bulk soil sample');
    const origin = async () =>
      (await db.pool.query('SELECT storage_unit_origin_names($1) AS n', [member])).rows[0].n;
    expect(await origin()).toEqual(['TH26-21']);

    await db.pool.query(
      `UPDATE bulk_group SET source_type = 'standalone_location', test_hole_id = NULL,
                             source_location_reference = 'Stockpile 4', sample_reference = 'B14'
       WHERE id = $1`,
      [groupId],
    );
    expect(await search(member)).toContain('stockpile 4: b14 at 3-4.5 m');
    expect(await search(member)).not.toContain('b4 at');
    expect(await origin()).toEqual(['Stockpile 4']);

    const holeGroup = await group({ sample_reference: 'B6' });
    const second = await unit({ unit_type: 'bulk_container', bulk_group_id: holeGroup });
    await db.pool.query(`UPDATE test_hole SET name = 'TH26-21R' WHERE id = $1`, [holeId]);
    expect(await search(second)).toContain('th26-21r: b6');
    expect(await search(legacyBucket)).toContain('th26-21r: g1-s10');
  });
});
