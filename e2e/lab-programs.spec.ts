import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
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

async function startProgram(page: Page) {
  await page.goto('/lab-testing');
  await expect(page.getByRole('heading', { name: 'Programs', level: 2 })).toBeVisible();
  await page.getByRole('link', { name: 'New program' }).click();
  await page.getByLabel('Project', { exact: true }).fill('DEMO-2601');
  await page.getByRole('button', { name: /DEMO-2601/ }).click();
}

async function chooseSource(page: Page, line: number, hole: string) {
  const card = page.getByRole('region', { name: `Line ${line}` });
  const option = card.getByLabel('Sampling source').locator('option', { hasText: `${hole} —` });
  await expect(option).toHaveCount(1);
  await card.getByLabel('Sampling source').selectOption((await option.getAttribute('value'))!);
  return card;
}

async function pickTest(page: Page, line: number, code: string) {
  const card = page.getByRole('region', { name: `Line ${line}` });
  await card.getByLabel('Find a test').fill(code);
  await card.getByRole('button', { name: new RegExp(code) }).click();
  await expect(card.getByRole('list', { name: 'Requested tests' })).toContainText(code);
}

/**
 * Submits the reviewed program. Other tests receive units on TH26-01 at the same time, so the
 * server may refuse with "material changed since the review" and show the fresh review; the
 * person then submits again, exactly as a user would.
 */
async function submitReviewed(page: Page) {
  const changed = page.getByText('The material for a line changed since the review');
  const submitted = page.getByRole('heading', { name: /^LP-\d{4}-\d{4}$/ });
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await page.getByRole('button', { name: 'Submit program' }).click();
    await expect(submitted.or(changed)).toBeVisible();
    if (await submitted.isVisible()) return;
  }
  await expect(submitted).toBeVisible();
}

test('Settings → Tests: a Lab Manager adds and retires a test; a technician only reads', async ({
  page,
}) => {
  const code = uniqueCode('DEMO_UI');
  await signInAs(page, 'lab');
  await page.goto('/settings/tests');
  await expect(page.getByRole('heading', { name: 'Tests', level: 2 })).toBeVisible();
  const form = page.getByRole('form', { name: 'Add a test' });
  await form.getByLabel('Code').fill(code);
  await form.getByLabel('Full description').fill('Fictional E2E description, kept in full.');
  await form.getByRole('button', { name: 'Add test' }).click();
  await expect(page.getByText(`Added ${code}.`)).toBeVisible();
  await page.getByLabel('Search tests').fill(code);
  const row = page.getByRole('table', { name: 'Lab tests' }).locator('tbody tr', { hasText: code });
  await row.getByRole('button', { name: 'Retire' }).click();
  await expect(row).toContainText('Retired');

  await signInAs(page, 'at');
  await page.goto('/settings/tests');
  await expect(
    page.getByText('Only Lab Managers and administrators can change the catalogue.'),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Add a test' })).toHaveCount(0);
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
  await chooseSource(page, 1, 'TH26-01');
  await pickTest(page, 1, mc);

  await page.getByRole('button', { name: 'Add line' }).click();
  const line2 = await chooseSource(page, 2, 'TH26-01');
  await line2.getByRole('radio', { name: 'Specific sample' }).check();
  await line2.getByLabel('Sample label').fill('G3');
  await line2.getByLabel('At', { exact: true }).fill('7.5');
  await line2.getByLabel('Unit').selectOption('ft');
  await pickTest(page, 2, att);

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const review = page.getByRole('region', { name: 'Review before submitting' });
  await expect(review).toContainText(/Covers (BKT|ST)-\d{4}-\d{6}/);
  await expect(review).toContainText('received so far');
  await submitReviewed(page);

  await expect(page.getByText(`${mc} · Moisture Content`)).toBeVisible();
  await expect(page.getByText(`${att} · Atterberg Limits`)).toBeVisible();
  await expect(page.locator('.request-list .badge', { hasText: 'Requested' })).toHaveCount(2);
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
      await page.getByRole('combobox', { name: /Requested by/ }).fill(i === 0 ? 'Jordan' : 'Pat');
      await page.getByRole('option', { name: people[i] }).click();
      await expect(page.getByText(/Recorded as LAB for/)).toContainText(people[i]!);
      await chooseSource(page, 1, 'TH26-01');
      await pickTest(page, 1, code);
      await page.getByRole('button', { name: 'Save draft' }).click();
      await expect(page).toHaveURL(/\/lab-testing\/programs\/[0-9a-f-]{36}$/);
    }
    // Station A's person never changed station B's draft, and both submit independently.
    for (const [i, page] of pages.entries()) {
      await page.getByRole('button', { name: 'Review', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Review before submitting' })).toBeVisible();
      await submitReviewed(page);
      await expect(page.locator('.program-summary')).toContainText('LAB for');
      await expect(page.locator('.program-summary')).toContainText(people[i]!);
    }
  } finally {
    await Promise.all(stations.map((context) => context.close()));
  }
});
