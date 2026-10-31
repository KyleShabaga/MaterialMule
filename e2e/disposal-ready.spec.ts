import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MISC-13: "Ready for disposal" on the Disposal & Retention page lists eligible units from every
// project without choosing one; a unit on hold isn't listed; approving and scanning one out
// removes it from the list. Each test makes its own buckets on fresh holes, received 2019-03-01
// so they sort first (oldest retain-until) among other specs' units. Desktop and phone width.
// Fictional data only: DEMO-2601, Lab Manager "Lab (test)" (lab).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const ALEX_TESTER_ID = '00000000-0000-4000-8000-000000000102';
const CSRF = { 'x-materialmule-csrf': '1' };

/** A bucket received 2019-03-01 (retain-until 2020-03-01, long reached) on its own hole. */
async function oldBucket(): Promise<{ id: string; readableId: string }> {
  return withDatabase(async (client) => {
    const n = randomInt(1, 999_999);
    const hole = await client.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [DEMO_PROJECT_ID, `TH-R${n}`],
    );
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                            receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                            request_hash)
       VALUES ($1, '2019-03-01', $2, 'AT', 'Alex Tester', $2, 1, gen_random_uuid(), 'e2e')
       RETURNING id`,
      [DEMO_PROJECT_ID, ALEX_TESTER_ID],
    );
    const readableId = `BKT-2019-${String(n).padStart(6, '0')}`;
    const unit = await client.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date)
       SELECT $1, 'BKT', 2019, 'bucket', $2, $3, 'bucket', 'bucket', l.id, '2019-03-01'
       FROM location l WHERE l.code_normalized = 'RECEIVING'
       RETURNING id`,
      [readableId, receipt.rows[0]!.id, DEMO_PROJECT_ID],
    );
    await client.query(
      `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id, summary_type)
       VALUES ($1, $2, $3, 'all')`,
      [unit.rows[0]!.id, DEMO_PROJECT_ID, hole.rows[0]!.id],
    );
    return { id: unit.rows[0]!.id, readableId };
  });
}

const readyCard = (page: Page) => page.getByRole('region', { name: 'Ready for disposal' });
const readyRow = (page: Page, readableId: string) =>
  readyCard(page).locator('tbody tr').filter({ hasText: readableId });

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('lists ready units without choosing a project; a unit on hold is not listed', async ({
  page,
}) => {
  const unit = await oldBucket();
  const held = await oldBucket();
  await signInAs(page, 'lab'); // Lab Manager
  const hold = await page.request.post('/api/retention/holds', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      scope: 'units',
      unitIds: [held.id],
      reason: 'E2E ready-list claim',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(hold.status()).toBe(201);

  await page.goto('/disposal-retention');
  await expect(readyCard(page)).toBeVisible();
  const row = readyRow(page, unit.readableId);
  await expect(row).toContainText('DEMO-2601');
  await expect(row).toContainText('Receiving lab');
  await expect(row).toContainText('2020-03-01');
  await expect(row).toContainText('Retention ended 2020-03-01 (1 year after receipt 2019-03-01)');
  await expect(readyRow(page, held.readableId)).toHaveCount(0);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // Each row leads to the unit.
  await row.getByRole('link', { name: unit.readableId }).click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${unit.readableId}$`));
});

test('approve from the list, scan it out, and the list no longer shows it', async ({ page }) => {
  const unit = await oldBucket();
  await signInAs(page, 'lab');
  await page.goto('/disposal-retention');
  const row = readyRow(page, unit.readableId);
  await expect(row).toContainText('Approve in project');
  await row.getByRole('link', { name: 'Approve in project' }).click();
  await expect(page).toHaveURL(new RegExp(`projectId=${DEMO_PROJECT_ID}`));

  const eligible = page.getByRole('region', { name: 'Eligible for disposal' });
  await eligible
    .getByRole('listitem')
    .filter({ hasText: unit.readableId })
    .getByRole('checkbox')
    .check();
  await eligible.getByRole('button', { name: 'Approve 1 for disposal' }).click();
  await page
    .getByRole('dialog', { name: 'Approve 1 for disposal?' })
    .getByRole('button', { name: 'Approve' })
    .click();
  // The list reloads after the approval: the unit now waits for the scan.
  await expect(row).toContainText('Approved');
  await row.getByRole('link', { name: 'Scan to dispose' }).click();

  await expect(page.getByRole('heading', { level: 1, name: 'Disposal scan' })).toBeVisible();
  const input = page.getByLabel('Scan or type a storage unit ID');
  await input.fill(unit.readableId);
  await input.press('Enter');
  await expect(
    page.getByRole('list', { name: 'Scan results' }).getByRole('listitem').first(),
  ).toContainText(`${unit.readableId} disposed.`);

  await page.getByRole('link', { name: '← Disposal & Retention' }).click();
  await expect(readyCard(page)).toBeVisible();
  await expect(readyCard(page).getByLabel('Ready count')).toBeVisible();
  await expect(readyRow(page, unit.readableId)).toHaveCount(0);

  // MISC-12: the disposed unit shows no current location.
  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    'No location',
  );
});
