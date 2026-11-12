import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { mainNav, openAccountMenu, openMore } from './support/shell';

// Strata shell (DESIGN.md › Shell, › Sidebar; STRATA-8, 9, 12, 15, 42): the phone Sheet, Retention
// and folding sections, Ctrl B and the collapsed rail, the account menu's theme, server health.

test('phone: the sidebar is a Sheet from the top bar; it keeps focus and Escape returns it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  const toggle = page.getByRole('banner').getByRole('button', { name: 'Toggle Sidebar' });
  // Closed: no "Main" navigation at all; the old bottom bar is gone.
  await expect(mainNav(page)).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'More', exact: true })).toHaveCount(0);

  await toggle.click();
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: 'Projects', exact: true })).toBeVisible();
  // Tabbing stays inside the Sheet (Radix focus trap).
  for (let i = 0; i < 14; i += 1) {
    await page.keyboard.press('Tab');
    const inPage = await page.evaluate(() => !!document.activeElement?.closest('#main, header'));
    expect(inPage, `Tab ${i + 1}`).toBe(false);
  }
  await page.keyboard.press('Escape');
  await expect(mainNav(page)).toHaveCount(0);
  await expect(toggle).toBeFocused();

  // Following a link closes it.
  await toggle.click();
  await mainNav(page).getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await expect(mainNav(page)).toHaveCount(0);
});

test('Retention opens inside its section; section headings fold and the fold is kept', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop sidebar');
  await signInAs(page, 'at');
  await page.goto('/disposal-retention/scan');
  const nav = mainNav(page);
  await expect(nav.getByRole('link', { name: 'Disposal scan' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  // The layout is saved for the person on the server (STRATA-41): each fold waits for its save.
  const saved = () =>
    page.waitForResponse(
      (r) => r.url().endsWith('/api/me/sidebar-layout') && r.request().method() === 'PUT',
    );
  const retention = nav.getByRole('button', { name: 'Retention', exact: true });
  await expect(retention).toHaveAttribute('aria-expanded', 'true');
  let save = saved();
  await retention.click();
  await expect(nav.getByRole('link', { name: 'Disposal scan' })).toBeHidden();
  expect((await save).status()).toBe(200);

  // Recent starts folded; folding Concrete hides its pages and survives a reload.
  await expect(nav.getByRole('button', { name: 'Recent', exact: true })).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(nav.getByRole('link', { name: 'Breaks', exact: true })).toBeVisible();
  save = saved();
  await nav.getByRole('button', { name: 'Concrete', exact: true }).click();
  await expect(nav.getByRole('link', { name: 'Breaks', exact: true })).toBeHidden();
  expect((await save).status()).toBe(200);
  await page.reload();
  await expect(mainNav(page).getByRole('link', { name: 'Inventory', exact: true })).toBeVisible();
  await expect(mainNav(page).getByRole('link', { name: 'Breaks', exact: true })).toBeHidden();
  // Unfold again: other specs sign in as the same person.
  save = saved();
  await mainNav(page).getByRole('button', { name: 'Concrete', exact: true }).click();
  await expect(mainNav(page).getByRole('link', { name: 'Breaks', exact: true })).toBeVisible();
  expect((await save).status()).toBe(200);
});

test('Ctrl B collapses to a 60 px rail with 44 px icons, is remembered, and leaves text fields alone', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'desktop sidebar');
  await signInAs(page, 'at');
  await page.goto('/');
  const sidebar = page.locator('[data-slot="sidebar"]');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');

  await page.locator('body').press('Control+b');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  const container = page.locator('[data-slot="sidebar-container"]');
  await expect.poll(async () => Math.round((await container.boundingBox())!.width)).toBe(60);
  const today = mainNav(page).getByRole('link', { name: 'Today', exact: true });
  const box = (await today.boundingBox())!;
  expect(Math.round(box.width)).toBe(44);
  expect(Math.round(box.height)).toBe(44);
  // A tooltip names the icon; Retention opens its pages in a menu to the right.
  await today.hover();
  await expect(page.getByRole('tooltip', { name: 'Today' })).toBeVisible();
  await mainNav(page).getByRole('button', { name: 'Retention pages' }).click();
  await page.getByRole('menuitem', { name: 'Disposal scan' }).click();
  await expect(page).toHaveURL(/\/disposal-retention\/scan$/);

  await page.reload();
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');

  // In a text field Ctrl B is the field's (bold), not the sidebar's.
  await page.goto('/sample-storage');
  const search = page.getByRole('main').getByRole('textbox').first();
  await search.focus();
  await search.press('Control+b');
  await expect(sidebar).toHaveAttribute('data-state', 'collapsed');
  // Out of the field (focusing <body> can't take focus from it), Ctrl B is the sidebar's again.
  await search.blur();
  await page.keyboard.press('Control+b');
  await expect(sidebar).toHaveAttribute('data-state', 'expanded');
});

test('STRATA-7/15: Light, Dark and System in the account menu apply at once and survive a reload', async ({
  page,
}) => {
  await page.emulateMedia({ colorScheme: 'light' });
  await signInAs(page, 'at');
  await page.goto('/');
  const lightBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);

  let menu = await openAccountMenu(page);
  await expect(menu.getByRole('menuitemradio', { name: 'System' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await menu.getByRole('menuitemradio', { name: 'Dark' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).not.toBe(
    lightBg,
  );

  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  // An explicit light choice wins over a dark OS setting; System follows the OS again.
  await page.emulateMedia({ colorScheme: 'dark' });
  menu = await openAccountMenu(page);
  await expect(menu.getByRole('menuitemradio', { name: 'Dark' })).toHaveAttribute(
    'aria-checked',
    'true',
  );
  await menu.getByRole('menuitemradio', { name: 'Light' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await page.evaluate(() => getComputedStyle(document.body).backgroundColor)).toBe(lightBg);
  await menu.getByRole('menuitemradio', { name: 'System' }).click();
  await expect(page.locator('html')).not.toHaveAttribute('data-theme');
});

test('MISC-09: server health shows only when the API is unreachable', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');
  await openMore(page);
  const health = page.locator('.server-health');
  await expect(health).toHaveText('Server connected');
  await expect(health).toHaveClass(/sr-only/);
  await page.route('**/api/health', (route) => route.abort('connectionrefused'));
  // Health is re-checked when the window regains focus.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(health).toHaveText('Server unreachable');
  await expect(health).toBeVisible();
});
