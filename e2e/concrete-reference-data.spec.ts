import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { DEMO } from './support/receiving';

// MM-V2-C37 against the real API, on desktop and phone: Settings → Suppliers (Lab (test) is the
// fixtures' Lab Manager), Settings → Holidays (admin; Alberta general holidays seeded) and the
// mix detail page's Discard draft (Pat Example, DEMO-2601's Lead). Fictional data only; names,
// dates and mix numbers are unique per viewport so the two runs never collide. Discard draft sits
// on the mix detail page of the project's Concrete → Mixes tab (C30).

const CSRF = { 'x-materialmule-csrf': '1' };

const tag = (testInfo: { project: { name: string } }) =>
  `${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now().toString(36)}`;

/** No sideways page scroll at this width (rows stack into cards on phones). */
async function expectNoHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
}

test('suppliers: the Lab Manager adds and edits one; everyone else reads it and is refused', async ({
  page,
}, testInfo) => {
  const name = `Example Ready-Mix ${tag(testInfo)}`;
  await signInAs(page, 'lab');
  await page.goto('/settings/suppliers');
  await expect(
    page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Suppliers' }),
  ).toBeVisible();
  const section = page.getByRole('region', { name: 'Suppliers', exact: true });
  await section.getByRole('button', { name: 'Add a supplier' }).click();
  const form = section.getByRole('form', { name: 'Add a supplier' });
  await form.getByLabel(/Supplier name/).fill(name);
  await form.getByLabel('Plants').fill('North Plant\nSouth Plant');
  await form.getByRole('button', { name: 'Add supplier' }).click();
  await expect(page.getByText(`${name} added.`)).toBeVisible();
  const table = section.getByRole('table', { name: 'Concrete suppliers' });
  const row = table.getByRole('row').filter({ hasText: name });
  await expect(row).toHaveCount(1);
  await expect(row.getByText('North Plant, South Plant')).toBeVisible();
  await expectNoHorizontalScroll(page);

  await section.getByRole('button', { name: `Edit ${name}` }).click();
  const edit = section.getByRole('form', { name: `Edit ${name}` });
  await edit.getByLabel('Plants').fill('North Plant');
  await edit.getByLabel('Reason (optional)').fill('South plant closed');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(page.getByText(`${name} saved.`)).toBeVisible();
  await expect(row.getByText('North Plant', { exact: true })).toBeVisible();

  await signInAs(page, 'at');
  await page.goto('/settings/suppliers');
  await expect(page.getByText(name, { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add a supplier' })).toHaveCount(0);
  await expect(page.getByText('Only Lab Managers and admins can change suppliers.')).toBeVisible();
  const refused = await page.request.post('/api/concrete/suppliers', {
    headers: CSRF,
    data: { name: `Refused ${name}` },
  });
  expect(refused.status()).toBe(403);
});

test('holidays: the Alberta list is seeded; an admin adds and removes a company holiday', async ({
  page,
}, testInfo) => {
  const phone = testInfo.project.name.startsWith('phone');
  // Different future years per viewport: one holiday per date.
  const year = phone ? 2032 : 2031;
  const date = `${year}-08-04`;
  await signInAs(page, 'admin');
  await page.goto('/settings/holidays');
  const section = page.getByRole('region', { name: 'Holidays', exact: true });
  await expect(section.getByRole('table', { name: /Holidays in 2026/ })).toBeVisible();
  await expect(section.getByText('Canada Day', { exact: true })).toBeVisible();
  await expect(section.getByText('Alberta Family Day', { exact: true })).toBeVisible();
  await expectNoHorizontalScroll(page);

  for (let y = 2026; y < year; y += 1) {
    await section.getByRole('button', { name: 'Next year' }).click();
  }
  await expect(
    section
      .getByRole('table', { name: `Holidays in ${year}` })
      .or(section.getByText(`No holidays are listed for ${year}.`))
      .first(),
  ).toBeVisible();
  await section.getByRole('button', { name: 'Add a holiday' }).click();
  const add = section.getByRole('form', { name: 'Add a holiday' });
  await add.getByLabel(/Date/).fill(date);
  await add.getByLabel(/Name/).fill('Heritage Day');
  await add.getByRole('button', { name: 'Add holiday' }).click();
  await expect(page.getByText('Heritage Day added.')).toBeVisible();
  const table = section.getByRole('table', { name: `Holidays in ${year}` });
  await expect(table.getByText(date)).toBeVisible();
  await expect(table.getByText('Company holiday')).toBeVisible();

  await section.getByRole('button', { name: 'Remove Heritage Day' }).click();
  const remove = section.getByRole('form', { name: 'Remove Heritage Day' });
  await remove.getByLabel(/Reason/).fill('Fictional test: office open');
  await remove.getByRole('button', { name: 'Remove holiday' }).click();
  await expect(page.getByText('Heritage Day removed.')).toBeVisible();
  await expect(section.getByText(`No holidays are listed for ${year}.`)).toBeVisible();

  // A Lab Manager reads the calendar but can't change it.
  await signInAs(page, 'lab');
  await page.goto('/settings/holidays');
  await expect(page.getByText('Only admins can change the holiday calendar.')).toBeVisible();
  const refused = await page.request.post('/api/concrete/holidays', {
    headers: CSRF,
    data: { holidayOn: date, name: 'Refused' },
  });
  expect(refused.status()).toBe(403);
});

test('mix draft discard: the Lead discards a draft and the approved revision stays', async ({
  page,
}, testInfo) => {
  const mixNumber = `E2E-${tag(testInfo)}`;
  await signInAs(page, 'pe');
  const created = await page.request.post(`/api/projects/${DEMO.projectId}/concrete-mixes`, {
    headers: CSRF,
    data: {
      idempotencyKey: crypto.randomUUID(),
      spec: {
        supplierName: 'Example Ready-Mix',
        mixNumber,
        specifiedStrengthMpa: 32,
        slumpTargetMm: 80,
        slumpToleranceMm: 30,
        airMinPercent: 5,
        airMaxPercent: 8,
        maxAggregateSizeMm: 20,
        cementType: 'GU',
      },
    },
  });
  expect(created.status()).toBe(201);
  const mix = (await created.json()) as {
    id: string;
    version: number;
    draftRevision: { id: string };
  };
  const approved = await page.request.post(`/api/concrete-mixes/${mix.id}/approve`, {
    headers: CSRF,
    data: {
      idempotencyKey: crypto.randomUUID(),
      version: mix.version,
      revisionId: mix.draftRevision.id,
    },
  });
  expect(approved.status()).toBe(201);
  const afterApprove = (await approved.json()) as { version: number };
  const drafted = await page.request.patch(`/api/concrete-mixes/${mix.id}`, {
    headers: CSRF,
    data: {
      idempotencyKey: crypto.randomUUID(),
      version: afterApprove.version,
      spec: { specifiedStrengthMpa: 35 },
    },
  });
  expect(drafted.status()).toBe(200);

  // The former mixes address opens the Concrete → Mixes tab; the mix's detail has the action.
  await page.goto(`/projects/${DEMO.projectId}`);
  await expect(page.getByRole('link', { name: 'Concrete mixes' })).toHaveCount(0);
  await page.goto(`/projects/${DEMO.projectId}/concrete-mixes`);
  await expect(page).toHaveURL(new RegExp(`/projects/${DEMO.projectId}/concrete/mixes$`));
  await page.getByRole('link', { name: `Open mix ${mixNumber}` }).click();
  const status = page.getByRole('group', { name: 'Mix status' });
  const spec = page.getByRole('table', { name: 'Mix specification' });
  await expect(status.getByText('Revision pending')).toBeVisible();
  await expect(spec.getByRole('columnheader', { name: 'Revision 1, in effect' })).toBeVisible();
  await expect(spec.getByRole('columnheader', { name: 'Revision 2, draft' })).toBeVisible();
  await expectNoHorizontalScroll(page);
  await page.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Discard draft revision 2' }).click();
  const dialog = page.getByRole('alertdialog', { name: 'Discard draft revision 2?' });
  await dialog.getByLabel(/Note/).fill('Wrong strength');
  await dialog.getByRole('button', { name: 'Discard draft' }).click();
  await expect(
    page.getByText(`Draft revision 2 of ${mixNumber} discarded. Revision 1 stays in effect.`),
  ).toBeVisible();
  await expect(status.getByText('Approved', { exact: true })).toBeVisible();
  await expect(spec.getByRole('columnheader', { name: 'Revision 1, in effect' })).toBeVisible();
  await expect(spec.getByRole('columnheader', { name: 'Revision 2, draft' })).toHaveCount(0);
  await page.getByRole('button', { name: 'More actions' }).click();
  await expect(page.getByRole('menuitem', { name: /Discard draft/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('region', { name: 'History', exact: true })).toContainText(
    'Draft discarded',
  );

  // The history records it.
  const detail = (await (await page.request.get(`/api/concrete-mixes/${mix.id}`)).json()) as {
    history: { action: string; note: string | null }[];
  };
  expect(detail.history[0]).toMatchObject({
    action: 'concrete_mix.draft_discarded',
    note: 'Wrong strength',
  });
});
