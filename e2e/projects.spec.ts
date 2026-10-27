import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// MM-T35: projects table, project detail, add test hole and edit. Each test makes its own tagged
// fictional projects (via the T12 inventory fixture), so viewports never see each other's rows.

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('T5: projects table → detail → add test hole (duplicate rejected) → edit', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'pe');
  await page.goto('/projects');
  await expect(page.getByRole('heading', { level: 1, name: 'Projects' })).toBeVisible();

  await page.getByRole('searchbox', { name: 'Search' }).fill(data.tag);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'project' })).toHaveText('2 projects');
  const table = page.getByRole('table', { name: 'Projects' });
  const rowA = table.locator('tbody tr').filter({ hasText: data.projectA });
  // Two holes; three in-stock units (the disposed one isn't counted).
  await expect(rowA).toContainText('Inventory demo A');
  await expect(rowA).toContainText('PE');
  await expect(rowA).toContainText('2026-10-12');

  await page.getByRole('link', { name: `Open project ${data.projectA}` }).click();
  await expect(page).toHaveURL(/\/projects\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { level: 1, name: data.projectA })).toBeVisible();
  const details = page.getByRole('region', { name: 'Project details' });
  await expect(details).toContainText('PE — Pat Example');
  await expect(details).toContainText('3 units in stock of 4 units received');
  await expect(page.getByRole('table', { name: 'Receipts' }).locator('tbody tr')).toHaveCount(4);
  const units = page.getByRole('region', { name: 'Storage units' });
  await expect(units.getByRole('table', { name: 'Storage units' }).locator('tbody tr')).toHaveCount(
    4,
  );
  await expect(units).toContainText(data.aDisposed);
  const holes = page.getByRole('list', { name: 'Test holes' });
  await expect(holes.locator('li').filter({ hasText: 'TH26-01' })).toContainText('3 units');

  // Add a hole, then try the same name with different case and a trailing space.
  const addHole = page.getByRole('textbox', { name: 'Add test hole' });
  await addHole.fill('TH26-03');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByText('Added test hole TH26-03.')).toBeVisible();
  await expect(holes.locator('li').filter({ hasText: 'TH26-03' })).toContainText('0 units');
  await addHole.fill('th26-01 ');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('TH26-01 already exists in this project.');
  await expect(holes.locator('li')).toHaveCount(3);

  // Edit as the PM/PE: the number is locked (receipts exist); the PM/PE is admin-only.
  await page.getByRole('button', { name: 'Edit project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit project' });
  await expect(dialog.getByRole('textbox', { name: 'Project number' })).toBeDisabled();
  await expect(dialog.getByRole('combobox', { name: 'PM/PE' })).toBeDisabled();
  await dialog.getByRole('textbox', { name: 'Name' }).fill(`Inventory demo A ${data.tag}`);
  await dialog
    .getByRole('textbox', { name: 'Server folder path' })
    .fill(`P:\\Projects\\${data.projectA}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText('Project saved.')).toBeVisible();
  await expect(page.getByText(`Inventory demo A ${data.tag}`)).toBeVisible();
  await expect(details.locator('code')).toHaveText(`P:\\Projects\\${data.projectA}`);
  await expect(details.getByRole('button', { name: 'Copy' })).toBeVisible();

  // Back keeps the search.
  await page.getByRole('link', { name: '← Back to Projects' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(data.tag);
});

test('T3: a technician sees the project but no Edit button', async ({ page }) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto(`/projects?search=${data.projectB}`);
  await page.getByRole('link', { name: `Open project ${data.projectB}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.projectB })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Receipts' })).toContainText('2026-10-23');
  await expect(page.getByRole('button', { name: 'Edit project' })).toHaveCount(0);
});

test('T6: phone width list and detail are usable without horizontal scroll', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'phone-chromium', 'phone layout only');
  const data = await insertInventoryFixture();
  await signInAs(page, 'pe');
  await page.goto(`/projects?search=${data.tag}`);
  const table = page.getByRole('table', { name: 'Projects' });
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await expect(table.locator('thead')).toBeHidden();
  const card = table.locator('tbody tr').filter({ hasText: data.projectA });
  await expect(card).toHaveCSS('display', 'block');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await card.getByRole('link', { name: `Open project ${data.projectA}` }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.projectA })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Storage units' })).toContainText(data.a1);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await page.getByRole('button', { name: 'Edit project' }).click();
  await expect(page.getByRole('dialog', { name: 'Edit project' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
