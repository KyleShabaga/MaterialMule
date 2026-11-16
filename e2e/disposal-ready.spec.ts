import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MISC-13 / STRATA-90: the Retention page's Eligible tab lists eligible units from every project
// without choosing one; a unit on hold isn't listed. A unit goes on the disposal list, is approved
// (it stays in stock) and, once scanned out, leaves Approved for Disposed. Each test makes its own
// buckets on fresh holes, received 2019-03-01 (searched by ID, so other specs' units don't
// matter). Desktop and phone width. Fictional data only: DEMO-2601, Lab Manager "Lab (test)" (lab).

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

const eligibleRow = (page: Page, readableId: string) =>
  page.getByRole('table', { name: 'Eligible for disposal' }).getByRole('row', {
    name: new RegExp(readableId),
  });

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('lists eligible units without choosing a project; a unit on hold is not listed', async ({
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

  await page.goto(`/disposal-retention?tab=eligible&search=${unit.readableId}`);
  await expect(
    page.getByText('Each is eligible: retain-until reached, no hold, programs closed.'),
  ).toBeVisible();
  const row = eligibleRow(page, unit.readableId);
  await expect(row).toContainText('DEMO-2601');
  await expect(row).toContainText('2020-03-01');
  await page.goto(`/disposal-retention?tab=eligible&search=${held.readableId}`);
  await expect(page.getByText('Nothing is eligible right now.')).toBeVisible();
  // The held unit is still in Coming up's Overdue band, with its hold and no Eligible tag.
  await page.goto(`/disposal-retention?search=${held.readableId}`);
  const heldRow = page
    .getByRole('region', { name: 'Overdue' })
    .getByRole('row', { name: new RegExp(held.readableId) });
  await expect(heldRow).toContainText('On hold until released');
  await expect(heldRow).not.toContainText('Eligible');
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  // Each row leads to the unit.
  await page.goto(`/disposal-retention?tab=eligible&search=${unit.readableId}`);
  await eligibleRow(page, unit.readableId).getByRole('link', { name: unit.readableId }).click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${unit.readableId}$`));
});

test('add to the disposal list, approve, scan it out: it moves from tab to tab', async ({
  page,
}) => {
  const unit = await oldBucket();
  await signInAs(page, 'lab');
  await page.goto(`/disposal-retention?tab=eligible&search=${unit.readableId}`);
  await eligibleRow(page, unit.readableId)
    .getByRole('checkbox', { name: `Select ${unit.readableId}` })
    .check();
  await page
    .getByRole('region', { name: 'Selection' })
    .getByRole('button', { name: 'Add to disposal list' })
    .click();
  const decide = page.getByRole('form', { name: 'Decide on 1 unit at end of retention' });
  await decide.getByLabel('Reason (required)').fill('E2E report issued');
  await decide.getByRole('button', { name: 'Add 1 unit to the disposal list' }).click();
  await expect(decide).toHaveCount(0);

  await page.goto(
    `/disposal-retention?tab=list&projectId=${DEMO_PROJECT_ID}&search=${unit.readableId}`,
  );
  const list = page.getByRole('region', { name: 'Disposal list DEMO-2601' });
  await expect(list.getByRole('row', { name: new RegExp(unit.readableId) })).toContainText('E2E');
  await list.getByRole('button', { name: 'Approve 1 unit' }).click();
  const approve = page.getByRole('alertdialog', {
    name: 'Approve 1 unit of DEMO-2601 for disposal?',
  });
  await expect(approve).toContainText(`${unit.readableId} · retain until 2020-03-01`);
  await approve.getByRole('button', { name: 'Approve' }).click();
  await expect(list).toHaveCount(0);

  // Approval doesn't dispose: it waits for the scan, still in stock.
  await page.goto(`/disposal-retention?tab=approved&search=${unit.readableId}`);
  const approved = page.getByRole('region', { name: 'Approved DEMO-2601' });
  await expect(approved.getByRole('row', { name: new RegExp(unit.readableId) })).toContainText(
    'The scan at the shelf',
  );
  const state = await withDatabase(async (client) =>
    client.query<{ status: string }>('SELECT status FROM storage_unit WHERE id = $1', [unit.id]),
  );
  expect(state.rows[0]!.status).toBe('approved_for_disposal');

  // The scan itself is covered by disposal.spec.ts; here it is recorded through the same route.
  const scanned = await page.request.post('/api/disposal/remove', {
    headers: CSRF,
    data: { suNumber: unit.readableId, idempotencyKey: crypto.randomUUID() },
  });
  expect(scanned.status()).toBe(200);
  await page.goto(`/disposal-retention?tab=approved&search=${unit.readableId}`);
  await expect(page.getByText('Nothing is approved for disposal.')).toBeVisible();
  await page.goto(`/disposal-retention?tab=disposed&search=${unit.readableId}`);
  await expect(page.getByRole('row', { name: new RegExp(unit.readableId) })).toBeVisible();

  // MISC-12: the disposed unit shows no current location.
  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(page.getByRole('region', { name: 'Where it is' })).toContainText('No location');
});
