import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T83: adding a testing line to a submitted program from the program page (AC1, AC3, test
// plan T2). Each test makes its own program on a fresh test hole, so parallel runs never share
// one. Fictional data only: DEMO-2601, Lead Project Engineer Pat Example (pe), Lab Manager
// "Lab (test)" (lab), Technician Alex Tester (at), the shared LAB station.

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

/** A program with one ALL line on a new test hole, submitted by the signed-in account. */
async function submittedProgram(request: APIRequestContext, testTypeId: string) {
  const holeName = unique('TH');
  const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: holeName },
  });
  expect(hole.status()).toBe(201);
  const holeId = (await hole.json()).id as string;
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
  const program = await submitted.json();
  return {
    programId: program.id as string,
    programNumber: program.programNumber as string,
    version: program.version as number,
    holeId,
    holeName,
  };
}

test('AC1/T2: a Lead Project Engineer adds a Grabs line with explicit units after a preview; the worklist shows the new test', async ({
  page,
}) => {
  const [first, added] = [unique('DEMO-AM'), unique('DEMO-AL')];
  const firstId = await addTestType(page, first);
  await addTestType(page, added);
  await signInAs(page, 'at');
  const program = await submittedProgram(page.request, firstId);
  const ticked = await insertConfirmedBucket(program.holeId);
  const unticked = await insertConfirmedBucket(program.holeId);

  await signInAs(page, 'pe');
  await page.goto(`/lab-testing/programs/${program.programId}`);
  await expect(page.getByRole('heading', { name: program.programNumber })).toBeVisible();
  await page.getByRole('button', { name: 'Amend program' }).click();
  await page.getByRole('button', { name: 'Add a testing line' }).click();

  const line = page.getByRole('region', { name: 'New line 2' });
  const source = line.getByLabel('Sampling source');
  const option = source.locator('option', { hasText: program.holeName });
  await source.selectOption((await option.getAttribute('value'))!);
  await line.getByLabel('All grabs (G)').check();
  await line.getByRole('checkbox', { name: new RegExp(ticked.readableId) }).check();
  await expect(
    line.getByRole('checkbox', { name: new RegExp(unticked.readableId) }),
  ).not.toBeChecked();
  await line.getByLabel('Find a test').fill(added);
  await line.getByRole('button', { name: new RegExp(added) }).click();

  // The preview is the server's coverage: nothing is saved until it is confirmed.
  await page.getByRole('button', { name: 'Preview line' }).click();
  const preview = page.getByRole('region', { name: 'Preview of new line 2' });
  await expect(preview).toContainText(`Covers ${ticked.readableId} received so far.`);
  await expect(preview).toContainText(
    `1 unit with unknown G/S classification excluded (${unticked.readableId})`,
  );
  await expect(page.getByRole('region', { name: /^Line 2/ })).toHaveCount(0);
  await page.getByRole('button', { name: 'Add line 2' }).click();

  const saved = page.getByRole('region', { name: /^Line 2/ });
  await expect(saved).toContainText(added);
  await expect(saved).toContainText('Requested');
  await expect(page.getByText('Amendments (1)')).toBeVisible();

  await page.goto('/lab-testing');
  await expect(page.getByRole('heading', { name: 'Worklist', level: 2 })).toBeVisible();
  await page.getByLabel('Test', { exact: true }).selectOption({ label: added });
  await expect(page.getByRole('link', { name: program.programNumber })).toBeVisible();
});

test('AC3: the LAB station gets no amend control and the server refuses it', async ({ page }) => {
  const code = unique('DEMO-AX');
  const typeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const program = await submittedProgram(page.request, typeId);

  await signInAsLabStation(page);
  await page.goto(`/lab-testing/programs/${program.programId}`);
  await expect(page.getByRole('heading', { name: program.programNumber })).toBeVisible();
  await expect(page.locator('.request-list li', { hasText: code })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Amend program' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Add a testing line' })).toHaveCount(0);

  const refused = await page.request.post(`/api/lab-programs/${program.programId}/amend`, {
    headers: CSRF,
    data: {
      version: program.version,
      idempotencyKey: crypto.randomUUID(),
      addLines: [
        {
          source: { kind: 'test_hole', id: program.holeId },
          scope: 'all',
          testTypeIds: [typeId],
          reviewedCoverageUnitIds: [],
        },
      ],
    },
  });
  expect(refused.status()).toBe(403);
});
