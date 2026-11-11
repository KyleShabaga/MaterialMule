import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { closeMore, openMore } from './support/shell';
import { signInAsLabStation } from './support/lab-station';

// MM-T91: Notifications are separate from Pending actions (action requests). Two labelled header
// controls with their own counts, the notification center with the linked request's live status,
// reading that never resolves anything, and resolution only through the real workflow action.
// Fictional data only: DEMO-2601, Lead Project Engineer Pat Example (pe), Lab Manager "Lab (test)"
// (lab), Technician Alex Tester (at).
//
// Other specs raise and resolve requests for pe in parallel, so this one never does arithmetic on
// pe's totals: it follows its own request and checks that each header count matches the server's.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };
const NOTIFICATIONS = /^Notifications, (\d+|none) unread$/;
const PENDING = /^Pending actions, \d+ waiting on you$/;

const unique = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function submittedProgram(page: Page) {
  await signInAs(page, 'lab');
  const code = unique('DEMO-NT');
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
  return { programId: program.id as string, programNumber: program.programNumber as string };
}

/** The number in a header control's accessible name ("none" is 0). */
function countFrom(label: string | null): number {
  const match = /, (\d+|none) /.exec(label ?? '');
  return !match?.[1] || match[1] === 'none' ? 0 : Number(match[1]);
}

/** The bell's unread count and Pending actions' count (in the phone More sheet, reopened). */
async function headerCounts(page: Page): Promise<{ pending: number; unread: number }> {
  const unread = countFrom(
    await page.getByRole('link', { name: NOTIFICATIONS }).getAttribute('aria-label'),
  );
  await openMore(page);
  const pending = countFrom(
    await page.getByRole('link', { name: PENDING }).getAttribute('aria-label'),
  );
  await closeMore(page);
  return { pending, unread };
}

async function serverCounts(page: Page): Promise<{ pending: number; unread: number }> {
  const pending = (await (await page.request.get('/api/action-items/count')).json()) as {
    open: number;
  };
  const unread = (await (await page.request.get('/api/notifications/count')).json()) as {
    unread: number;
  };
  return { pending: pending.open, unread: unread.unread };
}

async function pendingTitles(page: Page): Promise<string[]> {
  const list = await page.request.get('/api/action-items?status=open&scope=mine');
  return ((await list.json()) as { items: { title: string }[] }).items.map((item) => item.title);
}

/** Each header count matches its own server count; a window focus makes both refresh. */
async function expectHeaderMatchesServer(page: Page) {
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const [header, server] = [await headerCounts(page), await serverCounts(page)];
      return header.pending === server.pending && header.unread === server.unread;
    })
    .toBe(true);
}

test('MM-T91: a notification links to its request, reading it resolves nothing, and the real action does', async ({
  page,
}) => {
  const { programId, programNumber } = await submittedProgram(page);
  const title = `Closure requested for ${programNumber}`;
  // The technician asks for closure; the Lead Project Engineer is notified and has it pending.
  const asked = await page.request.post(`/api/lab-programs/${programId}/close-request`, {
    headers: CSRF,
    data: { reason: 'All tests done (E2E notifications)', idempotencyKey: crypto.randomUUID() },
  });
  expect(asked.status()).toBe(201);

  await signInAs(page, 'pe');
  await page.goto('/');
  const notifications = page.getByRole('link', { name: NOTIFICATIONS });
  await expect(notifications).toBeVisible();
  await openMore(page);
  await expect(page.getByRole('link', { name: PENDING })).toBeVisible();
  await closeMore(page);
  await expectHeaderMatchesServer(page);
  const before = await headerCounts(page);
  expect(before.unread).toBeGreaterThan(0);
  expect(before.pending).toBeGreaterThan(0);

  // The notification center: what happened, and the request's status now.
  await notifications.click();
  await expect(page).toHaveURL(/\/notifications$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
  const row = page.getByRole('listitem', { name: title });
  await expect(row).toContainText('Unread');
  await expect(row).toContainText(`Sent to you for action: ${title}`);
  await expect(row).toContainText('DEMO-2601');
  await expect(row).toContainText('Pending — waiting on you');
  await expect(page.getByRole('button', { name: /approve|resolve|close/i })).toHaveCount(0);

  // Mark read: the notification is read, the request is still pending.
  await row.getByRole('button', { name: 'Mark read' }).click();
  await expect(row).not.toContainText('Unread');
  await expect(row.getByRole('button', { name: 'Mark read' })).toHaveCount(0);
  await expect(row).toContainText('Pending — waiting on you');
  expect(await pendingTitles(page)).toContain(title);
  await expectHeaderMatchesServer(page);

  // Unread filter leaves it out; Active still has it.
  await page.getByRole('button', { name: 'Unread', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unread', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('listitem', { name: title })).toHaveCount(0);
  await page.getByRole('button', { name: 'Active', exact: true }).click();
  await expect(row).toBeVisible();

  // Open goes to the program; the real workflow action resolves the request.
  await row.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/lab-testing/programs/${programId}$`));
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();
  const testRow = page.locator('.request-list li').first();
  await testRow.getByRole('button', { name: 'Cancel test' }).click();
  await testRow.getByLabel(/Reason for cancelling/).fill('Not needed (E2E notifications)');
  await testRow.getByRole('form').getByRole('button', { name: 'Cancel test' }).click();
  await expect(testRow).toContainText('Cancelled');
  await page.locator('.program-lifecycle').getByRole('button', { name: 'Close program' }).click();
  await expect(page.locator('.program-lifecycle')).toContainText('Closed');

  // The same notification now says who resolved it; nothing still says it waits on you.
  await page.goto('/notifications');
  await expect(row).toContainText('Resolved by Pat Example · Program closed');
  await expect(row).not.toContainText('waiting on you');
  expect(await pendingTitles(page)).not.toContain(title);
  await expectHeaderMatchesServer(page);

  // The technician who asked is told it was decided.
  await signInAs(page, 'at');
  await page.goto('/notifications');
  const decided = page.getByRole('listitem', { name: title });
  await expect(decided).toContainText(`Your request was decided: ${title}`);
  await expect(decided).toContainText('Resolved by Pat Example · Program closed');

  // Dismiss hides it; All shows it again with Restore.
  await decided.getByRole('button', { name: 'Dismiss' }).click();
  await expect(decided).toHaveCount(0);
  await page.getByRole('button', { name: 'All', exact: true }).click();
  await expect(decided).toContainText('Dismissed');
  await decided.getByRole('button', { name: 'Restore' }).click();
  await expect(decided.getByRole('button', { name: 'Dismiss' })).toBeVisible();
});

test('MM-T91: the bell and Pending actions have 44 px targets and distinct names at phone width', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Phone layout only');
  await signInAs(page, 'pe');
  await page.goto('/');
  // The bell sits in the phone header; Pending actions in the More sheet.
  const notifications = page.getByRole('banner').getByRole('link', { name: NOTIFICATIONS });
  await expect(notifications).toBeVisible();
  await openMore(page);
  const pending = page.getByRole('link', { name: PENDING });
  await expect(pending).toBeVisible();
  for (const box of [await notifications.boundingBox(), await pending.boundingBox()]) {
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
  // The page doesn't scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await closeMore(page);
  await notifications.click();
  await expect(page.getByRole('heading', { level: 1, name: 'Notifications' })).toBeVisible();
});

test('MM-T91: LAB has no Notifications control or center', async ({ page }) => {
  await signInAsLabStation(page);
  await page.goto('/');
  // Today (Field Ledger): its queue heading, on desktop and phone.
  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Notifications/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Pending actions/ })).toHaveCount(0);
  for (const path of ['/api/notifications', '/api/notifications/count']) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
  await page.goto('/notifications');
  await expect(
    page.getByText('Notifications are for personal accounts. Sign in with your own account.'),
  ).toBeVisible();
});
