import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-V2-C28 T2: review, return, resubmit and issue a concrete field report against the real API,
// on desktop and phone. Fictional data only: DEMO-2601 (lead Pat Example), technician Alex
// Tester, invented supplier and tickets. There is no field-report form yet (C19), so the
// technician's steps (create, submit, correct, resubmit) go through the API.

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

function reportFields(ticketNumber: string) {
  return {
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber,
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
    // 130 mm is outside 80 ± 30 mm: a slump exception for the reviewer.
    readings: [
      { id: randomUUID(), test: 'slump', context: 'initial', value: 130 },
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

test('T2: review with exceptions, return with a comment, resubmit, review and issue', async ({
  page,
}) => {
  const ticket = `T-${randomUUID().slice(0, 8)}`;

  // The technician submits a report with a slump exception (and an unregistered mix).
  await signInAs(page, 'at');
  const created = await api(page, 'post', `/api/concrete/projects/${PROJECT_ID}/field-reports`, {
    idempotencyKey: randomUUID(),
    ...reportFields(`${ticket}-X`),
  });
  const submitted = await api(page, 'post', `/api/concrete/field-reports/${created.id}/submit`, {
    idempotencyKey: randomUUID(),
    version: created.version,
  });
  const reviewPath = `/concrete/review/${created.id}`;

  // The technician can't review their own report: the actions say so.
  await page.goto(reviewPath);
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();
  await expect(
    page.getByText('You are this report’s technician. Someone else must review it.').first(),
  ).toBeVisible();

  // The lead finds it in Awaiting review with its exception flags.
  await signInAs(page, 'pe');
  await page.goto('/concrete/review');
  if (await page.getByRole('button', { name: 'Menu' }).isVisible()) {
    await page.getByRole('button', { name: 'Menu' }).click();
    await expect(
      page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: 'Concrete Review' }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Menu' }).click();
  }
  await expect(page.getByRole('heading', { name: 'Concrete review' })).toBeVisible();
  await expect(page.getByRole('tab', { name: /Awaiting review \(\d+\)/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  const link = page.locator(`a[href="${reviewPath}"]`);
  const row = page.getByRole('row').filter({ has: link });
  await expect(row).toContainText('Slump out of range');
  await expect(row).toContainText('Alex Tester');
  await link.click();

  // AC1: Mark reviewed is disabled with the reason while exceptions are open.
  const preview = page.getByRole('article', { name: /Review preview · version 1/ });
  await expect(
    preview.getByText('This is not the issued report format.', { exact: false }),
  ).toBeVisible();
  const mark = page.getByRole('button', { name: 'Mark reviewed' });
  await expect(mark).toBeDisabled();
  await expect(
    page.getByText('2 exceptions are still open. Resolve or document each one first.'),
  ).toBeVisible();

  // AC2: Return needs a comment; then returned with one.
  await page.getByRole('button', { name: 'Return for correction' }).click();
  const dialog = page.getByRole('dialog', { name: 'Return for correction' });
  await dialog.getByRole('button', { name: 'Return report' }).click();
  await expect(dialog.getByText('Enter a comment explaining the changes needed.')).toBeVisible();
  await dialog.getByLabel(/What needs correcting/).fill('The ticket number has an extra suffix');
  await dialog.getByRole('button', { name: 'Return report' }).click();
  await expect(page.getByText('Returned for correction.', { exact: true })).toBeVisible();

  // The technician corrects the ticket number and resubmits (explicitly).
  await signInAs(page, 'at');
  const returned = await api<{ version: number }>(
    page,
    'get',
    `/api/concrete/field-reports/${created.id}`,
  );
  expect(returned.version).toBeGreaterThan(submitted.version);
  const saved = await api(page, 'patch', `/api/concrete/field-reports/${created.id}`, {
    idempotencyKey: randomUUID(),
    version: returned.version,
    ticketNumber: ticket,
  });
  await api(page, 'post', `/api/concrete/field-reports/${created.id}/resubmit`, {
    idempotencyKey: randomUUID(),
    version: saved.version,
  });

  // AC3: the lead sees only the changed field marked, with the full record still shown.
  await signInAs(page, 'pe');
  await page.goto(reviewPath);
  const v2 = page.getByRole('article', { name: /Review preview · version 2/ });
  await expect(v2.locator('[data-path="fields.ticketNumber"]')).toContainText(
    `Changed (was ${ticket}-X)`,
  );
  await expect(v2.locator('.review-changed-mark')).toHaveCount(1);
  await expect(v2.locator('[data-path="fields.truckNumber"]')).toContainText('T-7');
  await expect(page.getByText(/Returned by Pat Example/)).toContainText(
    'The ticket number has an extra suffix',
  );

  // Document both exceptions, then Mark reviewed.
  const checklist = page.getByRole('complementary', { name: 'Review checklist' });
  for (const note of ['Engineer accepted the load at 130 mm', 'Mix confirmed with the supplier']) {
    await checklist.getByRole('button', { name: 'Document exception' }).first().click();
    await checklist.getByLabel(/How it was addressed/).fill(note);
    await checklist.getByRole('button', { name: 'Save note' }).click();
    await expect(checklist.getByText(`“${note}”`, { exact: false })).toBeVisible();
  }
  await expect(mark).toBeEnabled();
  await mark.click();
  await expect(page.getByText('Marked reviewed. It now awaits issuance.')).toBeVisible();

  // Issue: exact version, reviewer, photos unavailable. Machine info (C38): the project setting is
  // unset, so it starts as Omit and Issue is available without a choice; the issuer overrides it.
  await page.getByRole('link', { name: 'Go to issue' }).click();
  const side = page.getByRole('complementary', { name: 'Issue' });
  await expect(side.getByText('v2', { exact: false }).first()).toBeVisible();
  await expect(side.getByRole('checkbox', { name: 'Include photos' })).toBeDisabled();
  await expect(
    side.getByText('Engineer accepted the load at 130 mm', { exact: false }),
  ).toBeVisible();
  const issue = side.getByRole('button', { name: 'Issue report' });
  await expect(side.getByRole('radio', { name: 'Omit' })).toBeChecked();
  await expect(issue).toBeEnabled();
  await side.getByRole('radio', { name: 'Include' }).check();
  await issue.click();
  const confirm = page.getByRole('dialog', { name: 'Issue this report?' });
  await expect(confirm).toContainText('testing machine information included');
  await confirm.getByRole('button', { name: 'Issue report' }).click();
  await expect(page.getByText('Version 2 issued.')).toBeVisible();
  await expect(side.getByText('Included', { exact: true })).toBeVisible();

  // It now sits under Issued.
  await page.goto('/concrete/review?status=issued');
  await expect(page.getByRole('tab', { name: /Issued/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator(`a[href="${reviewPath}"]`)).toBeVisible();

  // A Lab Manager who is neither a reviewer nor an issuer reads it but can't act.
  await signInAs(page, 'lab');
  await page.goto(reviewPath);
  await expect(page.getByRole('article', { name: /Review preview · version 2/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Start a revision' })).toHaveCount(0);
});
