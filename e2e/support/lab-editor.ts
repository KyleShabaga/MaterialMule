import { expect, type Locator, type Page } from '@playwright/test';

// The lab program editor (STRATA-86) for E2E: a new program starts its draft once a project is
// chosen and then saves as you go; lines are rows with a shadcn Select for the source, a
// toggle for ALL / Grabs / SPT / Specific and + Add test (catalogue search in a popover).

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export const editorLine = (page: Page, line: number): Locator =>
  page.getByRole('region', { name: `Line ${line}`, exact: true });

/** On /lab-testing/programs/new: choose the project and wait for the draft to open. */
export async function chooseProject(page: Page, project = 'DEMO-2601') {
  await page.getByRole('combobox', { name: 'Project', exact: true }).fill(project);
  await page.getByRole('option', { name: new RegExp(escape(project)) }).click();
  await expect(page).toHaveURL(/\/lab-testing\/programs\/[0-9a-f-]{36}$/);
  await expect(page.getByRole('heading', { name: 'Draft lab program', level: 1 })).toBeVisible();
}

/** Chooses a sampling source on a line (or any region holding a line row). */
export async function chooseSource(page: Page, row: Locator, source: string) {
  await row.getByLabel('Sampling source').click();
  await page.getByRole('option', { name: new RegExp(`^${escape(source)} —`) }).click();
  await expect(row.getByLabel('Sampling source')).toContainText(source);
}

/** + Add test on a line: searches the catalogue and adds the test as a chip. */
export async function addTest(page: Page, row: Locator, code: string) {
  await row.getByRole('button', { name: /^Add test to/ }).click();
  await page.getByPlaceholder('Find a test').fill(code);
  await page.getByRole('option', { name: new RegExp(escape(code)) }).click();
  await page.keyboard.press('Escape');
  await expect(row.getByRole('list', { name: 'Requested tests' })).toContainText(code);
}

/** Waits until the editor has saved everything on screen ("Draft · saved 10:02 AM"). */
export async function waitForSaved(page: Page) {
  await expect(page.getByText(/^Draft · saved/)).toBeVisible();
  await expect(page.getByText('Saving…')).toHaveCount(0);
}

/**
 * Submit to the lab. Other tests receive units on TH26-01 at the same time, so the server may
 * refuse with "the material for a line changed" and show the fresh coverage; the person then
 * submits again, exactly as a user would.
 */
export async function submitToLab(page: Page) {
  const bar = page.getByRole('region', { name: 'Submit' });
  const submit = bar.getByRole('button', { name: 'Submit to the lab' });
  const changed = page.getByText('The material for a line changed');
  const submitted = page.getByRole('heading', { name: /^LP-\d{4}-\d{4}$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(submitted.or(changed)).toBeVisible();
    if (await submitted.isVisible()) return;
  }
  await expect(submitted).toBeVisible();
}
