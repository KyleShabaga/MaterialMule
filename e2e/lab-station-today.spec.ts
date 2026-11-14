import { expect, test } from '@playwright/test';
import { DEFAULT_STATION_PERSON, signInAsLabStation } from './support/lab-station';
import { mainNav, openMore } from './support/shell';

// STRATA-20, 21, 63 and 27 on the shared LAB station: Today's three start tiles and this
// station's work (Customize read-only on the LAB session), and the picked person's Inbox, which
// stays private unless they turned on "Show my Inbox on shared LAB computers" (off by default).
// Fictional people only: Alex Tester from the dev seed is the station's default person.

test('STRATA-20: station Today shows who is recording, three start tiles and this station’s work', async ({
  page,
}) => {
  await signInAsLabStation(page);
  await page.goto('/');

  await expect(page.getByText(/Work started here is recorded as/)).toContainText(
    'Work started here is recorded as Alex Tester.',
  );
  const tiles = page.getByRole('navigation', { name: 'Start work' }).getByRole('link');
  await expect(tiles).toHaveCount(3);
  await expect(tiles.nth(0)).toHaveAttribute('href', '/receiving-log/new');
  await expect(tiles.nth(0)).toContainText('Receive samples');
  await expect(tiles.nth(1)).toHaveAttribute('href', '/concrete/receiving');
  await expect(tiles.nth(1)).toContainText('Receive concrete');
  await expect(tiles.nth(2)).toHaveAttribute('href', '/lab-testing/concrete');
  await expect(tiles.nth(2)).toContainText('Record breaks');

  const work = page.getByRole('region', { name: 'At this station' });
  await expect(work.getByRole('heading', { level: 2, name: 'At this station' })).toBeVisible();
  for (const title of ['Draft receipts to finish', 'Breaks due today', 'Labels to print']) {
    await expect(work.getByRole('link', { name: new RegExp(title) })).toBeVisible();
  }

  // The LAB session sees the station's setup read-only (Lab Managers change it on their own
  // account, STRATA-36 d).
  await work.getByRole('button', { name: 'Customize this station' }).click();
  const customize = page.getByRole('dialog', { name: 'Customize this station' });
  await expect(customize.getByText('Shown on this station')).toBeVisible();
  for (const control of await customize.getByRole('switch').all()) {
    await expect(control).toBeDisabled();
  }
  await expect(customize).toContainText('Only a Lab Manager can change this station.');
  await page.keyboard.press('Escape');

  await tiles.nth(0).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Receive samples' })).toBeVisible();
});

test('STRATA-27: a picked person’s Inbox stays private on the station by default', async ({
  page,
  isMobile,
}) => {
  await signInAsLabStation(page);
  await page.goto('/');

  const summary = await page.request.get(
    `/api/station/inbox/summary?personId=${DEFAULT_STATION_PERSON.id}`,
  );
  expect(summary.status()).toBe(200);
  expect(await summary.json()).toMatchObject({ state: 'private' });

  // No count anywhere in the shell, and the bell's preview only says it stays private.
  await expect(page.getByRole('link', { name: /^Notifications, / })).toHaveCount(0);
  if (!isMobile) {
    const bell = page.getByRole('banner').getByRole('link', { name: 'Notifications' });
    await bell.hover();
    await expect(page.getByLabel('Inbox preview')).toHaveText(
      'Alex Tester’s notifications stay private on this computer.',
    );
    await bell.click();
  } else {
    // The phone top bar keeps the recording chip; the station's Inbox is the sidebar row.
    await openMore(page);
    await mainNav(page)
      .getByRole('link', { name: /^Inbox/ })
      .click();
  }
  await expect(
    page.getByRole('heading', { name: 'Alex Tester’s Inbox stays private here' }),
  ).toBeVisible();
  await expect(page.getByText(/Show my Inbox on shared LAB computers/)).toBeVisible();
  await expect(
    page.getByText('Work done at this station is still recorded under Alex Tester’s name.'),
  ).toBeVisible();
  // Read-only and private: nothing to mark read, dismiss or decide.
  await expect(page.getByRole('button', { name: /Mark all read|Dismiss/ })).toHaveCount(0);
  // The personal Inbox routes stay closed to LAB.
  expect((await page.request.get('/api/inbox/summary')).status()).toBe(403);
});
