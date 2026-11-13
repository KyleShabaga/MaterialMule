import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { mainNav, openMore } from './support/shell';
import { chooseDemoProject, openWizard, toUnits } from './support/receiving';

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

test('MTR-136: removing a unit focuses the unit before it, then Add unit', async ({ page }) => {
  await signInAs(page, 'at');
  await openWizard(page);
  await chooseDemoProject(page);
  await toUnits(page);
  const add = page.getByRole('button', { name: 'Add unit', exact: true });
  for (const n of [2, 3]) {
    await add.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('region', { name: `Bucket ${n}` })).toBeVisible();
  }
  /** Opens the row's actions menu by keyboard and picks its last item, Remove. */
  async function removeByKeyboard(unitName: string) {
    await page.getByRole('button', { name: `${unitName} actions` }).focus();
    await page.keyboard.press('Enter');
    const remove = page.getByRole('menuitem', { name: `Remove ${unitName}` });
    await expect(remove).toBeVisible();
    // The menu focuses its first item once open; End before that would be undone by it.
    await expect(page.getByRole('menuitem').first()).toBeFocused();
    await page.keyboard.press('End');
    await expect(remove).toBeFocused();
    await page.keyboard.press('Enter');
  }
  await removeByKeyboard('Bucket 3');
  await expect(page.getByRole('combobox', { name: 'Bucket 2 holder' })).toBeFocused();
  // Removing the first unit leaves no unit before it: focus goes to Add unit.
  await removeByKeyboard('Bucket 1');
  expect(await activeTag(page)).not.toBe('BODY');
  await expect(add).toBeFocused();
});

test('MTR-136: closing the Add location dialog returns focus to Add location', async ({ page }) => {
  await signInAs(page, 'lab'); // Lab Manager: Lab admin › Locations
  await page.goto('/admin/locations');
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
  // Phone width: Projects sits in the sidebar Sheet, opened from the top bar.
  await openMore(page);
  await mainNav(page).getByRole('link', { name: 'Projects', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeFocused();
});

test('MTR-133: required fields are marked and a failed Add location focuses the first error', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await openWizard(page);
  // Project, Received date and Received by are marked required before anything is submitted.
  await expect(page.getByRole('combobox', { name: /Find project/ })).toHaveAttribute(
    'aria-required',
    'true',
  );
  await expect(page.getByLabel(/^Received date/)).toHaveAttribute('required', '');
  await expect(page.getByRole('combobox', { name: 'Received by', exact: true })).toHaveAttribute(
    'aria-required',
    'true',
  );

  await signInAs(page, 'lab');
  await page.goto('/admin/locations');
  await page.getByRole('button', { name: 'Add location' }).click();
  const panel = page.getByRole('dialog', { name: 'Add location' });
  await expect(panel.getByText('(required)')).toHaveCount(2);
  await panel.getByRole('button', { name: 'Add location' }).click();
  const code = panel.getByRole('textbox', { name: 'Code' });
  await expect(code).toBeFocused();
  await expect(code).toHaveAttribute('aria-invalid', 'true');
  await expect(panel.getByText(/Use 2–20 letters, digits or hyphens/)).toHaveCount(1);
});
