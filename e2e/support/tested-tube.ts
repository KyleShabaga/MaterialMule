import { randomBytes, randomInt } from 'node:crypto';
import { expect, type Page } from '@playwright/test';
import { signInAs } from './auth';
import { withDatabase, type TestUnit } from './db';

// A Shelby tube tested through the real MM-T23/T24 routes (MM-T80): a fictional test type, a new
// hole on DEMO-2601, one tube at Receiving lab, an ALL program submitted by Alex Tester and the
// test started and completed with the tube linked. `removeTestedTube` then confirms the MM-T36
// removal after testing through its real route. Leaves `page` signed in as Alex Tester.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const ALEX = '00000000-0000-4000-8000-000000000102';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };

const unique = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function ok(response: Awaited<ReturnType<Page['request']['post']>>, status: number) {
  expect(response.status(), await response.text()).toBe(status);
  return response.json();
}

export interface TestedTube extends TestUnit {
  testRequestId: string;
}

export async function testedTube(page: Page): Promise<TestedTube> {
  await signInAs(page, 'lab'); // Lab Manager
  const code = unique('DEMO-T80');
  const testType = await ok(
    await page.request.post('/api/test-types', {
      headers: CSRF,
      data: { groupId: SOILS, code, description: `Fictional ${code}`, name: `Test ${code}` },
    }),
    201,
  );

  await signInAs(page, 'at');
  const hole = await ok(
    await page.request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
      headers: CSRF,
      data: { name: unique('TH') },
    }),
    201,
  );
  const tube = await withDatabase(async (client) => {
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                            receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                            request_hash)
       VALUES ($1, CURRENT_DATE, $2, 'AT', 'Alex Tester', $2, 1, gen_random_uuid(), 'e2e')
       RETURNING id`,
      [DEMO_PROJECT_ID, ALEX],
    );
    const readableId = `ST-2025-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date, source_type,
                                 source_test_hole_id, sample_reference)
       SELECT $1, 'ST', 2025, 'shelby_tube', $2, $3, 'shelby_tube', 'shelby_tube', l.id,
              CURRENT_DATE, 'test_hole', $4, 'T5'
       FROM location l WHERE l.code_normalized = 'RECEIVING' RETURNING id`,
      [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID, hole.id],
    );
    return { id: rows[0]!.id, readableId };
  });

  const draft = await ok(
    await page.request.post('/api/lab-programs', {
      headers: CSRF,
      data: {
        projectId: DEMO_PROJECT_ID,
        idempotencyKey: crypto.randomUUID(),
        lines: [
          { source: { kind: 'test_hole', id: hole.id }, scope: 'all', testTypeIds: [testType.id] },
        ],
      },
    }),
    201,
  );
  const review = await (await page.request.get(`/api/lab-programs/${draft.id}/review`)).json();
  const program = await ok(
    await page.request.post(`/api/lab-programs/${draft.id}/submit`, {
      headers: CSRF,
      data: {
        version: draft.version,
        idempotencyKey: crypto.randomUUID(),
        coverage: review.lines.map(
          (l: { lineId: string; coverage: { storageUnitId: string }[] }) => ({
            lineId: l.lineId,
            unitIds: l.coverage.map((c) => c.storageUnitId),
          }),
        ),
      },
    }),
    200,
  );
  const testRequestId = program.lines[0].requests[0].id as string;
  let version = 1;
  for (const step of [
    { to: 'in_progress' },
    { to: 'completed', testedStorageUnitIds: [tube.id] },
  ]) {
    const moved = await ok(
      await page.request.post(`/api/test-requests/${testRequestId}/status`, {
        headers: CSRF,
        data: { ...step, version, idempotencyKey: crypto.randomUUID() },
      }),
      200,
    );
    version = moved.version;
  }
  return { ...tube, testRequestId };
}

/** Alex Tester confirms the tube has physically left the lab (MM-T36), at its current version. */
export async function removeTestedTube(page: Page, tube: TestedTube): Promise<void> {
  await signInAs(page, 'at');
  const detail = await (await page.request.get(`/api/storage-units/${tube.id}`)).json();
  await ok(
    await page.request.post(`/api/storage-units/${tube.id}/tested-removal`, {
      headers: CSRF,
      data: {
        testRequestId: tube.testRequestId,
        confirmPhysicalRemoval: true,
        version: detail.version,
        idempotencyKey: crypto.randomUUID(),
      },
    }),
    201,
  );
}
