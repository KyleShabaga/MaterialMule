import { randomBytes, randomUUID } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-V2-C39: submit → review → issue a strength report against the real API, on desktop and
// phone. A fictional project led by Pat Example gets one set cast 7 days before today
// (America/Edmonton), so its 7 d specimen (A) is due today; B and C are 28 d and D is HOLD. The
// permanent number is attached with SQL (standing in for C18's allocator). Taylor Bench (Lab
// Technician) enters A through C07's API, then submits in the page; the lead reviews and issues.
// Fictional data only.

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

async function castSet(page: Page) {
  const projectNumber = `E2E-C39-${randomBytes(3).toString('hex').toUpperCase()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Strength report demo', 'Example Client', $2) RETURNING id`,
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
  const set = await page.request.post(`/api/concrete/field-reports/${reportId}/specimen-sets`, {
    headers: CSRF,
    data: { idempotencyKey: randomUUID() },
  });
  expect(set.status()).toBe(201);
  const created = (await set.json()) as { id: string; specimens: { id: string; letter: string }[] };
  const label = `26-${(randomBytes(2).readUInt16BE() % 900) + 100}`;
  await withDatabase((client) =>
    client.query(
      `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
      [created.id, Number(label.slice(3)), label],
    ),
  );
  return { projectId, setId: created.id, specimens: created.specimens, label };
}

test('submit → review → issue a strength report', async ({ page }) => {
  const { setId, specimens, label } = await castSet(page);
  const path = `/concrete/strength/${setId}`;

  // The lab technician enters the 7 d break (C07) and submits the report in the page.
  await signInAs(page, 'lt');
  const a = specimens.find((s) => s.letter === 'A')!;
  const entered = await page.request.put(
    `/api/concrete/specimens/${a.id}/test-results/${randomUUID()}`,
    {
      headers: CSRF,
      data: {
        idempotencyKey: randomUUID(),
        version: 0,
        testedOn: labDate(),
        maxLoad: 412.6,
        heightReadings: [200.2],
        diameterReadings: [100.1],
      },
    },
  );
  expect(entered.status(), await entered.text()).toBe(200);

  await page.goto(path);
  await expect(page.getByRole('heading', { name: `Strength report ${label}` })).toBeVisible();
  const results = page.getByRole('table', { name: 'Strength results' });
  await expect(results.getByRole('row', { name: new RegExp(`${label}A`) })).toContainText('412.6');
  await expect(results.getByRole('row', { name: new RegExp(`${label}B`) })).toContainText(
    'Not yet tested',
  );
  await expect(results.getByRole('row', { name: new RegExp(`${label}D`) })).toContainText('HOLD');
  await page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(page.getByText('Awaiting review', { exact: true })).toBeVisible();
  // The person who entered the results alone can't review them.
  await expect(page.getByRole('button', { name: 'Mark reviewed' })).toBeDisabled();

  // The lead finds it in the review queue as a strength report, reviews and issues it.
  await signInAs(page, 'pe');
  await page.goto('/concrete/review');
  const link = page.locator(`a[href="${path}"]`);
  const row = page.getByRole('row').filter({ has: link });
  await expect(row).toContainText(`Strength report ${label} v1`);
  await link.click();
  await expect(page.getByRole('heading', { name: `Strength report ${label}` })).toBeVisible();
  await page.getByRole('button', { name: 'Mark reviewed' }).click();
  await expect(page.getByText('Reviewed awaiting issuance', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Issue' }).click();
  await expect(page.getByText('Issued', { exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Start a revision' })).toBeVisible();
  // MM-V2-C32: a CS number at first issue and the stored PDF (Rev 0).
  await expect(page.getByText(/^CS-\d{4}-\d{5}$/)).toBeVisible();
  const pdf = page.getByRole('link', { name: 'Download Rev 0 (PDF)' });
  await expect(pdf).toBeVisible();
  const file = await page.request.get((await pdf.getAttribute('href'))!);
  expect(file.status()).toBe(200);
  expect(file.headers()['content-type']).toContain('application/pdf');
  // The frozen version prints Rev 0 with its P1 strength (MM-V2-C24): 412.6 kN on
  // π × 100.1² / 4 = 7 869.70 mm² → 52.43 → 52.4 MPa.
  await expect(page.getByRole('heading', { name: /Rev 0/ })).toBeVisible();
  await expect(
    page.getByRole('table', { name: 'Strength results' }).getByRole('row', {
      name: new RegExp(`${label}A`),
    }),
  ).toContainText('52.4 MPa');

  const listed = await page.request.get(`/api/concrete/strength-reports?state=issued`);
  expect(listed.status()).toBe(200);
  const body = (await listed.json()) as { items: { setId: string; agesReported: number[] }[] };
  expect(body.items.find((i) => i.setId === setId)?.agesReported).toEqual([7]);
});
