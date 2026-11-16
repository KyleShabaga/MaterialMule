import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import {
  addTest,
  chooseProject,
  chooseSource,
  editorLine,
  submitToLab,
  waitForSaved,
} from './support/lab-editor';
import { signInAsLabStation } from './support/lab-station';

// MM-T23: test catalogue (Settings → Tests), program entry and submission (card T6), and two
// independent LAB stations with different Requested by people (card T7). Codes are random so the
// desktop and phone projects never collide. Fictional data only (DEMO-2601, TH26-01).

const SOILS = '00000000-0000-4000-8000-00000000c101';

function uniqueCode(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function addTestType(page: Page, code: string, description: string, name?: string) {
  await signInAs(page, 'lab'); // "Lab (test)": a Lab Manager
  const response = await page.request.post('/api/test-types', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { groupId: SOILS, code, description, name },
  });
  expect(response.status()).toBe(201);
}

/** Opens a new program from the Programs tab and chooses DEMO-2601, which starts the draft. */
async function startProgram(page: Page) {
  // MM-T24: the Workboard (the Worklist until STRATA-10) is the default tab; programs are one tab away.
  await page.goto('/lab-testing');
  await expect(page.getByRole('heading', { name: 'Workboard', level: 2 })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Lab programs' })
    .getByRole('link', { name: 'Programs' })
    .click();
  await expect(page.getByRole('heading', { name: 'Programs', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: 'New lab program' }).click();
  await chooseProject(page);
}

test('Settings → Tests: a Lab Manager adds and retires a test; a technician is refused', async ({
  page,
}) => {
  const code = uniqueCode('DEMO_UI');
  await signInAs(page, 'lab');
  await page.goto('/admin/lab-tests');
  await expect(page.getByRole('heading', { name: 'Lab tests', level: 1 })).toBeVisible();
  // STRATA-128: Add test opens the drawer (a sheet on phones); the new test opens there once added.
  await page.getByRole('button', { name: 'Add test' }).click();
  const form = page.getByRole('form', { name: 'Add a test' });
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Full description').fill('Fictional E2E description, kept in full.');
  await form.getByRole('button', { name: 'Add test' }).click();
  await expect(page.getByText(`Added ${code}.`)).toBeVisible();
  await expect(page.getByRole('form', { name: `Edit ${code}` })).toBeVisible();
  // The drawer's Close (on a phone the confirmation toast can sit over it, so dispatch the click).
  const closeDrawer = () =>
    page.getByRole('button', { name: 'Close', exact: true }).dispatchEvent('click');
  await closeDrawer();
  await page.getByLabel('Search tests').fill(code);
  const row = page.locator('tbody tr', { hasText: code });
  await row.click();
  // On a phone the "Added" toast sits over Retire, and hovering it keeps it there.
  await page.getByRole('button', { name: 'Retire', exact: true }).dispatchEvent('click');
  await expect(page.getByText(`Retired ${code}.`)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Restore', exact: true })).toBeVisible();
  // Retired tests leave the list until Include retired is ticked.
  await closeDrawer();
  await expect(row).toHaveCount(0);
  await page.getByRole('checkbox', { name: /^Include retired/ }).check();
  await expect(row).toContainText('Retired');

  // MISC-04 / STRATA-100: a technician has no Lab tests or Templates section; a direct address
  // opens My access with a notice instead of the catalogue.
  await signInAs(page, 'at');
  await page.goto('/admin/lab-tests');
  await expect(page).toHaveURL(/\/settings\/access$/);
  await expect(page.getByText('Lab tests isn’t available to you.')).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a test' })).toHaveCount(0);
  const settingsNav = page.getByRole('navigation', { name: 'Settings' });
  await expect(settingsNav.getByRole('link', { name: /Lab tests/ })).toHaveCount(0);
  await expect(settingsNav.getByRole('link', { name: 'Templates' })).toHaveCount(0);
  await expect(settingsNav.getByRole('link', { name: 'My access' })).toBeVisible();
});

test('MISC-01: New program opens the editor from Programs and Workboard, not the delete dialog', async ({
  page,
}) => {
  await signInAs(page, 'at');
  const remove = page.getByRole('alertdialog', { name: 'Delete this draft?' });
  const tabs = page.getByRole('navigation', { name: 'Lab programs' });
  for (const tab of ['Programs', 'Workboard']) {
    await page.goto('/lab-testing');
    await tabs.getByRole('link', { name: tab }).click();
    await expect(page.getByRole('heading', { name: tab, level: 2 })).toBeVisible();
    await page.getByRole('link', { name: 'New lab program' }).click();
    await expect(page.getByRole('heading', { name: 'New lab program', level: 1 })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Project', exact: true })).toBeVisible();
    await expect(remove).toBeHidden();
  }
  // STRATA-86: the draft starts once a project is chosen; Delete draft asks first, Cancel keeps it.
  await chooseProject(page);
  await expect(remove).toBeHidden();
  await page.getByRole('button', { name: 'More actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Delete draft' }).click();
  await expect(remove).toBeVisible();
  await remove.getByRole('button', { name: 'Cancel' }).click();
  await expect(remove).toBeHidden();
  await expect(page.getByRole('heading', { name: 'Draft lab program', level: 1 })).toBeVisible();
});

test('T6: ALL moisture on TH26-01 and Atterberg on G3 at 7.5 ft are submitted as Requested', async ({
  page,
}) => {
  const mc = uniqueCode('DEMO-MC');
  const att = uniqueCode('DEMO-ATT');
  await addTestType(page, mc, 'Moisture content (fictional E2E)', 'Moisture Content');
  await addTestType(page, att, 'Atterberg limits (fictional E2E)', 'Atterberg Limits');

  await signInAs(page, 'at');
  await startProgram(page);
  const line1 = editorLine(page, 1);
  await chooseSource(page, line1, 'TH26-01');
  await addTest(page, line1, mc);

  // The Grid shows the same lines: ticking the test's column adds it to every line.
  await page.getByRole('button', { name: 'Add sample line' }).click();
  const line2 = editorLine(page, 2);
  await chooseSource(page, line2, 'TH26-01');
  await line2.getByRole('radio', { name: 'Specific sample' }).click();
  await line2.getByLabel('Sample label').fill('G3');
  await line2.getByLabel('At', { exact: true }).fill('7.5');
  await addTest(page, line2, att);
  await page.getByRole('tab', { name: 'Grid' }).click();
  await expect(page.getByRole('checkbox', { name: 'Atterberg Limits on line 2' })).toBeChecked();
  await expect(
    page.getByRole('checkbox', { name: 'Atterberg Limits on line 1' }),
  ).not.toBeChecked();
  await page.getByRole('tab', { name: 'Lines' }).click();
  await expect(line2.getByRole('list', { name: 'Requested tests' })).toContainText(att);

  // Saves as you go; the ALL line then shows the units it covers so far.
  await waitForSaved(page);
  await expect(line1).toContainText(/(BKT|ST)-\d{4}-\d{6}/);
  await expect(page.getByRole('region', { name: 'Submit' })).toContainText('2 lines · 2 tests');
  await submitToLab(page);

  await expect(page.getByText(`${mc} · Moisture Content`, { exact: true })).toBeVisible();
  await expect(page.getByText(`${att} · Atterberg Limits`, { exact: true }).first()).toBeVisible();
  await expect(
    page.locator('.request-list [data-slot="badge"]', { hasText: 'Waiting' }),
  ).toHaveCount(2);
  // AC7: nothing asks for result values.
  await expect(page.getByLabel(/result/i)).toHaveCount(0);
});

test('T7: two LAB stations request for different people; each submission keeps its own person', async ({
  browser,
}) => {
  const code = uniqueCode('DEMO-T7');
  const setup = await browser.newPage();
  await addTestType(setup, code, 'Fictional two-station test');
  await setup.close();

  const stations = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(stations.map((context) => context.newPage()));
  const people = [/Jordan Smith/, /Pat Example/];
  try {
    for (const [i, page] of pages.entries()) {
      await signInAsLabStation(page);
      await startProgram(page);
      // STRATA-125: Requested by starts as the station's recording person; pick another person.
      const person = page.getByRole('combobox', { name: /Requested by/ });
      await expect(person).toHaveValue(/Alex Tester/);
      await person.fill(i === 0 ? 'Jordan' : 'Pat');
      await page.getByRole('option', { name: people[i] }).click();
      await expect(page.getByText(/Recorded as LAB for/)).toContainText(people[i]!);
      const line = editorLine(page, 1);
      await chooseSource(page, line, 'TH26-01');
      await addTest(page, line, code);
      await waitForSaved(page);
    }
    // Station A's person never changed station B's draft, and both submit independently.
    for (const [i, page] of pages.entries()) {
      await submitToLab(page);
      const header = page.locator('.program-lifecycle');
      await expect(header).toContainText('LAB for');
      await expect(header).toContainText(people[i]!);
    }
  } finally {
    await Promise.all(stations.map((context) => context.close()));
  }
});
