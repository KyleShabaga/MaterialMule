import { randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-V2-C30 T2: the project Concrete section's five tabs, add / copy / approve a mix, and the
// mix propagation review (approve only some records), on desktop and phone, against the real API.
// Fictional data only: DEMO-2601 and DEMO-2602 (both led by Pat Example), technician Alex
// Tester, invented supplier and mix numbers. There is no field-report form yet, so the
// technician's reports and sets are created through the API.

const PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const OTHER_PROJECT_ID = '00000000-0000-4000-8000-000000000202';
const CSRF = { 'x-materialmule-csrf': '1' };

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

async function expectProjectSections(page: Page) {
  // Nothing to do: the project sections are in the page, not the menu.
  await expect(page.getByRole('navigation', { name: 'Project sections' })).toBeVisible();
}

test('T2: five tabs, add / copy / approve a mix, and approve only some affected records', async ({
  page,
}) => {
  const run = randomUUID().slice(0, 6).toUpperCase();
  const mixNumber = `C30-${run}`;
  const sourceNumber = `SRC-${run}`;

  // A source mix in DEMO-2602 to copy from (set up through the API).
  await signInAs(page, 'pe');
  const source = await api<{ id: string; version: number; draftRevision: { id: string } }>(
    page,
    'post',
    `/api/projects/${OTHER_PROJECT_ID}/concrete-mixes`,
    {
      idempotencyKey: randomUUID(),
      spec: {
        supplierName: 'Example Ready-Mix',
        mixNumber: sourceNumber,
        specifiedStrengthMpa: 35,
        slumpTargetMm: 75,
        slumpToleranceMm: 25,
        airMinPercent: 4,
        airMaxPercent: 7,
        maxAggregateSizeMm: 20,
        cementType: 'GU',
      },
    },
  );
  await api(page, 'post', `/api/concrete-mixes/${source.id}/approve`, {
    idempotencyKey: randomUUID(),
    version: source.version,
    revisionId: source.draftRevision.id,
  });

  // The Concrete section sits beside the project's Overview.
  await page.goto(`/projects/${PROJECT_ID}`);
  await expectProjectSections(page);
  await page
    .getByRole('navigation', { name: 'Project sections' })
    .getByRole('link', { name: 'Concrete' })
    .click();
  const tabs = page.getByRole('navigation', { name: 'Concrete' });
  for (const name of ['Reports', 'Specimens', 'Summary', 'Mixes', 'Settings']) {
    await expect(tabs.getByRole('link', { name })).toBeVisible();
  }
  await expect(page.getByRole('searchbox', { name: 'Search reports' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New field report' })).toBeDisabled();

  await tabs.getByRole('link', { name: 'Summary' }).click();
  await expect(page.getByRole('radio', { name: 'All dates' })).toBeChecked();
  // MM-V2-C32: the lead may issue a summary report (concrete-report-output.spec.ts issues one).
  await expect(page.getByRole('button', { name: 'Generate summary report' })).toBeEnabled();

  await tabs.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('heading', { name: 'Concrete settings' })).toBeVisible();
  await expect(page.getByLabel('Default specimen ages')).toHaveValue(/HOLD/);
  await expect(page.getByRole('heading', { name: 'Lead and reviewers' })).toBeVisible();
  await expect(page.getByText('Pat Example', { exact: false }).first()).toBeVisible();

  // Add a mix (Unapproved), then approve it.
  await tabs.getByRole('link', { name: 'Mixes' }).click();
  await page.getByRole('button', { name: 'Add mix' }).click();
  const form = page.getByRole('form', { name: 'Add mix' });
  await form.getByLabel('Supplier').fill('Example Ready-Mix');
  await form.getByLabel('Mix number').fill(mixNumber);
  await form.getByLabel('Specified strength (MPa)').fill('32');
  await form.getByLabel('Slump target (mm)').fill('80');
  await form.getByLabel('Slump tolerance ± (mm)').fill('30');
  await form.getByLabel('Air minimum (%)').fill('5');
  await form.getByLabel('Air maximum (%)').fill('8');
  await form.getByLabel('Max aggregate size (mm)').fill('20');
  await form.getByLabel('Cement type').fill('GU');
  await form.getByRole('button', { name: 'Add mix' }).click();
  await expect(
    page.getByRole('heading', { name: `Example Ready-Mix · ${mixNumber}` }),
  ).toBeVisible();
  await expect(page.getByText('Unapproved', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Approve revision 1' }).click();
  await page
    .getByRole('dialog', { name: 'Approve revision 1?' })
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(page.getByText('Revision 1 approved.')).toBeVisible();
  await expect(page.locator('.mix-heading').getByText('Approved', { exact: true })).toBeVisible();
  const mixUrl = page.url();
  const mixId = mixUrl.split('/mixes/')[1]!.split(/[?#/]/)[0]!;

  // AC2: a copy from another project starts Unapproved.
  await page.getByRole('link', { name: '← Back to Mixes' }).click();
  await page.getByRole('button', { name: 'Copy from another project' }).click();
  await page.getByRole('searchbox', { name: 'Find the source project' }).fill('DEMO-2602');
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await page.getByRole('button', { name: /DEMO-2602/ }).click();
  await page.getByRole('button', { name: `Copy ${sourceNumber}` }).click();
  await expect(
    page.getByRole('heading', { name: `Example Ready-Mix · ${sourceNumber}` }),
  ).toBeVisible();
  await expect(page.getByText('Unapproved', { exact: true })).toBeVisible();
  await expect(page.getByText(/Copied from DEMO-2602/)).toBeVisible();

  // The technician has two draft reports made with revision 1 (one with a specimen set).
  await signInAs(page, 'at');
  const reports: string[] = [];
  for (const ticket of [`${run}-A`, `${run}-B`]) {
    const created = await api(page, 'post', `/api/concrete/projects/${PROJECT_ID}/field-reports`, {
      idempotencyKey: randomUUID(),
      mixId,
      applyMixDefaults: true,
      reportDate: '2026-11-06',
      ticketNumber: ticket,
      material: 'concrete',
      specimensCast: true,
      castAt: '2026-11-06T09:00:00-07:00',
      locationElements: ['Footing'],
      locationDescription: `C30 run ${run}`,
    });
    reports.push(created.id);
  }
  await api(page, 'post', `/api/concrete/field-reports/${reports[0]}/specimen-sets`, {
    idempotencyKey: randomUUID(),
  });

  // AC3: a non-Lead sees no mix actions.
  await page.goto(mixUrl);
  await expect(
    page.getByText('Only the project’s Lead Project Engineer can edit or approve this mix.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /Edit/ })).toHaveCount(0);
  await page.goto(`/projects/${PROJECT_ID}/concrete/mixes`);
  await expect(page.getByRole('button', { name: 'Add mix' })).toHaveCount(0);
  await expect(page.getByText(/Only the project’s Lead Project Engineer can add/)).toBeVisible();

  // The Reports and Specimens tabs list the technician's records.
  await page.goto(`/projects/${PROJECT_ID}/concrete/reports`);
  await page.getByRole('searchbox', { name: 'Search reports' }).fill(`C30 run ${run}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Showing 1–2 of 2 reports')).toBeVisible();
  await page.goto(`/projects/${PROJECT_ID}/concrete/specimens`);
  await page.getByRole('searchbox', { name: 'Search specimens' }).fill(`C30 run ${run}`);
  await page.getByRole('button', { name: 'Search', exact: true }).click();
  await expect(page.getByText('Showing 1–4 of 4 specimens')).toBeVisible();

  // The Lead edits the mix (a draft revision), approves it and lands on the propagation review.
  await signInAs(page, 'pe');
  await page.goto(mixUrl);
  await page.getByRole('button', { name: 'Edit (makes a draft revision)' }).click();
  const edit = page.getByRole('form', { name: 'Edit mix' });
  await edit.getByLabel('Slump target (mm)').fill('100');
  await edit.getByRole('button', { name: 'Save draft' }).click();
  await expect(page.getByText(/Saved as draft revision 2/)).toBeVisible();
  await page.getByRole('button', { name: 'Approve revision 2' }).click();
  await page
    .getByRole('dialog', { name: 'Approve revision 2?' })
    .getByRole('button', { name: 'Approve' })
    .click();
  await expect(
    page.getByRole('heading', {
      name: `Records made from earlier revisions of Example Ready-Mix ${mixNumber}`,
    }),
  ).toBeVisible();
  const reportsCard = page.getByRole('region', { name: 'Field reports', exact: true });
  await expect(reportsCard.getByRole('checkbox')).toHaveCount(2);
  await expect(reportsCard).toContainText('Slump target (mm): 80 → 100');

  // AC1: approve only one report; the other stays listed and the history shows the scope.
  await reportsCard
    .getByRole('checkbox', { name: `Update Field report 2026-11-06, ticket ${run}-A` })
    .check();
  await page.getByLabel('Note (optional, kept in the history)').fill('Supplier revised slump');
  await page.getByRole('button', { name: 'Approve selected (1)' }).click();
  await expect(page.getByText('Updated 1 record from the mix.', { exact: false })).toBeVisible();
  await expect(reportsCard.getByRole('checkbox')).toHaveCount(1);
  await expect(reportsCard).toContainText(`ticket ${run}-B`);
  await expect(reportsCard).not.toContainText(`ticket ${run}-A`);

  await page.getByRole('link', { name: '← Back to the mix' }).click();
  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(history).toContainText('Records updated from the mix');
  await expect(history).toContainText(
    `Chosen records from revision 2: Field report 2026-11-06, ticket ${run}-A`,
  );
  await expect(history).toContainText('Supplier revised slump');

  const updated = await api<{ fields: { projectSpec: { slumpTargetMm: number } } }>(
    page,
    'get',
    `/api/concrete/field-reports/${reports[0]}`,
  );
  expect(updated.fields.projectSpec.slumpTargetMm).toBe(100);
  const untouched = await api<{ fields: { projectSpec: { slumpTargetMm: number } } }>(
    page,
    'get',
    `/api/concrete/field-reports/${reports[1]}`,
  );
  expect(untouched.fields.projectSpec.slumpTargetMm).toBe(80);
});
