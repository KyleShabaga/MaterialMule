import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-V2-C23 T2: the daily testing table against the real API, desktop only (the lab computers;
// keyboard first). A fictional project gets 15 sets cast 28 days before today
// (America/Edmonton): 30 specimens (B, C of each) are due today, 15 (A) are 21 days overdue and D
// is HOLD. Permanent numbers are attached with SQL, standing in for C18's allocator, in an order
// where text sorting would put 26-10 before 26-2. Fictional data only.

const PE_ID = '00000000-0000-4000-8000-000000000101';
const CSRF = { 'x-materialmule-csrf': '1' };
const SETS = 15;

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

interface Cast {
  projectId: string;
  projectNumber: string;
  /** Specimen IDs by label, e.g. 26-2B. */
  specimens: Map<string, string>;
}

async function castProject(page: Page): Promise<Cast> {
  const projectNumber = `E2E-C23-${randomBytes(3).toString('hex').toUpperCase()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Concrete testing table demo', 'Example Client', $2) RETURNING id`,
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
  const setIds: string[] = [];
  for (let i = 0; i < SETS; i += 1) {
    const set = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
      headers: CSRF,
      data: { idempotencyKey: crypto.randomUUID() },
    });
    expect(set.status()).toBe(201);
    setIds.push(((await set.json()) as { id: string }).id);
  }
  // Highest numbers first, so creation order and text order both differ from the numeric one.
  const specimens = await withDatabase(async (client) => {
    for (const [i, setId] of setIds.entries()) {
      const n = SETS - i;
      await client.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [setId, n, `26-${String(n).padStart(2, '0')}`],
      );
    }
    const { rows } = await client.query<{ id: string; label: string }>(
      `SELECT sp.id, st.permanent_id || sp.letter AS label FROM concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id WHERE sp.project_id = $1`,
      [projectId],
    );
    return new Map(rows.map((r) => [r.label, r.id]));
  });
  return { projectId, projectNumber, specimens };
}

const todayLabels = () => {
  const labels: string[] = [];
  for (let n = 1; n <= SETS; n += 1) {
    for (const letter of ['B', 'C']) labels.push(`26-${String(n).padStart(2, '0')}${letter}`);
  }
  return labels;
};

test('T2: keyboard entry of 30 rows, a failed save, a correction needing a reason, Include overdue', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'desktop lab computers only');
  test.setTimeout(60_000);
  const cast = await castProject(page);
  await signInAs(page, 'lt');
  await page.goto('/concrete/testing');
  await expect(page.getByRole('heading', { name: 'Testing table', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: cast.projectNumber });
  const tester = page.getByRole('combobox', { name: /Tested by/ });
  await expect(tester).toHaveValue('00000000-0000-4000-8000-000000000110');
  const group = page.getByRole('region', { name: new RegExp(`${cast.projectNumber} ·`) });

  // T1 in the browser: numeric set order, then letter.
  const labels = todayLabels();
  await expect(group.getByRole('rowheader')).toHaveText(labels);
  await expect(page.getByText('0 of 30 completed')).toBeVisible();

  // One row's save fails (connection dropped) while the column is entered.
  const failing = cast.specimens.get('26-05C')!;
  await page.route(`**/api/concrete/specimens/${failing}/test-results/*`, (route) =>
    route.abort('connectionrefused'),
  );

  const loadOf = (n: number) => 300 + n;
  // Max load column: type, Enter moves down to the next row (the row left behind saves).
  await group.getByRole('textbox', { name: `Max load ${labels[0]}` }).focus();
  for (const [i] of labels.entries()) {
    await page.keyboard.type(String(loadOf(i)));
    await page.keyboard.press('Enter');
  }
  const failedRow = group.getByRole('row', { name: /26-05C/ });
  await expect(failedRow.getByText('Failed')).toBeVisible();
  // AC2: the failed row keeps what was typed.
  await expect(group.getByRole('textbox', { name: 'Max load 26-05C' })).toHaveValue(
    String(loadOf(labels.indexOf('26-05C'))),
  );
  await expect(
    group.getByRole('row', { name: /26-05B/ }).getByText('Saved · incomplete'),
  ).toBeVisible();

  // Height and diameter columns, still from the keyboard (Tab across, Enter down).
  await group.getByRole('textbox', { name: `Height ${labels[0]}` }).focus();
  for (const _ of labels) {
    await page.keyboard.type('203.2');
    await page.keyboard.press('Tab');
    await page.keyboard.type('101.6 101.7');
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Enter');
  }
  await expect(page.getByText('29 of 30 completed')).toBeVisible();

  // The connection is back: Retry saves the failed row with its kept values.
  await page.unroute(`**/api/concrete/specimens/${failing}/test-results/*`);
  await failedRow.getByRole('button', { name: 'Retry 26-05C' }).click();
  await expect(page.getByText('30 of 30 completed')).toBeVisible();
  await expect(failedRow.getByText('Saved', { exact: true })).toBeVisible();

  // AC1: changing the page tester leaves saved rows with their tester.
  await tester.selectOption({ label: 'PE · Pat Example' });
  await expect(
    group.getByRole('row', { name: /26-01B/ }).getByText('TB', { exact: true }),
  ).toBeVisible();

  // AC3: a change to a saved value without a reason is refused and the edit is kept.
  const corrected = cast.specimens.get('26-02B')!;
  const load = group.getByRole('textbox', { name: 'Max load 26-02B' });
  await load.fill('999');
  await page.getByRole('heading', { name: 'Testing table', level: 1 }).click();
  const correctedRow = group.getByRole('row', { name: /26-02B/ });
  await expect(correctedRow.getByText('Reason needed')).toBeVisible();
  await expect(load).toHaveValue('999');
  const before = await page.request.get(`/api/concrete/specimens/${corrected}/test-results`);
  const saved = ((await before.json()) as { results: { maxLoad: number }[] }).results[0]!;
  expect(saved.maxLoad).toBe(loadOf(labels.indexOf('26-02B')));
  await group.getByRole('textbox', { name: 'Correction reason 26-02B' }).fill('Misread the dial');
  await page.keyboard.press('Enter');
  await expect(correctedRow.getByText('Saved', { exact: true })).toBeVisible();
  const after = await page.request.get(`/api/concrete/specimens/${corrected}/test-results`);
  const result = (
    (await after.json()) as {
      results: {
        maxLoad: number;
        tester: { initials: string };
        revisions: { kind: string; reason: string | null }[];
      }[];
    }
  ).results[0]!;
  expect(result.maxLoad).toBe(999);
  expect(result.tester.initials).toBe('TB');
  expect(result.revisions.at(-1)).toMatchObject({ kind: 'correction', reason: 'Misread the dial' });

  // AC4: Include overdue adds the 7-day specimens, flagged, with their targets unchanged.
  const targetsBefore = await withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT id, target_date::text, version FROM concrete_specimen WHERE project_id = $1 ORDER BY id`,
      [cast.projectId],
    );
    return rows;
  });
  await page.getByRole('checkbox', { name: 'Include overdue' }).check();
  await expect(group.getByRole('rowheader')).toHaveCount(45);
  const overdueRow = group.getByRole('row', { name: /26-03A/ });
  await expect(overdueRow.getByText('Overdue 21 d')).toBeVisible();
  await expect(overdueRow.getByText(`target ${labDate(-21)}`)).toBeVisible();
  await expect(overdueRow.getByRole('link', { name: 'Details for 26-03A' })).toBeVisible();
  await expect(page.getByText('30 of 45 completed')).toBeVisible();
  const targetsAfter = await withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT id, target_date::text, version FROM concrete_specimen WHERE project_id = $1 ORDER BY id`,
      [cast.projectId],
    );
    return rows;
  });
  expect(targetsAfter).toEqual(targetsBefore);

  // Hide completed leaves the 15 overdue rows still to enter.
  await page.getByRole('checkbox', { name: 'Hide completed' }).check();
  await expect(group.getByRole('rowheader')).toHaveCount(15);
});
