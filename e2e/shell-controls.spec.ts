import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { mainNav, moreButton, openMore } from './support/shell';

// Bugs & UI lane B, Field Ledger shell: phone More sheet focus (MTR-137, was the drawer), the rail
// groups and the rail footer (MISC-09).

test('MTR-137: the phone More sheet keeps focus, closes on Escape and outside taps, and returns focus', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  const more = moreButton(page);
  const nav = mainNav(page);
  // One "Main" navigation: the bottom bar, no rail.
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(1);
  for (const slot of ['Today', 'Find', 'Scan', 'Receive']) {
    await expect(nav.getByRole('link', { name: slot, exact: true })).toBeVisible();
  }

  await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeFocused();
  await expect(page.locator('#main')).toHaveAttribute('inert', '');
  await expect(page.getByRole('banner')).toHaveAttribute('inert', '');
  // Tabbing never lands on what the sheet covers.
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    const inCovered = await page.evaluate(
      () => !!document.activeElement?.closest('#main, .phone-header, .phone-bar li[inert]'),
    );
    expect(inCovered, `Tab ${i + 1}`).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
  await expect(page.locator('#main')).not.toHaveAttribute('inert');

  // A tap on the page behind (the scrim) closes it.
  await more.click();
  await page.mouse.click(200, 10);
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  await expect(more).toBeFocused();
});

test('Field Ledger: rail groups open inside their section and toggle with the chevron', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop rail only');
  await signInAs(page, 'at');
  await page.goto('/disposal-retention/scan');
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: 'Disposal scan' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  const hide = nav.getByRole('button', { name: 'Hide Retention pages' });
  await expect(hide).toHaveAttribute('aria-expanded', 'true');
  await hide.click();
  await expect(nav.getByRole('link', { name: 'Disposal scan' })).toBeHidden();
  await expect(nav.getByRole('button', { name: 'Show Retention pages' })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  // Concrete stays closed outside its section.
  await expect(nav.getByRole('button', { name: 'Show Concrete pages' })).toBeVisible();
  await expect(nav.getByRole('link', { name: 'Breaks', exact: true })).toBeHidden();
});

test('MISC-09: the dark mode switch applies at once and survives a reload', async ({ page }) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signInAs(page, 'at');
  await page.goto('/');
  await openMore(page);
  const toggle = page.getByRole('switch', { name: 'Dark mode' });
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    lightBg,
  );

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await openMore(page);
  await expect(page.getByRole('switch', { name: 'Dark mode' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  // An explicit light choice wins over a dark OS setting.
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.getByRole('switch', { name: 'Dark mode' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(lightBg);
});

test('MISC-09: server health reads connected, then unreachable when the API is down', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await page.goto('/');
  await openMore(page);
  const nav = mainNav(page);
  await expect(nav.locator('.server-health')).toHaveText('Server connected');
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  // Health is re-checked when the window regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(nav.locator('.server-health')).toHaveText('Server unreachable');
});
