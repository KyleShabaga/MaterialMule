import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T30 (card T4, T5, T9): approve an eligible unit, a hold placed after approval blocks the
// disposal scan, releasing it lets the scan dispose; offline the scan mode is disabled; LAB can't
// scan. Each test makes its own old bucket on a fresh hole, so no program or hold of another spec
// covers it. Fictional data only: DEMO-2601, Lab Manager "Lab (test)" (lab).

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const ALEX_TESTER_ID = '00000000-0000-4000-8000-000000000102';
const CSRF = { 'x-materialmule-csrf': '1' };

/** A bucket received 2024-01-10 (retain-until 2025-01-10, long reached) on its own hole. */
async function oldBucket(): Promise<{ id: string; readableId: string }> {
  return withDatabase(async (client) => {
    const n = randomInt(1, 999_999);
    const hole = await client.query<{ id: string }>(
      `INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id`,
      [DEMO_PROJECT_ID, `TH-D${n}`],
    );
    const receipt = await client.query<{ id: string }>(
      `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                            receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                            request_hash)
       VALUES ($1, '2024-01-10', $2, 'AT', 'Alex Tester', $2, 1, gen_random_uuid(), 'e2e')
       RETURNING id`,
      [DEMO_PROJECT_ID, ALEX_TESTER_ID],
    );
    const readableId = `BKT-2024-${String(n).padStart(6, '0')}`;
    const unit = await client.query<{ id: string }>(
      `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                 receipt_id, project_id, unit_type, holder_kind,
                                 current_location_id, received_date)
       SELECT $1, 'BKT', 2024, 'bucket', $2, $3, 'bucket', 'bucket', l.id, '2024-01-10'
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

async function scan(page: Page, code: string) {
  const input = page.getByLabel('Scan or type a storage unit ID');
  await input.fill(code);
  await input.press('Enter');
}

test('T4/AC2: approve → hold placed after approval blocks the scan → release → Disposed', async ({
  page,
}) => {
  const unit = await oldBucket();
  await signInAs(page, 'lab'); // Lab Manager
  await page.goto(`/disposal-retention?projectId=${DEMO_PROJECT_ID}`);
  const eligible = page.getByRole('region', { name: 'Eligible for disposal' });
  const row = eligible.getByRole('listitem').filter({ hasText: unit.readableId });
  await row.getByRole('checkbox').check();
  await eligible.getByRole('button', { name: 'Approve 1 for disposal' }).click();
  const dialog = page.getByRole('dialog', { name: 'Approve 1 for disposal?' });
  await expect(dialog).toContainText(`${unit.readableId} · retain until 2025-01-10`);
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: '1 approved for disposal.' }),
  ).toBeVisible();
  const approved = page.getByRole('listitem', { name: `Approved ${unit.readableId}` });
  await expect(approved).toContainText('Approved for disposal');

  // Approval alone disposes nothing.
  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(page.getByText('Approved for disposal').first()).toBeVisible();

  const hold = await page.request.post('/api/retention/holds', {
    headers: CSRF,
    data: {
      projectId: DEMO_PROJECT_ID,
      scope: 'units',
      unitIds: [unit.id],
      reason: 'E2E claim review',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(hold.status()).toBe(201);
  const holdId = (await hold.json()).id as string;

  await page.goto('/disposal-retention/scan');
  await expect(page.getByRole('heading', { level: 1, name: 'Disposal scan' })).toBeVisible();
  await scan(page, unit.readableId);
  const results = page.getByRole('list', { name: 'Scan results' });
  await expect(results.getByRole('listitem').first()).toContainText(
    'Blocked: On hold: E2E claim review',
  );

  const released = await page.request.post(`/api/retention/holds/${holdId}/release`, {
    headers: CSRF,
    data: { reason: 'Settled', version: 1, idempotencyKey: crypto.randomUUID() },
  });
  expect(released.status()).toBe(200);
  await scan(page, unit.readableId.toLowerCase());
  await expect(results.getByRole('listitem').first()).toContainText(`${unit.readableId} disposed.`);
  await scan(page, unit.readableId);
  await expect(results.getByRole('listitem').first()).toContainText('already disposed');

  await page.goto(`/sample-storage/${unit.readableId}`);
  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(history).toContainText('Disposed');
  // MTR-59: the unit's own hold and its release are in History, with who placed them; MTR-3:
  // the Lab Manager fixture is a test account, so its events carry TEST.
  const placed = history.getByRole('listitem').filter({ hasText: 'Hold placed' });
  await expect(placed).toContainText('E2E claim review');
  await expect(placed.getByText('TEST', { exact: true })).toBeVisible();
  await expect(history.getByRole('listitem').filter({ hasText: 'Hold released' })).toContainText(
    'Settled',
  );

  // MISC-12: the page shows no current location; the database keeps the last saved one.
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    'No location',
  );
  const kept = await withDatabase((client) =>
    client.query<{ code: string }>(
      `SELECT l.code_normalized AS code FROM storage_unit su
       JOIN location l ON l.id = su.current_location_id WHERE su.id = $1`,
      [unit.id],
    ),
  );
  expect(kept.rows).toEqual([{ code: 'RECEIVING' }]);
  // MTR-48: the preview stays, watermarked, with no way to print it.
  await expect(page.getByRole('img', { name: new RegExp(unit.readableId) }).first()).toBeVisible();
  await expect(page.getByRole('link', { name: /Print \/ Save as PDF/ })).toHaveCount(0);
  const preview = await page.request.get(`/api/storage-units/${unit.readableId}/label/preview`);
  expect(await preview.json()).toMatchObject({ disposed: true });
  expect((await preview.json()).svg).toContain('data-watermark="DISPOSED"');
  await page.goto(`/labels/print/unit/${unit.readableId}`);
  await expect(page.getByRole('status')).toHaveText(
    'This storage unit is disposed; its label is not printed again.',
  );
  await expect(page.getByRole('button', { name: 'Print / Save as PDF' })).toHaveCount(0);
});

test('T5/AC3: offline, Disposal scan is disabled and nothing is queued', async ({
  page,
  context,
}) => {
  await signInAs(page, 'lab');
  await page.goto('/disposal-retention/scan');
  await expect(page.getByLabel('Scan or type a storage unit ID')).toBeEnabled();
  const removals: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/disposal/remove')) removals.push(request.url());
  });
  await context.setOffline(true);
  await expect(
    page.getByText(/switched off while offline, and nothing is saved or queued/),
  ).toBeVisible();
  await expect(page.getByLabel('Scan or type a storage unit ID')).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByLabel('Scan or type a storage unit ID')).toBeEnabled();
  expect(removals).toEqual([]);
});

test('T9: a LAB station cannot use the disposal scan, approve or remove', async ({ page }) => {
  const unit = await oldBucket();
  await signInAsLabStation(page);
  await page.goto('/disposal-retention/scan');
  await expect(page.getByText(/need a personal sign-in/)).toBeVisible();
  await expect(page.getByLabel('Scan or type a storage unit ID')).toBeDisabled();
  const approve = await page.request.post('/api/disposal/approvals', {
    headers: CSRF,
    data: { unitIds: [unit.id], idempotencyKey: crypto.randomUUID() },
  });
  const remove = await page.request.post('/api/disposal/remove', {
    headers: CSRF,
    data: { suNumber: unit.readableId, idempotencyKey: crypto.randomUUID() },
  });
  expect([approve.status(), remove.status()]).toEqual([403, 403]);
});
