import { labProgramReviewSchema, labProgramSchema, type LabProgram } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { issuanceYear } from '../numbering/storage-unit-id.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// BUG-008: when the year's program numbers (LP-YYYY-0001 to LP-YYYY-9999) are used up, submitting
// gives a clear 409, the draft stays a draft and no number is used. Fictional data: DEMO-2601.
describe.runIf(testDatabaseUrl)('program numbers used up (BUG-008)', () => {
  let h: LabHarness;
  let moisture: string;
  let year: number;

  async function draft(): Promise<LabProgram> {
    await h.bucket({ hole: h.holes.a1 });
    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture])],
      },
      'tech',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    return labProgramSchema.parse(created.body);
  }

  async function submit(program: LabProgram) {
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}/review`, 'tech')).body,
    );
    return h.send(
      'post',
      `/api/lab-programs/${program.id}/submit`,
      {
        version: program.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
      },
      'tech',
    );
  }

  const counter = async () => {
    const { rows } = await h.db.pool.query<{ last_value: number }>(
      'SELECT last_value FROM lab_program_counter WHERE year = $1',
      [year],
    );
    return rows[0]?.last_value;
  };

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)', 'Moisture Content')).id;
    year = issuanceYear(new Date(), 'America/Edmonton');
    await h.db.pool.query('INSERT INTO lab_program_counter (year, last_value) VALUES ($1, 9998)', [
      year,
    ]);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('gives out LP-YYYY-9999, then refuses the next submission and leaves the draft as it was', async () => {
    const last = await submit(await draft());
    expect(last.status, JSON.stringify(last.body)).toBe(200);
    expect(labProgramSchema.parse(last.body).programNumber).toBe(`LP-${year}-9999`);

    const next = await draft();
    const refused = await submit(next);
    expect(refused.status).toBe(409);
    expect(refused.body).toMatchObject({
      code: 'program_numbers_exhausted',
      year,
      message: expect.stringContaining(`No program numbers are left for ${year}`),
    });
    expect(await counter()).toBe(9999);
    const still = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${next.id}`, 'tech')).body,
    );
    expect(still).toMatchObject({ status: 'draft', programNumber: null, version: next.version });
    const { rows } = await h.db.pool.query(
      'SELECT count(*)::int AS n FROM test_request WHERE program_id = $1',
      [next.id],
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});
