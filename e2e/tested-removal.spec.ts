import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T36 removal after testing through the real MM-T24 route (T24 AC14 / T12, T36 AC9–AC11):
// LAB completes a test with the exact tube or bucket linked, LAB can't confirm removal, and a
// personal account then confirms it. Each test uses its own random hole and units so parallel
// runs don't share material. Fictional data only (DEMO-2601).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const ALEX = '00000000-0000-4000-8000-000000000102';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };

const unique = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function addTestType(page: Page, code: string) {
  await signInAs(page, 'lab'); // Lab Manager
  const response = await page.request.post('/api/test-types', {
    headers: CSRF,
    data: { groupId: SOILS, code, description: `Fictional ${code}`, name: `Test ${code}` },
  });
  expect(response.status()).toBe(201);
  return (await response.json()).id as string;
}

async function newHole(request: APIRequestContext) {
  const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
  });
  expect(hole.status()).toBe(201);
  return (await hole.json()).id as string;
}

/** Units on `holeId` at Receiving lab: Shelby tubes, or buckets of one new bulk sample. */
async function insertUnits(holeId: string, kind: 'tube' | 'bulk', count: number) {
  return withDatabase(async (client) => {
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                            receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                            request_hash)
       VALUES ($1, CURRENT_DATE, $2, 'AT', 'Alex Tester', $2, $3, gen_random_uuid(), 'e2e')
       RETURNING id`,
      [DEMO_PROJECT_ID, ALEX, count],
    );
    let groupId: string | null = null;
    if (kind === 'bulk') {
      const group = await client.query<{ id: string }>(
        `INSERT INTO bulk_group (project_id, source_type, test_hole_id, sample_reference,
                                 depth_from, depth_to, depth_unit, created_by_user_id)
         VALUES ($1, 'test_hole', $2, 'B1', 1.5, 2.0, 'm', $3) RETURNING id`,
        [DEMO_PROJECT_ID, holeId, ALEX],
      );
      groupId = group.rows[0]!.id;
    }
    const made: { id: string; readableId: string }[] = [];
    for (let i = 0; i < count; i += 1) {
      const prefix = kind === 'tube' ? 'ST' : 'BKT';
      const readableId = `${prefix}-2025-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
      const { rows } = await client.query<{ id: string }>(
        kind === 'tube'
          ? `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                       receipt_id, project_id, unit_type, holder_kind,
                                       current_location_id, received_date, source_type,
                                       source_test_hole_id, sample_reference)
             SELECT $1, 'ST', 2025, 'shelby_tube', $2, $3, 'shelby_tube', 'shelby_tube', l.id,
                    CURRENT_DATE, 'test_hole', $4, 'T' || $5
             FROM location l WHERE l.code_normalized = 'RECEIVING' RETURNING id`
          : `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                       receipt_id, project_id, unit_type, holder_kind,
                                       current_location_id, received_date, bulk_group_id)
             SELECT $1, 'BKT', 2025, 'bucket', $2, $3, 'bulk_container', 'bucket', l.id,
                    CURRENT_DATE, $4
             FROM location l WHERE l.code_normalized = 'RECEIVING' RETURNING id`,
        kind === 'tube'
          ? [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID, holeId, String(i + 5)]
          : [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID, groupId],
      );
      made.push({ id: rows[0]!.id, readableId });
    }
    return made;
  });
}

/** An ALL program on `holeId`, submitted by `request`'s signed-in account. */
async function submitProgram(request: APIRequestContext, testTypeId: string, holeId: string) {
  const draft = await request.post('/api/lab-programs', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      idempotencyKey: crypto.randomUUID(),
      lines: [
        { source: { kind: 'test_hole', id: holeId }, scope: 'all', testTypeIds: [testTypeId] },
      ],
    },
  });
  expect(draft.status()).toBe(201);
  const created = await draft.json();
  const review = await (await request.get(`/api/lab-programs/${created.id}/review`)).json();
  const submitted = await request.post(`/api/lab-programs/${created.id}/submit`, {
    headers: CSRF,
    data: {
      version: created.version,
      idempotencyKey: crypto.randomUUID(),
      coverage: review.lines.map(
        (l: { lineId: string; coverage: { storageUnitId: string }[] }) => ({
          lineId: l.lineId,
          unitIds: l.coverage.map((c) => c.storageUnitId),
        }),
      ),
    },
  });
  expect(submitted.status()).toBe(200);
  return (await submitted.json()) as {
    id: string;
    programNumber: string;
    lines: { requests: { id: string }[] }[];
  };
}

async function unitState(readableIds: string[]) {
  return withDatabase(
    async (client) =>
      (
        await client.query<{ readable_id: string; status: string; code: string }>(
          `SELECT su.readable_id, su.status, l.code FROM storage_unit su
           JOIN location l ON l.id = su.current_location_id
           WHERE su.readable_id = ANY ($1::text[]) ORDER BY su.readable_id`,
          [readableIds],
        )
      ).rows,
  );
}

test('T12: LAB completes ST-A for a person; LAB can’t remove it; a personal account confirms removal and ST-B stays in stock', async ({
  page,
}) => {
  const code = unique('DEMO-UCS');
  const testTypeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const holeId = await newHole(page.request);
  const [tubeA, tubeB] = await insertUnits(holeId, 'tube', 2);
  const program = await submitProgram(page.request, testTypeId, holeId);

  // LAB station: Start and Mark completed for Jordan Smith, linking only ST-A.
  await signInAsLabStation(page);
  await page.goto(`/lab-testing/programs/${program.id}`);
  const row = page.locator('.request-list li', { hasText: code });
  await row.getByRole('button', { name: 'Start' }).click();
  await row.getByRole('combobox', { name: /Who is doing this/ }).fill('Jordan');
  await page.getByRole('option', { name: /Jordan Smith/ }).click();
  await row.getByRole('group').getByRole('button', { name: 'Start' }).click();
  await expect(row).toContainText('In progress');
  await row.getByRole('button', { name: 'Mark completed' }).click();
  const panel = row.getByRole('group', { name: /Mark completed/ });
  await panel.getByRole('combobox', { name: /Who is doing this/ }).fill('Jordan');
  await page.getByRole('option', { name: /Jordan Smith/ }).click();
  await panel.getByRole('checkbox', { name: new RegExp(tubeA!.readableId) }).check();
  await panel.getByRole('button', { name: 'Mark completed' }).click();
  await expect(row).toContainText('Completed');

  // Testing alone: both tubes still in stock at Receiving lab.
  expect((await unitState([tubeA!.readableId, tubeB!.readableId])).map((u) => u.status)).toEqual([
    'in_stock',
    'in_stock',
  ]);

  // LAB sees the tested tube but no removal action, and the API refuses it outright.
  await row.getByRole('link', { name: tubeA!.readableId }).click();
  const section = page.getByRole('region', { name: 'Testing and removal' });
  await expect(section).toContainText('Can’t be tested again');
  await expect(section.getByRole('button', { name: /Confirm removal/ })).toHaveCount(0);
  const labAttempt = await page.request.post(`/api/storage-units/${tubeA!.id}/tested-removal`, {
    headers: CSRF,
    data: {
      testRequestId: program.lines[0]!.requests[0]!.id,
      confirmPhysicalRemoval: true,
      version: 1,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(labAttempt.status()).toBe(403);

  // MM-T71 T3/AC3: a hold on the tested tube is never shown as a removal blocker. The Lab
  // Manager places a unit hold; Sample Storage and the Disposal page show only the exception.
  await signInAs(page, 'lab');
  const hold = await page.request.post('/api/retention/holds', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      scope: 'units',
      unitIds: [tubeA!.id],
      reason: 'E2E tested tube hold',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(hold.status()).toBe(201);
  await page.goto(`/sample-storage?search=${tubeA!.readableId}`);
  const storageRow = page.getByRole('row', { name: new RegExp(tubeA!.readableId) });
  await expect(storageRow).toContainText('Not applicable');
  await expect(storageRow).not.toContainText('On hold');
  await page.goto(`/disposal-retention?projectId=${DEMO_PROJECT_ID}`);
  await expect(page.getByText(/current units, by storage unit ID/)).toBeVisible();
  const tested = page.getByRole('region', { name: 'Tested: removed after testing' });
  for (
    let next = 2;
    (await tested.getByRole('link', { name: tubeA!.readableId }).count()) === 0;
    next += 1
  ) {
    expect(next, 'tested tube not found on any Disposal page').toBeLessThan(50);
    await page
      .getByRole('navigation', { name: 'Pages' })
      .getByRole('button', { name: 'Next' })
      .click();
    await expect(page.getByText(new RegExp(`Page ${next} of`))).toBeVisible();
  }
  const testedItem = tested.getByRole('listitem').filter({ hasText: tubeA!.readableId });
  await expect(testedItem).toContainText('Retention: Not applicable');
  await expect(testedItem).not.toContainText(/On hold|Retain until/);
  await expect(page.getByRole('region', { name: 'Not eligible' })).not.toContainText(
    tubeA!.readableId,
  );

  // A personal account confirms the physical removal (the hold doesn't block it).
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${tubeA!.readableId}`);
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    'Not applicable — tested Shelby tube',
  );
  await section.getByRole('checkbox', { name: /has physically left the lab/ }).check();
  await section.getByRole('button', { name: 'Confirm removal after testing' }).click();
  await expect(page.getByText(/recorded as disposed after testing/)).toBeVisible();
  await expect(page.locator('.unit-meta')).toContainText('Disposed after testing');
  await expect(section).toContainText('last location Receiving lab');
  await expect(page.getByRole('region', { name: 'History', exact: true })).toContainText(
    'Disposed after testing',
  );

  // ST-B is untouched; ST-A keeps its last location and leaves Current stock.
  expect(await unitState([tubeA!.readableId, tubeB!.readableId])).toEqual(
    [
      { readable_id: tubeA!.readableId, status: 'disposed', code: 'RECEIVING' },
      { readable_id: tubeB!.readableId, status: 'in_stock', code: 'RECEIVING' },
    ].sort((x, y) => x.readable_id.localeCompare(y.readable_id)),
  );
  await page.goto(`/sample-storage/${tubeB!.readableId}`);
  await expect(page.getByRole('region', { name: 'Testing and removal' })).toContainText(
    'Available for testing',
  );
  await page.goto(`/sample-storage?search=${tubeA!.readableId}`);
  await expect(page.getByText(/No storage units match/)).toBeVisible();
  await page.goto(`/sample-storage?search=${tubeA!.readableId}&status=disposed`);
  await expect(page.getByRole('row', { name: new RegExp(tubeA!.readableId) })).toContainText(
    'Disposed after testing',
  );

  // The test itself is unchanged: removal is not review or acceptance.
  await page.goto(`/lab-testing/programs/${program.id}`);
  await expect(page.locator('.request-list li', { hasText: code })).toContainText('Completed');
});

test('tested bulk bucket: removal of BKT-A without approval or closure; BKT-B stays in stock', async ({
  page,
}) => {
  const code = unique('DEMO-PRO');
  const testTypeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const holeId = await newHole(page.request);
  const [bucketA, bucketB] = await insertUnits(holeId, 'bulk', 2);
  const program = await submitProgram(page.request, testTypeId, holeId);
  const requestId = program.lines[0]!.requests[0]!.id;
  for (const [to, version, extra] of [
    ['in_progress', 1, {}],
    ['completed', 2, { testedStorageUnitIds: [bucketA!.id] }],
  ] as const) {
    const moved = await page.request.post(`/api/test-requests/${requestId}/status`, {
      headers: CSRF,
      data: { to, version, idempotencyKey: crypto.randomUUID(), ...extra },
    });
    expect(moved.status()).toBe(200);
  }

  await page.goto(`/sample-storage/${bucketA!.readableId}`);
  const section = page.getByRole('region', { name: 'Testing and removal' });
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    'Not applicable — tested bulk sample',
  );
  await section.getByRole('checkbox', { name: /has physically left the lab/ }).check();
  await section.getByRole('button', { name: 'Confirm removal after testing' }).click();
  await expect(page.locator('.unit-meta')).toContainText('Disposed after testing');

  expect(
    (await unitState([bucketA!.readableId, bucketB!.readableId])).map((u) => [
      u.readable_id,
      u.status,
    ]),
  ).toEqual(
    [
      [bucketA!.readableId, 'disposed'],
      [bucketB!.readableId, 'in_stock'],
    ].sort((x, y) => x[0]!.localeCompare(y[0]!)),
  );
  await page.goto(`/sample-storage/${bucketB!.readableId}`);
  await expect(page.locator('.unit-meta')).toContainText('In stock');
  await expect(page.getByRole('region', { name: 'Testing and removal' })).toContainText(
    'No completed test has recorded this exact unit',
  );
});
