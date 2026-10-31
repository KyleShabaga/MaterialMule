import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// Bugs & UI lane B: phone drawer focus (MTR-137) and the sidebar footer (MISC-09).

test('MTR-137: the phone drawer keeps focus, closes on Escape and outside taps, and returns focus', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  const menu = page.getByRole('button', { name: 'Menu' });
  const nav = page.getByRole('navigation', { name: 'Main' });

  await menu.click();
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.getByRole('link', { name: 'Dashboard' })).toBeFocused();
  await expect(page.locator('#main')).toHaveAttribute('inert', '');
  await expect(page.getByLabel('Signed in user')).toHaveAttribute('inert', '');
  // Tabbing never lands on what the drawer covers.
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    const inCovered = await page.evaluate(
      () => !!document.activeElement?.closest('#main, .identity, .action-bell-wrap'),
    );
    expect(inCovered, `Tab ${i + 1}`).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
  await expect(menu).toBeFocused();
  await expect(page.locator('#main')).not.toHaveAttribute('inert');

  await menu.click();
  await page.locator('.app-brand').click();
  await expect(menu).toHaveAttribute('aria-expanded', 'false');
});

test('MISC-09: the dark mode switch applies at once and survives a reload', async ({
  page,
}, testInfo) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signInAs(page, 'at');
  await page.goto('/');
  if (testInfo.project.name === 'phone-chromium') {
    await page.getByRole('button', { name: 'Menu' }).click();
  }
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
  if (testInfo.project.name === 'phone-chromium') {
    await page.getByRole('button', { name: 'Menu' }).click();
  }
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
}, testInfo) => {
  await signInAs(page, 'at');
  await page.goto('/');
  if (testInfo.project.name === 'phone-chromium') {
    await page.getByRole('button', { name: 'Menu' }).click();
  }
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expect(nav.locator('.server-health')).toHaveText('Server connected');
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  // Health is re-checked when the window regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(nav.locator('.server-health')).toHaveText('Server unreachable');
});
