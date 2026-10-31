import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { openWizard } from './support/receiving';

// MTR-136: keyboard focus never falls to the page body after picking a project, removing a
// bucket, closing the Add location panel or following a menu link. Keyboard only; fictional data
// (DEMO-2601). Nothing is saved: the receipt stays a draft and no location is added.

const activeTag = (page: Page) => page.evaluate(() => document.activeElement?.tagName ?? 'NONE');

test('MTR-136: picking a project focuses Change project', async ({ page }) => {
  await signInAs(page, 'at');
  await openWizard(page);
  const project = page.getByRole('combobox', { name: /Find project/ });
  await project.fill('DEMO-260');
  await expect(page.getByRole('option').first()).toHaveAttribute('aria-selected', 'true');
  await project.press('ArrowDown');
  await project.press('Enter');
  const change = page.getByRole('button', { name: 'Change project' });
  await expect(change).toBeFocused();
  await change.press('Enter');
  await expect(page.getByRole('combobox', { name: /Find project/ })).toBeFocused();
  expect(await activeTag(page)).not.toBe('BODY');
});

test('MTR-136: removing a bucket focuses the bucket before it, then Add bucket', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await openWizard(page);
  const add = page.getByRole('button', { name: 'Add bucket' });
  for (const n of [2, 3]) {
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { level: 3, name: `Bucket ${n}` })).toBeVisible();
  }
  await page.getByRole('button', { name: 'Remove Bucket 3' }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 3, name: 'Bucket 2' })).toBeFocused();
  for (const name of ['Remove Bucket 2', 'Remove Bucket 1']) {
    await page.getByRole('button', { name }).focus();
    await page.keyboard.press('Enter');
    expect(await activeTag(page)).not.toBe('BODY');
  }
  await expect(page.getByRole('button', { name: 'Add bucket' })).toBeFocused();
});

test('MTR-136: closing the Add location panel returns focus to Add location', async ({ page }) => {
  await signInAs(page, 'lab'); // Lab Manager: full Locations page
  await page.goto('/settings/locations');
  const trigger = page.getByRole('button', { name: 'Add location' });
  const panel = page.getByRole('dialog', { name: 'Add location' });

  await trigger.focus();
  await page.keyboard.press('Enter');
  await expect(panel).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await page.keyboard.press('Enter');
  await panel.getByRole('button', { name: 'Close' }).focus();
  await page.keyboard.press('Enter');
  await expect(panel).toHaveCount(0);
  await expect(trigger).toBeFocused();
});

test('MTR-136: a menu link moves focus to the new page heading', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
  // Phone width: the side menu opens from the header first.
  const menu = page.getByRole('button', { name: 'Menu' });
  if (await menu.isVisible()) await menu.click();
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Projects' })
    .focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();
});

test('MTR-133: required fields are marked and a failed Add location focuses the first error', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await openWizard(page);
  const details = page.getByRole('region', { name: 'Details' });
  await expect(details.getByText('(required)')).toHaveCount(3);

  await signInAs(page, 'lab');
  await page.goto('/settings/locations');
  await page.getByRole('button', { name: 'Add location' }).click();
  const panel = page.getByRole('dialog', { name: 'Add location' });
  await expect(panel.getByText('(required)')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Add location' }).click();
  const code = panel.getByRole('textbox', { name: 'Code' });
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(panel.getByText(/Use 2–20 letters, digits or hyphens/)).toHaveCount(1);
});
