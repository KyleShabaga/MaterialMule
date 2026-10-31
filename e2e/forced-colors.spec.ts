import { expect, test, type Locator } from '@playwright/test';
import { signInAs } from './support/auth';

// MTR-131: under a Windows contrast theme (Chromium's forced-colors emulation) the selected
// dashboard filter, Standard/Compact segment, Settings tab, side-menu item and the dark mode
// switch still look different from the unselected ones. Desktop only: the side menu is open there.

test.skip(({ isMobile }) => isMobile, 'Desktop layout');
test.use({ forcedColors: 'active' });

/** The computed values a person can see that tell selected and unselected apart. */
function look(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    const style = getComputedStyle(element);
    return [
      style.backgroundColor,
      style.color,
      style.borderTopWidth,
      style.borderBottomWidth,
      style.borderLeftWidth,
      style.textDecorationLine,
    ].join(' | ');
  });
}

async function expectDifferent(selected: Locator, other: Locator, what: string) {
  await expect(selected).toBeVisible();
  await expect(other).toBeVisible();
  expect(await look(selected), what).not.toBe(await look(other));
}

test('MTR-131: selected states stay distinguishable in forced colours', async ({ page }) => {
  await signInAs(page, 'admin');

  await page.goto('/');
  const filters = page.getByRole('button', { name: 'All', exact: true });
  await expect(filters).toHaveAttribute('aria-pressed', 'true');
  await expectDifferent(
    filters,
    page.getByRole('button', { name: 'Today', exact: true }),
    'dashboard filter chip',
  );
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expectDifferent(
    nav.getByRole('link', { name: 'Dashboard' }),
    nav.getByRole('link', { name: 'Sample Storage' }),
    'side-menu item',
  );

  await page.goto('/sample-storage?status=all');
  const standard = page.getByRole('button', { name: 'Standard', exact: true });
  await standard.click();
  await expect(standard).toHaveAttribute('aria-pressed', 'true');
  await expectDifferent(
    standard,
    page.getByRole('button', { name: 'Compact', exact: true }),
    'Standard/Compact segment',
  );

  await page.goto('/settings/profile');
  const tabs = page.getByRole('navigation', { name: 'Settings' });
  await expect(tabs.getByRole('link', { name: 'My profile' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectDifferent(
    tabs.getByRole('link', { name: 'My profile' }),
    tabs.getByRole('link', { name: 'Locations' }),
    'Settings tab',
  );

  const toggle = page.getByRole('switch', { name: 'Dark mode' });
  const track = toggle.locator('.theme-switch-track');
  const thumb = toggle.locator('.theme-switch-thumb');
  const wasChecked = await toggle.getAttribute('aria-checked');
  const before = [await look(track), await look(thumb)].join(' / ');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', wasChecked === 'true' ? 'false' : 'true');
  const after = [await look(track), await look(thumb)].join(' / ');
  expect(after, 'dark mode switch on vs off').not.toBe(before);
});
