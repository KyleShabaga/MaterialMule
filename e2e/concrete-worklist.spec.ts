import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-V2-C22 T3: Concrete → Breaks on desktop and phone against the real API. Each
// test casts its own fictional project's set 28 days before today (America/Edmonton), so the two
// 28-day specimens are due today, the 7-day one is 21 days overdue and the HOLD runs 28 more days.
// Permanent numbers are attached with SQL, standing in for C18's allocator. Fictional data only.

const PE_ID = '00000000-0000-4000-8000-000000000101';
const CSRF = { 'x-materialmule-csrf': '1' };

const labDate = (offsetDays = 0) => {
  const today = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
  const [y, m, d] = today.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10);
};
const isWeekend = (date: string) => [0, 6].includes(new Date(`${date}T00:00:00Z`).getUTCDay());

async function castProjectSet(
  page: Page,
  { numbered = true }: { numbered?: boolean } = {},
): Promise<{ projectId: string; projectNumber: string; setId: string; reportId: string }> {
  const projectNumber = `E2E-C22-${randomBytes(3).toString('hex').toUpperCase()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Concrete worklist demo', 'Example Client', $2) RETURNING id`,
      [projectNumber, PE_ID],
    );
    return rows[0]!.id;
  });
  await signInAs(page, 'at');
  const report = await page.request.post(`/api/concrete/projects/${projectId}/field-reports`, {
    headers: CSRF,
    data: {
      idempotencyKey: crypto.randomUUID(),
      material: 'concrete',
      specimensCast: true,
      castAt: `${labDate(-28)}T09:00:00-06:00`,
    },
  });
  expect(report.status()).toBe(201);
  const reportId = ((await report.json()) as { id: string }).id;
  const set = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
    headers: CSRF,
    data: { idempotencyKey: crypto.randomUUID() },
  });
  expect(set.status()).toBe(201);
  const setId = ((await set.json()) as { id: string }).id;
  if (numbered) {
    await withDatabase((client) =>
      client.query(
        `UPDATE concrete_specimen_set SET permanent_number = 1, permanent_id = '26-01' WHERE id = $1`,
        [setId],
      ),
    );
  }
  return { projectId, projectNumber, setId, reportId };
}

async function openFor(page: Page, projectNumber: string) {
  await page.goto('/lab-testing/concrete');
  await expect(page.getByRole('heading', { name: 'Concrete breaks', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project' }).click();
  await page.getByRole('option', { name: projectNumber, exact: true }).click();
}

/** The Breaks selection bar (STRATA-95), shown while specimens are ticked. */
const selectionBar = (page: Page) => page.getByRole('region', { name: 'Selection' });

test('T3: Today, Overdue and HOLD for one project; a technician reads but cannot reschedule', async ({
  page,
}, testInfo) => {
  const { projectNumber } = await castProjectSet(page);
  await openFor(page, projectNumber);
  // The sidebar's Concrete section marks Breaks as the current page (desktop: always shown).
  if (testInfo.project.name.startsWith('desktop')) {
    await expect(
      page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Breaks', exact: true }),
    ).toHaveAttribute('aria-current', 'page');
  }

  const tabs = page.getByRole('tablist', { name: 'Concrete worklist views' });
  await expect(tabs.getByRole('tab', { name: /Today/ })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('tab', { name: /Today/ })).toContainText('2');
  const group = page.getByRole('region', { name: new RegExp(`${projectNumber} ·`) });
  await expect(group.getByText('2 specimens', { exact: true })).toBeVisible();
  const today = labDate();
  for (const id of ['26-01B', '26-01C']) await expect(group.getByText(id)).toBeVisible();
  await expect(group.getByText(today).first()).toBeVisible();
  // AC1: a weekend target stays on the weekend, flagged.
  if (isWeekend(today)) await expect(group.getByText('Weekend target').first()).toBeVisible();
  // A technician can tick specimens, but Reschedule is disabled with the reason.
  await group.getByRole('checkbox', { name: 'Select 26-01B' }).check();
  const reschedule = selectionBar(page).getByRole('button', { name: 'Reschedule' });
  await expect(reschedule).toBeDisabled();
  await expect(reschedule).toHaveAccessibleDescription(/Reschedule needs the project lead/);
  await selectionBar(page).getByRole('button', { name: 'Clear selection' }).click();

  // AC2: the 7-day specimen is overdue and keeps its target.
  await tabs.getByRole('tab', { name: /Overdue/ }).click();
  await expect(group.getByText('26-01A')).toBeVisible();
  await expect(group.getByText(labDate(-21))).toBeVisible();
  await expect(group.getByText('21 days late', { exact: true })).toBeVisible();

  // Keyboard: arrow keys move between the views (Overdue, Today, Next 7 days, On HOLD).
  // AC3: HOLD shows its hold-until date.
  await tabs.getByRole('tab', { name: /Overdue/ }).focus();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  const holdTab = tabs.getByRole('tab', { name: /On HOLD/ });
  await expect(holdTab).toBeFocused();
  await expect(holdTab).toHaveAttribute('aria-selected', 'true');
  await expect(group.getByText('26-01D')).toBeVisible();
  await expect(group.getByText(labDate(28))).toBeVisible();
  await expect(group.getByText('Ordinary HOLD')).toBeVisible();

  await tabs.getByRole('tab', { name: /Exceptions/ }).click();
  await expect(page.getByText(/Not checked here yet/)).toBeVisible();
});

test('T3: the Lead Project Engineer reschedules a test with a reason; history is kept', async ({
  page,
}) => {
  const { projectId, projectNumber } = await castProjectSet(page);
  await signInAs(page, 'pe');
  await openFor(page, projectNumber);
  const group = page.getByRole('region', { name: new RegExp(`${projectNumber} ·`) });
  await expect(group.getByText('2 specimens', { exact: true })).toBeVisible();
  await group.getByRole('checkbox', { name: 'Select 26-01B' }).check();
  await selectionBar(page).getByRole('button', { name: 'Reschedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Reschedule 1 specimen' });
  await dialog.getByLabel('New test age (days)').fill('56');
  await expect(dialog.getByRole('list', { name: 'Specimens to reschedule' })).toContainText(
    `→ 56-day ${labDate(28)}`,
  );
  await dialog.getByLabel('Reason').fill('Engineer requested a 56-day break');
  await dialog.getByRole('button', { name: 'Reschedule 1 specimen' }).click();
  await expect(
    page.getByText(`Rescheduled 26-01B to 56 days (test date ${labDate(28)}).`),
  ).toBeVisible();
  await expect(group.getByText('1 specimen', { exact: true })).toBeVisible();

  // The other 28-day specimen is unchanged; the moved one carries its reschedule flag.
  const tabs = page.getByRole('tablist', { name: 'Concrete worklist views' });
  await tabs.getByRole('tab', { name: /Today/ }).click();
  await group.getByRole('checkbox', { name: 'Select 26-01C' }).check();
  await selectionBar(page).getByRole('button', { name: 'Reschedule' }).click();
  const second = page.getByRole('dialog', { name: 'Reschedule 1 specimen' });
  await expect(second.getByRole('list', { name: 'Specimens to reschedule' })).toContainText(
    `26-01C28-day ${labDate()}`,
  );
  await second.getByRole('button', { name: 'Cancel' }).click();
  const history = await page.request.get(
    `/api/concrete/lab-worklist?view=overdue&on=${labDate(29)}&projectId=${projectId}`,
  );
  const body = (await history.json()) as {
    groups: {
      projectNumber: string;
      rows: { identity: { permanentId: string }; flags: string[] }[];
    }[];
  };
  const moved = body.groups
    .find((g) => g.projectNumber === projectNumber)!
    .rows.find((r) => r.identity.permanentId === '26-01B')!;
  expect(moved.flags).toContain('rescheduled');
});

// MM-V2-C38 (owner decision 2026-11-09): past draft, an unnumbered set can't be rescheduled. The
// report is moved past draft with SQL, standing in for C09's submit.
test('C38: Reschedule leaves out an unnumbered set past draft and names the reason', async ({
  page,
}) => {
  const { projectNumber, reportId } = await castProjectSet(page, { numbered: false });
  await withDatabase((client) =>
    client.query(
      `UPDATE concrete_field_report SET workflow_state = 'submitted', submitted_at = now()
       WHERE id = $1`,
      [reportId],
    ),
  );
  await signInAs(page, 'pe');
  await openFor(page, projectNumber);
  const group = page.getByRole('region', { name: new RegExp(`${projectNumber} ·`) });
  await expect(group.getByText('2 specimens', { exact: true })).toBeVisible();
  await group.getByRole('checkbox', { name: /^Select set .* \(28-day\)$/ }).check();
  await selectionBar(page).getByRole('button', { name: 'Reschedule' }).click();
  const dialog = page.getByRole('dialog', { name: 'Nothing to reschedule' });
  const left = dialog.getByRole('list', { name: 'Not included' }).getByRole('listitem');
  await expect(left).toHaveCount(2);
  for (const item of await left.all()) {
    await expect(item).toContainText('its set isn’t numbered yet; number the set first');
  }
  await expect(dialog.getByRole('button', { name: 'Nothing to reschedule' })).toBeDisabled();
});
