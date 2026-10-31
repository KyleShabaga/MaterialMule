import { labProgramReviewSchema, labProgramSchema } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T82 (owner decision 2026-10-30): a unit's sampling source and bulk sample are final once it
// is disposed or has any test-request link, whatever writes them (migration 0008). Fictional
// data only: DEMO-2601, TH26-9x.
describe.runIf(testDatabaseUrl)(
  'unit source and bulk sample are final once tested or disposed',
  () => {
    let h: LabHarness;
    let moisture: string;
    let hole: string;
    let otherGroup: string;
    const constraint = 'storage_unit_source_final';

    /** Completes one ALL request on `hole`, linking exactly `units`. */
    async function linkAsTested(units: string[]) {
      const created = await h.send(
        'post',
        '/api/lab-programs',
        {
          projectId: h.projects.a,
          idempotencyKey: newKey(),
          lines: [line({ kind: 'test_hole', id: hole }, 'all', [moisture])],
        },
        'tech',
      );
      const review = labProgramReviewSchema.parse(
        (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
      );
      const submitted = labProgramSchema.parse(
        (
          await h.send(
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
          )
        ).body,
      );
      const requestId = submitted.lines[0]!.requests[0]!.id;
      const status = (body: Record<string, unknown>, as: 'tech' | 'lab') =>
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
    }

    beforeAll(async () => {
      h = await createLabHarness();
      moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)')).id;
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-91') RETURNING id`,
        [h.projects.a],
      );
      hole = rows[0]!.id;
      otherGroup = (
        await h.bulkGroup({ holeId: h.holes.a2, sampleReference: 'B9', depthFrom: 4, buckets: 1 })
      ).groupId;
    });

    afterAll(async () => {
      await h?.close();
    });

    it("refuses changing a tested tube's source or a tested bucket's bulk sample", async () => {
      const tube = await h.tube({ holeId: hole, sampleReference: 'T1' });
      const { members } = await h.bulkGroup({
        holeId: hole,
        sampleReference: 'B1',
        depthFrom: 1,
        buckets: 1,
      });
      await linkAsTested([tube.id, members[0]!.id]);

      for (const sql of [
        `UPDATE storage_unit SET sample_reference = 'T2' WHERE id = $1`,
        `UPDATE storage_unit SET sample_depth_from = 1, sample_depth_unit = 'm' WHERE id = $1`,
        `UPDATE storage_unit SET source_type = 'standalone_location', source_test_hole_id = NULL,
                               source_location_reference = 'Pit 1' WHERE id = $1`,
      ]) {
        await expect(h.db.pool.query(sql, [tube.id])).rejects.toMatchObject({ constraint });
      }
      await expect(
        h.db.pool.query('UPDATE storage_unit SET bulk_group_id = $2 WHERE id = $1', [
          members[0]!.id,
          otherGroup,
        ]),
      ).rejects.toMatchObject({ constraint });
      // Becoming an ordinary bucket leaves the group: refused as well.
      await expect(
        h.db.pool.query(
          `UPDATE storage_unit SET unit_type = 'bucket', bulk_group_id = NULL WHERE id = $1`,
          [members[0]!.id],
        ),
      ).rejects.toMatchObject({ constraint });

      // Rewriting the same values, and other columns, still work.
      await h.db.pool.query(
        `UPDATE storage_unit SET sample_reference = 'T1', note = 'Cap taped' WHERE id = $1`,
        [tube.id],
      );
    });

    it("refuses changing a disposed unit's source or bulk sample", async () => {
      const tube = await h.tube({ holeId: hole, sampleReference: 'T3' });
      const { members } = await h.bulkGroup({
        holeId: hole,
        sampleReference: 'B2',
        depthFrom: 2,
        buckets: 1,
      });
      await h.db.pool.query(
        `UPDATE storage_unit SET status = 'disposed', disposed_at = now() WHERE id = ANY($1)`,
        [[tube.id, members[0]!.id]],
      );
      await expect(
        h.db.pool.query(`UPDATE storage_unit SET sample_reference = 'T4' WHERE id = $1`, [tube.id]),
      ).rejects.toMatchObject({ constraint });
      await expect(
        h.db.pool.query('UPDATE storage_unit SET bulk_group_id = $2 WHERE id = $1', [
          members[0]!.id,
          otherGroup,
        ]),
      ).rejects.toMatchObject({ constraint });
      await h.db.pool.query(`UPDATE storage_unit SET note = 'Lid replaced' WHERE id = $1`, [
        tube.id,
      ]);
    });

    it('lets an untested, in-stock tube and bulk bucket change source and group', async () => {
      const tube = await h.tube({ holeId: hole, sampleReference: 'T5' });
      const { members } = await h.bulkGroup({
        holeId: hole,
        sampleReference: 'B3',
        depthFrom: 3,
        buckets: 1,
      });
      await h.db.pool.query(
        `UPDATE storage_unit SET source_test_hole_id = $2, sample_reference = 'T6' WHERE id = $1`,
        [tube.id, h.holes.a1],
      );
      await h.db.pool.query('UPDATE storage_unit SET bulk_group_id = $2 WHERE id = $1', [
        members[0]!.id,
        otherGroup,
      ]);
      await h.db.pool.query(
        `UPDATE storage_unit SET unit_type = 'bucket', bulk_group_id = NULL WHERE id = $1`,
        [members[0]!.id],
      );
    });
  },
);
