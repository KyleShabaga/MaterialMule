import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { signInAsLabStation } from './support/lab-station';
import { uniqueTag } from './support/receiving';
import { isPhoneLayout, openAccountMenu } from './support/shell';

// Help and Feedback & bugs (STRATA-103/104, round 10): the Help drawer beside the page, the
// /help page (also signed out), and the Feedback & bugs dialog, whose messages stay on the host:
// a person sends one, an administrator reads it on /help. Fictional text only.

test('Feedback & bugs is a dialog over the page; an administrator reads it on Help', async ({
  page,
}) => {
  const text = `The label preview was hard to read ${uniqueTag('help')}`;

  await signInAs(page, 'at');
  await page.goto('/sample-storage?search=DEMO-2601');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  const menu = await openAccountMenu(page);
  await menu.getByRole('menuitem', { name: 'Feedback & bugs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Feedback & bugs' });
  await expect(dialog).toBeVisible();
  // The page stays where it was, and only its path goes with the message.
  await expect(page).toHaveURL(/\/sample-storage\?search=DEMO-2601$/);
  await expect(dialog.getByRole('checkbox', { name: 'Include the page I was on' })).toBeChecked();
  await expect(dialog).toContainText('/sample-storage');
  await expect(dialog).not.toContainText('DEMO-2601');
  await expect(dialog).toContainText(
    'Stays inside the office. Nothing is sent outside the building.',
  );

  await dialog.getByRole('button', { name: 'Send to the administrator' }).click();
  await expect(dialog.getByText('Write a few words about what happened first.')).toBeVisible();
  await dialog.getByRole('radio', { name: 'Question' }).click();
  await dialog.getByLabel('What happened').fill(text);
  await dialog.getByRole('button', { name: 'Send to the administrator' }).click();
  await expect(page.getByRole('heading', { name: 'Sent.' })).toBeVisible();
  await expect(page.getByText('An administrator will read it here in the office.')).toBeVisible();
  await page.getByRole('button', { name: 'Done' }).click();
  await expect(dialog).toHaveCount(0);

  // Only administrators see what was sent.
  await page.goto('/help');
  await expect(page.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Feedback received' })).toHaveCount(0);

  await signInAs(page, 'admin');
  await page.goto('/help');
  const received = page.getByRole('region', { name: 'Feedback received' });
  await expect(received.getByText(text)).toBeVisible();
  await expect(received.getByText('/sample-storage', { exact: true }).first()).toBeVisible();
});

test('? opens the Help drawer beside the page; Esc closes it', async ({ page }) => {
  test.skip(isPhoneLayout(page), 'The drawer is for 1024 px and up; phones open /help.');
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  // Nothing editable focused: ? is a shortcut, not typing.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('?');
  const help = page.getByRole('complementary', { name: 'Help' });
  await expect(help.getByRole('heading', { level: 2, name: 'Help for Inventory' })).toBeVisible();
  // The page stays in place beside the drawer.
  await expect(page).toHaveURL(/\/sample-storage$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Inventory' })).toBeVisible();
  await expect(help.getByRole('button', { name: 'Find a unit' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );

  await help.getByRole('searchbox', { name: 'Search help' }).fill('invoice');
  await expect(help.getByText('No guide matches “invoice”.')).toBeVisible();
  await help.getByRole('button', { name: 'Clear search' }).click();
  await help.getByRole('button', { name: /^Keyboard shortcuts, \d+$/ }).click();
  await expect(help.getByRole('heading', { level: 2, name: 'Keyboard shortcuts' })).toBeVisible();
  await help.getByRole('button', { name: 'All help' }).click();

  await help.getByRole('heading', { level: 2, name: 'Help for Inventory' }).focus();
  await page.keyboard.press('Escape');
  await expect(help).toHaveCount(0);

  // Account menu › Help opens it too; Open as full page goes to the guide's anchor on /help.
  const menu = await openAccountMenu(page);
  await menu.getByRole('menuitem', { name: 'Help', exact: true }).click();
  await expect(help).toBeVisible();
  await help.getByRole('link', { name: 'Open as full page' }).click();
  await expect(page).toHaveURL(/\/help#find-unit$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
  await expect(help).toHaveCount(0);
});

test('/help works signed out, without the app, with Back to sign in', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help', exact: true })).toHaveAttribute(
    'href',
    '/help',
  );
  await page.goto('/help#sidebar');
  await expect(page).toHaveURL(/\/help#sidebar$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
  await expect(page.getByText(/You’re not signed in/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'How the sidebar works' })).toHaveAttribute(
    'aria-expanded',
    'true',
  );
  await expect(page.getByRole('navigation', { name: 'Main' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Feedback received' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Back to sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
});

test('the LAB station picker’s help link opens the guides without leaving the station', async ({
  page,
}) => {
  await signInAsLabStation(page, { person: null });
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Who is working here?' })).toBeVisible();
  await page.getByRole('link', { name: 'How LAB stations work' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'How LAB stations work' })).toBeVisible();
  await page.getByRole('link', { name: 'Back to Who is working here?' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Who is working here?' })).toBeVisible();
});
