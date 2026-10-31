import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MTR-94: on a 375 px phone every control a person taps is at least 44 × 44 px: buttons, the
// action requests bell, date and select fields (the receive step's too), checkbox rows (the label
// is the hit area), back links, "See all" links and the dashboard filter chips. Inline links in a
// sentence or a table cell are exempt (WCAG 2.5.8) and not measured.

test.skip(({ isMobile }) => !isMobile, 'Phone layout only');
test.use({ viewport: { width: 375, height: 812 } });

const TARGETS = [
  'button',
  'select',
  'input:not([type="checkbox"], [type="radio"], [type="hidden"])',
  'label:has(> input[type="checkbox"])',
  'label:has(> input[type="radio"])',
  '.back-link a',
  '.see-all-link',
  '.action-bell',
  '.action-bell-item',
  '.action-bell-all',
  '.app-brand',
].join(', ');

async function smallTargets(page: Page): Promise<string[]> {
  return page.evaluate((selector) => {
    return [...document.querySelectorAll<HTMLElement>(selector)]
      .filter((element) => element.closest('[hidden], .visually-hidden') === null)
      .map((element) => ({ element, box: element.getBoundingClientRect() }))
      .filter(({ box }) => box.width > 0 && box.height > 0)
      .filter(({ box }) => box.width < 43.5 || box.height < 43.5)
      .map(({ element, box }) => {
        const name = (element.getAttribute('aria-label') ?? element.textContent ?? '').trim();
        return `${element.tagName.toLowerCase()} "${name.slice(0, 30)}" ${Math.round(box.width)}×${Math.round(box.height)}`;
      });
  }, TARGETS);
}

for (const route of [
  '/',
  '/receiving-log/new',
  '/sample-storage',
  '/sample-storage/scan',
  '/sample-storage/move',
  '/disposal-retention/scan',
]) {
  test(`MTR-94: ${route} has 44 px touch targets at 375 px`, async ({ page }) => {
    await signInAs(page, 'at');
    await page.goto(route);
    await expect(page.getByRole('main')).toBeVisible();
    await expect(page.locator('[aria-busy="true"]')).toHaveCount(0);
    if (route === '/receiving-log/new') {
      await expect(page.getByLabel('Physical holder').first()).toBeVisible();
    }
    expect(await smallTargets(page)).toEqual([]);
  });
}

test('MTR-94: the open menu and the bell popover have 44 px targets', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');
  await page.getByRole('button', { name: /^Action requests/ }).click();
  await expect(page.locator('.action-bell-panel')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Menu', exact: true }).click();
  await expect(page.locator('.side-nav-footer')).toBeVisible();
  expect(await smallTargets(page)).toEqual([]);
});
