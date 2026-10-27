import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';
import {
  DEMO,
  chooseProject,
  createProjectThroughApi,
  receiveThroughApi,
  uniqueTag,
} from './support/receiving';

// MM-T51: Receiving Log list and receipt detail against the real API (card tests T7 and T8), at
// desktop and phone widths. Each test receives into its own fictional project so parallel runs
// never see each other's receipts.

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Body rows only: the header row is hidden when a table stacks into cards on a phone. */
const bodyRows = (table: Locator) => table.locator('tbody tr');

async function printJobCount(): Promise<number> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM print_job');
    return rows[0]!.n;
  });
}

test('T7/T8: receive two buckets at LAB, find the receipt, open it, its unit and label preview', async ({
  page,
}) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  const project = await createProjectThroughApi(page, projectNumber, 'TH26-01');
  // The shared station confirms; Alex Tester is the person who received.
  await signInAsLabStation(page);
  const units = await receiveThroughApi(page, {
    projectId: project.projectId,
    holeIds: [project.holeId],
    units: 2,
    receivedDate: '2026-10-21',
  });
  const ids = units.map((u) => u.suNumber).sort();
  const printJobs = await printJobCount();

  await page.goto('/receiving-log');
  await expect(page.getByRole('heading', { name: 'Receiving Log' })).toBeVisible();

  // An exact storage unit ID finds its receipt once, with quantity two (AC1, AC9).
  const search = page.getByRole('searchbox', { name: 'Search' });
  await search.fill(ids[1]!.toLowerCase());
  await search.press('Enter');
  await expect(page.getByRole('status').filter({ hasText: /receipt/ })).toHaveText('1 receipt');
  const table = page.getByRole('table', { name: 'Confirmed receipts' });
  await expect(bodyRows(table)).toHaveCount(1);
  await expect(table.getByText('AT · Alex Tester')).toBeVisible();
  await expect(table.getByText('by LAB (shared station)')).toBeVisible();
  await expect(table.getByText(projectNumber)).toBeVisible();
  await noHorizontalScroll(page);

  // The URL keeps the search across a reload.
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(ids[1]!.toLowerCase());

  // Keyboard: focus the receipt link and open it with Enter (AC11).
  const open = page.getByRole('link', { name: new RegExp(`^Open receipt: ${projectNumber}`) });
  await open.focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: `Receipt ${projectNumber} · 2026-10-21` }),
  ).toBeVisible();
  const header = page.getByRole('region', { name: 'Original receipt record' });
  await expect(header.getByText('AT · Alex Tester')).toBeVisible();
  await expect(header.getByText('LAB (shared station)')).toBeVisible();
  const unitTable = page.getByRole('table', { name: 'Storage units in this receipt' });
  for (const id of ids) {
    await expect(unitTable.getByRole('link', { name: `Open ${id}` })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Print all labels' })).toBeVisible();
  await noHorizontalScroll(page);

  // Back returns to the filtered list.
  await page.getByRole('link', { name: '← Back to Receiving Log' }).click();
  await expect(page.getByRole('searchbox', { name: 'Search' })).toHaveValue(ids[1]!.toLowerCase());
  await page.goBack();

  // Open a unit: its label preview and the existing LAB correction restriction (AC6).
  await unitTable.getByRole('link', { name: `Open ${ids[0]}` }).click();
  await expect(page.getByRole('heading', { name: ids[0] })).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'Preview label' })
      .getByRole('img', { name: `Label for storage unit ${ids[0]}` }),
  ).toBeVisible();
  await expect(page.getByText('Corrections need a personal account.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct details' })).toHaveCount(0);

  // Reading and previewing queued no printing (AC8).
  expect(await printJobCount()).toBe(printJobs);
});

test('T8: a local draft is not a receipt and stays in the drafts flow', async ({ page }) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  await createProjectThroughApi(page, projectNumber, 'TH26-01');

  await page.goto('/receiving-log/new');
  await chooseProject(page, projectNumber, `${projectNumber} · Example Ridge · Example Client`);
  await expect(page.locator('.draft-status')).toHaveText(/Draft saved/, { timeout: 10_000 });

  await page.goto(`/receiving-log?search=${encodeURIComponent(projectNumber)}`);
  await expect(page.getByText('No receipts match these filters.')).toBeVisible();
  await page.getByRole('link', { name: 'Drafts on this computer' }).click();
  const drafts = page.getByRole('region', { name: 'Drafts on this computer' });
  await expect(drafts).toBeVisible();
  await expect(drafts.getByText(projectNumber)).toBeVisible();
});

test('AC4: receivers sharing initials are filtered by person, and told apart', async ({ page }) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  const project = await createProjectThroughApi(page, projectNumber, 'TH26-01');
  for (const receiverUserId of [DEMO.jordanSmith, DEMO.jamieSong]) {
    await receiveThroughApi(page, {
      projectId: project.projectId,
      holeIds: [project.holeId],
      receiverUserId,
    });
  }

  await page.goto(`/receiving-log?search=${encodeURIComponent(projectNumber)}`);
  const table = page.getByRole('table', { name: 'Confirmed receipts' });
  await expect(bodyRows(table)).toHaveCount(2);
  await expect(table.getByText('JS · Jordan Smith')).toBeVisible();
  await expect(table.getByText('JS · Jamie Song')).toBeVisible();

  await page.getByRole('combobox', { name: 'Received by' }).fill('JS');
  await page.getByRole('option', { name: /Jamie Song/ }).click();
  await expect(bodyRows(table)).toHaveCount(1);
  await expect(table.getByText('JS · Jamie Song')).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`receiverUserId=${DEMO.jamieSong}`));
  await expect(
    page.getByRole('list', { name: 'Active filters' }).getByText(/Received by: JS · Jamie Song/),
  ).toBeVisible();
  await noHorizontalScroll(page);
});
