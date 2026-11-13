import { randomBytes, randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { mainNav, openMore } from './support/shell';
import { withDatabase } from './support/db';

// MM-V2-C31 T2: the Concrete dashboard, the Concrete Lab workspace, Specimen lookup, Concrete
// search and the top-bar Lab search, on desktop and phone against the real API. Each test makes
// two fictional projects and casts one set in each as Alex Tester (`at`), both numbered with the
// same random set number, so the number repeats across projects (AC1); the first set also gets a
// temporary ID (AC2). IDs are attached with SQL, standing in for C18 / C12. Fictional data only.

const PE_ID = '00000000-0000-4000-8000-000000000101';
const CSRF = { 'x-materialmule-csrf': '1' };

interface Fixture {
  projects: { id: string; number: string }[];
  setIds: string[];
  setNumber: string;
  temporaryId: string;
}

async function castTwoProjects(page: Page): Promise<Fixture> {
  const tag = randomBytes(3).toString('hex').toUpperCase();
  const counter = randomInt(10_000, 99_999);
  const setNumber = `26-${counter}`;
  const temporaryId = `TMP-E2E${tag}-1`;
  const projects = await withDatabase(async (client) => {
    const made: { id: string; number: string }[] = [];
    for (const suffix of ['A', 'B']) {
      const number = `E2E-C31-${tag}${suffix}`;
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
         VALUES ($1, 'Concrete lab demo', 'Example Client', $2) RETURNING id`,
        [number, PE_ID],
      );
      made.push({ id: rows[0]!.id, number });
    }
    return made;
  });
  await signInAs(page, 'at');
  const setIds: string[] = [];
  for (const project of projects) {
    const report = await page.request.post(`/api/concrete/projects/${project.id}/field-reports`, {
      headers: CSRF,
      data: {
        idempotencyKey: crypto.randomUUID(),
        material: 'concrete',
        specimensCast: true,
        castAt: '2026-11-02T09:00:00-06:00',
      },
    });
    expect(report.status()).toBe(201);
    const reportId = ((await report.json()) as { id: string }).id;
    const set = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
      headers: CSRF,
      data: { idempotencyKey: crypto.randomUUID() },
    });
    expect(set.status()).toBe(201);
    setIds.push(((await set.json()) as { id: string }).id);
  }
  await withDatabase(async (client) => {
    await client.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3
       WHERE id = ANY($1::uuid[])`,
      [setIds, counter, setNumber],
    );
    await client.query(`UPDATE concrete_specimen_set SET temporary_id = $2 WHERE id = $1`, [
      setIds[0],
      temporaryId,
    ]);
  });
  return { projects, setIds, setNumber, temporaryId };
}

test('AC1 and AC2: Specimen lookup lists a repeated set number with both projects, and a TMP ID opens its set', async ({
  page,
}) => {
  const data = await castTwoProjects(page);
  // A Lab Technician on a lab computer: the sidebar's Concrete section holds the lab pages.
  await signInAs(page, 'lt');
  await page.goto('/');
  await openMore(page);
  const nav = mainNav(page);
  for (const label of ['Overview', 'Breaks', 'Receiving', 'Specimens', 'Holds', 'Review']) {
    await expect(nav.getByRole('link', { name: label, exact: true })).toBeVisible();
  }
  await nav.getByRole('link', { name: 'Specimens', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Specimen lookup', level: 1 })).toBeVisible();

  const box = page.getByRole('textbox', { name: 'Specimen or set ID' });
  await box.fill(`${data.setNumber}B`);
  await box.press('Enter');
  await expect(page.getByText('Set numbers repeat between projects')).toBeVisible();
  for (const project of data.projects) {
    const sets = page.getByRole('list', { name: `Specimen sets, ${project.number}` });
    await expect(sets.getByRole('link', { name: `${data.setNumber}B` })).toBeVisible();
  }
  // Nothing was chosen for the user: still on the list.
  await expect(page).toHaveURL(/\/concrete\/specimens\?q=/);

  await page.getByRole('textbox', { name: 'Specimen or set ID' }).fill(data.temporaryId);
  await page.getByRole('textbox', { name: 'Specimen or set ID' }).press('Enter');
  await expect(page).toHaveURL(new RegExp(`/concrete/specimens/${data.setIds[0]}`));
  await expect(
    page.getByRole('heading', { name: `Set ${data.setNumber}`, level: 1 }),
  ).toBeVisible();
  await expect(page.getByText(`Project ${data.projects[0]!.number}`)).toBeVisible();
  await expect(page.getByText(`Temporary ID: ${data.temporaryId}`)).toBeVisible();
  const specimens = page.getByRole('region', { name: 'Specimens' });
  await expect(specimens.getByText(`${data.setNumber}A`, { exact: true })).toBeVisible();
  await expect(specimens.getByText('Awaiting pickup').first()).toBeVisible();
  await expect(page.getByRole('heading', { name: 'History' })).toBeVisible();
  await expect(page.getByText(/Set recorded by Alex Tester/)).toBeVisible();
});

test('AC3: dashboard counts match the lists they open, and My reports come first', async ({
  page,
}) => {
  const data = await castTwoProjects(page);
  // Alex Tester did both field tests: both sets are under My reports.
  await page.goto('/concrete');
  await expect(page.getByRole('heading', { name: 'Concrete', level: 1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New field report' })).toBeDisabled();
  await expect(page.getByRole('link', { name: 'Open testing table' })).toHaveAttribute(
    'href',
    '/concrete/testing',
  );

  // Other lanes' tests may add sets meanwhile: compare the two numbers until they agree.
  await expect(async () => {
    await page.goto('/concrete');
    const tile = page.getByRole('link', { name: /^\d+ Awaiting pickup$/ });
    const count = Number((await tile.textContent())!.match(/\d+/)![0]);
    await tile.click();
    await expect(page.getByRole('heading', { name: 'Specimen receiving', level: 1 })).toBeVisible();
    await expect(page.getByRole('tab', { name: /Awaiting pickup/ })).toHaveText(
      `Awaiting pickup (${count})`,
      { timeout: 5_000 },
    );
  }).toPass({ timeout: 30_000 });

  const mine = page.getByRole('region', { name: /My reports/ });
  for (const project of data.projects) {
    await expect(mine.getByText(project.number)).toBeVisible();
  }
  await page.getByRole('tab', { name: /Awaiting pickup/ }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('tab', { name: /Awaiting receiving/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await expect(page).toHaveURL(/stage=awaiting_receiving/);

  // STRATA-93: the overdue tile opens Breaks on Overdue; On HOLD opens Holds; and Breaks still
  // opens on the HOLDs due for review from a link (`?view=hold&holdDue=true`).
  await page.goto('/concrete');
  await page.getByRole('link', { name: /^\d+ Tests overdue$/ }).click();
  await expect(page.getByRole('tab', { name: /Overdue/ })).toHaveAttribute('aria-selected', 'true');
  await page.goto('/concrete');
  await page.getByRole('link', { name: /^\d+ On HOLD/ }).click();
  await expect(page).toHaveURL(/\/lab-testing\/concrete\/holds$/);
  await page.goto('/lab-testing/concrete?view=hold&holdDue=true');
  await expect(page.getByRole('tab', { name: /On HOLD/ })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('checkbox', { name: /Only HOLDs due for review/ })).toBeChecked();
});

test('Search (Ctrl K) covers projects and concrete records', async ({ page }) => {
  const data = await castTwoProjects(page);
  await page.goto('/');
  await expect(page.getByRole('banner')).toBeVisible();
  // Strata (STRATA-14): one command menu; Enter on a non-exact query lands on the results page.
  await page.keyboard.press('Control+k');
  const box = page
    .getByRole('dialog', { name: 'Search or scan' })
    .getByRole('combobox', { name: 'Search or scan a label' });
  await box.fill(data.projects[1]!.number);
  await box.press('Enter');
  await expect(page).toHaveURL(/\/search\?q=/);
  await expect(page.getByRole('heading', { name: /^Results for /, level: 1 })).toBeVisible();
  const projects = page.getByRole('region', { name: 'Projects' });
  await expect(
    projects.getByRole('link', { name: new RegExp(`^${data.projects[1]!.number} `) }),
  ).toBeVisible();
  const concrete = page.getByRole('region', { name: 'Concrete' });
  await expect(concrete.getByText(/Matched on Project/).first()).toBeVisible();
  await expect(concrete.getByRole('link').first()).toBeVisible();

  // STRATA-93: Find concrete records on the overview opens the same Ctrl K search with the
  // query, which finds the ticket-less report by its set number too, in both projects.
  await page.goto('/concrete');
  const search = page.getByRole('textbox', { name: 'Find concrete records' });
  await search.fill(data.setNumber);
  await search.press('Enter');
  const menu = page.getByRole('dialog', { name: 'Search or scan' });
  await expect(menu.getByRole('combobox', { name: 'Search or scan a label' })).toHaveValue(
    data.setNumber,
  );
  for (const project of data.projects) {
    await expect(menu.getByText(project.number).first()).toBeVisible();
  }
});
