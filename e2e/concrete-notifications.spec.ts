import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-V2-C29 T3: a returned concrete field report reaches the one header bell as an unread
// notification, on desktop and phone. Opening it goes to the report and marks it read. Fictional
// data only: DEMO-2601, technician Alex Tester (at), Lead Project Engineer Pat Example (pe), who
// reviews and returns it.
//
// Other specs notify `at` in parallel, so this one follows its own row (found by its unique
// return comment) and checks that the bell matches the server's count, never arithmetic.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const CSRF = { 'x-materialmule-csrf': '1' };
const NOTIFICATIONS = /^Notifications, (\d+|none) unread$/;

const SPEC = {
  specifiedStrengthMpa: 32,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
};

/** A complete fictional field report (C04's final-review fields), created by the signed-in user. */
function completeFields() {
  return {
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: `T-${randomBytes(4).toString('hex')}`,
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
      { id: crypto.randomUUID(), test: 'slump', context: 'initial', value: 90 },
      { id: crypto.randomUUID(), test: 'air', context: 'initial', value: 6 },
    ],
    attachmentRefs: [
      { id: crypto.randomUUID(), kind: 'ticket_photo', fileName: 'ticket-0042.jpg' },
    ],
  };
}

/** `at` submits a report; `pe` returns it with `comment`. Leaves the page signed in as `pe`. */
async function returnedReport(page: Page, comment: string): Promise<string> {
  await signInAs(page, 'at');
  const created = await page.request.post(
    `/api/concrete/projects/${DEMO_PROJECT_ID}/field-reports`,
    { headers: CSRF, data: { idempotencyKey: crypto.randomUUID(), ...completeFields() } },
  );
  expect(created.status(), await created.text()).toBe(201);
  const draft = (await created.json()) as { id: string; version: number };
  const submitted = await page.request.post(`/api/concrete/field-reports/${draft.id}/submit`, {
    headers: CSRF,
    data: { idempotencyKey: crypto.randomUUID(), version: draft.version },
  });
  expect(submitted.status(), await submitted.text()).toBe(201);
  const report = (await submitted.json()) as { version: number };
  await signInAs(page, 'pe');
  const returned = await page.request.post(`/api/concrete/field-reports/${draft.id}/return`, {
    headers: CSRF,
    data: { idempotencyKey: crypto.randomUUID(), version: report.version, comment },
  });
  expect(returned.status(), await returned.text()).toBe(201);
  return draft.id;
}

async function expectBellMatchesServer(page: Page) {
  await expect
    .poll(async () => {
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      const label = await page
        .getByRole('link', { name: NOTIFICATIONS })
        .getAttribute('aria-label');
      const match = /, (\d+|none) /.exec(label ?? '');
      const shown = !match?.[1] || match[1] === 'none' ? 0 : Number(match[1]);
      const server = (await (await page.request.get('/api/notifications/count')).json()) as {
        unread: number;
      };
      return shown === server.unread;
    })
    .toBe(true);
}

test('MM-V2-C29: a returned field report reaches the technician’s bell and opens the report', async ({
  page,
}) => {
  const comment = `Fictional E2E correction ${randomBytes(3).toString('hex')}: slump time missing`;
  const reportId = await returnedReport(page, comment);

  await signInAs(page, 'at');
  await page.goto('/');
  const bell = page.getByRole('link', { name: NOTIFICATIONS });
  await expect(bell).toBeVisible();
  await expectBellMatchesServer(page);
  expect(await bell.getAttribute('aria-label')).not.toBe('Notifications, none unread');

  await bell.click();
  await expect(page).toHaveURL(/\/notifications$/);
  const row = page.getByRole('listitem').filter({ hasText: comment });
  await expect(row).toContainText('Unread');
  await expect(row).toContainText('Field report returned for correction');
  await expect(row).toContainText('DEMO-2601');
  await expect(row).toContainText('Returned for correction');
  await expect(row).toContainText('Returned by Pat Example');

  const open = row.getByRole('link', { name: 'Open report' });
  await expect(open).toHaveAttribute('href', `/concrete/field-reports/${reportId}`);
  await open.click();
  await expect(page).toHaveURL(new RegExp(`/concrete/field-reports/${reportId}$`));

  // Opening read it; the bell follows the server.
  await page.goto('/notifications');
  await expect(row).toBeVisible();
  await expect(row).not.toContainText('Unread');
  await expectBellMatchesServer(page);
});
