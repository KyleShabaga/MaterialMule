import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T24: worklist, per-test progress with actor/time and comments (card T5), two LAB stations
// acting for different people (T6), and exact Shelby tube completion evidence (T11/T12 lab
// side). Each test works on its own random test hole so parallel runs don't share material.
// Fictional data only (DEMO-2601).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
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

/** A program submitted by `request`'s signed-in account on a fresh hole of DEMO-2601. */
async function submitProgram(
  request: APIRequestContext,
  testTypeIds: string[],
  options: { holeId?: string; person?: string } = {},
): Promise<{ id: string; programNumber: string }> {
  let holeId = options.holeId;
  if (!holeId) {
    const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
      headers: CSRF,
      data: { name: unique('TH') },
    });
    expect(hole.status()).toBe(201);
    holeId = (await hole.json()).id as string;
  }
  const person = options.person ? { requestedByUserId: options.person } : {};
  const draft = await request.post('/api/lab-programs', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      idempotencyKey: crypto.randomUUID(),
      lines: [{ source: { kind: 'test_hole', id: holeId }, scope: 'all', testTypeIds }],
      ...person,
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
      ...person,
    },
  });
  expect(submitted.status()).toBe(200);
  return submitted.json();
}

function testRow(page: Page, code: string) {
  return page.locator('.request-list li', { hasText: code });
}

test('T5: a Technician starts and completes a test, comments and edits; actor and time are shown', async ({
  page,
}) => {
  const [a, b] = [unique('DEMO-W1'), unique('DEMO-W2')];
  const ids = [await addTestType(page, a), await addTestType(page, b)];
  await signInAs(page, 'at');
  const program = await submitProgram(page.request, ids);

  await page.goto('/lab-testing');
  await expect(page.getByRole('heading', { name: 'Worklist', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: program.programNumber }).click();
  await expect(page.getByRole('heading', { name: program.programNumber })).toBeVisible();

  await testRow(page, a).getByRole('button', { name: 'Start' }).click();
  await expect(testRow(page, a)).toContainText('In progress');
  await expect(testRow(page, a)).toContainText('Alex Tester');
  await testRow(page, a).getByRole('button', { name: 'Mark completed' }).click();
  await testRow(page, a).getByRole('group').getByRole('button', { name: 'Mark completed' }).click();
  await expect(testRow(page, a)).toContainText('Completed');
  // AC4: the other test keeps its own status; AC5: no jump buttons are offered.
  await expect(testRow(page, b)).toContainText('Requested');
  await expect(testRow(page, b).getByRole('button', { name: 'Mark completed' })).toHaveCount(0);

  const line = page.getByRole('region', { name: /^Line 1/ });
  await line.getByLabel('Comment on this line').fill('Lid cracked');
  await line.getByRole('button', { name: 'Post comment' }).click();
  await expect(line.getByRole('list', { name: 'Line comments' })).toContainText('Lid cracked');
  await line.getByRole('button', { name: 'Edit' }).click();
  await line.getByLabel('Edit comment').fill('Lid cracked, contents fine');
  await line.getByRole('button', { name: 'Save comment' }).click();
  await expect(line.getByRole('list', { name: 'Line comments' })).toContainText('contents fine');
  await expect(line.getByText('Earlier versions (1)')).toBeVisible();
  // AC2: a Technician sees no priority control.
  await expect(page.getByRole('button', { name: 'Mark urgent' })).toHaveCount(0);
  await expect(page.getByLabel(/result/i)).toHaveCount(0);
});

test('T6: two LAB stations act for different people on different tests and comment separately', async ({
  browser,
}) => {
  const setup = await browser.newPage();
  const [x, y] = [unique('DEMO-X'), unique('DEMO-Y')];
  const ids = [await addTestType(setup, x), await addTestType(setup, y)];
  await signInAs(setup, 'at');
  const program = await submitProgram(setup.request, ids);
  await setup.close();

  const stations = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(stations.map((context) => context.newPage()));
  const plan = [
    { code: x, search: 'Jordan', person: /Jordan Smith/ },
    { code: y, search: 'Pat', person: /Pat Example/ },
  ];
  try {
    for (const page of pages) {
      await signInAsLabStation(page);
      await page.goto(`/lab-testing/programs/${program.id}`);
      await expect(page.getByRole('heading', { name: program.programNumber })).toBeVisible();
    }
    for (const [i, page] of pages.entries()) {
      const row = testRow(page, plan[i]!.code);
      await row.getByRole('button', { name: 'Start' }).click();
      const panel = row.getByRole('group', { name: /Start/ });
      await panel.getByRole('combobox', { name: /Who is doing this/ }).fill(plan[i]!.search);
      await page.getByRole('option', { name: plan[i]!.person }).click();
      await panel.getByRole('button', { name: 'Start' }).click();
      await expect(row).toContainText('In progress');
      await expect(row).toContainText('LAB for');
      await expect(row).toContainText(plan[i]!.person);
    }
    // Each station sees the other's shared, persisted progress after a reload.
    await pages[0]!.reload();
    await expect(testRow(pages[0]!, y)).toContainText(/LAB for .*Pat Example/);

    const box = pages[1]!.locator('.program-comments');
    await box.getByLabel('Comment on the program').fill('Second station note');
    await box.getByRole('combobox', { name: /Who is doing this/ }).fill('Pat');
    await pages[1]!.getByRole('option', { name: /Pat Example/ }).click();
    await box.getByRole('button', { name: 'Post comment' }).click();
    await expect(box.getByRole('list', { name: 'Program comments' })).toContainText(
      /LAB for .*Pat Example/,
    );
  } finally {
    await Promise.all(stations.map((context) => context.close()));
  }
});

test('T11/T12 (lab side): completion records the exact Shelby tube used; the other tube and both locations are unchanged', async ({
  page,
}) => {
  const code = unique('DEMO-ST');
  const id = await addTestType(page, code);
  await signInAs(page, 'at');
  const hole = await page.request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
  });
  const holeId = (await hole.json()).id as string;
  const tubes = await withDatabase(async (client) => {
    const made: string[] = [];
    for (const reference of ['T5', 'T6']) {
      const receipt = await client.query<{ id: string }>(
        `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                              receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                              request_hash)
         VALUES ($1, '2025-11-03', '00000000-0000-4000-8000-000000000102', 'AT', 'Alex Tester',
                 '00000000-0000-4000-8000-000000000102', 1, gen_random_uuid(), 'e2e')
         RETURNING id`,
        [DEMO_PROJECT_ID],
      );
      const readableId = `ST-2025-${String(randomInt(1, 999_999)).padStart(6, '0')}`;
      await client.query(
        `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                   receipt_id, project_id, unit_type, holder_kind,
                                   current_location_id, received_date, source_type,
                                   source_test_hole_id, sample_reference)
         SELECT $1, 'ST', 2025, 'shelby_tube', $2, $3, 'shelby_tube', 'shelby_tube', l.id,
                '2025-11-03', 'test_hole', $4, $5
         FROM location l WHERE l.code_normalized = 'RECEIVING'`,
        [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID, holeId, reference],
      );
      made.push(readableId);
    }
    return made;
  });
  const program = await submitProgram(page.request, [id], { holeId });

  await signInAsLabStation(page);
  await page.goto(`/lab-testing/programs/${program.id}`);
  const row = testRow(page, code);
  await row.getByRole('button', { name: 'Start' }).click();
  await row.getByRole('combobox', { name: /Who is doing this/ }).fill('Jordan');
  await page.getByRole('option', { name: /Jordan Smith/ }).click();
  await row.getByRole('group').getByRole('button', { name: 'Start' }).click();
  await expect(row).toContainText('In progress');

  await row.getByRole('button', { name: 'Mark completed' }).click();
  const panel = row.getByRole('group', { name: /Mark completed/ });
  await expect(panel.getByText('Units actually used (required)')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Mark completed' })).toBeDisabled();
  await panel.getByRole('combobox', { name: /Who is doing this/ }).fill('Jordan');
  await page.getByRole('option', { name: /Jordan Smith/ }).click();
  await panel.getByRole('checkbox', { name: new RegExp(tubes[0]!) }).check();
  await panel.getByRole('button', { name: 'Mark completed' }).click();
  await expect(row).toContainText('Completed');
  await expect(row).toContainText(`Used: ${tubes[0]}`);
  await expect(row).not.toContainText(tubes[1]!);

  // Completion alone removes nothing: both tubes are still in stock at Receiving lab.
  const units = await withDatabase(
    async (client) =>
      (
        await client.query<{ readable_id: string; status: string; code: string }>(
          `SELECT su.readable_id, su.status, l.code FROM storage_unit su
         JOIN location l ON l.id = su.current_location_id
         WHERE su.readable_id = ANY ($1::text[]) ORDER BY su.readable_id`,
          [tubes],
        )
      ).rows,
  );
  expect(units.map((unit) => [unit.status, unit.code])).toEqual([
    ['in_stock', 'RECEIVING'],
    ['in_stock', 'RECEIVING'],
  ]);
  // No removal action is offered from the lab screens (MM-T36 owns it; LAB can never confirm).
  await expect(page.getByRole('button', { name: /remov|dispos/i })).toHaveCount(0);
});
