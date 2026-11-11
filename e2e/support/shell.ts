import { expect, type Locator, type Page } from '@playwright/test';

// Field Ledger shell: on desktop the rail ("Main" navigation) holds the destinations, Pending
// actions, Settings, Help & Feedback and the account row; on a phone (≤ 640 px) those live in the
// More sheet above the five-slot bottom bar (Today, Find, Scan, Receive, More).

/** Phone layout: the bottom bar and More sheet instead of the rail. */
export function isPhoneLayout(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) <= 640;
}

export function mainNav(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Main' });
}

export function moreButton(page: Page): Locator {
  return mainNav(page).getByRole('button', { name: 'More', exact: true });
}

/**
 * Makes the rail's contents reachable: on a phone opens the More sheet (the page behind is inert
 * until `closeMore`); on desktop does nothing, the rail is always there.
 */
export async function openMore(page: Page): Promise<void> {
  if (!isPhoneLayout(page)) return;
  const more = moreButton(page);
  if ((await more.getAttribute('aria-expanded')) !== 'true') await more.click();
  await expect(more).toHaveAttribute('aria-expanded', 'true');
}

/** Closes the phone More sheet if it is open (Escape returns focus to More). */
export async function closeMore(page: Page): Promise<void> {
  if (!isPhoneLayout(page)) return;
  const more = moreButton(page);
  if ((await more.getAttribute('aria-expanded')) === 'true') await page.keyboard.press('Escape');
  await expect(more).toHaveAttribute('aria-expanded', 'false');
}

/** The account row (name, role, tag, Sign out; Switch user and session end for LAB). */
export function accountRow(page: Page): Locator {
  return page.getByRole('group', { name: 'Signed in user' });
}

/** Opens the More sheet on a phone, then returns the account row. */
export async function openAccount(page: Page): Promise<Locator> {
  await openMore(page);
  return accountRow(page);
}
