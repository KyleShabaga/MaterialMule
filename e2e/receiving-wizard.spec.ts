import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// TRP-T10: the three-step receiving wizard against the real API (fictional DEMO-2601 data).
// Runs at desktop and phone widths (T7: every step without horizontal scrolling).

const BKT_ID = /^BKT-\d{4}-\d{6}$/;

async function noHorizontalScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

async function startReceipt(page: Page) {
  await page.goto('/');
  await page.getByRole('link', { name: 'Receive samples' }).click();
  await expect(page.getByRole('heading', { name: 'Receive samples' })).toBeVisible();
  await page.getByRole('combobox', { name: /Find project/ }).fill('DEMO-2601');
  await page
    .getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' })
    .click();
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');
}

const bucket = (page: Page, n: number) => page.getByRole('region', { name: `Bucket ${n}` });

async function addHole(unit: Locator, name: string) {
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill(name);
  await unit.getByRole('option', { name, exact: true }).click();
}

function summaryOf(unit: Locator, hole: string) {
  return unit.getByRole('group', { name: `${hole} summary` });
}

async function sampleRange(unit: Locator, hole: string, from: string, to: string) {
  const group = summaryOf(unit, hole);
  await group.getByLabel('Summary type').selectOption('sample_range');
  await group.getByLabel('Sample from').fill(from);
  await group.getByLabel('Sample to').fill(to);
}

/** Issued IDs from the labels step, in unit order. */
async function issuedIds(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'New storage units' });
  await expect(list).toBeVisible();
  const ids = await list.getByRole('heading').allTextContents();
  for (const id of ids) expect(id).toMatch(BKT_ID);
  return ids;
}

async function summariesFor(readableIds: string[]) {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{
      readable_id: string;
      quantity: number;
      hole: string;
      summary_type: string;
      sample_from: string | null;
      sample_to: string | null;
      depth_from: string | null;
      depth_to: string | null;
      depth_unit: string | null;
      custom_text: string | null;
    }>(
      `SELECT su.readable_id, r.quantity, th.name AS hole, s.summary_type, s.sample_from,
              s.sample_to, s.depth_from::text, s.depth_to::text, s.depth_unit, s.custom_text
       FROM storage_unit su
       JOIN receipt r ON r.id = su.receipt_id
       JOIN storage_unit_hole_summary s ON s.storage_unit_id = su.id
       JOIN test_hole th ON th.id = s.test_hole_id
       WHERE su.readable_id = ANY($1)
       ORDER BY su.readable_id, th.name`,
      [readableIds],
    );
    return rows;
  });
}

test('T3/AC1: two buckets for TH26-01, reviewed and confirmed with two BKT IDs', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await startReceipt(page);

  await addHole(bucket(page, 1), 'TH26-01');
  await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
  await page.getByRole('button', { name: 'Add bucket' }).click();
  await expect(page.getByText('2 storage units').first()).toBeVisible();
  await addHole(bucket(page, 2), 'TH26-01');
  await sampleRange(bucket(page, 2), 'TH26-01', 'G13', 'S32');
  await expect(bucket(page, 2).getByText('Bucket 2 · TH26-01: G13–S32')).toBeVisible();
  // Receiving never asks for individual samples: one summary per hole per bucket.
  await expect(page.getByLabel(/sample (number|id)/i)).toHaveCount(0);
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(bucket(page, 1).getByText('G1–S12')).toBeVisible();
  await expect(bucket(page, 2).getByText('G13–S32')).toBeVisible();
  await noHorizontalScroll(page);

  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const ids = await issuedIds(page);
  expect(ids).toHaveLength(2);
  await noHorizontalScroll(page);

  const rows = await summariesFor(ids);
  expect(rows.map((r) => [r.quantity, r.hole, r.summary_type, r.sample_from, r.sample_to])).toEqual(
    [
      [2, 'TH26-01', 'sample_range', 'G1', 'S12'],
      [2, 'TH26-01', 'sample_range', 'G13', 'S32'],
    ],
  );

  // Labels step: preview a label (TRP-T39) and print through the T15 queue; open a unit.
  const units = page.getByRole('list', { name: 'New storage units' });
  await units.getByText('Preview label').first().click();
  await expect(units.getByRole('img', { name: `Label for storage unit ${ids[0]}` })).toBeVisible();
  await noHorizontalScroll(page);
  const labels = page.getByRole('region', { name: 'Receipt confirmed' });
  await expect(
    labels.getByRole('link', { name: 'Print / Save all labels as PDF' }),
  ).toHaveAttribute('href', /^\/labels\/print\/receipt\/[0-9a-f-]{36}$/);
  await labels.getByRole('button', { name: 'Print all labels' }).click();
  await expect(labels.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });
  await page.getByRole('link', { name: `Open ${ids[1]}` }).click();
  await expect(page.getByRole('heading', { name: ids[1]! })).toBeVisible();
});

test('T4/AC2/AC8: a mixed-hole bucket is one unit with two summaries; blank description', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await startReceipt(page);
  const unit = bucket(page, 1);
  await addHole(unit, 'TH26-01');
  await sampleRange(unit, 'TH26-01', 'G1', 'S12');
  await addHole(unit, 'TH26-02');
  await summaryOf(unit, 'TH26-02').getByLabel('Summary type').selectOption('all');
  await expect(unit.getByText('Bucket 1 · TH26-01: G1–S12 · TH26-02: ALL')).toBeVisible();
  await expect(page.getByLabel('Description (optional)')).toHaveValue('');

  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByRole('region', { name: 'Details' }).getByText('None')).toBeVisible();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const ids = await issuedIds(page);
  expect(ids).toHaveLength(1);
  const rows = await summariesFor(ids);
  expect(rows.map((r) => [r.quantity, r.hole, r.summary_type, r.sample_from])).toEqual([
    [1, 'TH26-01', 'sample_range', 'G1'],
    [1, 'TH26-02', 'all', null],
  ]);
});

test('T5/AC3/AC4: validation per type blocks Next; 10.5 m is saved as 10.5 m', async ({ page }) => {
  await signInAs(page, 'at');
  await startReceipt(page);
  const next = page.getByRole('button', { name: 'Next: Review' });

  // A unit with no test hole.
  await next.click();
  const errors = page.getByRole('alert');
  await expect(
    errors.getByRole('link', { name: 'Bucket 1: Choose at least one test hole.' }),
  ).toBeVisible();

  // Reversed depth range and no ft/m.
  const unit = bucket(page, 1);
  await addHole(unit, 'TH26-01');
  const depth = summaryOf(unit, 'TH26-01');
  await depth.getByLabel('Summary type').selectOption('depth_range');
  await depth.getByLabel('Depth from').fill('30');
  await depth.getByLabel('Depth to').fill('0');
  await next.click();
  await expect(
    errors.getByRole('link', {
      name: 'Bucket 1 · TH26-01: Depth to must be greater than or equal to depth from.',
    }),
  ).toBeVisible();
  await expect(
    errors.getByRole('link', { name: 'Bucket 1 · TH26-01: Choose ft or m.' }),
  ).toBeVisible();
  await expect(depth.getByLabel('Depth to')).toHaveAttribute('aria-invalid', 'true');

  // Empty custom text on a second hole.
  await addHole(unit, 'TH26-02');
  const custom = summaryOf(unit, 'TH26-02');
  await custom.getByLabel('Summary type').selectOption('custom');
  await expect(custom.getByText('State units if you describe depths.')).toBeVisible();
  await next.click();
  await expect(
    errors.getByRole('link', {
      name: 'Bucket 1 · TH26-02: Describe the samples (Custom needs text).',
    }),
  ).toBeVisible();
  await expect(next).toBeVisible(); // still on step 1

  // Fix everything: 0–10.5 m (no conversion) and a custom description.
  await depth.getByLabel('Depth from').fill('0');
  await depth.getByLabel('Depth to').fill('10.5');
  await depth.getByRole('radio', { name: 'm' }).check();
  await custom.getByLabel('Custom summary').fill('Grab bags, 0–2 m');
  await expect(errors).toHaveCount(0);
  await next.click();
  await expect(bucket(page, 1).getByText('0–10.5 m')).toBeVisible();
  await expect(bucket(page, 1)).not.toContainText(/\bft\b/);
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const ids = await issuedIds(page);
  await expect(page.getByText('TH26-01: 0–10.5 m')).toBeVisible();
  const rows = await summariesFor(ids);
  expect(rows.map((r) => [r.hole, r.depth_from, r.depth_to, r.depth_unit, r.custom_text])).toEqual([
    ['TH26-01', '0.00', '10.50', 'm', null],
    ['TH26-02', null, null, null, 'Grab bags, 0–2 m'],
  ]);
});

test('T6/AC6/AC7: offline disables Confirm; Review → Step 1 → Review keeps everything', async ({
  page,
  context,
}) => {
  await signInAs(page, 'at');
  await startReceipt(page);
  await page.getByLabel('Description (optional)').fill('One bucket from the drill crew');
  const unit = bucket(page, 1);
  await addHole(unit, 'TH26-01');
  await sampleRange(unit, 'TH26-01', 'G1', 'S12');
  await unit.getByLabel('Bucket 1 note (optional)').fill('Lid taped');
  await page.getByRole('button', { name: 'Next: Review' }).click();

  await context.setOffline(true);
  const confirm = page.getByRole('button', { name: 'Confirm receipt' });
  await expect(
    page.getByText("You're offline. Your draft is kept. Connect to confirm."),
  ).toBeVisible();
  await expect(confirm).toBeDisabled();

  await page.getByRole('button', { name: 'Edit Bucket 1' }).click();
  await expect(summaryOf(bucket(page, 1), 'TH26-01').getByLabel('Sample to')).toHaveValue('S12');
  await expect(bucket(page, 1).getByLabel('Bucket 1 note (optional)')).toHaveValue('Lid taped');
  await expect(page.getByLabel('Description (optional)')).toHaveValue(
    'One bucket from the drill crew',
  );
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(bucket(page, 1).getByText('G1–S12')).toBeVisible();
  await expect(bucket(page, 1).getByText('Lid taped')).toBeVisible();

  await context.setOffline(false);
  await expect(confirm).toBeEnabled();
  await confirm.click();
  expect(await issuedIds(page)).toHaveLength(1);
});

test('T8/AC5: a personal account defaults to itself; LAB starts blank and must choose', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
  await expect(receiver).toHaveValue(/^AT · Alex Tester/);

  // The shared LAB station: /api/me reports the shared_lab account type. (Signing in as the real
  // LAB account needs the shared password, which another E2E test resets; this keeps them apart.)
  await signInAs(page, 'lab');
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    const me = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...me, accountType: 'shared_lab' } });
  });
  await page.goto('/receiving-log/new');
  await expect(receiver).toHaveValue('');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(
    page.getByRole('alert').getByRole('link', { name: 'Choose who received the samples.' }),
  ).toBeVisible();
  await receiver.fill('AT');
  await page.getByRole('option', { name: /^AT · Alex Tester/ }).click();
  await expect(
    page.getByRole('alert').getByRole('link', { name: 'Choose who received the samples.' }),
  ).toHaveCount(0);
});
