import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// STRATA-32/33/50 (wave 3 accessibility pass, DESIGN.md › Accessibility and › Hover, focus and
// motion). Desktop layout: drawers sit beside the list from 1024 px. Fictional data only.

test.skip(({ isMobile }) => isMobile, 'Desktop layout (drawers beside the list)');

/** Open a drawer by clicking, then: reload keeps it open; Back closes it and stays on the list. */
async function drawerSurvivesReloadAndBack(
  page: Page,
  list: string,
  open: () => Promise<void>,
  drawer: Locator,
) {
  await open();
  await expect(drawer).toBeVisible();
  await expect(page).toHaveURL(/[?&]open=/);
  await page.reload();
  await expect(drawer).toBeVisible();
  await page.goBack();
  await expect(drawer).toHaveCount(0);
  await expect(page).not.toHaveURL(/[?&]open=/);
  await expect(page).toHaveURL(new RegExp(`${list.replace(/[?]/g, '\\?')}`));
}

test('?open= drawers: reload keeps the drawer and Back closes it', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'admin');

  // Inventory: the unit drawer.
  await page.goto(`/sample-storage?search=${data.tag}`);
  await drawerSurvivesReloadAndBack(
    page,
    '/sample-storage',
    () => page.getByRole('link', { name: data.a1, exact: true }).click(),
    page.getByRole('region', { name: data.a1 }),
  );

  // Staff: a person (read only; nothing is changed).
  await page.goto('/admin/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await drawerSurvivesReloadAndBack(
    page,
    '/admin/staff',
    () => page.getByRole('button', { name: 'Manage Alex Tester' }).click(),
    page.getByRole('region', { name: 'Alex Tester', exact: true }),
  );

  // Locations: the receiving lab (reference data).
  await page.goto('/admin/locations');
  const locations = page.getByRole('table', { name: 'Locations' });
  await expect(locations).toBeVisible();
  await drawerSurvivesReloadAndBack(
    page,
    '/admin/locations',
    () =>
      locations
        .locator('tbody tr', { hasText: 'RECEIVING' })
        .getByRole('button', { name: 'Receiving lab' })
        .click(),
    page.getByRole('region', { name: 'Receiving lab' }),
  );
});

test('reduced motion: nothing animates, opening a drawer included', async ({ browser }) => {
  const data = await insertInventoryFixture();
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    reducedMotion: 'reduce',
  });
  const page = await context.newPage();
  await signInAs(page, 'at');
  await page.goto(`/sample-storage?search=${data.tag}`);
  await expect(page.getByRole('link', { name: data.a1, exact: true })).toBeVisible();
  const moving = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('*')].filter((element) => {
          const style = getComputedStyle(element);
          return (
            parseFloat(style.transitionDuration) > 0.02 ||
            (style.animationName !== 'none' && parseFloat(style.animationDuration) > 0.02)
          );
        }).length,
    );
  expect(await moving()).toBe(0);
  await page.getByRole('link', { name: data.a1, exact: true }).click();
  await expect(page.getByRole('region', { name: data.a1 })).toBeVisible();
  expect(await moving()).toBe(0);
  await context.close();
});

test('forced colours: sidebar rows draw no boxes; keyboard focus still shows', async ({
  browser,
}) => {
  const context = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
    forcedColors: 'active',
  });
  const page = await context.newPage();
  await signInAs(page, 'at');
  await page.goto('/');
  const nav = page
    .getByRole('navigation', { name: 'Main' })
    .or(page.locator('[data-slot=sidebar]'));
  await expect(nav.first()).toBeVisible();
  const outlined = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('[data-slot=sidebar] *')].filter((element) => {
          if (element === document.activeElement) return false;
          const style = getComputedStyle(element);
          return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
        }).length,
    );
  expect(await outlined()).toBe(0);
  // Tab to the first sidebar row: its outline is the focus ring in a contrast theme.
  const today = page.locator('[data-slot=sidebar]').getByRole('link', { name: 'Today' });
  await today.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(today).toBeFocused();
  const ring = await today.evaluate((element) => {
    const style = getComputedStyle(element);
    return style.outlineStyle !== 'none' && parseFloat(style.outlineWidth) > 0;
  });
  expect(ring).toBe(true);
  await context.close();
});

test('200 % zoom (720 px): pages reflow without sideways scrolling and IDs stay whole', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await page.setViewportSize({ width: 720, height: 450 });
  await signInAs(page, 'admin');
  for (const path of [
    '/',
    `/sample-storage?search=${data.tag}`,
    '/receiving-log',
    '/disposal-retention',
    '/lab-testing/programs',
    '/inbox',
    '/admin/staff',
    '/admin/locations',
  ]) {
    await page.goto(path);
    await expect(page.locator('h1')).toHaveCount(1);
    await page.waitForLoadState('networkidle');
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, `${path} scrolls sideways`).toBeLessThanOrEqual(0);
  }
  await page.goto(`/sample-storage?search=${data.tag}`);
  const id = page.getByRole('link', { name: data.a1, exact: true });
  await expect(id).toBeVisible();
  const whole = await id.evaluate((element) => element.scrollWidth <= element.clientWidth + 1);
  expect(whole).toBe(true);
});
