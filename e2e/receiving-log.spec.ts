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

// MM-T51 and STRATA-78: the Receiving log (table tools, drafts on this computer, drawer) and the
// receipt page against the real API, at desktop and phone widths. STRATA-108: only the person
// who started a draft or a Lab Manager can delete it. Each test receives into its own fictional
// project so parallel runs never see each other's receipts.

const CSRF = { 'x-materialmule-csrf': '1' };

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

/** Body rows only. */
const bodyRows = (table: Locator) => table.locator('tbody tr');

async function printJobCount(): Promise<number> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ n: number }>('SELECT count(*)::int AS n FROM print_job');
    return rows[0]!.n;
  });
}

/** Opens the toolbar search and types into it (the server is asked after a short pause). */
async function searchReceipts(page: Page, text: string) {
  const box = page.getByRole('searchbox', { name: 'Search receipts' });
  if (!(await box.isVisible()))
    await page.getByRole('button', { name: 'Search', exact: true }).click();
  await box.fill(text);
}

test('T7/T8: receive two buckets at LAB, find the receipt, open it, its unit and label preview', async ({
  page,
}, testInfo) => {
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
  await expect(page.getByRole('heading', { name: 'Receiving log', level: 1 })).toBeVisible();

  // An exact storage unit ID finds its receipt once, with quantity two (AC1, AC9).
  await searchReceipts(page, ids[1]!.toLowerCase());
  await expect(page.getByRole('status').filter({ hasText: /receipt/ })).toHaveText('1 receipt');
  const table = page.getByRole('table', { name: 'Confirmed receipts' });
  await expect(bodyRows(table)).toHaveCount(1);
  const open = table.getByRole('link', {
    name: `Open receipt: ${projectNumber}, received 2026-10-21 by AT · Alex Tester`,
  });
  await expect(open).toBeVisible();
  await expect(table.getByText('Confirmed', { exact: true })).toBeVisible();
  await noHorizontalScroll(page);

  // The URL keeps the search across a reload.
  await page.reload();
  await expect(page.getByRole('searchbox', { name: 'Search receipts' })).toHaveValue(
    ids[1]!.toLowerCase(),
  );

  if (testInfo.project.name.startsWith('desktop')) {
    // Wide screens open the receipt in the drawer; Open as full page goes to the receipt page.
    await open.focus();
    await page.keyboard.press('Enter');
    await expect(page).toHaveURL(/[?&]open=/);
    const drawer = page.getByRole('region', { name: /^Receipt 2026-10-21 · Alex Tester$/ });
    await expect(drawer).toBeVisible();
    await page.getByRole('link', { name: 'Open as full page' }).click();
  } else {
    // Keyboard: focus the receipt link and open it with Enter (AC11).
    await open.focus();
    await page.keyboard.press('Enter');
  }
  await expect(
    page.getByRole('heading', { name: 'Receipt 2026-10-21 · Alex Tester', level: 1 }),
  ).toBeVisible();
  // Entered at the shared station, for the person who received.
  await expect(page.getByText('LAB (shared station), for Alex Tester').first()).toBeVisible();
  const original = page.getByRole('region', { name: 'Original receipt record' });
  await expect(original.getByText('AT · Alex Tester')).toBeVisible();
  const unitTable = page.getByRole('table', { name: 'Storage units in this receipt' });
  for (const id of ids) {
    await expect(unitTable.getByRole('link', { name: `Open ${id}` })).toBeVisible();
  }
  await expect(page.getByRole('button', { name: 'Print all labels' })).toBeVisible();
  await expect(
    page.getByRole('list', { name: 'Corrections and history, newest first' }),
  ).toBeVisible();
  await noHorizontalScroll(page);

  // Open a unit: its label preview and the existing LAB correction restriction (AC6).
  await unitTable.getByRole('link', { name: `Open ${ids[0]}` }).click();
  await expect(page.getByRole('heading', { name: ids[0] })).toBeVisible();
  await expect(
    page
      .getByRole('group', { name: 'Preview label' })
      .getByRole('img', { name: `Label for storage unit ${ids[0]}` }),
  ).toBeVisible();
  // STRATA-72: Correct sits in More, disabled for LAB with its reason under it.
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: 'Correct' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(page.getByText('Corrections need a personal account.')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('form', { name: 'Correct details' })).toHaveCount(0);

  // Reading and previewing queued no printing (AC8).
  expect(await printJobCount()).toBe(printJobs);
});

test('T8: a local draft is not a receipt and is listed as a draft to continue', async ({
  page,
}) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  await createProjectThroughApi(page, projectNumber, 'TH26-01');

  await page.goto('/receiving-log/new');
  await chooseProject(page, projectNumber, `${projectNumber} · Example Ridge · Example Client`);
  await expect(page.getByText(/Draft saved|saved \d/).first()).toBeVisible({ timeout: 10_000 });

  await page.goto(`/receiving-log?search=${encodeURIComponent(projectNumber)}`);
  await expect(page.getByText('No receipts match these filters.')).toBeVisible();
  // The draft is listed above the receipts, with no ID, and opens again with Continue.
  const drafts = page.getByRole('list', { name: 'Drafts on this computer' });
  await expect(drafts).toBeVisible();
  const item = drafts.getByRole('listitem').filter({ hasText: projectNumber });
  await expect(item.getByText('Draft · Receipt')).toBeVisible();
  await expect(item.getByText(/Started by you/)).toBeVisible();
  await expect(item.getByText(/BKT-|ST-|CRE-|CT-/)).toHaveCount(0);
  await item.getByRole('link', { name: `Continue draft for ${projectNumber}` }).click();
  await expect(page).toHaveURL(/\/receiving-log\/new\?draft=/);
});

test('STRATA-108: only the starter deletes a draft; the server refuses anyone else', async ({
  page,
}) => {
  const projectNumber = uniqueTag('E2E').toUpperCase();
  await signInAs(page, 'at');
  await createProjectThroughApi(page, projectNumber, 'TH26-01');
  await page.goto('/receiving-log/new');
  await chooseProject(page, projectNumber, `${projectNumber} · Example Ridge · Example Client`);
  await expect(page.getByText(/Draft saved|saved \d/).first()).toBeVisible({ timeout: 10_000 });

  await page.goto(`/receiving-log?search=${encodeURIComponent(projectNumber)}`);
  const item = page
    .getByRole('list', { name: 'Drafts on this computer' })
    .getByRole('listitem')
    .filter({ hasText: projectNumber });
  const draftId = await item.getAttribute('data-draft-id');
  expect(draftId).toBeTruthy();
  // Registered with Alex Tester as its starter (metadata only).
  await expect
    .poll(() =>
      withDatabase(async (client) => {
        const { rows } = await client.query<{ starter_user_id: string }>(
          'SELECT starter_user_id FROM receipt_draft_registry WHERE draft_id = $1',
          [draftId],
        );
        return rows[0]?.starter_user_id ?? null;
      }),
    )
    .toBe(DEMO.at);

  // Someone else calling the API directly is refused.
  const other = await page
    .context()
    .browser()!
    .newContext({ baseURL: test.info().project.use.baseURL });
  const otherPage = await other.newPage();
  await signInAs(otherPage, 'pe');
  const refused = await otherPage.request.post(`/api/receipt-drafts/${draftId}/delete`, {
    headers: CSRF,
    data: {},
  });
  expect(refused.status()).toBe(403);
  expect(await refused.json()).toMatchObject({ code: 'draft_delete_forbidden' });
  await other.close();

  // The starter: asked first, Keep draft changes nothing; Delete draft removes it.
  const button = item.getByRole('button', { name: 'Delete draft' });
  await expect(button).toBeEnabled();
  await button.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Keep draft' }).click();
  await expect(item).toBeVisible();
  await button.click();
  await page.getByRole('alertdialog').getByRole('button', { name: 'Delete draft' }).click();
  await expect(item).toHaveCount(0);
  const deleted = await withDatabase((client) =>
    client.query<{ deleted_by_user_id: string }>(
      'SELECT deleted_by_user_id FROM receipt_draft_registry WHERE draft_id = $1',
      [draftId],
    ),
  );
  expect(deleted.rows[0]!.deleted_by_user_id).toBe(DEMO.at);
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
  await expect(table.getByRole('link', { name: /by JS · Jordan Smith$/ })).toBeVisible();
  await expect(table.getByRole('link', { name: /by JS · Jamie Song$/ })).toBeVisible();

  // The Filter menu offers the people on this page, by name.
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Received by Jamie Song' }).click();
  await page.keyboard.press('Escape');
  await expect(bodyRows(table)).toHaveCount(1);
  await expect(table.getByRole('link', { name: /by JS · Jamie Song$/ })).toBeVisible();
  await expect(page).toHaveURL(new RegExp(`receiver%3A${DEMO.jamieSong}`));
  await expect(
    page
      .getByRole('group', { name: 'Active sort and filters' })
      .getByText('Received by Jamie Song'),
  ).toBeVisible();
  // An older link by user ID still filters.
  await page.goto(
    `/receiving-log?search=${encodeURIComponent(projectNumber)}&receiverUserId=${DEMO.jordanSmith}`,
  );
  await expect(bodyRows(table)).toHaveCount(1);
  await expect(table.getByRole('link', { name: /by JS · Jordan Smith$/ })).toBeVisible();
  await noHorizontalScroll(page);
});
