import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { closeMore, mainNav, openMore } from './support/shell';
import { inboxRow, inboxUrl, openInboxItem } from './support/inbox';
import { signInAsLabStation } from './support/lab-station';

// MM-T27 (card T5, T6): action requests in the Inbox (STRATA-24; the Action requests page before
// it, which now redirects there), resolution through the real workflow action, LAB without an
// inbox, and the email preference (default off; nothing is sent).
// Fictional data only: DEMO-2601, Lead Project Engineer Pat Example (pe), Lab Manager "Lab (test)" (lab),
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

test('T5: a closure request appears in the Lead Project Engineer’s Inbox, opens the program, and closing resolves it', async ({
  page,
}) => {
  const { programId, programNumber } = await submittedProgram(page);
  const title = `Closure requested for ${programNumber}`;
  // The technician asks for closure; it never waits on them.
  const asked = await page.request.post(`/api/lab-programs/${programId}/close-request`, {
    headers: CSRF,
    data: { reason: 'All tests done (E2E)', idempotencyKey: crypto.randomUUID() },
  });
  expect(asked.status()).toBe(201);
  // The old Action requests page is the Inbox's Requests tab now.
  await page.goto('/action-requests');
  await expect(page).toHaveURL(/\/inbox\?tab=requests$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await page.goto(inboxUrl(programNumber, { tab: 'requests', filter: 'waiting_on_me' }));
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await expect(inboxRow(page, title)).toHaveCount(0);

  await signInAs(page, 'pe');
  await page.goto('/');
  // Strata: Inbox is the sidebar row (in the Sheet on a phone); requests are in it.
  const open = await page.request.get('/api/action-items/count');
  expect(((await open.json()) as { open: number }).open).toBeGreaterThan(0);
  await openMore(page);
  const inbox = mainNav(page).getByRole('link', { name: 'Inbox', exact: true });
  await expect(inbox).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Action requests' })).toHaveCount(0);
  await inbox.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await openMore(page);
  await expect(inbox).toHaveAttribute('aria-current', 'page');
  await closeMore(page);
  await page.goto(inboxUrl(programNumber, { tab: 'requests', filter: 'waiting_on_me' }));
  const row = inboxRow(page, title);
  await expect(row).toContainText('Request');
  await expect(row).toContainText('Close a program');
  await expect(row).toContainText('Alex Tester');
  const item = await openInboxItem(page, row, title);
  await expect(item).toContainText(/From Alex Tester · .+ · waiting on you/);
  await expect(item).toContainText('All tests done (E2E)');
  await expect(item).toContainText('This request closes on its own when the program is closed.');
  // Nothing in the inbox approves the request; the Lead Project Engineer opens the program and acts there.
  await expect(item.getByRole('button', { name: /approve|resolve|close/i })).toHaveCount(0);
  await item.getByRole('link', { name: 'Review the closure' }).click();
  await expect(page).toHaveURL(new RegExp(`/lab-testing/programs/${programId}$`));
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();

  // Resolve through the real workflow: cancel the only test, then close the program.
  const testRow = page.locator('.request-list li').first();
  await testRow.getByRole('button', { name: 'Cancel test' }).click();
  // The program page asks for the reason in a dialog (STRATA-87).
  const cancelDialog = page.getByRole('dialog', { name: 'Cancel test' });
  await cancelDialog.getByLabel(/Reason for cancelling/).fill('Not needed (E2E)');
  await cancelDialog.getByRole('button', { name: 'Cancel test' }).click();
  await expect(testRow).toContainText('Cancelled');
  await page.locator('.program-lifecycle').getByRole('button', { name: 'Close program' }).click();
  await expect(page.locator('.program-lifecycle')).toContainText('Closed');

  await page.goto(inboxUrl(programNumber, { tab: 'requests' }));
  await expect(page.getByText('Nothing matches.')).toBeVisible();
  await expect(inboxRow(page, title)).toHaveCount(0);
  // Done holds it, with who resolved it and how.
  await page.goto(inboxUrl(programNumber, { tab: 'done' }));
  const done = await openInboxItem(page, inboxRow(page, title), title);
  await expect(done).toContainText('Resolved by Pat Example · Program closed');
});

test('T6: LAB has no Action requests or Notifications control, inbox or preferences, whoever the station would select', async ({
  page,
}) => {
  await signInAsLabStation(page);
  await page.goto('/');
  // Today on a LAB station (STRATA-20): this station's work, on desktop and phone.
  await expect(page.getByRole('heading', { level: 2, name: 'At this station' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Action requests/ })).toHaveCount(0);
  // STRATA-27: the bell may show the picked person's Inbox only with their consent; Alex Tester
  // hasn't given it, so no count anywhere.
  await expect(page.getByRole('link', { name: /^Notifications, / })).toHaveCount(0);
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

test('MISC-11: Settings › Notifications has no Email me opt-in; the stored preference stays', async ({
  page,
}) => {
  await signInAs(page, 'de');
  await page.goto('/settings/notifications');
  await expect(page.getByRole('heading', { name: 'Notifications' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: /Email me/ })).toHaveCount(0);
  await expect(page.getByText(/Email me|switched off for everyone/)).toHaveCount(0);
  // UI only: the stored preference is still served.
  expect((await page.request.get('/api/me/notification-preferences')).status()).toBe(200);
});
