import {
  labProgramReviewSchema,
  labProgramSchema,
  sampleTagSheetSchema,
  testTypeSchema,
  type LabProgram,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// MM-T69 printable sample ID tags: catalogue tag settings and the read-only tag sheet. Real
// PostgreSQL. Fictional data only: DEMO-2601 (A), test holes TH26-01 / TH26-02.
describe.runIf(testDatabaseUrl)('sample ID tags (MM-T69)', () => {
  let h: LabHarness;
  let moisture: string;
  let atterberg: string;
  let hydrometer: string;
  let sieve: string;

  async function tagType(code: string, sampleTagMode: string, sampleTagGroup?: string) {
    const response = await h.send(
      'post',
      '/api/test-types',
      {
        groupId: '00000000-0000-4000-8000-00000000c101',
        code,
        description: `${code} (fictional)`,
        sampleTagMode,
        sampleTagGroup,
      },
      'lm',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return testTypeSchema.parse(response.body);
  }

  async function draft(lines: unknown[], as: 'tech' | 'pe' = 'tech') {
    const created = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines },
      as,
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return labProgramSchema.parse(created.body);
  }

  async function submit(lines: unknown[]): Promise<LabProgram> {
    const created = await draft(lines);
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${created.id}/review`, 'tech')).body,
    );
    const submitted = await h.send(
      'post',
      `/api/lab-programs/${created.id}/submit`,
      {
        version: created.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
    expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
    return labProgramSchema.parse(submitted.body);
  }

  const specific = (holeId: string, testTypeIds: string[], extra: Record<string, unknown> = {}) =>
    line({ kind: 'test_hole', id: holeId }, 'specific', testTypeIds, {
      sampleLabel: 'G13',
      depthMode: 'point',
      depthFrom: 10,
      depthUnit: 'm',
      ...extra,
    });

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await tagType('DEMO-MC69', 'none')).id;
    atterberg = (await tagType('DEMO-ATT69', 'own')).id;
    hydrometer = (await tagType('DEMO-HYD69', 'shared', 'Grain size')).id;
    sieve = (await tagType('DEMO-SV69', 'shared', 'Grain size')).id;
  });

  afterAll(async () => {
    await h?.close();
  });

  it('stores and audits the catalogue tag setting; a shared tag needs a group', async () => {
    const created = await tagType('DEMO-X69', 'shared', 'Grain size');
    expect(created).toMatchObject({ sampleTagMode: 'shared', sampleTagGroup: 'Grain size' });
    const noGroup = await h.send(
      'post',
      '/api/test-types',
      {
        groupId: '00000000-0000-4000-8000-00000000c101',
        code: 'DEMO-Y69',
        description: 'Y (fictional)',
        sampleTagMode: 'shared',
      },
      'lm',
    );
    expect(noGroup.status).toBe(400);

    const changed = await h.send(
      'patch',
      `/api/test-types/${created.id}`,
      { version: created.version, sampleTagMode: 'none' },
      'lm',
    );
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body).toMatchObject({ sampleTagMode: 'none', sampleTagGroup: null });

    const { rows } = await h.db.pool.query<{ before: unknown; after: unknown }>(
      `SELECT before_values AS before, after_values AS after FROM audit_event
       WHERE entity_id = $1 AND action = 'test_type.updated'`,
      [created.id],
    );
    expect(rows[0]).toMatchObject({
      before: { sampleTagMode: 'shared', sampleTagGroup: 'Grain size' },
      after: { sampleTagMode: 'none', sampleTagGroup: null },
    });

    // The database refuses the shape too.
    await expect(
      h.db.pool.query(
        `UPDATE test_type SET sample_tag_mode = 'shared', sample_tag_group = NULL WHERE id = $1`,
        [created.id],
      ),
    ).rejects.toThrow(/sample_tag_shape/);
  });

  it('refuses a draft and hides someone else’s draft', async () => {
    const mine = await draft([specific(h.holes.a1, [atterberg])]);
    const own = await h.get(`/api/lab-programs/${mine.id}/sample-tags`, 'tech');
    expect(own.status).toBe(409);
    expect(own.body.code).toBe('program_not_submitted');
    const other = await h.get(`/api/lab-programs/${mine.id}/sample-tags`, 'pe');
    expect(other.status).toBe(404);
  });

  it('groups by the catalogue setting and changes nothing when read', async () => {
    const program = await submit([
      specific(h.holes.a1, [moisture, atterberg, hydrometer, sieve]),
      // Same label in another hole: never combined.
      specific(h.holes.a2, [hydrometer]),
      line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [atterberg]),
    ]);
    const before = await h.db.pool.query(
      `SELECT p.version AS program_version, r.id, r.status, r.version
       FROM lab_program p JOIN test_request r ON r.program_id = p.id
       WHERE p.id = $1 ORDER BY r.id`,
      [program.id],
    );

    const response = await h.get(`/api/lab-programs/${program.id}/sample-tags`, 'tech');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    const sheet = sampleTagSheetSchema.parse(response.body);
    expect(sheet.program).toMatchObject({
      programNumber: program.programNumber,
      project: { projectNumber: 'DEMO-2601' },
    });
    expect(
      sheet.tags.map((tag) => [
        tag.source.label,
        tag.sampleLabel,
        tag.depth,
        tag.tests.map((t) => t.code),
      ]),
    ).toEqual([
      ['TH26-01', 'G13', '10.0 m', ['DEMO-ATT69']],
      ['TH26-01', 'G13', '10.0 m', ['DEMO-HYD69', 'DEMO-SV69']],
      ['TH26-02', 'G13', '10.0 m', ['DEMO-HYD69']],
    ]);
    expect(sheet.noTagTests.map((t) => t.test.code)).toEqual(['DEMO-MC69']);
    expect(sheet.untaggedLines).toEqual([
      expect.objectContaining({ lineNumber: 3, scope: 'all', sourceLabel: 'TH26-01' }),
    ]);

    // The shared LAB station sees the same tags (permissions follow the program workflow).
    const lab = await h.get(`/api/lab-programs/${program.id}/sample-tags`, 'lab');
    expect(lab.status).toBe(200);
    expect(lab.body).toEqual(response.body);

    const after = await h.db.pool.query(
      `SELECT p.version AS program_version, r.id, r.status, r.version
       FROM lab_program p JOIN test_request r ON r.program_id = p.id
       WHERE p.id = $1 ORDER BY r.id`,
      [program.id],
    );
    expect(after.rows).toEqual(before.rows);
  });

  it('follows the current catalogue setting and leaves cancelled requests out', async () => {
    const program = await submit([specific(h.holes.a1, [atterberg, hydrometer])]);
    const [att] = program.lines[0]!.requests;
    const { rowCount } = await h.db.pool.query(
      `UPDATE test_request SET status = 'cancelled', cancel_reason = 'Not needed (fictional)',
              cancelled_at = now(), cancelled_by_user_id = $2,
              cancelled_by_name_snapshot = 'Lee Manager'
       WHERE id = $1`,
      [att!.id, h.users.lm],
    );
    expect(rowCount).toBe(1);
    const sheet = sampleTagSheetSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}/sample-tags`, 'tech')).body,
    );
    expect(sheet.tags.map((tag) => tag.tests.map((t) => t.code))).toEqual([['DEMO-HYD69']]);
  });
});
