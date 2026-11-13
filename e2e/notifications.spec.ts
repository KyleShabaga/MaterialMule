import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { closeMore, mainNav, openMore } from './support/shell';
import { inboxRow, inboxUrl, openInboxItem } from './support/inbox';
import { signInAsLabStation } from './support/lab-station';

// MM-T91 with the single Inbox (STRATA-24): the bell (top bar) carries the Inbox's unread count
// and opens /inbox, as does the sidebar's Inbox row; an item shows the linked request's live
// status, reading it never resolves anything, and resolution comes only through the real workflow
// action. The old /notifications page redirects to the Inbox.
// Fictional data only: DEMO-2601, Lead Project Engineer Pat Example (pe), Lab Manager "Lab (test)"
// (lab), Technician Alex Tester (at).
//
// Other specs raise and resolve requests for pe in parallel, so this one never does arithmetic on
// pe's totals: it follows its own request and checks that the bell's count matches the server's.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSRF = { 'x-materialmule-csrf': '1' };
const NOTIFICATIONS = /^Notifications, (\d+|none) unread$/;

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

/** The bell's unread count. */
async function bellCount(page: Page): Promise<number> {
  return countFrom(
    await page.getByRole('link', { name: NOTIFICATIONS }).getAttribute('aria-label'),
  );
}

/** The Inbox's one badge-eligible unread count (STRATA-55), which the bell shows. */
async function serverUnread(page: Page): Promise<number> {
  const body = (await (await page.request.get('/api/inbox/summary')).json()) as {
    counts: { badge: number };
  };
  return body.counts.badge;
}

async function serverPending(page: Page): Promise<number> {
  const body = (await (await page.request.get('/api/action-items/count')).json()) as {
    open: number;
  };
  return body.open;
}

async function pendingTitles(page: Page): Promise<string[]> {
  const list = await page.request.get('/api/action-items?status=open&scope=mine');
  return ((await list.json()) as { items: { title: string }[] }).items.map((item) => item.title);
}

/** The bell's count matches the server's unread count; a window focus makes it refresh. */
async function expectHeaderMatchesServer(page: Page) {
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      return (await bellCount(page)) === (await serverUnread(page));
    })
    .toBe(true);
}

test('MM-T91: an Inbox item links to its request, reading it resolves nothing, and the real action does', async ({
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
  await expect(mainNav(page).getByRole('link', { name: 'Inbox', exact: true })).toBeVisible();
  await closeMore(page);
  await expectHeaderMatchesServer(page);
  expect(await bellCount(page)).toBeGreaterThan(0);
  expect(await serverPending(page)).toBeGreaterThan(0);

  // The bell opens the Inbox: what it is, and the request's status now.
  await notifications.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await page.goto(inboxUrl(programNumber));
  const row = inboxRow(page, title);
  await expect(row).toContainText('Unread');
  await expect(row).toContainText('Request');
  await expect(row).toContainText('Close a program');
  await expect(row).toContainText('DEMO-2601');
  await expect(page.getByRole('button', { name: /approve|resolve/i })).toHaveCount(0);

  // Opening it reads it; the request is still pending.
  const item = await openInboxItem(page, row, title);
  await expect(item).toContainText('waiting on you');
  await expect(item.getByRole('button', { name: /approve|resolve|close/i })).toHaveCount(0);
  await expect(item.getByRole('button', { name: 'Mark unread' })).toBeVisible();
  await page.goto(inboxUrl(programNumber));
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('Unread');
  expect(await pendingTitles(page)).toContain(title);
  await expectHeaderMatchesServer(page);

  // Unread only leaves it out; clearing the filter brings it back.
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Unread only' }).click();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Clear Unread only' })).toBeVisible();
  await expect(inboxRow(page, title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Clear Unread only' }).click();
  await expect(row).toBeVisible();

  // Its link goes to the program; the real workflow action resolves the request.
  const again = await openInboxItem(page, row, title);
  await again.getByRole('link', { name: 'Review the closure' }).click();
  await expect(page).toHaveURL(new RegExp(`/lab-testing/programs/${programId}$`));
  await expect(page.getByRole('heading', { name: programNumber })).toBeVisible();
  const testRow = page.locator('.request-list li').first();
  await testRow.getByRole('button', { name: 'Cancel test' }).click();
  // The program page asks for the reason in a dialog (STRATA-87).
  const cancelDialog = page.getByRole('dialog', { name: 'Cancel test' });
  await cancelDialog.getByLabel(/Reason for cancelling/).fill('Not needed (E2E notifications)');
  await cancelDialog.getByRole('button', { name: 'Cancel test' }).click();
  await expect(testRow).toContainText('Cancelled');
  await page.locator('.program-lifecycle').getByRole('button', { name: 'Close program' }).click();
  await expect(page.locator('.program-lifecycle')).toContainText('Closed');

  // The same request (now in Done) says who resolved it; nothing still says it waits on you.
  await page.goto(inboxUrl(programNumber, { tab: 'done' }));
  const resolved = await openInboxItem(page, inboxRow(page, title), title);
  await expect(resolved).toContainText('Resolved by Pat Example · Program closed');
  await expect(resolved).not.toContainText('waiting on you');
  expect(await pendingTitles(page)).not.toContain(title);
  await expectHeaderMatchesServer(page);

  // The technician who asked is told it was decided.
  await signInAs(page, 'at');
  await page.goto(inboxUrl(programNumber));
  const decided = inboxRow(page, title).filter({ hasText: 'Your request was decided' });
  await expect(decided).toContainText('Unread');
  const update = await openInboxItem(page, decided, title);
  await expect(update).toContainText('Your request was decided');
  await expect(update).toContainText('Resolved by Pat Example · Program closed');

  // Dismiss hides it from All; Done shows it as dismissed, with Restore.
  await update.getByRole('button', { name: 'Dismiss' }).click();
  await expect(update.getByRole('button', { name: 'Restore' })).toBeVisible();
  await page.goto(inboxUrl(programNumber));
  await expect(decided).toHaveCount(0);
  await page.goto(inboxUrl(programNumber, { tab: 'done' }));
  const dismissed = inboxRow(page, title).filter({ hasText: 'Your request was decided' });
  await expect(dismissed).toContainText('Dismissed');
  const restored = await openInboxItem(page, dismissed, title);
  await restored.getByRole('button', { name: 'Restore' }).click();
  await expect(restored.getByRole('button', { name: 'Dismiss' })).toBeVisible();
});

test('MM-T91: the bell and the Inbox row have 44 px targets and distinct names at phone width', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Phone layout only');
  await signInAs(page, 'pe');
  await page.goto('/');
  // The bell sits in the phone top bar; the Inbox row in the sidebar Sheet.
  const notifications = page.getByRole('banner').getByRole('link', { name: NOTIFICATIONS });
  await expect(notifications).toBeVisible();
  // Measured before the Sheet opens: the open Sheet hides the top bar from assistive tech.
  const bellBox = await notifications.boundingBox();
  await openMore(page);
  const inbox = mainNav(page).getByRole('link', { name: 'Inbox', exact: true });
  await expect(inbox).toBeVisible();
  for (const box of [bellBox, await inbox.boundingBox()]) {
    expect(box!.width).toBeGreaterThanOrEqual(43.5);
    expect(box!.height).toBeGreaterThanOrEqual(43.5);
  }
  // The page doesn't scroll sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(
    true,
  );
  await closeMore(page);
  await notifications.click();
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
});

test('STRATA-13: hovering the bell previews Inbox with the same count, and the bell opens it', async ({
  page,
  isMobile,
}) => {
  test.skip(isMobile, 'The preview opens on hover or keyboard focus (desktop)');
  await signInAs(page, 'pe');
  await page.goto('/');
  const bell = page.getByRole('banner').getByRole('link', { name: NOTIFICATIONS });
  await expect(bell).toBeVisible();
  await bell.hover();
  const preview = page.getByLabel('Inbox preview');
  await expect(preview).toBeVisible();
  // The heading and the badge come from one count, which follows the server's.
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const unread = await serverUnread(page);
      const heading = unread > 0 ? `Inbox · ${unread} unread` : 'Inbox';
      const shown = countFrom(await bell.getAttribute('aria-label'));
      return shown === unread && (await preview.getByText(heading, { exact: true }).count()) === 1;
    })
    .toBe(true);
  // At most the three newest, each a link to its record.
  expect(
    await preview.getByRole('list', { name: 'Newest in your Inbox' }).getByRole('link').count(),
  ).toBeLessThanOrEqual(3);
  await expect(preview.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');
  await bell.click();
  await expect(page).toHaveURL(/\/inbox$/);
});

test('MM-T91: LAB has no Notifications control or center', async ({ page }) => {
  await signInAsLabStation(page);
  await page.goto('/');
  // Today (Field Ledger): its queue heading, on desktop and phone.
  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('link', { name: /^Notifications/ })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Action requests/ })).toHaveCount(0);
  for (const path of [
    '/api/notifications',
    '/api/notifications/count',
    '/api/inbox',
    '/api/inbox/summary',
  ]) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
  // The old page is the Inbox; on a station it shows the station Inbox (STRATA-27), never the
  // shared account's own feed, so it never fails to load one.
  await page.goto('/notifications');
  await expect(page).toHaveURL(/\/inbox$/);
  await expect(page.getByText('Inbox couldn’t load')).toHaveCount(0);
});
