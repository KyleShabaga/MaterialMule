import {
  labProgramListSchema,
  labProgramReviewSchema,
  labProgramSchema,
  type LabProgramList,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-47 (server sort, search and paging for the lab programs list) and STRATA-58 (stage on
// each row). Fictional data only: projects DEMO-2601 (a) and DEMO-2602 (b).
describe.runIf(testDatabaseUrl)('lab program list sort, paging and stage (STRATA-47, 58)', () => {
  let h: LabHarness;
  const submittedIds: string[] = [];

  async function draft(project: 'a' | 'b', lines: unknown[] = []) {
    const response = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects[project], idempotencyKey: newKey(), lines },
      'tech',
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return labProgramSchema.parse(response.body);
  }

  async function list(query: string): Promise<LabProgramList> {
    const response = await h.get(`/api/lab-programs${query}`, 'tech');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramListSchema.parse(response.body);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    const moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional demo entry)')).id;
    await h.bucket({ hole: h.holes.a1 });
    // Two submitted programs (numbered), then five drafts: three in project a, two in b.
    for (let i = 0; i < 2; i += 1) {
      const program = await draft('a', [
        line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture]),
      ]);
      const review = labProgramReviewSchema.parse(
        (await h.get(`/api/lab-programs/${program.id}/review`, 'tech')).body,
      );
      const submitted = await h.send(
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
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      submittedIds.push(program.id);
    }
    for (const project of ['a', 'a', 'a', 'b', 'b'] as const) await draft(project);
  });

  afterAll(async () => {
    await h?.close();
  });

  it('sends each row its stage from the program status', async () => {
    const all = await list('?pageSize=100');
    expect(all.total).toBe(7);
    for (const item of all.items) {
      expect(item.stage).toBe(item.status === 'draft' ? 'draft' : 'lab');
    }
  });

  it('pages every sort without overlap or gaps, and the total ignores the page size', async () => {
    for (const sort of ['recent', 'number', 'project', 'submitted']) {
      for (const dir of ['asc', 'desc']) {
        const whole = await list(`?sort=${sort}&dir=${dir}&pageSize=100`);
        const paged: string[] = [];
        for (let page = 1; page <= 4; page += 1) {
          const part = await list(`?sort=${sort}&dir=${dir}&pageSize=2&page=${page}`);
          expect(part.total).toBe(whole.total);
          paged.push(...part.items.map((item) => item.id));
        }
        expect(paged, `${sort} ${dir}`).toEqual(whole.items.map((item) => item.id));
        expect(new Set(paged).size).toBe(7);
      }
    }
  });

  it('breaks ties on equal keys by program ID', async () => {
    // Drafts share a null program number; project a holds five programs.
    const byProject = await list('?sort=project&dir=asc&pageSize=100');
    const projectA = byProject.items.filter((item) => item.project.projectNumber === 'DEMO-2601');
    expect(byProject.items.slice(0, 5)).toEqual(projectA);
    const drafts = projectA.filter((item) => item.status === 'draft').map((item) => item.id);
    expect(drafts).toEqual([...drafts].sort());

    const byNumber = await list('?sort=number&dir=asc&pageSize=100');
    expect(byNumber.items.slice(0, 2).map((item) => item.status)).toEqual([
      'submitted',
      'submitted',
    ]);
    expect(byNumber.items[0]!.programNumber! < byNumber.items[1]!.programNumber!).toBe(true);
    const nullNumbers = byNumber.items.slice(2).map((item) => item.id);
    expect(nullNumbers).toEqual([...nullNumbers].sort());
  });

  it('finds matches beyond page one and counts them all', async () => {
    const first = await list('?search=DEMO-2602&pageSize=1');
    expect(first.total).toBe(2);
    expect(first.items).toHaveLength(1);
    const second = await list('?search=DEMO-2602&pageSize=1&page=2');
    expect(second.total).toBe(2);
    expect(second.items[0]!.project.projectNumber).toBe('DEMO-2602');
    expect(second.items[0]!.id).not.toBe(first.items[0]!.id);
  });

  it('refuses sort, direction and paging values outside the allowlist (400) and changes nothing', async () => {
    const before = await list('?pageSize=100');
    for (const query of [
      '?sort=lp.id;DROP%20TABLE%20lab_program',
      '?sort=program_number',
      '?dir=sideways',
      '?dir=asc;--',
      '?pageSize=101',
      '?pageSize=0',
      '?page=-1',
      '?status=everything',
      '?projectId=not-a-uuid',
    ]) {
      const response = await h.get(`/api/lab-programs${query}`, 'tech');
      expect(response.status, query).toBe(400);
    }
    expect(await list('?pageSize=100')).toEqual(before);
  });
});
