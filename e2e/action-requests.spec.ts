import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { signInAsLabStation } from './support/lab-station';

// MM-T27 (card T5, T6): the header bell and Action requests page, resolution through the real
// workflow action, LAB without an inbox, and the email preference (default off; nothing is sent).
// Fictional data only: DEMO-2601, PM/PE Pat Example (pe), Lab Manager "Lab (test)" (lab),
// Technician Alex Tester (at).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };

const unique = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function submittedProgram(page: Page) {
  await signInAs(page, 'lab');
  const code = unique('DEMO-AR');
  const type = await page.request.post('/api/test-types', {
    headers: CSRF,
    data: { groupId: SOILS, code, description: `Fictional ${code}`, name: `Test ${code}` },
  });
  expect(type.status()).toBe(201);
  const testTypeId = (await type.json()).id as string;
  await signInAs(page, 'at');
  const request: APIRequestContext = page.request;
  const hole = await request.post(`/api/projects/${DEMO_PROJECT_ID}/test-holes`, {
    headers: CSRF,
    data: { name: unique('TH') },
  });
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
    testRequestId: program.lines[0].requests[0].id as string,
  };
}

test('T5: a closure request appears under the PM/PE bell, opens the program, and closing resolves it', async ({
  page,
}) => {
  const { programId, programNumber } = await submittedProgram(page);
  // The technician asks for closure; they don't see it themselves.
  const asked = await page.request.post(`/api/lab-programs/${programId}/close-request`, {
    headers: CSRF,
    data: { reason: 'All tests done (E2E)', idempotencyKey: crypto.randomUUID() },
  });
  expect(asked.status()).toBe(201);
  await page.goto('/action-requests');
  await expect(page.getByRole('heading', { name: 'Action requests' })).toBeVisible();
  await expect(
    page.getByRole('listitem', { name: `Closure requested for ${programNumber}` }),
  ).toHaveCount(0);

  await signInAs(page, 'pe');
  await page.goto('/');
  const bell = page.getByRole('link', { name: /^Action requests, \d+ open$/ });
  await expect(bell).toBeVisible();
  await bell.click();
  const row = page.getByRole('listitem', { name: `Closure requested for ${programNumber}` });
  await expect(row).toContainText(
    `PM/PE: Closure requested for ${programNumber} by AT · All tests done (E2E)`,
  );
  // Nothing in the inbox approves the request; the PM/PE opens the program and acts there.
  await expect(row.getByRole('button', { name: /approve|resolve|close/i })).toHaveCount(0);
  await row.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/lab-testing/programs/${programId}$`));
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();

  // Resolve through the real workflow: cancel the only test, then close the program.
  const testRow = page.locator('.request-list li').first();
  await testRow.getByRole('button', { name: 'Cancel test' }).click();
  await testRow.getByLabel(/Reason for cancelling/).fill('Not needed (E2E)');
  await testRow.getByRole('form').getByRole('button', { name: 'Cancel test' }).click();
  await expect(testRow).toContainText('Cancelled');
  await page.locator('.program-lifecycle').getByRole('button', { name: 'Close program' }).click();
  await expect(page.locator('.program-lifecycle')).toContainText('Closed');

  await page.goto('/action-requests');
  await expect(
    page.getByRole('listitem', { name: `Closure requested for ${programNumber}` }),
  ).toHaveCount(0);
  await page.getByRole('button', { name: 'Resolved' }).click();
  await expect(
    page.getByRole('listitem', { name: `Closure requested for ${programNumber}` }),
  ).toContainText('Resolved by PE · Program closed');
});

test('T6: LAB has no bell, inbox or preferences, whoever the station would select', async ({
  page,
}) => {
  await signInAsLabStation(page);
  await page.goto('/');
  await expect(page.getByRole('link', { name: 'Sample Storage' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Action requests/ })).toHaveCount(0);
  for (const path of [
    '/api/action-items',
    '/api/action-items/count',
    '/api/me/notification-preferences',
  ]) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toHaveCount(0);
});

test('My profile: action-request email defaults off, saves, and explains sending is switched off', async ({
  page,
}) => {
  await signInAs(page, 'de');
  await page.goto('/settings/profile');
  const box = page.getByRole('checkbox', {
    name: 'Email me when an action request needs my decision',
  });
  await expect(box).toBeVisible();
  await expect(page.getByText(/switched off for everyone until IT approves it/)).toBeVisible();
  const before = await box.isChecked();
  await box.click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
  await page.reload();
  await expect(box).toBeChecked({ checked: !before });
  // Restore, so reruns start from the same state.
  await box.click();
  await expect(page.getByRole('status').filter({ hasText: 'Saved.' })).toBeVisible();
});
