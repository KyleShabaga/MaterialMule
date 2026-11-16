import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// MM-T35, STRATA-83/84: the Projects list (tabs, table tools), the project page (header, line
// tabs with their own URLs), Overview test holes, add test hole and edit. Each test makes its own
// tagged fictional projects (via the T12 inventory fixture), so viewports never see each other's
// rows.

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

const projectHeading = (page: Page, number: string) =>
  page.getByRole('heading', { level: 1, name: new RegExp(`^${number}`) });

async function openEdit(page: Page) {
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Edit project' }).click();
}

test('T5: projects list → project page tabs → add test hole (duplicate rejected) → edit', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'pe');
  await page.goto(`/projects?tab=all&search=${data.tag}`);
  await expect(page.getByRole('tab', { name: /All projects/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const table = page.getByRole('table', { name: 'All projects' });
  const rowA = table.getByRole('row').filter({ hasText: data.projectA });
  await expect(rowA).toContainText('Inventory demo A');
  await expect(rowA).toContainText('Pat Example');
  await expect(rowA).toContainText('2026-10-12');
  await expect(page.getByText('1–2 of 2 projects')).toBeVisible();

  await rowA.getByRole('link', { name: `Open project ${data.projectA}` }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(projectHeading(page, data.projectA)).toBeVisible();
  const counts = page.getByRole('list', { name: 'Counts' });
  await expect(counts).toContainText('3units in stock');
  await expect(counts).toContainText('4units received');
  await expect(page.getByRole('link', { name: 'Receive for this project' })).toBeVisible();

  // Overview: test holes, each opening its units on the Storage units tab.
  const holes = page.getByRole('table', { name: 'Test holes' });
  await expect(holes.getByRole('row').filter({ hasText: 'TH26-01' })).toContainText('3');
  await holes.getByRole('link', { name: 'TH26-01: open its storage units' }).click();
  await expect(page).toHaveURL(/\/units\?hole=/);
  const units = page.getByRole('table', { name: `Storage units on ${data.projectA}` });
  await expect(units).toContainText(data.aReceiving);
  await expect(units).not.toContainText(data.aOtherHole);
  // Refresh and Back keep the tab and its filter.
  await page.reload();
  await expect(page.getByRole('tab', { name: /Storage units/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page.getByRole('button', { name: 'Remove filter Test hole TH26-01' })).toBeVisible();
  await page.goBack();
  await expect(page.getByRole('tab', { name: 'Overview' })).toHaveAttribute(
    'aria-selected',
    'true',
  );

  // Add a hole, then try the same name with different case and a trailing space.
  await page.getByRole('button', { name: 'Add test hole' }).click();
  let dialog = page.getByRole('dialog', { name: 'Add test hole' });
  await dialog.getByRole('textbox', { name: 'Test hole name' }).fill('TH26-03');
  await dialog.getByRole('button', { name: 'Add test hole' }).click();
  await expect(dialog).toBeHidden();
  await expect(holes.getByRole('row').filter({ hasText: 'TH26-03' })).toContainText('No units yet');
  await page.getByRole('button', { name: 'Add test hole' }).click();
  dialog = page.getByRole('dialog', { name: 'Add test hole' });
  await dialog.getByRole('textbox', { name: 'Test hole name' }).fill('th26-01 ');
  await dialog.getByRole('button', { name: 'Add test hole' }).click();
  await expect(dialog.getByRole('alert')).toHaveText('TH26-01 already exists in this project.');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(holes.locator('tbody tr')).toHaveCount(3);

  // Edit as the Lead Project Engineer: the number is locked (receipts exist); the lead is admin-only.
  await openEdit(page);
  const edit = page.getByRole('dialog', { name: 'Edit project' });
  await expect(edit.getByRole('textbox', { name: 'Project number' })).toHaveAttribute('readonly');
  await expect(edit.getByRole('combobox', { name: 'Lead Project Engineer' })).toBeDisabled();
  await edit.getByRole('textbox', { name: 'Name' }).fill(`Inventory demo A ${data.tag}`);
  await edit
    .getByRole('textbox', { name: 'Server folder path' })
    .fill(`P:\\Projects\\${data.projectA}`);
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(edit).toBeHidden();
  await expect(projectHeading(page, data.projectA)).toContainText(`Inventory demo A ${data.tag}`);
  const details = page.getByRole('region', { name: 'Project details' });
  await expect(details.locator('code')).toHaveText(`P:\\Projects\\${data.projectA}`);
  await expect(details.getByRole('button', { name: 'Copy' })).toBeVisible();

  // The breadcrumb returns to the list with its search.
  await page
    .getByRole('navigation', { name: 'breadcrumb' })
    .getByRole('link', { name: 'Projects', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`/projects\\?tab=all&search=${data.tag}`));
});

test('T3: a technician sees the project but no Edit project', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto(`/projects?search=${data.projectB}`);
  await page.getByRole('link', { name: `Open project ${data.projectB}` }).click();
  await expect(projectHeading(page, data.projectB)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Recent receipts' })).toContainText('2026-10-23');
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await expect(page.getByRole('menuitem', { name: 'Copy link' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Edit project' })).toHaveCount(0);
});

test('MTR-26: Edit project shows what changed and asks before discarding it', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'pe');
  await page.goto(`/projects?search=${data.projectB}`);
  await page.getByRole('link', { name: `Open project ${data.projectB}` }).click();
  await openEdit(page);
  const dialog = page.getByRole('dialog', { name: 'Edit project' });
  await dialog.getByRole('textbox', { name: 'Client' }).fill('Changed client (fictional)');
  await expect(dialog).toContainText('Changed: client');

  // Escape asks; Cancel there keeps the edit.
  await page.keyboard.press('Escape');
  const confirm = page.getByRole('dialog', { name: 'Discard changes?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(dialog.getByRole('textbox', { name: 'Client' })).toHaveValue(
    'Changed client (fictional)',
  );

  // The Cancel button asks too; discarding closes the editor and nothing is saved.
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await confirm.getByRole('button', { name: 'Discard changes' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('region', { name: 'Project details' })).not.toContainText(
    'Changed client (fictional)',
  );
});

test('T6: phone width list and project page are usable without horizontal scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  const data = await insertInventoryFixture();
  await signInAs(page, 'pe');
  await page.goto(`/projects?search=${data.tag}`);
  const table = page.getByRole('table', { name: 'All projects' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await table.getByRole('link', { name: `Open project ${data.projectA}` }).click();
  await expect(projectHeading(page, data.projectA)).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByRole('tab', { name: /Storage units/ }).click();
  await expect(
    page.getByRole('table', { name: `Storage units on ${data.projectA}` }),
  ).toContainText(data.a1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await openEdit(page);
  await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
