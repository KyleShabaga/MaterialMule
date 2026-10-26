import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

test('signed-out visitors land on sign-in and return to where they were going', async ({
  page,
}) => {
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Fprojects/);
  await page.getByRole('link', { name: 'Test sign-in (development only)' }).click();
  await page.getByRole('button', { name: 'Alex Tester' }).click();
  await page.getByRole('link', { name: 'Continue to Trapezoid' }).click();
  await expect(page).toHaveURL(/\/projects$/);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();
});

test('AC1/AC4: header identity, menu and Receive samples', async ({ page }) => {
  await signInAs(page, 'lab');
  await page.goto('/');

  const header = page.getByLabel('Signed in user');
  await expect(header).toContainText('Lab (test)');
  await expect(header).toContainText('TEST');

  const menu = page.getByRole('navigation', { name: 'Main' });
  if (await page.getByRole('button', { name: 'Menu' }).isVisible()) {
    // Phone width: the menu is a drawer, and Receive samples is visible without opening it.
    await expect(page.getByRole('link', { name: 'Receive samples' })).toBeInViewport();
    await page.getByRole('button', { name: 'Menu' }).click();
  }
  for (const label of ['Dashboard', 'Receiving Log', 'Sample Storage', 'Projects', 'Settings']) {
    await expect(menu.getByRole('link', { name: label })).toBeVisible();
  }
  // AC7: later-increment areas stay hidden.
  await expect(menu.getByRole('link', { name: 'Lab Testing Worklist' })).toHaveCount(0);

  await menu.getByRole('link', { name: 'Dashboard' }).click();
  await page.getByRole('link', { name: 'Receive samples' }).click();
  // The open receipt draft's ID is added to the URL (TRP-T11).
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
  await expect(page.getByLabel('Signed in user')).toContainText('Admin (test)');

  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByText('Admin (test)')).toHaveCount(0);

  await signInAs(page, 'at');
  await page.goto('/');
  await expect(page.getByLabel('Signed in user')).toContainText('Alex Tester');
  await expect(page.getByText('Admin (test)')).toHaveCount(0);
});
