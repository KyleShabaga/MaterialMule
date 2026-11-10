import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-V2-C24: provisional method P1 end to end, desktop only (the lab computers). A fictional
// project led by Pat Example gets one set cast 7 days before today (America/Edmonton), so its
// 7 d specimen (A) is due today; the specification is f′c 25 MPa at 28 d. Taylor Bench (Lab
// Technician) enters A in the testing table and sees its strength; then submits the strength
// report, which the lead reviews and issues with the values frozen. Hand-checked: d̄ = 100.1 mm,
// A = π × 100.1² / 4 = 7 869.70 mm² → 7 870 mm², L/D = 200.2 / 100.1 = 2.00 (no correction),
// f = 412.6 kN × 1000 / 7 869.70 = 52.43 → 52.4 MPa; 7 d is information only. Fictional data.

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

test('enter a break in the testing table, see its P1 strength, issue the strength report with values', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'desktop lab computers only');
  test.setTimeout(60_000);
  const projectNumber = `E2E-C24-${randomBytes(3).toString('hex').toUpperCase()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Strength calculation demo', 'Example Client', $2) RETURNING id`,
      [projectNumber, PE_ID],
    );
    return rows[0]!.id;
  });
  await signInAs(page, 'at');
  const report = await page.request.post(`/api/concrete/projects/${projectId}/field-reports`, {
    headers: CSRF,
    data: {
      idempotencyKey: randomUUID(),
      material: 'concrete',
      specimensCast: true,
      castAt: `${labDate(-7)}T09:00:00-06:00`,
    },
  });
  expect(report.status()).toBe(201);
  const reportId = ((await report.json()) as { id: string }).id;
  const made = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
    headers: CSRF,
    data: { idempotencyKey: randomUUID() },
  });
  expect(made.status()).toBe(201);
  const setId = ((await made.json()) as { id: string }).id;
  const label = `26-${(randomBytes(2).readUInt16BE() % 900) + 100}`;
  await withDatabase(async (client) => {
    await client.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [setId, Number(label.slice(3)), label],
    );
    // The specification as the field report records it (f′c and its reference age).
    await client.query(
      `UPDATE concrete_field_report
       SET project_spec = '{"specifiedStrengthMpa": 25, "specifiedStrengthAgeDays": 28}'
       WHERE id = $1`,
      [reportId],
    );
  });

  // The lab technician enters A's break in the testing table.
  await signInAs(page, 'lt');
  await page.goto('/concrete/testing');
  await expect(page.getByRole('heading', { name: 'Testing table', level: 1 })).toBeVisible();
  await page.getByRole('combobox', { name: 'Project' }).selectOption({ label: projectNumber });
  const group = page.getByRole('region', { name: new RegExp(`${projectNumber} ·`) });
  const row = group.getByRole('row', { name: new RegExp(`${label}A`) });
  await group.getByRole('textbox', { name: `Max load ${label}A` }).fill('412.6');
  await group.getByRole('textbox', { name: `Height ${label}A` }).fill('200.2');
  await group.getByRole('textbox', { name: `Diameter ${label}A` }).fill('100.1');
  await page.getByRole('heading', { name: 'Testing table', level: 1 }).click();
  await expect(row.getByText('Saved', { exact: true })).toBeVisible();
  const strength = row.getByLabel(`Strength ${label}A: 52.4 MPa`);
  await expect(strength).toContainText('52.4');
  await expect(strength).toContainText('P1 (provisional)');

  // The strength report shows the values and the method line, then is submitted.
  const path = `/concrete/strength/${setId}`;
  await page.goto(path);
  await expect(page.getByRole('heading', { name: `Strength report ${label}` })).toBeVisible();
  await expect(page.getByText('Calculation method P1 (provisional)')).toBeVisible();
  const results = page.getByRole('table', { name: 'Strength results' });
  const rowA = results.getByRole('row', { name: new RegExp(`${label}A`) });
  await expect(rowA).toContainText('52.4 MPa');
  await expect(rowA).toContainText('7870 mm²');
  await expect(page.getByText('Information only')).toBeVisible();
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Awaiting review', { exact: true })).toBeVisible();

  // The lead reviews and issues it; the issued version keeps the values.
  await signInAs(page, 'pe');
  await page.goto(path);
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByText('Reviewed awaiting issuance', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await expect(page.getByRole('heading', { name: /Rev 0/ })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Strength results' }).getByRole('row', {
      name: new RegExp(`${label}A`),
    }),
  ).toContainText('52.4 MPa');
  const pdf = page.getByRole('link', { name: 'Download Rev 0 (PDF)' });
  await expect(pdf).toBeVisible();
  const file = await page.request.get((await pdf.getAttribute('href'))!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toContain('application/pdf');

  const version = await page.request.get(
    `/api/concrete/specimen-sets/${setId}/strength-report/versions/1`,
  );
  expect(version.status()).toBe(200);
  const snapshot = (
    (await version.json()) as {
      snapshot: {
        calculation: { method: { line: string } | null };
        results: { letter: string; strength: number | null; area: number | null }[];
        ages: { ageDays: number; averageStrength: number | null; assessment: string | null }[];
      };
    }
  ).snapshot;
  expect(snapshot.calculation.method?.line).toBe('Calculation method P1 (provisional)');
  expect(snapshot.results.find((r) => r.letter === 'A')).toMatchObject({
    strength: 52.4,
    area: 7870,
  });
  expect(snapshot.ages.find((a) => a.ageDays === 7)).toMatchObject({
    averageStrength: 52.4,
    assessment: 'information_only',
  });
});
