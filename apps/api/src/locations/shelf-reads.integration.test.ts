import { randomUUID } from 'node:crypto';
import {
  labProgramReviewSchema,
  labProgramSchema,
  locationActivitySchema,
  storageUnitLabProgramsSchema,
  type MoveRequest,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// Field Ledger reads for the shelf page and the unit page (lane C): a location's comings and
// goings with arrival times, and a unit's lab program progress. Real PostgreSQL, fictional data.
describe.runIf(testDatabaseUrl)('shelf activity and unit lab progress (Field Ledger)', () => {
  let h: LabHarness;
  const shelves: Record<string, string> = {};

  async function addLocation(code: string, name: string) {
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO location (code, name, kind, area) VALUES ($1, $2, 'warehouse', 'Bay C')
       RETURNING id`,
      [code, name],
    );
    shelves[code] = rows[0]!.id;
  }

  async function move(unitId: string, to: string, baseVersion: number) {
    const body: MoveRequest = {
      clientMoveId: randomUUID(),
      storageUnitId: unitId,
      toLocationId: shelves[to]!,
      baseVersion,
      scannedAt: new Date().toISOString(),
      capturedOffline: false,
      captureContext: { stationId: randomUUID(), accountId: h.users.tech },
    };
    const response = await h.send('post', '/api/moves', body, 'tech');
    expect(response.status, JSON.stringify(response.body)).toBe(201);
  }

  beforeAll(async () => {
    h = await createLabHarness();
    await addLocation('WH-C2', 'Bay C · Shelf 2');
    await addLocation('WH-C3', 'Bay C · Shelf 3');
  });

  afterAll(async () => {
    await h?.close();
  });

  it('lists moves in and out of a shelf, newest first, and when each unit arrived', async () => {
    const stays = await h.bucket({ hole: h.holes.a1 });
    const leaves = await h.bucket({ hole: h.holes.a1 });
    await move(stays.id, 'WH-C2', 1);
    await move(leaves.id, 'WH-C2', 1);
    await move(leaves.id, 'WH-C3', 2);

    const response = await h.get(`/api/locations/${shelves['WH-C2']}/activity`, 'lab');
    expect(response.status).toBe(200);
    const activity = locationActivitySchema.parse(response.body);
    expect(
      activity.movements.map((m) => [m.direction, m.storageUnit.readableId, m.otherLocation.code]),
    ).toEqual([
      ['out', leaves.readableId, 'WH-C3'],
      ['in', leaves.readableId, 'RECEIVING'],
      ['in', stays.readableId, 'RECEIVING'],
    ]);
    expect(activity.movements[0]!.actor).toEqual({ initials: 'AT', name: 'Alex Tester' });
    // Only the unit still saved here has an arrival time.
    expect(activity.arrivals.map((a) => a.storageUnitId)).toEqual([stays.id]);
  });

  it('answers 404 for an unknown location', async () => {
    const response = await h.get(`/api/locations/${randomUUID()}/activity`, 'tech');
    expect(response.status).toBe(404);
  });

  it('counts the tests covering a unit by state, per submitted program', async () => {
    const moisture = (await h.testType('DEMO-MC', 'Moisture content (fictional)')).id;
    const atterberg = (await h.testType('DEMO-ATT', 'Atterberg limits (fictional)')).id;
    const { rows } = await h.db.pool.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-09') RETURNING id`,
      [h.projects.a],
    );
    const hole = rows[0]!.id;
    const unit = await h.bucket({ hole });
    const other = await h.bucket({ hole: h.holes.a2 });

    const created = await h.send(
      'post',
      '/api/lab-programs',
      {
        projectId: h.projects.a,
        idempotencyKey: newKey(),
        lines: [line({ kind: 'test_hole', id: hole }, 'all', [moisture, atterberg])],
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
    const started = await h.send(
      'post',
      `/api/test-requests/${program.lines[0]!.requests[0]!.id}/status`,
      { idempotencyKey: newKey(), to: 'in_progress', version: 1 },
      'tech',
    );
    expect(started.status, JSON.stringify(started.body)).toBe(200);

    const response = await h.get(`/api/storage-units/${unit.readableId}/lab-programs`, 'lab');
    expect(response.status).toBe(200);
    expect(storageUnitLabProgramsSchema.parse(response.body).programs).toEqual([
      {
        id: program.id,
        programNumber: program.programNumber,
        status: 'submitted',
        notStarted: 1,
        inProgress: 1,
        done: 0,
      },
    ]);
    const uncovered = await h.get(`/api/storage-units/${other.id}/lab-programs`, 'tech');
    expect(uncovered.body).toEqual({ programs: [] });
    const unknown = await h.get(`/api/storage-units/BKT-2026-999999/lab-programs`, 'tech');
    expect(unknown.status).toBe(404);
  });
});
