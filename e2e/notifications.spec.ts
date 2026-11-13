import { randomBytes } from 'node:crypto';
import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { closeMore, mainNav, openMore } from './support/shell';
import { signInAsLabStation } from './support/lab-station';

// MM-T91: Notifications are separate from action requests. The bell (top bar) carries the unread
// count; Action requests is its own sidebar row under Inbox, and the two are never added together, the notification center with the linked request's live status,
// reading that never resolves anything, and resolution only through the real workflow action.
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
  await expect(
    mainNav(page).getByRole('link', { name: 'Action requests', exact: true }),
  ).toBeVisible();
  await closeMore(page);
  await expectHeaderMatchesServer(page);
  expect(await bellCount(page)).toBeGreaterThan(0);
  expect(await serverPending(page)).toBeGreaterThan(0);

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
  // The program page asks for the reason in a dialog (STRATA-87).
  const cancelDialog = page.getByRole('dialog', { name: 'Cancel test' });
  await cancelDialog.getByLabel(/Reason for cancelling/).fill('Not needed (E2E notifications)');
  await cancelDialog.getByRole('button', { name: 'Cancel test' }).click();
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

test('MM-T91: the bell and Action requests have 44 px targets and distinct names at phone width', async ({
  page,
  isMobile,
}) => {
  test.skip(!isMobile, 'Phone layout only');
  await signInAs(page, 'pe');
  await page.goto('/');
  // The bell sits in the phone top bar; Action requests in the sidebar Sheet, under Inbox.
  const notifications = page.getByRole('banner').getByRole('link', { name: NOTIFICATIONS });
  await expect(notifications).toBeVisible();
  // Measured before the Sheet opens: the open Sheet hides the top bar from assistive tech.
  const bellBox = await notifications.boundingBox();
  await openMore(page);
  const requests = mainNav(page).getByRole('link', { name: 'Action requests', exact: true });
  await expect(requests).toBeVisible();
  for (const box of [bellBox, await requests.boundingBox()]) {
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
  await expect(preview.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute(
    'href',
    '/notifications',
  );
  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);
});

test('MM-T91: LAB has no Notifications of its own', async ({ page }) => {
  await signInAsLabStation(page);
  await page.goto('/');
  // Today on a LAB station (STRATA-20): this station's work, on desktop and phone.
  await expect(page.getByRole('heading', { level: 2, name: 'At this station' })).toBeVisible();
  // STRATA-27: the picked person's Inbox shows only with their consent (lab-station-today.spec);
  // Alex Tester hasn't given it, so there is no count anywhere.
  await expect(page.getByRole('link', { name: /^Notifications, / })).toHaveCount(0);
  await expect(page.getByRole('link', { name: /^Action requests/ })).toHaveCount(0);
  for (const path of ['/api/notifications', '/api/notifications/count']) {
    expect((await page.request.get(path)).status(), path).toBe(403);
  }
});
