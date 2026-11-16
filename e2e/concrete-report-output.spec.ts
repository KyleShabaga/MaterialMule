import { createHash, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-V2-C32: issue a concrete field report and download its stored PDF; issue a project summary
// report from the Concrete → Summary tab. Desktop and phone. Fictional data only: DEMO-2601
// (lead Pat Example), technician Alex Tester, invented supplier and tickets. The technician's
// and reviewer's steps go through the API (there is no field-report form yet, C19).

const PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const CSRF = { 'x-materialmule-csrf': '1' };

const SPEC = {
  specifiedStrengthMpa: 32,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
};

function reportFields() {
  return {
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    paperFieldId: 'F-E2E',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: `T-${randomUUID().slice(0, 8)}`,
    truckNumber: 'T-7',
    plantName: 'North Plant',
    batchedAt: '2026-11-08T15:00:00.000Z',
    loadVolumeM3: 8,
    cumulativeVolumeM3: 24,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: '2026-11-08T15:20:00.000Z',
    sampledAt: '2026-11-08T15:30:00.000Z',
    testedAt: '2026-11-08T15:35:00.000Z',
    timeLimitExceeded: false,
    loadRejected: false,
    loadDecisionByName: 'Sam Example',
    loadDecisionByCompany: 'Example Builders',
    samplingLocation: 'chute',
    placementMethods: ['chute'],
    material: 'concrete',
    superplasticizerAdded: 'none',
    concreteTempC: 18,
    ambientTempC: -4,
    waterAdded: false,
    specimensCast: false,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders',
    readings: [
      { id: randomUUID(), test: 'slump', context: 'initial', value: 90 },
      { id: randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [{ id: randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' }],
  };
}

async function api<T = { id: string; version: number }>(
  page: Page,
  method: 'post' | 'patch' | 'get',
  url: string,
  data?: unknown,
): Promise<T> {
  const response =
    method === 'get'
      ? await page.request.get(url)
      : await page.request[method](url, { headers: CSRF, data: data as object });
  expect(response.ok(), `${method} ${url}: ${await response.text()}`).toBe(true);
  return (await response.json()) as T;
}

/** A submitted report, reviewed by the lead through the API (exceptions documented first). */
async function reviewedReport(page: Page): Promise<string> {
  await signInAs(page, 'at');
  const created = await api(page, 'post', `/api/concrete/projects/${PROJECT_ID}/field-reports`, {
    idempotencyKey: randomUUID(),
    ...reportFields(),
  });
  const submitted = await api(page, 'post', `/api/concrete/field-reports/${created.id}/submit`, {
    idempotencyKey: randomUUID(),
    version: created.version,
  });
  await signInAs(page, 'pe');
  const detail = await api<{
    lifecycle: { latestVersion: { versionNo: number } };
    review: { warnings: { code: string; field: string | null }[] };
  }>(page, 'get', `/api/concrete/field-reports/${created.id}`);
  for (const warning of detail.review.warnings) {
    await api(
      page,
      'post',
      `/api/concrete/field-reports/${created.id}/versions/${detail.lifecycle.latestVersion.versionNo}/exception-notes`,
      { code: warning.code, field: warning.field, note: 'Checked with the supplier' },
    );
  }
  await api(page, 'post', `/api/concrete/field-reports/${created.id}/review`, {
    idempotencyKey: randomUUID(),
    version: submitted.version,
  });
  return created.id;
}

test('issuing a field report stores its PDF; the issue view opens exactly that file', async ({
  page,
}) => {
  const reportId = await reviewedReport(page);
  await page.goto(`/concrete/review/${reportId}/issue`);
  const side = page.getByRole('complementary', { name: 'Issue panel' });
  await side.getByRole('button', { name: 'Issue report' }).click();
  await page
    .getByRole('alertdialog', { name: /^Issue the .* field report\?$/ })
    .getByRole('button', { name: 'Issue report' })
    .click();
  await expect(page.getByText('Version 1 issued.')).toBeVisible();

  const number = side.getByText(/^CF-\d{4}-\d{5}$/);
  await expect(number).toBeVisible();
  const reportNumber = (await number.textContent())!;
  const open = side.getByRole('link', { name: 'Open issued PDF (Rev 0)' });
  await expect(open).toBeVisible();
  await expect(side.getByText(/Field report template P1 \(provisional\)/)).toBeVisible();

  // Download the stored file: a PDF whose bytes match the recorded SHA-256.
  const href = (await open.getAttribute('href'))!;
  expect(href).toMatch(/^\/api\/concrete\/report-files\/[0-9a-f-]{36}$/);
  const response = await page.request.get(href);
  expect(response.status()).toBe(200);
  expect(response.headers()['content-type']).toBe('application/pdf');
  const bytes = await response.body();
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  expect(createHash('sha256').update(bytes).digest('hex')).toBe(
    response.headers()['x-content-sha256'],
  );

  // The version list records the same number and file.
  const versions = await api<{
    versions: { issued: { reportNumber: string; file: { id: string; sha256: string } } | null }[];
  }>(page, 'get', `/api/concrete/field-reports/${reportId}/versions`);
  const issued = versions.versions.find((v) => v.issued)!.issued!;
  expect(issued.reportNumber).toBe(reportNumber);
  expect(href.endsWith(issued.file.id)).toBe(true);
  expect(issued.file.sha256).toBe(response.headers()['x-content-sha256']);
});

test('the lead issues a project summary report from the Summary tab', async ({ page }) => {
  await signInAs(page, 'pe');
  await page.goto(`/projects/${PROJECT_ID}/concrete/summary`);
  const generate = page.getByRole('button', { name: 'Generate summary report' });
  await expect(generate).toBeEnabled();

  // The preview is the server's unnumbered PDF.
  const preview = page.getByRole('link', { name: 'Preview summary report' });
  const previewResponse = await page.request.get((await preview.getAttribute('href'))!);
  expect(previewResponse.headers()['content-type']).toBe('application/pdf');

  await generate.click();
  await page
    .getByRole('alertdialog', { name: 'Issue this summary report?' })
    .getByRole('button', { name: 'Issue summary report' })
    .click();
  const status = page.getByRole('status').filter({ hasText: /CSR-\d{4}-\d{4} issued\./ });
  await expect(status).toBeVisible();
  const reportNumber = (await status.textContent())!.replace(' issued.', '');
  const open = page.getByRole('link', { name: `Open ${reportNumber} (PDF)` });
  await expect(open).toBeVisible();
  const file = await page.request.get((await open.getAttribute('href'))!);
  expect(file.status()).toBe(200);
  expect((await file.body()).subarray(0, 5).toString('latin1')).toBe('%PDF-');

  // Someone without report.issue sees why the button is off.
  await signInAs(page, 'at');
  await page.goto(`/projects/${PROJECT_ID}/concrete/summary`);
  await expect(page.getByRole('button', { name: 'Generate summary report' })).toBeDisabled();
  await expect(
    page.getByText(
      'Only the project’s Lead Project Engineer or an Authorized report issuer can issue a summary report.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: `Open ${reportNumber} (PDF)` })).toBeVisible();
});
