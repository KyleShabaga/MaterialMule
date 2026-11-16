import { expect, test, type Locator } from '@playwright/test';
import { signInAs } from './support/auth';

// MTR-131: under a Windows contrast theme (Chromium's forced-colors emulation) the selected
// dashboard filter, Inventory stage tab (STRATA-79; was the Standard/Compact segment), Settings
// tab, sidebar row, sidebar sub-page and the account menu's theme choice still look different
// from the unselected ones. Desktop only.

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

  // Strata: the Inbox's segmented tabs (STRATA-24; the Notifications filter before it).
  await page.goto('/inbox');
  const inboxTabs = page.getByRole('tablist', { name: 'Inbox' });
  const pressed = inboxTabs.getByRole('tab', { name: /^All/ });
  await expect(pressed).toHaveAttribute('aria-selected', 'true');
  await expectDifferent(
    pressed,
    inboxTabs.getByRole('tab', { name: /^Requests/ }),
    'segmented filter',
  );
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: 'Main' });
  await expectDifferent(
    nav.getByRole('link', { name: 'Today', exact: true }),
    nav.getByRole('link', { name: 'Inventory', exact: true }),
    'sidebar row',
  );

  await page.goto('/disposal-retention/scan');
  await expect(nav.getByRole('link', { name: 'Disposal scan' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expectDifferent(
    nav.getByRole('link', { name: 'Disposal scan' }),
    nav.getByRole('link', { name: 'Due and overdue' }),
    'sidebar sub-page',
  );

  // STRATA-79: Inventory's stage tabs (the old Standard/Compact segment is now a View menu).
  await page.goto('/sample-storage');
  const stages = page.getByRole('tablist', { name: 'Stage' });
  const all = stages.getByRole('tab', { name: /^All [\d,]+$/ });
  await expect(all).toHaveAttribute('aria-selected', 'true');
  await expectDifferent(
    all,
    stages.getByRole('tab', { name: /^In lab [\d,]+$/ }),
    'Inventory stage tab',
  );

  await page.goto('/settings/profile');
  const tabs = page.getByRole('navigation', { name: 'Settings' });
  await expect(tabs.getByRole('link', { name: 'Profile' })).toHaveAttribute('aria-current', 'page');
  await expectDifferent(
    tabs.getByRole('link', { name: 'Profile' }),
    tabs.getByRole('link', { name: 'Preferences' }),
    'Settings tab',
  );

  // Close Settings: the page behind (and its account menu) is inert while it is open.
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

  // The account menu's theme choice: the chosen one carries its dot, the others none.
  await page.getByRole('group', { name: 'Signed in user' }).getByRole('button').click();
  const chosen = page.getByRole('menuitemradio', { checked: true });
  const other = page.getByRole('menuitemradio', { checked: false }).first();
  await expect(chosen).toHaveCount(1);
  await expect(chosen.locator('svg.fill-current')).toBeVisible();
  await expect(other.locator('svg.fill-current')).toHaveCount(0);
});
