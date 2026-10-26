import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, insertConfirmedReceipt, withDatabase } from './support/db';
import { decodePdfPage, decodeSvg, readPdfPages } from './support/pdf';

// TRP-T39: label preview on the unit page and the true-size print view for Save as PDF.

const symbols = (id: string) => [
  ['Code128', id],
  ['QRCode', id],
];

/** What printing to PDF must never touch: print jobs, audit events and the unit row. */
function sideEffects(unitIds: string[]) {
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT (SELECT count(*)::int FROM print_job_item WHERE storage_unit_id = ANY($1::uuid[])) AS items,
              (SELECT count(*)::int FROM audit_event WHERE entity_id = ANY($1::uuid[])) AS audits,
              (SELECT json_agg(su ORDER BY su.readable_id) FROM storage_unit su
                WHERE su.id = ANY($1::uuid[])) AS units`,
      [unitIds],
    );
    return rows[0];
  });
}

/** Chromium's Save as PDF, honouring the print view's @page size, as the print dialog does. */
async function saveAsPdf(page: Page) {
  return readPdfPages(await page.pdf({ preferCSSPageSize: true, printBackground: true }));
}

test('T3/T4: preview on the unit page, then a true-size PDF whose barcodes decode', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  const before = await sideEffects([unit.id]);

  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${unit.readableId}`);
  const panel = page.getByRole('region', { name: 'Preview label' });
  const image = panel.getByRole('img', { name: `Label for storage unit ${unit.readableId}` });
  await expect(image).toBeVisible();
  // AC1: the label shown on screen carries both barcodes, encoding exactly the ID.
  const src = (await image.getAttribute('src'))!;
  expect(src.startsWith('data:image/svg+xml')).toBe(true);
  const svg = decodeURIComponent(src.slice(src.indexOf(',') + 1));
  expect(await decodeSvg(svg, 3.5)).toEqual(symbols(unit.readableId));
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);

  await panel.getByRole('button', { name: 'Zoom in' }).click();
  await expect(panel.getByText('Zoomed to twice the real size.')).toBeVisible();

  // Print view: no app chrome, instructions, one label.
  await panel.getByRole('link', { name: 'Print / Save as PDF' }).click();
  await expect(page.getByRole('heading', { name: `Label ${unit.readableId}` })).toBeVisible();
  await expect(page.getByText(/100% \(Actual size\)/)).toBeVisible();
  await expect(page.getByRole('navigation')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toBeVisible();

  // AC2: each PDF page is 3.5 × 1.5 in with one label whose barcodes decode to the ID.
  const pages = await saveAsPdf(page);
  expect(pages).toHaveLength(1);
  expect(pages[0]!.widthIn).toBeCloseTo(3.5, 3);
  expect(pages[0]!.heightIn).toBeCloseTo(1.5, 3);
  expect(await decodePdfPage(pages[0]!)).toEqual(symbols(unit.readableId));

  // T4 / AC5: previewing and saving a PDF create no print job, audit event or unit change.
  expect(await sideEffects([unit.id])).toEqual(before);
  await page.getByRole('link', { name: `← Back to ${unit.readableId}` }).click();
  await expect(page.getByText('No labels printed yet.')).toBeVisible();
});

test('AC3: one print view holds every label of a receipt, in receipt order', async ({ page }) => {
  const { units } = await insertConfirmedReceipt(3);
  const before = await sideEffects(units.map((u) => u.id));

  await signInAs(page, 'lab');
  await page.goto(`/sample-storage/${units[1]!.readableId}`);
  await page.getByRole('link', { name: 'Print / Save all 3 labels of this receipt' }).click();
  await expect(page.getByRole('heading', { name: '3 labels' })).toBeVisible();
  const sheet = page.getByLabel('Labels to print');
  await expect(sheet.getByRole('img')).toHaveCount(3);

  const pages = await saveAsPdf(page);
  expect(pages).toHaveLength(3);
  for (const [index, pdfPage] of pages.entries()) {
    expect(pdfPage.widthIn).toBeCloseTo(3.5, 3);
    expect(pdfPage.heightIn).toBeCloseTo(1.5, 3);
    expect(await decodePdfPage(pdfPage)).toEqual(symbols(units[index]!.readableId));
  }
  expect(await sideEffects(units.map((u) => u.id))).toEqual(before);
});

test('AC4: signed out, the preview API answers 401', async ({ page }) => {
  const unit = await insertConfirmedBucket();
  const response = await page.request.get(`/api/storage-units/${unit.readableId}/label/preview`);
  expect(response.status()).toBe(401);
});
