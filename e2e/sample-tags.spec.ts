import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import {
  addTest,
  chooseProject,
  chooseSource,
  editorLine,
  submitToLab,
} from './support/lab-editor';
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

  // The setting is visible in Lab admin › Lab tests (STRATA-128: tables per group).
  await page.goto('/admin/lab-tests');
  await page.getByLabel('Search tests').fill(hyd);
  await expect(page.locator('tbody tr', { hasText: hyd })).toContainText(`Shared: ${group}`);

  await signInAs(page, 'at');
  await page.goto('/lab-testing/programs/new');
  await chooseProject(page);
  const line1 = editorLine(page, 1);
  await chooseSource(page, line1, 'TH26-01');
  await line1.getByRole('radio', { name: 'Specific sample' }).click();
  await line1.getByLabel('Sample label').fill('G13');
  await line1.getByLabel('At', { exact: true }).fill('10');
  await line1.getByLabel('Unit').click();
  await page.getByRole('option', { name: 'm', exact: true }).click();
  for (const code of [mc, att, hyd, sv]) await addTest(page, line1, code);
  await page.getByRole('button', { name: 'Add sample line' }).click();
  const line2 = editorLine(page, 2);
  await chooseSource(page, line2, 'TH26-01');
  await addTest(page, line2, att);
  await submitToLab(page);
  const submitted = page.getByRole('heading', { name: /^LP-\d{4}-\d{4}$/ });
  const programNumber = (await submitted.textContent())!;
  const before = await requestState(programNumber);

  // Offered right after submission.
  await expect(page.getByText('Program submitted. Print sample ID tags')).toBeVisible();
  await page.getByRole('link', { name: 'Print sample ID tags' }).click();
  await expect(page.getByRole('heading', { name: 'Print sample ID tags', level: 1 })).toBeVisible();
  // STRATA-89: the breadcrumb names the program; the page says which program the tags are for.
  await expect(
    page.getByRole('navigation', { name: 'breadcrumb' }).getByRole('link', { name: programNumber }),
  ).toBeVisible();

  // Moisture content gets no tag; Atterberg and the grain-size pair get separate tags.
  const list = page.getByRole('list', { name: 'Tags to print' });
  await expect(list.getByRole('listitem')).toHaveCount(2);
  await expect(list.getByRole('listitem').nth(0)).toContainText('Atterberg Limits');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Hydrometer');
  await expect(list.getByRole('listitem').nth(1)).toContainText('Sieve');
  await expect(page.getByRole('heading', { name: 'No tag needed' })).toBeVisible();
  await expect(page.getByText(/G13 · 10\.0 m: Moisture Content/)).toBeVisible();
  await expect(page.getByText(/Line 2 · ALL · TH26-01: Atterberg Limits/)).toBeVisible();

  // Split the shared tag; start on card 9 of a partly used sheet: two sheets.
  await page.getByRole('button', { name: 'Split into 2 tags' }).click();
  await page.getByRole('combobox', { name: 'Start at card' }).click();
  await page.getByRole('option', { name: 'Card 9' }).click();
  await expect(page.getByText('3 of 3 tags selected · 2 sheets')).toBeVisible();
  // The true-size preview shows one card, black on white, with its place on the sheet.
  const aside = page.getByRole('complementary', { name: 'Preview' });
  await expect(aside.locator('[data-slot="tag-card-frame"] .tag-card')).toHaveCount(1);
  await expect(
    aside.getByRole('img', { name: /^Sheet 1 of 2: 2 tags on cards 9 to 10/ }),
  ).toBeVisible();
  const frame = (await aside.locator('[data-slot="tag-card-frame"]').boundingBox())!;
  expect(frame.width / CSS_PX_PER_IN).toBeCloseTo(4, 2);
  expect(frame.height / CSS_PX_PER_IN).toBeCloseTo(2, 2);
  // The sheets that print (off screen until printing, hidden from assistive tech).
  const preview = page.locator('.tag-preview');
  await expect(preview.locator('.tag-sheet')).toHaveCount(2);
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
  await page
    .getByRole('navigation', { name: 'breadcrumb' })
    .getByRole('link', { name: programNumber })
    .click();
  await expect(page.getByRole('link', { name: 'Print sample ID tags' })).toBeVisible();
  await expect(page.getByText('Program submitted. Print sample ID tags')).toHaveCount(0);
});
