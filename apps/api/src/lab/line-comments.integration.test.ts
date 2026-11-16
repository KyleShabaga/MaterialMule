import { labProgramReviewSchema, labProgramSchema, type LabProgram } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  line,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';

// STRATA-129: an optional comment on each sample line of a lab program. It saves with the draft
// (create and PATCH), freezes at submission, comes with a line an amendment adds, and is never a
// test result. No new route: the existing program routes and their permission checks carry it.
// LAB station saves are attributed to the person the station names (attribution only). Fictional
// data only.
describe.runIf(testDatabaseUrl)('lab line comments (STRATA-129)', () => {
  let h: LabHarness;
  let moisture: string;
  let sieve: string;

  type As = PersonKey | 'lab' | string;

  async function createDraft(as: As, lines: unknown[], extra: Record<string, unknown> = {}) {
    const response = await h.send(
      'post',
      '/api/lab-programs',
      { projectId: h.projects.a, idempotencyKey: newKey(), lines, ...extra },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(201);
    return labProgramSchema.parse(response.body);
  }

  const patch = (program: LabProgram, body: Record<string, unknown>, as: As = 'tech') =>
    h.send('patch', `/api/lab-programs/${program.id}`, { version: program.version, ...body }, as);

  async function submit(program: LabProgram, as: As = 'tech', extra: Record<string, unknown> = {}) {
    const review = labProgramReviewSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}/review`, as)).body,
    );
    const response = await h.send(
      'post',
      `/api/lab-programs/${program.id}/submit`,
      {
        version: program.version,
        idempotencyKey: newKey(),
        coverage: review.lines.map((l) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        })),
        ...extra,
      },
      as,
    );
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return labProgramSchema.parse(response.body);
  }

  const holeLine = (comment?: unknown) =>
    line({ kind: 'test_hole', id: h.holes.a1 }, 'all', [moisture], { comment });

  beforeAll(async () => {
    h = await createLabHarness();
    moisture = (await h.testType('DEMO-MC129', 'Moisture content (fictional)', 'Moisture')).id;
    sieve = (await h.testType('DEMO-SV129', 'Sieve analysis (fictional)', 'Sieve')).id;
    await h.bucket({ hole: h.holes.a1 });
  });

  afterAll(async () => {
    await h?.close();
  });

  it('saves a trimmed comment on create; blank or omitted is none', async () => {
    const draft = await createDraft('tech', [
      holeLine('  Run the hydrometer\non the finer half  '),
      holeLine('   '),
      line({ kind: 'test_hole', id: h.holes.a2 }, 'all', [moisture]),
    ]);
    expect(draft.lines.map((l) => l.comment)).toEqual([
      'Run the hydrometer\non the finer half',
      null,
      null,
    ]);
  });

  it('PATCH changes, keeps and clears a line comment while the program is a draft', async () => {
    const draft = await createDraft('tech', [holeLine('First thought')]);
    const lineId = draft.lines[0]!.id;
    const changed = await patch(draft, {
      lines: [{ ...holeLine('Second thought'), id: lineId }],
    });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    const program = labProgramSchema.parse(changed.body);
    expect(program.lines[0]).toMatchObject({ id: lineId, comment: 'Second thought' });

    // Notes only: the lines (and their comments) stay as they are.
    const notesOnly = labProgramSchema.parse(
      (await patch(program, { notes: 'Program notes (fictional)' })).body,
    );
    expect(notesOnly.lines[0]!.comment).toBe('Second thought');

    const cleared = labProgramSchema.parse(
      (await patch(notesOnly, { lines: [{ ...holeLine(null), id: lineId }] })).body,
    );
    expect(cleared.lines[0]!.comment).toBeNull();
  });

  it('refuses a comment over 2000 characters or with control characters (400)', async () => {
    const draft = await createDraft('tech', [holeLine()]);
    for (const bad of ['x'.repeat(2001), 'bell\u0007', 42]) {
      const response = await patch(draft, {
        lines: [{ ...holeLine(bad), id: draft.lines[0]!.id }],
      });
      expect(response.status, JSON.stringify(bad)).toBe(400);
    }
    const ok = await patch(draft, {
      lines: [{ ...holeLine('x'.repeat(2000)), id: draft.lines[0]!.id }],
    });
    expect(ok.status, JSON.stringify(ok.body)).toBe(200);
  });

  it('a LAB station saves comments attributed to the person it names (attribution only)', async () => {
    const draft = await createDraft('lab', [holeLine('Station note (fictional)')], {
      requestedByUserId: h.users.js,
    });
    expect(draft.lines[0]!.comment).toBe('Station note (fictional)');
    expect(draft.requestedBy.userId).toBe(h.users.js);

    const saved = await patch(
      draft,
      {
        requestedByUserId: h.users.js,
        lines: [{ ...holeLine('Edited at the station'), id: draft.lines[0]!.id }],
      },
      'lab',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect(labProgramSchema.parse(saved.body).lines[0]!.comment).toBe('Edited at the station');

    const { rows } = await h.db.pool.query<{ actor_user_id: string; receiver_user_id: string }>(
      `SELECT actor_user_id, receiver_user_id FROM audit_event
       WHERE entity_id = $1 AND action = 'lab_program.draft_saved'`,
      [draft.id],
    );
    expect(rows).toEqual([{ actor_user_id: h.users.lab, receiver_user_id: h.users.js }]);
  });

  it('refuses direct calls from accounts that may not edit the draft (404)', async () => {
    const draft = await createDraft('tech', [holeLine('Mine (fictional)')]);
    const body = { lines: [{ ...holeLine('Not yours'), id: draft.lines[0]!.id }] };
    for (const as of ['pe', 'lm', 'lab'] as const) {
      const response = await patch(
        draft,
        as === 'lab' ? { ...body, requestedByUserId: h.users.js } : body,
        as,
      );
      expect(response.status, as).toBe(404);
    }
    const unchanged = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${draft.id}`, 'tech')).body,
    );
    expect(unchanged.lines[0]!.comment).toBe('Mine (fictional)');
    // Without a session the request never reaches the handler (CSRF or sign-in refuses it).
    const anonymous = await h.http().patch(`/api/lab-programs/${draft.id}`).send(body);
    expect([401, 403]).toContain(anonymous.status);
  });

  it('freezes at submission and shows on the submitted program', async () => {
    const draft = await createDraft('tech', [holeLine('Frozen with the line')]);
    const program = await submit(draft);
    expect(program.lines[0]!.comment).toBe('Frozen with the line');
    const seen = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}`, 'lm')).body,
    );
    expect(seen.lines[0]!.comment).toBe('Frozen with the line');

    const refused = await patch(program, {
      lines: [{ ...holeLine('Too late'), id: program.lines[0]!.id }],
    });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('not_draft');
  });

  it('a line added by an amendment carries its comment, recorded in the amendment', async () => {
    const program = await submit(await createDraft('tech', [holeLine()]));
    const hole = (
      await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-29') RETURNING id`,
        [h.projects.a],
      )
    ).rows[0]!.id;
    const unit = await h.bucket({ hole });
    const amended = await h.send(
      'post',
      `/api/lab-programs/${program.id}/amend`,
      {
        version: program.version,
        idempotencyKey: newKey(),
        addLines: [
          {
            source: { kind: 'test_hole', id: hole },
            scope: 'all',
            testTypeIds: [sieve],
            reviewedCoverageUnitIds: [unit.id],
            comment: '  Added later (fictional)  ',
          },
        ],
      },
      'tech',
    );
    expect(amended.status, JSON.stringify(amended.body)).toBe(201);
    const after = labProgramSchema.parse(
      (await h.get(`/api/lab-programs/${program.id}`, 'tech')).body,
    );
    expect(after.lines[1]).toMatchObject({
      amendmentId: amended.body.amendmentId,
      comment: 'Added later (fictional)',
    });
    const { rows } = await h.db.pool.query<{ details: { addLines: { comment: string }[] } }>(
      'SELECT details FROM program_amendment WHERE id = $1',
      [amended.body.amendmentId],
    );
    expect(rows[0]!.details.addLines[0]!.comment).toBe('Added later (fictional)');
  });
});
