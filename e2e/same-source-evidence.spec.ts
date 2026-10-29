import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T73 T3 (owner decision 2026-10-28, option B): a Specific line submitted without choosing
// its Shelby tube. LAB completes the test for a person, picks the tube from the same source in
// the completion panel (keyboard only) and confirms it; the tube then shows the program in
// "Tested in", LAB can't remove it, and a personal account confirms its removal. Runs at desktop
// and phone width (playwright projects). Fictional data only (DEMO-2601, random hole names).

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

/** One Shelby tube (sample T5) sourced from `holeId`, at Receiving lab. */
async function insertTube(holeId: string) {
  return withDatabase(async (client) => {
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
      [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID, holeId],
    );
    return { id: rows[0]!.id, readableId };
  });
}

/** "hole / Specific / T5 at 10–12 ft / test" with no unit chosen, submitted. */
async function submitSpecific(request: APIRequestContext, testTypeId: string, holeId: string) {
  const draft = await request.post('/api/lab-programs', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      idempotencyKey: crypto.randomUUID(),
      lines: [
        {
          source: { kind: 'test_hole', id: holeId },
          scope: 'specific',
          testTypeIds: [testTypeId],
          sampleLabel: 'T5',
          depthMode: 'interval',
          depthFrom: 10,
          depthTo: 12,
          depthUnit: 'ft',
        },
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

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

test('T3: Specific line tube outside coverage — LAB records it with a same-source confirmation; a personal account removes it', async ({
  page,
}) => {
  const code = unique('DEMO-UCS');
  const testTypeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const holeId = await newHole(page.request);
  const tube = await insertTube(holeId);
  const program = await submitSpecific(page.request, testTypeId, holeId);
  const requestId = program.lines[0]!.requests[0]!.id;

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

  // Keyboard only: open the same-source picker, tick the tube, then confirm.
  const reveal = panel.getByRole('button', { name: /Used a unit from this source/ });
  await reveal.focus();
  await page.keyboard.press('Enter');
  const picker = panel.getByRole('group', { name: /Other units from/ });
  const tubeBox = picker.getByRole('checkbox', { name: new RegExp(`^${tube.readableId}`) });
  await tubeBox.focus();
  await page.keyboard.press('Space');
  await expect(tubeBox).toBeChecked();
  const complete = panel.getByRole('button', { name: 'Mark completed' });
  // Not until the confirmation is ticked.
  await expect(complete).toBeDisabled();
  const confirm = picker.getByRole('checkbox', { name: /I confirm .* used in this test/ });
  await confirm.focus();
  await page.keyboard.press('Space');
  await expect(complete).toBeEnabled();
  await noHorizontalScroll(page);
  await complete.focus();
  await page.keyboard.press('Enter');

  await expect(row).toContainText('Completed');
  await expect(row.getByRole('link', { name: tube.readableId })).toBeVisible();
  await expect(row).toContainText(
    /outside this line’s coverage: same source confirmed by .*Jordan Smith/,
  );

  // LAB sees the tested tube but can't remove it; the API refuses outright.
  const labAttempt = await page.request.post(`/api/storage-units/${tube.id}/tested-removal`, {
    headers: CSRF,
    data: {
      testRequestId: requestId,
      confirmPhysicalRemoval: true,
      version: 1,
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(labAttempt.status()).toBe(403);

  // A personal account sees it Used by the program and confirms the physical removal.
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${tube.readableId}`);
  const section = page.getByRole('region', { name: 'Testing and removal' });
  const evidence = section.getByRole('list', { name: 'Completed tests that used this unit' });
  await expect(evidence).toContainText(program.programNumber);
  await expect(evidence).toContainText('same source confirmed by');
  await noHorizontalScroll(page);
  await section.getByRole('checkbox', { name: /has physically left the lab/ }).check();
  await section.getByRole('button', { name: 'Confirm removal after testing' }).click();
  await expect(page.locator('.unit-meta')).toContainText('Disposed after testing');

  // Removal never changes the test.
  await page.goto(`/lab-testing/programs/${program.id}`);
  await expect(page.locator('.request-list li', { hasText: code })).toContainText('Completed');
});
