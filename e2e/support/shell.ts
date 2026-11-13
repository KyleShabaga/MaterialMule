import { expect, type Locator, type Page } from '@playwright/test';

// Strata shell (DESIGN.md › Shell, › Sidebar): on desktop the sidebar ("Main" navigation) holds
// the destinations and, in its footer, the account row and its menu (Settings, Help, Feedback &
// bugs, Sign out). Under 768 px the sidebar is a Sheet opened from the top bar's Toggle Sidebar
// button; the page behind is inert while it is open.

/** Phone layout: the sidebar is a Sheet opened from the top bar instead of always shown. */
export function isPhoneLayout(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) < 768;
}

export function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

/**
 * Makes the sidebar's contents reachable: on a phone opens the sidebar Sheet from the top bar
 * (closed again by `closeMore`); on desktop does nothing, the sidebar is always there.
 */
export async function openMore(page: Page): Promise<void> {
  if (!isPhoneLayout(page)) return;
  // A Sheet still closing (a link was just followed) finishes first.
  await expect(sidebarSheet(page).and(page.locator('[data-state="closed"]'))).toHaveCount(0);
  if ((await sidebarSheet(page).count()) === 0) {
    await page.getByRole('banner').getByRole('button', { name: 'Toggle Sidebar' }).click();
  }
  // Waits out a menu inside the Sheet that is still closing (it hides the rest while open).
  await expect(mainNav(page)).toBeVisible();
}

/** Closes the phone sidebar Sheet if it is open. */
export async function closeMore(page: Page): Promise<void> {
  if (!isPhoneLayout(page)) return;
  if (await mainNav(page).isVisible()) await page.keyboard.press('Escape');
  await expect(sidebarSheet(page)).toHaveCount(0);
}

/**
 * The phone sidebar Sheet element, open or closing. A CSS locator, so it is found even while an
 * open menu hides the rest of the page from the accessibility tree.
 */
function sidebarSheet(page: Page): Locator {
  return page.locator('[data-slot="sidebar"][data-mobile="true"]');
}

/** The account row in the sidebar footer (name, role line, TEST tag; LAB station on a station). */
export function accountRow(page: Page): Locator {
  return page.getByRole('group', { name: 'Signed in user' });
}

/** Opens the sidebar Sheet on a phone, then returns the account row. */
export async function openAccount(page: Page): Promise<Locator> {
  await openMore(page);
  return accountRow(page);
}

/** Opens the footer account menu ("<name>, <line>. Account menu") and returns the menu. */
export async function openAccountMenu(page: Page): Promise<Locator> {
  const row = await openAccount(page);
  await row.getByRole('button', { name: /Account menu$/ }).click();
  const menu = page.getByRole('menu');
  await expect(menu).toBeVisible();
  return menu;
}

/** Signs out through the account menu (End station session on a shared LAB station). */
export async function signOut(page: Page): Promise<void> {
  const menu = await openAccountMenu(page);
  await menu.getByRole('menuitem', { name: /^(Sign out|End station session)$/ }).click();
}
