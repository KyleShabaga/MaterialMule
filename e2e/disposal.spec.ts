import { randomInt } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T30 (card T4, T5, T9) and STRATA-92 Disposal scan-out: approve an eligible unit, a hold
// placed after approval flags the scan and nothing is disposed, releasing it lets the next scan be
// recorded after the exact-ID confirmation; offline, scans queue as intents and nothing is sent or
// disposed until the person confirms online (Kyle's decision STRATA-112); LAB can't scan. Each test makes its own old bucket on a fresh hole, so no program or hold of another spec
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

const SCAN_LABEL = 'Scan each unit as it leaves the shelf';

async function scan(page: Page, code: string) {
  const input = page.getByLabel(SCAN_LABEL);
  await input.fill(code);
  await input.press('Enter');
}

const scanRow = (page: Page, readableId: string) =>
  page
    .getByRole('list', { name: 'Scanned units, newest first' })
    .getByRole('listitem', { name: readableId, exact: true });

test('T4/AC2: approve → hold placed after approval flags the scan → release → confirm → Disposed', async ({
  page,
}) => {
  const unit = await oldBucket();
  await signInAs(page, 'lab'); // Lab Manager
  // Retention page (STRATA-90/91): Eligible → disposal list → approve.
  const only = `projectId=${DEMO_PROJECT_ID}&search=${unit.readableId}`;
  await page.goto(`/disposal-retention?tab=eligible&${only}`);
  const eligible = page.getByRole('table', { name: 'Eligible for disposal' });
  await eligible.getByRole('checkbox', { name: `Select ${unit.readableId}` }).check();
  await page
    .getByRole('region', { name: 'Selection' })
    .getByRole('button', { name: 'Add to disposal list' })
    .click();
  const decide = page.getByRole('form', { name: 'Decide on 1 unit at end of retention' });
  await decide.getByLabel('Reason (required)').fill('E2E disposal');
  await decide.getByRole('button', { name: 'Add 1 unit to the disposal list' }).click();
  await expect(decide).toHaveCount(0);
  // Filtered to this unit, so Approve takes no other spec's listed units of DEMO-2601.
  await page.goto(`/disposal-retention?tab=list&${only}`);
  const group = page.getByRole('region', { name: 'Disposal list DEMO-2601' });
  await expect(group.getByRole('row', { name: new RegExp(unit.readableId) })).toBeVisible();
  await group.getByRole('button', { name: /^Approve \d+ units?$/ }).click();
  const dialog = page.getByRole('alertdialog', { name: /of DEMO-2601 for disposal\?/ });
  await expect(dialog).toContainText(`${unit.readableId} · retain until 2025-01-10`);
  await dialog.getByRole('button', { name: 'Approve' }).click();
  await page.getByRole('tab', { name: /Approved/ }).click();
  await expect(
    page
      .getByRole('region', { name: 'Approved DEMO-2601' })
      .getByRole('row', { name: new RegExp(unit.readableId) }),
  ).toContainText('The scan at the shelf');

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
  await expect(scanRow(page, unit.readableId)).toContainText('Blocked: On hold: E2E claim review');
  await expect(page.getByRole('button', { name: 'Record disposal', exact: true })).toBeDisabled();

  const released = await page.request.post(`/api/retention/holds/${holdId}/release`, {
    headers: CSRF,
    data: { reason: 'Settled', version: 1, idempotencyKey: crypto.randomUUID() },
  });
  expect(released.status()).toBe(200);
  // The flagged scan stays as it was checked; remove it and scan the unit again.
  await scanRow(page, unit.readableId)
    .getByRole('button', { name: `Remove scan of ${unit.readableId}` })
    .click();
  // The removal is stored on this computer first: wait for the row to go before scanning again.
  await expect(scanRow(page, unit.readableId)).toHaveCount(0);
  await scan(page, unit.readableId.toLowerCase());
  await expect(scanRow(page, unit.readableId)).toContainText('Approved · will be disposed');
  await page.getByRole('button', { name: 'Record disposal of 1 unit' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Record disposal of 1 storage unit?' });
  await expect(confirm).toContainText('This can’t be undone.');
  await expect(confirm.getByRole('region', { name: '1 storage unit' })).toContainText(
    unit.readableId,
  );
  await confirm.getByRole('button', { name: 'Record disposal of 1 unit' }).click();
  await expect(page.getByRole('heading', { name: '1 storage unit disposed' })).toBeVisible();
  await expect(page.getByRole('button', { name: /undo/i })).toHaveCount(0);
  await page.getByRole('button', { name: 'Scan more' }).click();
  await scan(page, unit.readableId);
  await expect(scanRow(page, unit.readableId)).toContainText('already disposed');

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
  await expect(page.getByRole('region', { name: 'Where it is' })).toContainText('No location');
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
  await expect(page.getByRole('button', { name: /Save as PDF/ })).toHaveCount(0);
});

test('T5/AC3 (STRATA-92): offline, scans queue as intents; nothing is sent or disposed until confirmed online', async ({
  page,
  context,
}) => {
  const unit = await oldBucket();
  await signInAs(page, 'lab'); // Lab Manager
  const approve = await page.request.post('/api/disposal/approvals', {
    headers: CSRF,
    data: { unitIds: [unit.id], idempotencyKey: crypto.randomUUID() },
  });
  expect(approve.status()).toBe(201);
  await page.goto('/disposal-retention/scan');
  await expect(page.getByLabel(SCAN_LABEL)).toBeEnabled();
  const checks: string[] = [];
  const records: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/disposal/scan/check')) checks.push(request.url());
    if (request.url().includes('/api/disposal/scan/record')) records.push(request.url());
    if (request.url().includes('/api/disposal/remove')) records.push(request.url());
  });
  await context.setOffline(true);
  await expect(page.getByText('This computer is offline')).toBeVisible();
  await scan(page, unit.readableId);
  await expect(scanRow(page, unit.readableId)).toContainText('Not disposed yet');
  await expect(
    page.getByRole('button', { name: 'Record disposal when back online' }),
  ).toBeDisabled();
  expect([checks, records]).toEqual([[], []]);
  const offline = await withDatabase((client) =>
    client.query<{ status: string }>('SELECT status FROM storage_unit WHERE id = $1', [unit.id]),
  );
  expect(offline.rows[0]!.status).toBe('approved_for_disposal');

  // Back online: checked again, but recorded only after the exact-ID confirmation.
  await context.setOffline(false);
  await expect(scanRow(page, unit.readableId)).toContainText('Approved · will be disposed');
  expect(checks.length).toBeGreaterThan(0);
  expect(records).toEqual([]);
  await page.getByRole('button', { name: 'Record disposal of 1 unit' }).click();
  const confirm = page.getByRole('alertdialog', { name: 'Record disposal of 1 storage unit?' });
  await confirm.getByRole('button', { name: 'Record disposal of 1 unit' }).click();
  await expect(page.getByRole('heading', { name: '1 storage unit disposed' })).toBeVisible();
  expect(records).toHaveLength(1);
});

test('T9: a LAB station cannot use the disposal scan, approve or remove', async ({ page }) => {
  const unit = await oldBucket();
  await signInAsLabStation(page);
  await page.goto('/disposal-retention/scan');
  await expect(page.getByText(/need a personal sign-in/)).toBeVisible();
  await expect(page.getByLabel(SCAN_LABEL)).toBeDisabled();
  const approve = await page.request.post('/api/disposal/approvals', {
    headers: CSRF,
    data: { unitIds: [unit.id], idempotencyKey: crypto.randomUUID() },
  });
  const remove = await page.request.post('/api/disposal/remove', {
    headers: CSRF,
    data: { suNumber: unit.readableId, idempotencyKey: crypto.randomUUID() },
  });
  // STRATA-92 routes: refused whoever the station names.
  const intents = [
    {
      intentId: crypto.randomUUID(),
      code: unit.readableId,
      scannedByUserId: ALEX_TESTER_ID,
      scannedAt: new Date().toISOString(),
    },
  ];
  const check = await page.request.post('/api/disposal/scan/check', {
    headers: CSRF,
    data: { intents },
  });
  const record = await page.request.post('/api/disposal/scan/record', {
    headers: CSRF,
    data: { intents },
  });
  expect([approve.status(), remove.status(), check.status(), record.status()]).toEqual([
    403, 403, 403, 403,
  ]);
});
