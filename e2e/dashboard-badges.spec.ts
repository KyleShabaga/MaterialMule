import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { receiveThroughApi } from './support/receiving';

// MTR-92 (second half): at 820 px the Recently received badges ("No label yet") stay on one line;
// the table scrolls inside its card (a focusable region) rather than wrapping them or widening
// the page. Desktop only: the width is set here.

test.skip(({ isMobile }) => isMobile, 'Sets its own width');

test('MTR-92: Recently received badges stay on one line at 820 px', async ({ page }) => {
  await signInAs(page, 'at');
  await receiveThroughApi(page);
  await page.setViewportSize({ width: 820, height: 1024 });
  await page.goto('/');
  const region = page.getByRole('region', { name: 'Recent unit table' });
  await expect(region.getByText('No label yet').first()).toBeVisible();
  await expect(region).toHaveAttribute('tabindex', '0');

  const heights = await region
    .locator('.badge')
    .evaluateAll((badges) => badges.map((badge) => badge.getBoundingClientRect().height));
  expect(heights.length).toBeGreaterThan(0);
  // One line: the 20 px badge height (--badge-height), never two or three lines.
  for (const height of heights) expect(height).toBeLessThan(28);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    ),
  ).toBeLessThanOrEqual(0);
});
