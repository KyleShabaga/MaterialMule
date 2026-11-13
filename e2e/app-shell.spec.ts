import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import {
  isPhoneLayout,
  mainNav,
  openAccount,
  openAccountMenu,
  openMore,
  signOut,
} from './support/shell';

test('signed-out visitors land on sign-in and return to where they were going', async ({
  page,
}) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprojects/);
  await page.getByRole('link', { name: 'Test sign-in (development only)' }).click();
  await page.getByRole('button', { name: 'Alex Tester' }).click();
  await page.getByRole('link', { name: 'Continue to Material Mule' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('AC1/AC4: account row, sidebar and Receive samples', async ({ page }) => {
  await signInAs(page, 'lab');
  await page.goto('/');

  // Phone width: Receive samples is visible before the sidebar Sheet is opened.
  if (isPhoneLayout(page)) {
    await expect(page.getByRole('link', { name: 'Receive samples' })).toBeInViewport();
  }
  const account = await openAccount(page);
  await expect(account).toContainText('Lab (test)');
  await expect(account).toContainText('TEST');

  const menu = mainNav(page);
  // Strata sidebar (DESIGN.md › Sidebar): Today, Projects; then Storage units, Soils, Concrete.
  for (const label of [
    'Today',
    'Projects',
    'Receive',
    'Inventory',
    'Lab programs',
    'Workboard',
    'Overview',
    'Breaks',
    'Review',
  ]) {
    await expect(menu.getByRole('link', { name: label, exact: true }).first()).toBeVisible();
  }
  await expect(menu.getByRole('button', { name: 'Retention', exact: true })).toBeVisible();
  // The old lab placeholders and pre-redesign menu names are gone (MM-T23, STRATA-10).
  for (const gone of ['Lab Testing Worklist', 'Testing Programs', 'Dashboard', 'Sample Storage']) {
    await expect(menu.getByRole('link', { name: gone })).toHaveCount(0);
  }
  // Settings, Help and Feedback & bugs live in the account menu.
  const accountMenu = await openAccountMenu(page);
  for (const item of ['Settings', 'Help', 'Feedback & bugs', 'Sign out']) {
    await expect(accountMenu.getByRole('menuitem', { name: item, exact: true })).toBeVisible();
  }
  await page.keyboard.press('Escape');

  await openMore(page);
  await mainNav(page).getByRole('link', { name: 'Projects', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();
  await openMore(page);
  await mainNav(page).getByRole('link', { name: 'Today', exact: true }).click();
  await page.getByRole('link', { name: 'Receive samples' }).click();
  // The open receipt draft's ID is added to the URL (MM-T11).
  await expect(page).toHaveURL(/\/receiving-log\/new(\?draft=[\w-]+)?$/);
  await expect(page.getByRole('heading', { name: 'Receive samples' })).toBeVisible();
});

test('AC5: an expired session sends the user to sign in', async ({ page, context }) => {
  await signInAs(page, 'at');
  await page.goto('/settings');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();

  await context.clearCookies();
  await page.goto('/sample-storage');
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fsample-storage&expired=1/);
});

test('AC6: after sign-out, the next person sees none of the previous user', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto('/');
  const account = await openAccount(page);
  await expect(account).toContainText('Admin (test)');

  await signOut(page);
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText('Admin (test)')).toHaveCount(0);

  await signInAs(page, 'at');
  await page.goto('/');
  await expect(await openAccount(page)).toContainText('Alex Tester');
  await expect(page.getByText('Admin (test)')).toHaveCount(0);
});
