import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-V2-C26 T2: Concrete → Holds and the Ready for disposal concrete filter, on desktop and
// phone against the real API. Each test casts its own fictional project's numbered 7/28/28/HOLD
// sets 10 days ago (America/Edmonton); permanent numbers are attached with SQL (standing in for
// C18) and a failed-specimen hold is inserted with SQL (standing in for C25). Fictional data only.

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

/** A project with `sets` numbered sets; returns the project and each set's specimen IDs. */
async function castProject(page: Page, sets: number) {
  const projectNumber = `E2E-C26-${randomBytes(3).toString('hex').toUpperCase()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Concrete HOLD demo', 'Example Client', $2) RETURNING id`,
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
      castAt: `${labDate(-10)}T09:00:00-06:00`,
    },
  });
  expect(report.status()).toBe(201);
  const reportId = ((await report.json()) as { id: string }).id;
  const out: { setId: string; hold: string; tested: string }[] = [];
  for (let n = 1; n <= sets; n += 1) {
    const set = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
      headers: CSRF,
      data: { idempotencyKey: crypto.randomUUID() },
    });
    expect(set.status()).toBe(201);
    const body = (await set.json()) as {
      id: string;
      specimens: { id: string; assignedAge: number | 'HOLD' }[];
    };
    await withDatabase((client) =>
      client.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [body.id, n, `26-${String(n).padStart(2, '0')}`],
      ),
    );
    out.push({
      setId: body.id,
      hold: body.specimens.find((s) => s.assignedAge === 'HOLD')!.id,
      tested: body.specimens.find((s) => s.assignedAge === 28)!.id,
    });
  }
  return { projectId, projectNumber, sets: out };
}

/** Turns on one entry of the Holds table's Filter menu (a project, or a closed state). */
async function chooseFilter(page: Page, name: string | RegExp) {
  await page.getByRole('button', { name: /^Filter/ }).click();
  await page.getByRole('menuitemcheckbox', { name }).click();
  await page.keyboard.press('Escape');
}

async function openHolds(page: Page, projectNumber: string) {
  await page.goto('/lab-testing/concrete/holds');
  await expect(page.getByRole('heading', { name: 'Concrete holds', level: 1 })).toBeVisible();
  await chooseFilter(page, projectNumber);
}

test('T2: the lead authorizes disposal of two HOLDs in bulk; a Lab Technician records removal from Ready for disposal', async ({
  page,
}) => {
  const { projectNumber } = await castProject(page, 2);
  await signInAs(page, 'pe');
  await openHolds(page, projectNumber);
  // The open holds (inside the hold period or past it) sit in this region.
  const table = page.getByRole('region', { name: 'HOLD specimens' });
  await expect(table.getByText('26-01D')).toBeVisible();
  await expect(table.getByText('26-02D')).toBeVisible();
  // HOLD expiry is casting + 56 days; nothing has happened on any date.
  await expect(table.getByText(labDate(46)).first()).toBeVisible();
  await expect(table.getByText('Inside the hold period').first()).toBeVisible();

  await page.getByRole('checkbox', { name: 'Select 26-01D' }).check();
  await page.getByRole('checkbox', { name: 'Select 26-02D' }).check();
  const bar = page.getByRole('region', { name: 'Selection' });
  await expect(bar.getByText('2 specimens selected')).toBeVisible();
  await bar.getByRole('button', { name: 'Authorize disposal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Authorize disposal: 2 specimens' });
  const changes = dialog.getByRole('list', { name: 'Specimens and changes' });
  await expect(changes.getByText('HOLD → Disposal authorized')).toHaveCount(2);
  // A reason is required: nothing is sent without one.
  const confirm = dialog.getByRole('button', { name: 'Authorize disposal of 2 specimens' });
  await confirm.click();
  await expect(dialog.getByText('A reason is required')).toBeVisible();
  // The modal dialog hides the page from the accessibility tree; the row is still listed behind it.
  await expect(
    page.getByRole('region', { name: 'HOLD specimens', includeHidden: true }).getByText('26-01D'),
  ).toBeVisible();
  await dialog.getByLabel('Reason').fill('Spare cylinders not needed');
  await confirm.click();
  await expect(page.getByText('2 specimens authorized for disposal.')).toBeVisible();
  await expect(table.getByText('26-01D')).toHaveCount(0);
  // Authorized specimens leave the open list; they are under Filter, shown as a chip.
  await chooseFilter(page, /^Disposal authorized/);
  await expect(
    page.getByRole('group', { name: 'Active sort and filters' }).getByText('Disposal authorized'),
  ).toBeVisible();
  await expect(table.getByRole('row').filter({ hasText: 'Disposal authorized' })).toHaveCount(2);

  // A Lab Technician records the actual removal from the MISC-13 list's concrete filter.
  await signInAs(page, 'lt');
  await page.goto('/disposal-retention');
  await page
    .getByRole('group', { name: 'Show' })
    .getByRole('button', { name: 'Concrete specimens' })
    .click();
  const ready = page.getByRole('table', { name: 'Concrete specimens ready for disposal' });
  await expect(ready.getByText('26-01D').first()).toBeVisible();
  // Other tests' projects may be listed too; pick this project's rows by their checkboxes.
  const rows = ready.getByRole('row').filter({ hasText: projectNumber });
  await expect(rows).toHaveCount(2);
  for (const box of await rows.getByRole('checkbox').all()) await box.check();
  await page.getByRole('button', { name: 'Record disposal' }).click();
  const record = page.getByRole('dialog', { name: 'Record disposal: 2 specimens' });
  await expect(record.getByText('Recorded as removed by you.')).toBeVisible();
  await expect(record.getByText('Disposal authorized → Disposed')).toHaveCount(2);
  await record.getByRole('button', { name: 'Confirm record disposal' }).click();
  await expect(page.getByText('2 specimens recorded as disposed.')).toBeVisible();
  await expect(ready.getByRole('row').filter({ hasText: projectNumber })).toHaveCount(0);

  // Storage units stay the default view of the same card.
  await page.reload();
  await expect(
    page.getByRole('group', { name: 'Show' }).getByRole('button', { name: 'Storage units' }),
  ).toHaveAttribute('aria-pressed', 'true');
});

test('T2: a Lab Manager schedules a HOLD for testing but cannot release a failed-specimen hold without the grant', async ({
  page,
}) => {
  const { projectNumber, sets } = await castProject(page, 1);
  await withDatabase((client) =>
    client.query(
      `INSERT INTO concrete_specimen_failure_hold
         (project_id, specimen_id, reason, placed_by_user_id, placed_by_name_snapshot)
       SELECT project_id, id, 'Low 28-day result', $2, 'Pat Example'
       FROM concrete_specimen WHERE id = $1`,
      [sets[0]!.tested, PE_ID],
    ),
  );
  await signInAs(page, 'lab');
  await openHolds(page, projectNumber);
  // The open holds (inside the hold period or past it) sit in this region.
  const table = page.getByRole('region', { name: 'HOLD specimens' });
  await expect(table.getByText('Failed-specimen hold')).toBeVisible();
  await expect(table.getByText('Low 28-day result')).toBeVisible();
  // No concrete grant on this project: nothing can be done with the failed hold. Selected, every
  // action stays disabled with the server-derived reason (STRATA-95: all three stay visible).
  await page.getByRole('checkbox', { name: 'Select 26-01B' }).check();
  const bar = page.getByRole('region', { name: 'Selection' });
  await expect(bar.getByRole('button', { name: 'Schedule test' })).toBeDisabled();
  await expect(bar.getByRole('button', { name: 'Authorize disposal' })).toBeDisabled();
  await expect(bar.getByRole('button', { name: 'Record disposal' })).toBeDisabled();
  await expect(
    bar.getByText(/26-01B is a failed-specimen hold: no test can be scheduled\./),
  ).toBeVisible();
  await bar.getByRole('button', { name: 'Clear selection' }).click();

  await page.getByRole('checkbox', { name: 'Select 26-01D' }).check();
  await bar.getByRole('button', { name: 'Schedule test' }).click();
  const dialog = page.getByRole('dialog', { name: 'Schedule test: 1 specimen' });
  await dialog.getByLabel('Test age (days)').fill('56');
  await expect(dialog.getByText(`HOLD → 56 d, target ${labDate(46)}`)).toBeVisible();
  await dialog.getByLabel('Reason').fill('Engineer wants a 56-day break');
  await dialog.getByRole('button', { name: 'Schedule test for 1 specimen' }).click();
  await expect(page.getByText('1 specimen scheduled for testing.')).toBeVisible();
  await expect(table.getByText('26-01D')).toHaveCount(0);

  // It is now on the worklist at its new target, with no HOLD expiry.
  const response = await page.request.get(
    `/api/concrete/lab-worklist?view=upcoming&on=${labDate(40)}`,
  );
  expect(JSON.stringify(await response.json())).toContain(sets[0]!.hold);
});
