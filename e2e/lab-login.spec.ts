import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { accountRow } from './support/shell';

/** STRATA-16: a LAB sign-in asks who is working; Alex Tester (fictional, dev seed) is picked. */
async function pickWhoIsWorking(page: Page) {
  await expect(page).toHaveURL(/\/who-is-working$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Who is working here?' })).toBeVisible();
  await page.getByRole('button', { name: /^Alex Tester/ }).click();
  await expect(page).toHaveURL(/\/$/);
}

// MM-T06 T6. One test, desktop only: setting the LAB password signs out every LAB station, so a
// second project running this in parallel would sign this one out.
test('T6/AC4: an admin sets the LAB password; LAB stays signed in after the browser reopens', async ({
  page,
  browser,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'LAB password is shared per run');
  const baseURL = testInfo.project.use.baseURL;
  // Generated per run, never committed.
  const password = `e2e-${randomBytes(12).toString('base64url')}`;

  // Admin: Lab admin › Staff → Reset LAB password, with confirmation.
  await signInAs(page, 'admin');
  await page.goto('/settings/staff');
  const card = page.getByRole('region', { name: 'Shared receiving account (LAB)' });
  await card.getByLabel('New LAB password').fill(password);
  await card.getByLabel('Repeat the new password').fill(password);
  await card.getByRole('button', { name: 'Reset LAB password' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Reset password' }).click();
  await expect(card.getByRole('status')).toContainText('LAB password reset');

  // The shared station signs in as LAB on the landing page.
  const station = await browser.newContext({ baseURL });
  const stationPage = await station.newPage();
  await stationPage.goto('/sign-in');
  // STRATA-18: a computer not marked as the station opens on Microsoft sign-in; the LAB form is
  // one link away (a marked station opens straight on it).
  await expect(stationPage.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await stationPage.getByRole('link', { name: 'Sign in as LAB' }).click();
  await expect(stationPage).toHaveURL(/[?&]method=lab/);
  const form = stationPage.getByRole('region', { name: 'Shared receiving station', exact: true });
  await expect(form.getByText('Forgot password? Ask an administrator.')).toBeVisible();
  await form.getByLabel('Password').fill(password);
  await form.getByRole('button', { name: 'Sign in as LAB' }).click();
  await pickWhoIsWorking(stationPage);
  const account = accountRow(stationPage);
  await expect(account).toContainText('LAB station');
  // D38 (session length) is an open gate: no session end time is shown.
  await expect(account).not.toContainText('Session ends');

  // The cookie is persistent, lasting about a calendar month (28–31 days).
  const cookie = (await station.cookies()).find((c) => c.name === 'materialmule_session');
  const days = ((cookie?.expires ?? 0) * 1000 - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(27.9);
  expect(days).toBeLessThan(31.1);

  // LAB can't reach administration (server-side).
  const admin = await stationPage.request.get('/api/admin/lab');
  expect(admin.status()).toBe(403);

  // Close the browser and reopen it with what it stored: still signed in as LAB.
  const stored = await station.storageState();
  await station.close();
  const reopened = await browser.newContext({ baseURL, storageState: stored });
  const reopenedPage = await reopened.newPage();
  await reopenedPage.goto('/');
  // The picked person lasts for the tab only, so the reopened station asks again.
  await pickWhoIsWorking(reopenedPage);
  await expect(accountRow(reopenedPage)).toContainText('LAB station');

  // When the session is gone, the station explains that the draft is kept.
  await reopened.clearCookies();
  await reopenedPage.goto('/receiving-log/new');
  await expect(reopenedPage).toHaveURL(/\/sign-in\?/);
  await expect(reopenedPage.getByRole('status')).toHaveText(
    'The LAB session has expired. Your draft is saved. Sign in to confirm.',
  );
  await reopened.close();
});
