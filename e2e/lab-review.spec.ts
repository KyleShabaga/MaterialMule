import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { signInAsLabStation } from './support/lab-station';

// MM-T25 review corrections and delegated acceptance (card T4 correction route, T5 LAB denial,
// project-page delegation). Each test makes its own program on a fresh test hole, so parallel
// runs never share a test. Fictional data only: DEMO-2601 / DEMO-2602, Lead Project Engineer Pat Example (pe),
// Lab Manager "Lab (test)" (lab), Technician Alex Tester (at), engineer Dana Example (de).

const PROJECTS = {
  'desktop-chromium': '00000000-0000-4000-8000-000000000201',
  'phone-chromium': '00000000-0000-4000-8000-000000000202',
} as const;
const DEMO_PROJECT_ID = PROJECTS['desktop-chromium'];
const DANA = '00000000-0000-4000-8000-000000000105';
const PAT = '00000000-0000-4000-8000-000000000101';
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

/** A program submitted and moved to Review by the signed-in account; returns its one test. */
async function testInReview(request: APIRequestContext, testTypeId: string) {
  const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
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
  const testRequestId = program.lines[0].requests[0].id as string;
  let version = 1;
  for (const to of ['in_progress', 'completed', 'review']) {
    const moved = await request.post(`/api/test-requests/${testRequestId}/status`, {
      headers: CSRF,
      data: { to, version, idempotencyKey: crypto.randomUUID() },
    });
    expect(moved.status()).toBe(200);
    version = (await moved.json()).version;
  }
  return {
    programId: program.id as string,
    programNumber: program.programNumber as string,
    testRequestId,
    version,
  };
}

function testRow(page: Page, code: string) {
  return page.locator('.request-list li', { hasText: code });
}

test('T4: return for correction → correction done → fresh review → accept by the Lead Project Engineer', async ({
  page,
}) => {
  const code = unique('DEMO-RV');
  const typeId = await addTestType(page, code);
  await signInAs(page, 'at');
  const { programId, programNumber } = await testInReview(page.request, typeId);

  // A Technician reviews and returns it with a required comment; it stays in Review.
  await page.goto(`/lab-testing/programs/${programId}`);
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();
  const row = testRow(page, code);
  await expect(row).toContainText('Awaiting review');
  await expect(row.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await expect(row).toContainText('You don’t have acceptance authority for this project');
  await row.getByRole('button', { name: 'Return for correction' }).click();
  const returnButton = row.getByRole('form').getByRole('button', { name: 'Return for correction' });
  await expect(returnButton).toBeDisabled();
  await row.getByLabel(/What needs correcting/).fill('Moisture tin weight missing');
  await returnButton.click();
  await expect(row).toContainText('Returned to Lab Manager');
  await expect(row).toContainText('Moisture tin weight missing');
  await expect(row).toContainText('In review');

  // The Lab Manager marks the correction done but can't accept without delegation.
  await signInAs(page, 'lab');
  await page.goto(`/lab-testing/programs/${programId}`);
  await expect(row.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await row.getByRole('button', { name: 'Mark correction done' }).click();
  await row.getByLabel(/What was corrected/).fill('Tin weight re-entered from the sheet');
  await row.getByRole('form').getByRole('button', { name: 'Mark correction done' }).click();
  await expect(row).toContainText('Correction done — awaiting re-review');

  // Acceptance stays blocked until a fresh review completes.
  await signInAs(page, 'pe');
  await page.goto(`/lab-testing/programs/${programId}`);
  await expect(row.getByRole('button', { name: 'Accept' })).toBeDisabled();
  await expect(row).toContainText('Review not complete');
  await signInAs(page, 'at');
  await page.goto(`/lab-testing/programs/${programId}`);
  await row.getByRole('button', { name: 'Mark review complete' }).click();
  await expect(row).toContainText('Review complete');

  await signInAs(page, 'pe');
  await page.goto(`/lab-testing/programs/${programId}`);
  await row.getByRole('button', { name: 'Accept' }).click();
  await expect(row).toContainText('Accepted');
  await expect(row).toContainText('Accepted by PE · Pat Example');
  await row.getByText(/Review history/).click();
  await expect(row).toContainText('Returned for correction by AT · Alex Tester');
  await expect(row).toContainText('Correction done by LAB · Lab (test)');
});

test('T5: LAB stations may send to review but every review and acceptance action is refused', async ({
  browser,
}) => {
  const setup = await browser.newPage();
  const code = unique('DEMO-LB');
  const typeId = await addTestType(setup, code);
  await signInAs(setup, 'at');
  const { programId, testRequestId, version } = await testInReview(setup.request, typeId);
  await setup.close();

  const station = await browser.newContext();
  const page = await station.newPage();
  try {
    await signInAsLabStation(page);
    await page.goto(`/lab-testing/programs/${programId}`);
    const row = testRow(page, code);
    await expect(row).toContainText('Awaiting review');
    await expect(row).toContainText('Review and acceptance need a personal sign-in');
    await expect(row.getByRole('button', { name: 'Mark review complete' })).toHaveCount(0);
    await expect(row.getByRole('button', { name: 'Accept' })).toHaveCount(0);
    for (const [path, data] of [
      ['review', { action: 'complete', version, actingStaffUserId: PAT }],
      ['correction-done', { note: 'x', version, actingStaffUserId: PAT }],
      ['accept', { version }],
    ] as const) {
      const response = await page.request.post(`/api/test-requests/${testRequestId}/${path}`, {
        headers: CSRF,
        data: { ...data, idempotencyKey: crypto.randomUUID() },
      });
      expect(response.status()).toBe(403);
    }
    const delegate = await page.request.post(
      `/api/projects/${DEMO_PROJECT_ID}/acceptance-delegates`,
      { headers: CSRF, data: { delegateUserId: DANA, idempotencyKey: crypto.randomUUID() } },
    );
    expect(delegate.status()).toBe(403);
  } finally {
    await station.close();
  }
});

test('Acceptance delegates: the Lead Project Engineer adds and revokes a delegate on the project page', async ({
  page,
}, testInfo) => {
  const projectId = PROJECTS[testInfo.project.name as keyof typeof PROJECTS] ?? DEMO_PROJECT_ID;
  await signInAs(page, 'pe');
  // Start clean if an earlier interrupted run left Dana delegated.
  const current = await (
    await page.request.get(`/api/projects/${projectId}/acceptance-delegates`)
  ).json();
  for (const grant of current.active as { id: string }[]) {
    await page.request.delete(`/api/projects/${projectId}/acceptance-delegates/${grant.id}`, {
      headers: CSRF,
    });
  }

  await page.goto(`/projects/${projectId}`);
  const section = page.getByRole('region', { name: 'Acceptance delegates' });
  await expect(section).toContainText('No acceptance delegates.');
  await section.getByRole('combobox', { name: /Add a delegate/ }).fill('Dana');
  await page.getByRole('option', { name: /Dana Example/ }).click();
  await section.getByRole('button', { name: 'Add delegate' }).click();
  await expect(section.getByRole('list', { name: 'Acceptance delegates' })).toContainText(
    'Dana Example',
  );
  await section.getByRole('button', { name: 'Revoke Dana Example' }).click();
  await expect(section).toContainText('No acceptance delegates.');
  await section.getByText(/Delegation history/).click();
  await expect(section).toContainText(/Dana Example: added by PE · Pat Example/);

  // Someone who isn't the Lead Project Engineer sees the list but no controls.
  await signInAs(page, 'de');
  await page.goto(`/projects/${projectId}`);
  await expect(page.getByRole('region', { name: 'Acceptance delegates' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add delegate' })).toHaveCount(0);
});
