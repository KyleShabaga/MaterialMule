import { randomUUID } from 'node:crypto';
import type {
  BulkGroupSummary,
  ConfirmReceiptRequestInput,
  ConfirmReceiptResponse,
  InventoryPage,
  StorageUnitDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../../auth/auth.guard.js';
import { testDatabaseUrl } from '../../test-support/database.js';
import { insertProject, insertTestHole } from '../../test-support/fixtures.js';
import {
  bootReceivingHarness,
  type ReceivingHarness,
} from '../../test-support/receiving-harness.js';

// MM-T36 receiving increment: Shelby tubes with a test-hole or standalone sampling source, bulk
// soil buckets in bulk groups, joins by later receipts, idempotent retries, rollback, server-side
// validation, inventory/search/detail/label preview and the personal-only group corrections.
// Card tests T1–T5, T8, T9, T14, T15 (API parts). Fictional data only: DEMO-2601/2602,
// TH26-01/02/21, Embankment Location 03. Tested-unit removal (AC9–AC11) is NOT covered here: it
// needs real T23/T24 exact-unit completion evidence, which doesn't exist yet.

describe.runIf(testDatabaseUrl)('bulk groups and Shelby tube receiving (MM-T36)', () => {
  let h: ReceivingHarness;
  let lab: string;
  let at: string;
  let th21: string;
  let otherProject: string;
  let otherHole: string;

  const B1_TH21 = () => ({
    sourceType: 'test_hole' as const,
    testHoleId: th21,
    sampleReference: 'B1',
    depthFrom: 1.5,
    depthTo: 2,
    depthUnit: 'm' as const,
  });

  function receipt(
    units: ConfirmReceiptRequestInput['units'],
    extra: Partial<ConfirmReceiptRequestInput> = {},
  ): ConfirmReceiptRequestInput {
    return {
      idempotencyKey: randomUUID(),
      projectId: h.projectId,
      receivedDate: '2026-01-15',
      receiverUserId: h.users.at,
      description: null,
      units,
      ...extra,
    };
  }

  async function confirm(body: ConfirmReceiptRequestInput, cookie = lab) {
    const response = await h.postReceipt(body, cookie);
    return response;
  }

  async function confirmed(body: ConfirmReceiptRequestInput): Promise<ConfirmReceiptResponse> {
    const response = await confirm(body);
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return response.body as ConfirmReceiptResponse;
  }

  const get = async <T>(path: string, cookie = lab): Promise<T> => {
    const response = await h.http().get(path).set('Cookie', cookie);
    expect(response.status, `${path}: ${JSON.stringify(response.body)}`).toBe(200);
    return response.body as T;
  };
  const detail = (id: string) => get<StorageUnitDetail>(`/api/storage-units/${id}`);
  const search = async (text: string) =>
    (
      await get<InventoryPage>(`/api/inventory?search=${encodeURIComponent(text)}&pageSize=100`)
    ).items.map((item) => item.readableId);

  const patch = (path: string, body: unknown, cookie = at) =>
    h
      .http()
      .patch(path)
      .set('Cookie', cookie)
      .set(CSRF_HEADER, '1')
      .send(body as object);

  beforeAll(async () => {
    h = await bootReceivingHarness();
    lab = await h.cookieFor('lab');
    at = await h.cookieFor('at');
    th21 = await insertTestHole(h.db.pool, h.projectId, 'TH26-21');
    otherProject = await insertProject(h.db.pool, 'DEMO-2602', h.users.pe);
    otherHole = await insertTestHole(h.db.pool, otherProject, 'TH26-21');
  });

  afterAll(async () => {
    await h?.close();
  });

  describe('receiving', () => {
    let first: ConfirmReceiptResponse;

    it('AC1/T5: two buckets of one new bulk sample get their own BKT IDs and one group; quantity 2', async () => {
      const body = receipt(
        [
          { clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'b1' } },
          { clientRowId: 'b', unitType: 'bucket', bulkGroup: { newGroupKey: 'b1' } },
        ],
        { bulkGroups: [{ key: 'b1', ...B1_TH21(), description: 'Clayey sand' }] },
      );
      first = await confirmed(body);
      expect(first.units.map((u) => u.suNumber)).toEqual([
        expect.stringMatching(/^BKT-\d{4}-\d{6}$/),
        expect.stringMatching(/^BKT-\d{4}-\d{6}$/),
      ]);
      expect(new Set(first.units.map((u) => u.suNumber)).size).toBe(2);
      expect(first.bulkGroups).toHaveLength(1);
      const groupId = first.bulkGroups![0]!.bulkGroupId;
      expect(first.units.map((u) => u.bulkGroupId)).toEqual([groupId, groupId]);

      const { rows } = await h.db.pool.query(
        `SELECT r.quantity, su.unit_type, su.holder_kind, su.id_prefix,
                (SELECT count(*)::int FROM storage_unit_hole_summary s WHERE s.storage_unit_id = su.id)
                  AS summaries
         FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id
         WHERE su.id = ANY($1::uuid[]) ORDER BY su.readable_id`,
        [first.units.map((u) => u.storageUnitId)],
      );
      expect(rows).toEqual([
        {
          quantity: 2,
          unit_type: 'bulk_container',
          holder_kind: 'bucket',
          id_prefix: 'BKT',
          summaries: 0,
        },
        {
          quantity: 2,
          unit_type: 'bulk_container',
          holder_kind: 'bucket',
          id_prefix: 'BKT',
          summaries: 0,
        },
      ]);
      // No CT ID and no group letter anywhere.
      const counters = await h.db.pool.query(
        "SELECT 1 FROM storage_unit_annual_counter WHERE prefix = 'CT'",
      );
      expect(counters.rows).toEqual([]);

      const unit = await detail(first.units[1]!.storageUnitId);
      expect(unit.sample).toEqual({
        source: { type: 'test_hole', testHoleId: th21, testHoleName: 'TH26-21' },
        sampleReference: 'B1',
        depthFrom: 1.5,
        depthTo: 2,
        depthUnit: 'm',
      });
      expect(unit.bulkGroup).toMatchObject({
        groupId,
        memberNumber: 2,
        memberCount: 2,
        description: 'Clayey sand',
      });
      expect(unit.bulkGroup!.members.map((m) => m.readableId)).toEqual(
        first.units.map((u) => u.suNumber),
      );
    });

    it('AC5/T5: a retry with the same key returns the original group and IDs, creating nothing', async () => {
      // Same payload, same key: replay.
      const body = receipt(
        [
          { clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'k' } },
          { clientRowId: 'b', unitType: 'bucket', bulkGroup: { newGroupKey: 'k' } },
        ],
        { bulkGroups: [{ key: 'k', ...B1_TH21(), sampleReference: 'B9' }] },
      );
      const original = await confirmed(body);
      const before = await h.snapshot();
      const groups = await h.db.pool.query('SELECT count(*)::int AS n FROM bulk_group');
      const retry = await confirm(body);
      expect(retry.status).toBe(200);
      expect(retry.body).toEqual(original);
      expect(await h.snapshot()).toEqual(before);
      expect((await h.db.pool.query('SELECT count(*)::int AS n FROM bulk_group')).rows).toEqual(
        groups.rows,
      );
    });

    it('AC2: a later receipt joins the group explicitly; membership becomes three, own BKT ID and date', async () => {
      const groupId = first.bulkGroups![0]!.bulkGroupId;
      const group = (
        await get<BulkGroupSummary[]>(`/api/projects/${h.projectId}/bulk-groups`)
      ).find((g) => g.id === groupId)!;
      expect(group).toMatchObject({ memberCount: 2, version: 1 });
      const later = await confirmed(
        receipt(
          [
            {
              clientRowId: 'c',
              unitType: 'bucket',
              bulkGroup: { existingId: groupId, version: 1 },
            },
          ],
          { receivedDate: '2026-02-01' },
        ),
      );
      const third = await detail(later.units[0]!.storageUnitId);
      expect(third.readableId).toMatch(/^BKT-/);
      expect(third.receivedDate).toBe('2026-02-01');
      expect(third.location.name).toBe('Receiving lab');
      expect(third.bulkGroup).toMatchObject({ groupId, memberNumber: 3, memberCount: 3 });
      expect(third.sample?.sampleReference).toBe('B1');
      // The first bucket's numbering is computed again: still 1 of now 3.
      expect((await detail(first.units[0]!.storageUnitId)).bulkGroup).toMatchObject({
        memberNumber: 1,
        memberCount: 3,
      });
    });

    it('AC3/T3/T14: another project never offers or accepts the group; equal B1s stay separate', async () => {
      const groupId = first.bulkGroups![0]!.bulkGroupId;
      const offered = await get<BulkGroupSummary[]>(`/api/projects/${otherProject}/bulk-groups`);
      expect(offered.map((g) => g.id)).not.toContain(groupId);

      const before = await h.snapshot();
      const crossJoin = await confirm(
        receipt(
          [
            {
              clientRowId: 'x',
              unitType: 'bucket',
              bulkGroup: { existingId: groupId, version: 1 },
            },
          ],
          { projectId: otherProject },
        ),
      );
      expect(crossJoin.status).toBe(422);
      expect(crossJoin.body.errors).toEqual([
        expect.objectContaining({
          field: 'units.0.bulkGroup.existingId',
          code: 'bulk_group_not_in_project',
        }),
      ]);
      expect(await h.snapshot()).toEqual(before);

      // B1 from a standalone location and B1 from TH26-21 at another depth: new groups, not merged.
      const standalone = await confirmed(
        receipt(
          [
            { clientRowId: 's', unitType: 'bucket', bulkGroup: { newGroupKey: 's' } },
            { clientRowId: 'd', unitType: 'bucket', bulkGroup: { newGroupKey: 'd' } },
          ],
          {
            bulkGroups: [
              {
                key: 's',
                sourceType: 'standalone_location',
                sourceLocationReference: 'Embankment Location 03',
                sampleReference: 'B1',
                depthFrom: 0.5,
                depthUnit: 'm',
              },
              { key: 'd', ...B1_TH21(), depthFrom: 3, depthTo: 3.5 },
            ],
          },
        ),
      );
      const ids = new Set([groupId, ...standalone.bulkGroups!.map((g) => g.bulkGroupId)]);
      expect(ids.size).toBe(3);
      const b1Groups = (
        await get<BulkGroupSummary[]>(`/api/projects/${h.projectId}/bulk-groups`)
      ).filter((g) => g.identity.sampleReference === 'B1');
      expect(b1Groups.length).toBeGreaterThanOrEqual(3);
    });

    it('AC4/AC7/T8: Shelby tubes from a hole and a standalone location get ST IDs; no placeholder hole', async () => {
      const holesBefore = await h.db.pool.query('SELECT count(*)::int AS n FROM test_hole');
      const result = await confirmed(
        receipt([
          {
            clientRowId: 't1',
            unitType: 'shelby_tube',
            sample: { sourceType: 'test_hole', testHoleId: th21, sampleReference: 'T5' },
          },
          {
            clientRowId: 't2',
            unitType: 'shelby_tube',
            note: 'Ends waxed',
            sample: {
              sourceType: 'standalone_location',
              sourceLocationReference: 'Embankment Location 03',
              sampleReference: 'T1',
              depthFrom: 10,
              depthTo: 12,
              depthUnit: 'ft',
            },
          },
        ]),
      );
      expect(result.units.map((u) => u.suNumber)).toEqual([
        expect.stringMatching(/^ST-\d{4}-\d{6}$/),
        expect.stringMatching(/^ST-\d{4}-\d{6}$/),
      ]);
      expect((await h.db.pool.query('SELECT count(*)::int AS n FROM test_hole')).rows).toEqual(
        holesBefore.rows,
      );
      const [hole, standalone] = await Promise.all(
        result.units.map((u) => detail(u.storageUnitId)),
      );
      expect(hole!.sample).toEqual({
        source: { type: 'test_hole', testHoleId: th21, testHoleName: 'TH26-21' },
        sampleReference: 'T5',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
      });
      expect(standalone!.sample?.source).toEqual({
        type: 'standalone_location',
        locationReference: 'Embankment Location 03',
      });
      expect(standalone!.bulkGroup).toBeNull();
      expect(standalone!.holes).toEqual([]);

      // Search by each origin, as displayed.
      expect(await search('Embankment Location 03')).toContain(result.units[1]!.suNumber);
      expect(await search('Embankment Location 03: T1 at 10–12 ft')).toEqual([
        result.units[1]!.suNumber,
      ]);
      expect(await search('TH26-21: T5')).toEqual([result.units[0]!.suNumber]);

      // AC13: the label preview's origin line carries the source only, never T1/depth.
      const preview = await get<{ svg: string }>(
        `/api/storage-units/${result.units[1]!.storageUnitId}/label/preview`,
      );
      expect(preview.svg).toContain('Embankment Location 03');
      expect(preview.svg).not.toContain('T1');
      expect(preview.svg).not.toContain('10–12');
    });

    it('T9/AC8: cross-project hole, blank standalone text and conflicting source fields are refused', async () => {
      const before = await h.snapshot();
      const cross = await confirm(
        receipt([
          {
            clientRowId: 't',
            unitType: 'shelby_tube',
            sample: { sourceType: 'test_hole', testHoleId: otherHole },
          },
        ]),
      );
      expect(cross.status).toBe(422);
      expect(cross.body.errors).toEqual([
        expect.objectContaining({
          field: 'units.0.sample.testHoleId',
          code: 'test_hole_not_in_project',
        }),
      ]);
      const crossGroup = await confirm(
        receipt([{ clientRowId: 'g', unitType: 'bucket', bulkGroup: { newGroupKey: 'g' } }], {
          bulkGroups: [{ key: 'g', ...B1_TH21(), testHoleId: otherHole }],
        }),
      );
      expect(crossGroup.status).toBe(422);
      expect(crossGroup.body.errors[0]).toMatchObject({ field: 'bulkGroups.0.testHoleId' });

      const blank = await confirm(
        receipt([
          {
            clientRowId: 't',
            unitType: 'shelby_tube',
            sample: { sourceType: 'standalone_location', sourceLocationReference: '   ' },
          },
        ]),
      );
      expect(blank.status).toBe(400);
      expect(blank.body.errors).toEqual([
        expect.objectContaining({
          field: 'units.0.sample.sourceLocationReference',
          code: 'required',
        }),
      ]);
      const conflicting = await confirm(
        receipt([
          {
            clientRowId: 't',
            unitType: 'shelby_tube',
            sample: {
              sourceType: 'test_hole',
              testHoleId: th21,
              sourceLocationReference: 'Embankment Location 03',
            },
          },
        ]),
      );
      expect(conflicting.status).toBe(400);
      expect(conflicting.body.errors[0]).toMatchObject({ code: 'conflicting_source' });
      expect(await h.snapshot()).toEqual(before);
    });

    it('T1/T4/AC12: missing identity, reversed interval, summaries on a bulk bucket, Shelby in a group', async () => {
      const before = await h.snapshot();
      const expectFields = async (body: ConfirmReceiptRequestInput, fields: string[]) => {
        const response = await confirm(body);
        expect(response.status).toBe(400);
        expect(
          response.body.errors.map((e: { field: string; code: string }) => `${e.field}:${e.code}`),
        ).toEqual(fields);
      };
      await expectFields(
        receipt([{ clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'n' } }], {
          bulkGroups: [{ key: 'n', sourceType: 'test_hole', testHoleId: th21 } as never],
        }),
        [
          'bulkGroups.0.sampleReference:required',
          'bulkGroups.0.depthFrom:required',
          'bulkGroups.0.depthUnit:required',
        ],
      );
      await expectFields(
        receipt([{ clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'n' } }], {
          bulkGroups: [{ key: 'n', ...B1_TH21(), depthFrom: 2, depthTo: 1 }],
        }),
        ['bulkGroups.0.depthTo:depth_range_reversed'],
      );
      await expectFields(
        receipt(
          [
            {
              clientRowId: 'a',
              unitType: 'bucket',
              bulkGroup: { newGroupKey: 'n' },
              holeSummaries: [{ testHoleId: h.holes.th01, type: 'all' }],
            },
          ],
          { bulkGroups: [{ key: 'n', ...B1_TH21() }] },
        ),
        ['units.0.holeSummaries:not_allowed'],
      );
      await expectFields(
        receipt([
          {
            clientRowId: 'a',
            unitType: 'shelby_tube',
            sample: { sourceType: 'test_hole', testHoleId: th21 },
            bulkGroup: { newGroupKey: 'n' },
          },
        ]),
        ['units.0.bulkGroup:not_allowed', 'units.0.bulkGroup.newGroupKey:unknown_bulk_group'],
      );
      expect(await h.snapshot()).toEqual(before);

      // A non-B reference is valid: B is a convention, not a compulsory prefix.
      const nonB = await confirmed(
        receipt([{ clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'n' } }], {
          bulkGroups: [{ key: 'n', ...B1_TH21(), sampleReference: 'Bag 7', depthTo: null }],
        }),
      );
      expect((await detail(nonB.units[0]!.storageUnitId)).sample).toMatchObject({
        sampleReference: 'Bag 7',
        depthTo: null,
      });
    });

    it('a join at a stale identity version is refused (no silent combining)', async () => {
      const groupId = first.bulkGroups![0]!.bulkGroupId;
      const response = await confirm(
        receipt([
          { clientRowId: 'a', unitType: 'bucket', bulkGroup: { existingId: groupId, version: 99 } },
        ]),
      );
      expect(response.status).toBe(422);
      expect(response.body.errors[0]).toMatchObject({ code: 'bulk_group_changed' });
    });

    it('T3: concurrent receipts joining one group all land in it, numbered without gaps', async () => {
      const created = await confirmed(
        receipt([{ clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'c' } }], {
          bulkGroups: [{ key: 'c', ...B1_TH21(), sampleReference: 'B5' }],
        }),
      );
      const groupId = created.bulkGroups![0]!.bulkGroupId;
      const joins = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          confirm(
            receipt([
              {
                clientRowId: `j${i}`,
                unitType: 'bucket',
                bulkGroup: { existingId: groupId, version: 1 },
              },
            ]),
          ),
        ),
      );
      expect(joins.map((r) => r.status)).toEqual(Array(6).fill(201));
      const unit = await detail(created.units[0]!.storageUnitId);
      expect(unit.bulkGroup!.memberCount).toBe(7);
      expect(unit.bulkGroup!.members).toHaveLength(7);
      const groupCount = await h.db.pool.query(
        "SELECT count(*)::int AS n FROM bulk_group WHERE sample_reference = 'B5'",
      );
      expect(groupCount.rows[0]!.n).toBe(1);
    });
  });

  describe('inventory, search and labels', () => {
    let units: ConfirmReceiptResponse['units'];
    let groupId: string;

    beforeAll(async () => {
      const result = await confirmed(
        receipt(
          [
            { clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'q' } },
            {
              clientRowId: 'b',
              unitType: 'bucket',
              holeSummaries: [
                {
                  testHoleId: h.holes.th01,
                  type: 'sample_range',
                  sampleFrom: 'G1',
                  sampleTo: 'S10',
                },
              ],
            },
          ],
          {
            receivedDate: '2026-03-03',
            bulkGroups: [
              {
                key: 'q',
                sourceType: 'test_hole',
                testHoleId: h.holes.th02,
                sampleReference: 'B3',
                depthFrom: 4,
                depthTo: 5.5,
                depthUnit: 'ft',
                description: 'Quarry fill',
              },
            ],
          },
        ),
      );
      units = result.units;
      groupId = result.bulkGroups![0]!.bulkGroupId;
    });

    it('search matches the bulk identity as displayed, with any dash, and old forms still work', async () => {
      const [bulk, ordinary] = units.map((u) => u.suNumber);
      expect(await search('TH26-02: B3 at 4–5.5 ft')).toEqual([bulk]);
      expect(await search('TH26-02: B3 at 4-5.5 ft')).toEqual([bulk]);
      expect(await search('B3 4−5.5')).toEqual([bulk]);
      expect(await search('bulk soil sample quarry')).toEqual([bulk]);
      // MM-T59 hole-summary forms for an ordinary bucket.
      expect(await search('TH26-01: G1–S10')).toContain(ordinary);
      expect(await search('G1 S10')).toContain(ordinary);
    });

    it('inventory rows carry the identity and bucket n of N; the hole filter finds bulk and tubes', async () => {
      const page = await get<InventoryPage>(`/api/inventory?testHoleId=${h.holes.th02}&status=all`);
      const row = page.items.find((i) => i.readableId === units[0]!.suNumber)!;
      expect(row.unitType).toBe('bulk_container');
      expect(row.sample).toMatchObject({ sampleReference: 'B3', depthUnit: 'ft' });
      expect(row.bulkGroup).toEqual({ groupId, memberNumber: 1, memberCount: 1 });
      const tubes = await get<InventoryPage>(`/api/inventory?testHoleId=${th21}&type=shelby_tube`);
      expect(tubes.items.length).toBeGreaterThan(0);
      expect(tubes.items.every((i) => i.sample?.source.type === 'test_hole')).toBe(true);
    });

    it('T15/AC13: the bulk bucket sticker prints its BKT ID and source only', async () => {
      const preview = await get<{ svg: string; readableId: string }>(
        `/api/storage-units/${units[0]!.storageUnitId}/label/preview`,
      );
      expect(preview.readableId).toBe(units[0]!.suNumber);
      expect(preview.svg).toContain(units[0]!.suNumber);
      expect(preview.svg).toContain('TH26-02');
      for (const forbidden of ['B3', '5.5', 'Quarry', 'bucket 1', groupId]) {
        expect(preview.svg).not.toContain(forbidden);
      }
    });

    it('a renamed source hole refreshes the search documents of its bulk buckets', async () => {
      await h.db.pool.query("UPDATE test_hole SET name = 'TH26-02A' WHERE id = $1", [h.holes.th02]);
      expect(await search('TH26-02A: B3')).toEqual([units[0]!.suNumber]);
      await h.db.pool.query("UPDATE test_hole SET name = 'TH26-02' WHERE id = $1", [h.holes.th02]);
    });
  });

  describe('corrections (personal accounts only, with a reason)', () => {
    let a: ConfirmReceiptResponse;
    let b: ConfirmReceiptResponse;

    beforeAll(async () => {
      a = await confirmed(
        receipt(
          [
            { clientRowId: '1', unitType: 'bucket', bulkGroup: { newGroupKey: 'x' } },
            { clientRowId: '2', unitType: 'bucket', bulkGroup: { newGroupKey: 'x' } },
          ],
          { bulkGroups: [{ key: 'x', ...B1_TH21(), sampleReference: 'B7' }] },
        ),
      );
      b = await confirmed(
        receipt([{ clientRowId: '1', unitType: 'bucket', bulkGroup: { newGroupKey: 'y' } }], {
          bulkGroups: [{ key: 'y', ...B1_TH21(), sampleReference: 'B8' }],
        }),
      );
    });

    it('AC6: LAB gets 403 for membership and identity corrections; nothing changes', async () => {
      const unit = await detail(a.units[1]!.storageUnitId);
      const before = await h.snapshot();
      const move = await patch(
        `/api/storage-units/${unit.id}/bulk-group`,
        { version: unit.version, reason: 'LAB tries', groupId: b.bulkGroups![0]!.bulkGroupId },
        lab,
      );
      expect(move.status).toBe(403);
      const identity = await patch(
        `/api/bulk-groups/${a.bulkGroups![0]!.bulkGroupId}`,
        { version: 1, reason: 'LAB tries', identity: { ...B1_TH21(), sampleReference: 'B70' } },
        lab,
      );
      expect(identity.status).toBe(403);
      expect(await h.snapshot()).toEqual(before);
    });

    it('moves a bucket into another group with before/after history; both groups renumber', async () => {
      const unit = await detail(a.units[1]!.storageUnitId);
      const target = b.bulkGroups![0]!.bulkGroupId;
      const response = await patch(`/api/storage-units/${unit.id}/bulk-group`, {
        version: unit.version,
        reason: 'Wrong pail chosen at receipt',
        groupId: target,
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const moved = response.body as StorageUnitDetail;
      expect(moved.readableId).toBe(unit.readableId);
      expect(moved.bulkGroup).toMatchObject({ groupId: target, memberCount: 2 });
      expect(moved.sample?.sampleReference).toBe('B8');
      expect((await detail(a.units[0]!.storageUnitId)).bulkGroup).toMatchObject({
        memberNumber: 1,
        memberCount: 1,
      });
      expect(await search('B8')).toContain(unit.readableId);
      expect(await search('B7')).not.toContain(unit.readableId);

      const history = await get<{
        items: { action: string; reason: string | null; before: unknown; after: unknown }[];
      }>(`/api/storage-units/${unit.id}/history`);
      const event = history.items.find((e) => e.action === 'storage_unit.bulk_group_changed')!;
      expect(event.reason).toBe('Wrong pail chosen at receipt');
      expect(event.before).toMatchObject({ bulkGroup: { sampleReference: 'B7', memberCount: 2 } });
      expect(event.after).toMatchObject({ bulkGroup: { sampleReference: 'B8', memberCount: 2 } });

      // A stale version is a conflict.
      const stale = await patch(`/api/storage-units/${unit.id}/bulk-group`, {
        version: unit.version,
        reason: 'again',
        groupId: a.bulkGroups![0]!.bulkGroupId,
      });
      expect(stale.status).toBe(409);
    });

    it('refuses null, cross-project targets and non-bulk units (422)', async () => {
      const unit = await detail(a.units[0]!.storageUnitId);
      const nullGroup = await patch(`/api/storage-units/${unit.id}/bulk-group`, {
        version: unit.version,
        reason: 'leave the group',
        groupId: null,
      });
      expect(nullGroup.status).toBe(422);
      expect(nullGroup.body.code).toBe('bulk_identity_required');

      const other = await insertTestHole(h.db.pool, otherProject, 'TH26-30');
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO bulk_group (project_id, source_type, test_hole_id, sample_reference,
                                 depth_from, depth_unit, created_by_user_id)
         VALUES ($1, 'test_hole', $2, 'B1', 1, 'm', $3) RETURNING id`,
        [otherProject, other, h.users.at],
      );
      const cross = await patch(`/api/storage-units/${unit.id}/bulk-group`, {
        version: unit.version,
        reason: 'other project',
        groupId: rows[0]!.id,
      });
      expect(cross.status).toBe(422);
      expect(cross.body.code).toBe('bulk_group_not_in_project');

      const ordinary = await confirmed(h.receipt(1));
      const notBulk = await patch(
        `/api/storage-units/${ordinary.units[0]!.storageUnitId}/bulk-group`,
        {
          version: 1,
          reason: 'join a group',
          groupId: a.bulkGroups![0]!.bulkGroupId,
        },
      );
      expect(notBulk.status).toBe(422);
      expect(notBulk.body.code).toBe('not_bulk_bucket');
    });

    it('corrects a group identity for every member; old identity kept in history; search refreshed', async () => {
      const groupId = b.bulkGroups![0]!.bulkGroupId;
      const members = (await detail(b.units[0]!.storageUnitId)).bulkGroup!.members;
      const response = await patch(`/api/bulk-groups/${groupId}`, {
        version: 1,
        reason: 'Field sheet says B18',
        identity: {
          sourceType: 'standalone_location',
          sourceLocationReference: 'Stockpile 4',
          sampleReference: 'B18',
          depthFrom: 0.3,
          depthUnit: 'm',
        },
      });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      expect(response.body).toMatchObject({ version: 2, memberCount: members.length });
      for (const member of members) {
        const unit = await detail(member.id);
        expect(unit.sample).toMatchObject({
          source: { type: 'standalone_location', locationReference: 'Stockpile 4' },
          sampleReference: 'B18',
        });
        expect(await search('Stockpile 4: B18 at 0.3 m')).toContain(unit.readableId);
        const history = await get<{ items: { action: string; before: unknown }[] }>(
          `/api/storage-units/${member.id}/history`,
        );
        expect(
          history.items.find((e) => e.action === 'bulk_group.corrected')?.before,
        ).toMatchObject({ sampleReference: 'B8' });
      }
      // A join still naming version 1 is now refused.
      const join = await confirm(
        receipt([
          { clientRowId: 'a', unitType: 'bucket', bulkGroup: { existingId: groupId, version: 1 } },
        ]),
      );
      expect(join.status).toBe(422);

      const crossHole = await patch(`/api/bulk-groups/${groupId}`, {
        version: 2,
        reason: 'wrong project hole',
        identity: { ...B1_TH21(), testHoleId: otherHole },
      });
      expect(crossHole.status).toBe(422);
    });

    it('the ordinary correction refuses type, project and hole changes for tubes and bulk buckets', async () => {
      const unit = await detail(a.units[0]!.storageUnitId);
      const response = await patch(`/api/storage-units/${unit.id}`, {
        version: unit.version,
        reason: 'try to add holes',
        changes: { holeSummaries: [{ testHoleId: h.holes.th01, type: 'all' }] },
      });
      expect(response.status).toBe(422);
      expect(response.body.code).toBe('not_correctable_for_contents');
      const note = await patch(`/api/storage-units/${unit.id}`, {
        version: unit.version,
        reason: 'note only',
        changes: { note: 'Lid split' },
      });
      expect(note.status).toBe(200);
    });
  });

  it('a failure mid-confirmation rolls back the new group with everything else', async () => {
    // Force the second unit's insert to fail after the group is created (duplicate receipt_line).
    await h.db.pool.query(`
      CREATE FUNCTION fail_second_bulk_unit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.receipt_line = 2 AND NEW.bulk_group_id IS NOT NULL THEN
          RAISE EXCEPTION 'injected failure';
        END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER fail_second_bulk_unit BEFORE INSERT ON storage_unit
        FOR EACH ROW EXECUTE FUNCTION fail_second_bulk_unit();`);
    try {
      const before = await h.snapshot();
      const groups = (await h.db.pool.query('SELECT count(*)::int AS n FROM bulk_group')).rows;
      const response = await confirm(
        receipt(
          [
            { clientRowId: 'a', unitType: 'bucket', bulkGroup: { newGroupKey: 'r' } },
            { clientRowId: 'b', unitType: 'bucket', bulkGroup: { newGroupKey: 'r' } },
          ],
          { bulkGroups: [{ key: 'r', ...B1_TH21(), sampleReference: 'B99' }] },
        ),
      );
      expect(response.status).toBe(500);
      expect(await h.snapshot()).toEqual(before);
      expect((await h.db.pool.query('SELECT count(*)::int AS n FROM bulk_group')).rows).toEqual(
        groups,
      );
    } finally {
      await h.db.pool.query(
        'DROP TRIGGER fail_second_bulk_unit ON storage_unit; DROP FUNCTION fail_second_bulk_unit()',
      );
    }
  });
});
