import {
  describeStorageUnitCorrection,
  inventoryPageSchema,
  labelPreviewSchema,
  labProgramReviewSchema,
  labProgramSchema,
  storageUnitDetailSchema,
  storageUnitHistoryPageSchema,
  type LabProgram,
  type StorageUnitDetail,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../../test-support/database.js';
import {
  createLabHarness,
  line,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../../test-support/lab-harness.js';

// MM-T82: a Shelby tube's source correction and a bulk soil bucket made an ordinary bucket,
// both through PATCH /api/storage-units/:id. Owner decision 2026-10-30: refused once the unit has
// any test-request link, or is removed or disposed. Real PostgreSQL, fictional data only
// (DEMO-2601 / DEMO-2602, TH26-xx holes).
describe.runIf(testDatabaseUrl)(
  'tube source and bulk → ordinary bucket corrections (MM-T82)',
  () => {
    let h: LabHarness;
    let moisture: string;
    type As = PersonKey | 'lab';

    async function newHole(name: string, project: 'a' | 'b' = 'a') {
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
        [h.projects[project], name],
      );
      return rows[0]!.id;
    }

    async function detail(id: string, as: As = 'tech'): Promise<StorageUnitDetail> {
      const response = await h.get(`/api/storage-units/${id}`, as);
      expect(response.status).toBe(200);
      return storageUnitDetailSchema.parse(response.body);
    }

    const correct = (id: string, body: Record<string, unknown>, as: As = 'tech') =>
      h.send('patch', `/api/storage-units/${id}`, body, as);

    async function corrections(id: string) {
      const page = storageUnitHistoryPageSchema.parse(
        (await h.get(`/api/storage-units/${id}/history`, 'tech')).body,
      );
      return page.items.filter((event) => event.action === 'storage_unit.corrected');
    }

    async function found(text: string): Promise<string[]> {
      const response = await h.get(
        `/api/inventory?search=${encodeURIComponent(text)}&pageSize=100`,
        'tech',
      );
      expect(response.status).toBe(200);
      return inventoryPageSchema.parse(response.body).items.map((item) => item.readableId);
    }

    /** A submitted ALL program on `holeId`, then one request completed linking exactly `units`. */
    async function testedOn(holeId: string, units: string[]): Promise<LabProgram> {
      const created = await h.send(
        'post',
        '/api/lab-programs',
        {
          projectId: h.projects.a,
          idempotencyKey: newKey(),
          lines: [line({ kind: 'test_hole', id: holeId }, 'all', [moisture])],
        },
        'tech',
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      const review = labProgramReviewSchema.parse(
        (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
      );
      const submitted = await h.send(
        'post',
        `/api/lab-programs/${created.body.id}/submit`,
        {
          version: created.body.version,
          idempotencyKey: newKey(),
          coverage: review.lines.map((l) => ({
            lineId: l.lineId,
            unitIds: l.coverage.map((c) => c.storageUnitId),
          })),
        },
        'tech',
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      const program = labProgramSchema.parse(submitted.body);
      const requestId = program.lines[0]!.requests[0]!.id;
      const status = (body: Record<string, unknown>, as: As) =>
        h.send(
          'post',
          `/api/test-requests/${requestId}/status`,
          { idempotencyKey: newKey(), ...body },
          as,
        );
      expect((await status({ to: 'in_progress', version: 1 }, 'tech')).status).toBe(200);
      const done = await status(
        { to: 'completed', version: 2, testedStorageUnitIds: units, actingStaffUserId: h.users.js },
        'lab',
      );
      expect(done.status, JSON.stringify(done.body)).toBe(200);
      return program;
    }

    beforeAll(async () => {
      h = await createLabHarness();
      moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content'))
        .id;
    });

    afterAll(async () => {
      await h?.close();
    });

    it('AC1 (T1): a Technician corrects a tube’s source with a reason; history, search and sticker follow; the ID stays', async () => {
      const from = await newHole('TH26-81');
      const to = await newHole('TH26-82');
      const tube = await h.tube({ holeId: from, sampleReference: 'T5' });
      const before = await detail(tube.id);
      expect(await found('TH26-81: T5')).toContain(tube.readableId);

      // A reason is required; LAB can't correct at all.
      const sample = {
        sourceType: 'test_hole',
        testHoleId: to,
        sampleReference: 'T6',
        depthFrom: 1.5,
        depthTo: 2,
        depthUnit: 'm',
      };
      const noReason = await correct(tube.id, { version: before.version, changes: { sample } });
      expect(noReason.status).toBe(400);
      const lab = await correct(
        tube.id,
        { version: before.version, reason: 'Tag misread', changes: { sample } },
        'lab',
      );
      expect(lab.status).toBe(403);
      // The source hole must be in the tube's project.
      const otherProject = await correct(tube.id, {
        version: before.version,
        reason: 'Tag misread',
        changes: { sample: { ...sample, testHoleId: h.holes.b1 } },
      });
      expect(otherProject.status).toBe(422);
      expect(otherProject.body.errors[0].field).toBe('changes.sample.testHoleId');
      // Type, project and test holes still aren't corrected alongside a source.
      const mixed = await correct(tube.id, {
        version: before.version,
        reason: 'Tag misread',
        changes: { sample, unitType: 'bucket' },
      });
      expect(mixed.status).toBe(422);
      expect(mixed.body.code).toBe('not_correctable_for_contents');

      const saved = await correct(tube.id, {
        version: before.version,
        reason: 'Tag misread at receiving',
        changes: { sample },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const after = storageUnitDetailSchema.parse(saved.body);
      expect(after.readableId).toBe(tube.readableId);
      expect(after.unitType).toBe('shelby_tube');
      expect(after.version).toBe(before.version + 1);
      expect(after.sample).toEqual({
        source: { type: 'test_hole', testHoleId: to, testHoleName: 'TH26-82' },
        sampleReference: 'T6',
        depthFrom: 1.5,
        depthTo: 2,
        depthUnit: 'm',
      });

      const [event] = await corrections(tube.id);
      expect(event).toMatchObject({
        reason: 'Tag misread at receiving',
        actor: { initials: 'AT' },
      });
      expect(Object.keys(event!.after!)).toEqual(['sample']);
      expect(describeStorageUnitCorrection(event!.before, event!.after)).toEqual([
        'sampling source TH26-81: T5 → TH26-82: T6 at 1.5–2 m',
      ]);

      // Search refreshes in the same transaction; the sticker's origin line names the new hole.
      expect(await found('TH26-82: T6')).toContain(tube.readableId);
      expect(await found('TH26-81: T5')).not.toContain(tube.readableId);
      const preview = labelPreviewSchema.parse(
        (await h.get(`/api/storage-units/${tube.id}/label/preview`, 'tech')).body,
      );
      expect(preview.svg).toContain('TH26-82');
      expect(preview.svg).not.toContain('TH26-81');

      // A standalone sampling location works the same way.
      const standalone = await correct(tube.id, {
        version: after.version,
        reason: 'Was the embankment, not a hole',
        changes: {
          sample: { sourceType: 'standalone_location', sourceLocationReference: 'Embankment 07' },
        },
      });
      expect(standalone.status, JSON.stringify(standalone.body)).toBe(200);
      expect(storageUnitDetailSchema.parse(standalone.body).sample).toEqual({
        source: { type: 'standalone_location', locationReference: 'Embankment 07' },
        sampleReference: null,
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
      });

      // Only a Shelby tube has its own source.
      const bucket = await h.bucket({ hole: from });
      const notTube = await correct(bucket.id, {
        version: 1,
        reason: 'Tag misread',
        changes: { sample },
      });
      expect(notTube.status).toBe(422);
      expect(notTube.body.code).toBe('not_a_shelby_tube');
    });

    it('AC2 (T2): a bulk-group bucket becomes an ordinary bucket; the group summary and n of N update', async () => {
      const hole = await newHole('TH26-83');
      const { groupId, members } = await h.bulkGroup({
        holeId: hole,
        sampleReference: 'B1',
        depthFrom: 1,
        buckets: 2,
      });
      const [first, second] = members as [(typeof members)[0], (typeof members)[0]];
      const before = await detail(first.id);
      expect(before.bulkGroup).toMatchObject({ memberNumber: 1, memberCount: 2 });

      // The test holes it holds are required; the project can't change with it.
      const noHoles = await correct(first.id, {
        version: before.version,
        reason: 'Not part of B1',
        changes: { unitType: 'bucket' },
      });
      expect(noHoles.status).toBe(400);
      expect(noHoles.body.errors[0].field).toBe('changes.holeSummaries');
      const moved = await correct(first.id, {
        version: before.version,
        reason: 'Not part of B1',
        changes: {
          unitType: 'bucket',
          projectId: h.projects.b,
          holeSummaries: [{ testHoleId: h.holes.b1, type: 'all' }],
        },
      });
      expect(moved.status).toBe(422);
      expect(moved.body.code).toBe('not_correctable_for_contents');
      // LAB gets 403.
      const lab = await correct(
        first.id,
        {
          version: before.version,
          reason: 'Not part of B1',
          changes: { unitType: 'bucket', holeSummaries: [{ testHoleId: hole, type: 'all' }] },
        },
        'lab',
      );
      expect(lab.status).toBe(403);

      const saved = await correct(first.id, {
        version: before.version,
        reason: 'Ordinary grab bucket, not part of B1',
        changes: {
          unitType: 'bucket',
          holeSummaries: [
            { testHoleId: hole, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'G4' },
          ],
        },
      });
      expect(saved.status, JSON.stringify(saved.body)).toBe(200);
      const after = storageUnitDetailSchema.parse(saved.body);
      expect(after.readableId).toBe(first.readableId);
      expect(after.unitType).toBe('bucket');
      expect(after.sample).toBeNull();
      expect(after.bulkGroup).toBeNull();
      expect(after.holes).toMatchObject([
        { testHoleId: hole, testHoleName: 'TH26-83', type: 'sample_range', sampleFrom: 'G1' },
      ]);
      const { rows } = await h.db.pool.query(
        'SELECT unit_type, holder_kind, bulk_group_id FROM storage_unit WHERE id = $1',
        [first.id],
      );
      expect(rows[0]).toEqual({ unit_type: 'bucket', holder_kind: 'bucket', bulk_group_id: null });

      // The group's remaining bucket is now 1 of 1, and the project's list counts one bucket.
      const remaining = await detail(second.id);
      expect(remaining.bulkGroup).toMatchObject({ memberNumber: 1, memberCount: 1 });
      expect(remaining.bulkGroup!.members.map((m) => m.id)).toEqual([second.id]);
      const groups = (await h.get(`/api/projects/${h.projects.a}/bulk-groups`, 'tech')).body as {
        id: string;
        memberCount: number;
      }[];
      expect(groups.find((g) => g.id === groupId)?.memberCount).toBe(1);

      const [event] = await corrections(first.id);
      expect(event!.reason).toBe('Ordinary grab bucket, not part of B1');
      expect(describeStorageUnitCorrection(event!.before, event!.after)).toEqual([
        'type Bulk soil sample → Bucket',
        'bulk sample TH26-83: B1 at 1 m (bucket 1 of 2) → none',
        'test holes none → TH26-83: G1–G4',
      ]);
      // Search follows the new contents.
      expect(await found('TH26-83: G1')).toContain(first.readableId);
    });

    it('AC3 (T1/T2): refused once the unit has a test-request link, after a tested removal, and when disposed', async () => {
      const hole = await newHole('TH26-84');
      const tube = await h.tube({ holeId: hole, sampleReference: 'T1' });
      const { members } = await h.bulkGroup({
        holeId: hole,
        sampleReference: 'B2',
        depthFrom: 2,
        buckets: 2,
      });
      const program = await testedOn(hole, [tube.id, members[0]!.id]);

      const sample = { sourceType: 'standalone_location', sourceLocationReference: 'Pit 4' };
      const tubeNow = await detail(tube.id);
      const linked = await correct(tube.id, {
        version: tubeNow.version,
        reason: 'Tag misread',
        changes: { sample },
      });
      expect(linked.status).toBe(422);
      expect(linked.body).toMatchObject({
        code: 'storage_unit_tested',
        errors: [{ field: 'changes.sample', code: 'storage_unit_tested' }],
      });
      // Other corrections still work on a tested unit.
      const noted = await correct(tube.id, {
        version: tubeNow.version,
        reason: 'Label smudged',
        changes: { note: 'Cap taped' },
      });
      expect(noted.status, JSON.stringify(noted.body)).toBe(200);

      const bulkNow = await detail(members[0]!.id);
      const convert = {
        version: bulkNow.version,
        reason: 'Not part of B2',
        changes: { unitType: 'bucket', holeSummaries: [{ testHoleId: hole, type: 'all' }] },
      };
      const linkedBulk = await correct(members[0]!.id, convert);
      expect(linkedBulk.status).toBe(422);
      expect(linkedBulk.body.code).toBe('storage_unit_tested');
      // Its bulk sample can't change either.
      const moveTested = await h.send(
        'patch',
        `/api/storage-units/${members[0]!.id}/bulk-group`,
        {
          version: bulkNow.version,
          reason: 'Belongs to a new sample',
          newGroup: {
            sourceType: 'test_hole',
            testHoleId: hole,
            sampleReference: 'B3',
            depthFrom: 3,
            depthUnit: 'm',
          },
        },
        'tech',
      );
      expect(moveTested.status).toBe(422);
      expect(moveTested.body.code).toBe('storage_unit_tested');
      expect((await detail(members[0]!.id)).bulkGroup).toMatchObject({ memberCount: 2 });

      // Removed after testing: disposed, refused as such.
      const removed = await h.send(
        'post',
        `/api/storage-units/${tube.id}/tested-removal`,
        {
          confirmPhysicalRemoval: true,
          idempotencyKey: newKey(),
          testRequestId: program.lines[0]!.requests[0]!.id,
          version: tubeNow.version + 1,
        },
        'tech',
      );
      expect(removed.status, JSON.stringify(removed.body)).toBe(201);
      const afterRemoval = await correct(tube.id, {
        version: tubeNow.version + 2,
        reason: 'Tag misread',
        changes: { sample },
      });
      expect(afterRemoval.status).toBe(422);
      expect(afterRemoval.body.code).toBe('storage_unit_disposed');

      // Disposed (untested) bucket and tube: refused, and nothing changed.
      const disposedTube = await h.tube({ holeId: hole, sampleReference: 'T9' });
      await h.db.pool.query(
        `UPDATE storage_unit SET status = 'disposed', disposed_at = now() WHERE id = ANY($1)`,
        [[disposedTube.id, members[1]!.id]],
      );
      const disposed = await correct(disposedTube.id, {
        version: 1,
        reason: 'Tag misread',
        changes: { sample },
      });
      expect(disposed.status).toBe(422);
      expect(disposed.body.code).toBe('storage_unit_disposed');
      const disposedBulk = await correct(members[1]!.id, { ...convert, version: 1 });
      expect(disposedBulk.status).toBe(422);
      expect(disposedBulk.body.code).toBe('storage_unit_disposed');
      expect((await detail(disposedTube.id)).sample?.sampleReference).toBe('T9');
      expect((await detail(members[1]!.id)).unitType).toBe('bulk_container');
    });
  },
);
