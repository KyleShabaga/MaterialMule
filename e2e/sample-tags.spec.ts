import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { readPdfPages } from './support/pdf';

// MM-T69: printable sample ID tags. Catalogue tag settings decide grouping; the tag sheet prints
// on letter paper in the Uline S-15619 positions (2 × 5 cards of 4 × 2 in) and changes nothing
// in the program. Codes are random so the desktop and phone projects never collide. Fictional
// data only (DEMO-2601, TH26-01).

const SOILS = '00000000-0000-4000-8000-00000000c101';
const CSS_PX_PER_IN = 96;

const uniqueCode = (prefix: string) => `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;

async function addTestType(page: Page, code: string, name: string, tag: Record<string, string>) {
  const response = await page.request.post('/api/test-types', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { groupId: SOILS, code, description: `${name} (fictional E2E)`, name, ...tag },
  });
  expect(response.status()).toBe(201);
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

/** Status and version of every request of the program: printing must never change them. */
function requestState(programNumber: string) {
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT p.version AS program_version, r.id, r.status, r.version
       FROM lab_program p JOIN test_request r ON r.program_id = p.id
       WHERE p.program_number = $1 ORDER BY r.id`,
      [programNumber],
    );
    return rows;
  });
}

test('T1–T4: tags group by the catalogue, preview and position on the sheet, and change nothing', async ({
  page,
}) => {
  const group = uniqueCode('Grain size');
  const mc = uniqueCode('DEMO-MC');
  const att = uniqueCode('DEMO-ATT');
  const hyd = uniqueCode('DEMO-HYD');
  const sv = uniqueCode('DEMO-SV');
  await signInAs(page, 'lab'); // "Lab (test)": a Lab Manager
  await addTestType(page, mc, 'Moisture Content', { sampleTagMode: 'none' });
  await addTestType(page, att, 'Atterberg Limits', { sampleTagMode: 'own' });
  await addTestType(page, hyd, 'Hydrometer', { sampleTagMode: 'shared', sampleTagGroup: group });
  await addTestType(page, sv, 'Sieve', { sampleTagMode: 'shared', sampleTagGroup: group });

  // The setting is visible in Settings → Tests.
  await page.goto('/settings/tests');
  await page.getByLabel('Search tests').fill(hyd);
  await expect(
    page.getByRole('table', { name: 'Lab tests' }).locator('tbody tr', { hasText: hyd }),
  ).toContainText(`Shared: ${group}`);

  await signInAs(page, 'at');
  await page.goto('/lab-testing/programs/new');
  await page.getByLabel('Project', { exact: true }).fill('DEMO-2601');
  await page.getByRole('button', { name: /DEMO-2601/ }).click();
  const line1 = await chooseSource(page, 1, 'TH26-01');
  await line1.getByRole('radio', { name: 'Specific sample' }).check();
  await line1.getByLabel('Sample label').fill('G13');
  await line1.getByLabel('At', { exact: true }).fill('10');
  await line1.getByLabel('Unit').selectOption('m');
  for (const code of [mc, att, hyd, sv]) await pickTest(page, 1, code);
  await page.getByRole('button', { name: 'Add line' }).click();
  await chooseSource(page, 2, 'TH26-01');
  await pickTest(page, 2, att);

  await page.getByRole('button', { name: 'Review', exact: true }).click();
  const changed = page.getByText('The material for a line changed since the review');
  const submitted = page.getByRole('heading', { name: /^LP-\d{4}-\d{4}$/ });
  for (let attempt = 0; attempt < 3 && !(await submitted.isVisible()); attempt += 1) {
    await page.getByRole('button', { name: 'Submit program' }).click();
    await expect(submitted.or(changed)).toBeVisible();
  }
  await expect(submitted).toBeVisible();
  const programNumber = (await submitted.textContent())!;
  const before = await requestState(programNumber);

  // Offered right after submission.
  await expect(page.getByText('Program submitted. Print sample ID tags')).toBeVisible();
  await page.getByRole('link', { name: 'Print sample ID tags' }).click();
  await expect(page.getByRole('heading', { name: new RegExp(programNumber) })).toBeVisible();

  // Moisture content gets no tag; Atterberg and the grain-size pair get separate tags.
  const list = page.getByRole('list').filter({ has: page.getByRole('checkbox') });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(0)).toContainText('Atterberg Limits');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Hydrometer');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Sieve');
  await page.getByText(/^Not tagged: 2 items$/).click();
  await expect(page.getByText(/G13 · 10\.0 m: Moisture Content/)).toBeVisible();
  await expect(page.getByText(/Line 2 · ALL · TH26-01: Atterberg Limits/)).toBeVisible();

  // Split the shared tag; start on card 9 of a partly used sheet: two sheets.
  await page.getByRole('button', { name: 'Split into 2 tags' }).click();
  await page.getByLabel('Start at card').selectOption('9');
  await expect(page.getByText('3 of 3 tags selected · 2 sheets')).toBeVisible();
  const preview = page.getByLabel('Tag sheets to print');
  await expect(preview.getByRole('region', { name: /^Sheet \d of 2$/ })).toHaveCount(2);
  await expect(preview.locator('.tag-card')).toHaveCount(3);
  await expect(preview.locator('.tag-card-overflow')).toHaveCount(0);
  const first = preview.locator('.tag-card').first();
  await expect(first).toContainText('DEMO-2601');
  await expect(first).toContainText('TH26-01');
  await expect(first).toContainText('10.0 m');

  // On paper: letter pages, cards exactly where the S-15619 template puts them.
  await page.emulateMedia({ media: 'print' });
  const sheet = preview.locator('.tag-sheet').first();
  const origin = (await sheet.boundingBox())!;
  const slots = sheet.locator('.tag-slot');
  await expect(slots).toHaveCount(10);
  for (const [slot, column, row] of [
    [0, 0, 0],
    [8, 0, 4],
    [9, 1, 4],
  ] as const) {
    const box = (await slots.nth(slot).boundingBox())!;
    expect((box.x - origin.x) / CSS_PX_PER_IN).toBeCloseTo([17 / 72, 307 / 72][column]!, 2);
    expect((box.y - origin.y) / CSS_PX_PER_IN).toBeCloseTo(0.5 + 2 * row, 2);
    expect(box.width / CSS_PX_PER_IN).toBeCloseTo(4, 2);
    expect(box.height / CSS_PX_PER_IN).toBeCloseTo(2, 2);
  }
  const pdf = await readPdfPages(
    await page.pdf({ preferCSSPageSize: true, printBackground: true }),
  );
  expect(pdf).toHaveLength(2);
  for (const pdfPage of pdf) {
    expect(pdfPage.widthIn).toBeCloseTo(8.5, 2);
    expect(pdfPage.heightIn).toBeCloseTo(11, 2);
  }
  await page.emulateMedia({ media: 'screen' });

  // Nothing in the program changed, and the tags stay available for reprinting.
  expect(await requestState(programNumber)).toEqual(before);
  await page.getByRole('link', { name: `← Back to ${programNumber}` }).click();
  await expect(page.getByRole('link', { name: 'Print sample ID tags' })).toBeVisible();
  await expect(page.getByText('Program submitted. Print sample ID tags')).toHaveCount(0);
});
