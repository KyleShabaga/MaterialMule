import { randomInt } from 'node:crypto';
import { expect, test } from '@playwright/test';
import type pg from 'pg';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-T82 T3: Correct details for a Shelby tube's sampling source, and "Make it an ordinary
// bucket" for a bulk soil bucket, on Desktop Chrome and Pixel 7. Units are inserted directly
// (issue year 2025, random numbers) so they never collide with IDs the app issues. Fictional data
// only: DEMO-2601, TH26-01 / TH26-02, made-up sampling locations.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const TH26_01_ID = '00000000-0000-4000-8000-000000000301';
const ALEX_TESTER_ID = '00000000-0000-4000-8000-000000000102';

const readable = (prefix: 'ST' | 'BKT') =>
  `${prefix}-2025-${String(randomInt(1, 999_999)).padStart(6, '0')}`;

async function receipt(client: pg.Client, quantity: number): Promise<string> {
  const { rows } = await client.query<{ id: string }>(
    `INSERT INTO receipt (project_id, received_date, receiver_user_id, receiver_initials_snapshot,
                          receiver_name_snapshot, account_user_id, quantity, idempotency_key,
                          request_hash)
     VALUES ($1, '2025-11-03', $2, 'AT', 'Alex Tester', $2, $3, gen_random_uuid(), 'e2e')
     RETURNING id`,
    [DEMO_PROJECT_ID, ALEX_TESTER_ID, quantity],
  );
  return rows[0]!.id;
}

async function unit(
  client: pg.Client,
  receiptId: string,
  line: number,
  values: { prefix: 'ST' | 'BKT'; sample?: string; groupId?: string },
): Promise<string> {
  const readableId = readable(values.prefix);
  const tube = values.prefix === 'ST';
  await client.query(
    `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                               receipt_id, receipt_line, project_id, unit_type, holder_kind,
                               current_location_id, received_date, source_type,
                               source_test_hole_id, sample_reference, bulk_group_id)
     SELECT $1, $2, 2025, $3, $4, $5, $6, $7, $3, l.id, '2025-11-03', $8, $9, $10, $11
     FROM location l WHERE l.code_normalized = 'RECEIVING'`,
    [
      readableId,
      values.prefix,
      tube ? 'shelby_tube' : 'bucket',
      receiptId,
      line,
      DEMO_PROJECT_ID,
      tube ? 'shelby_tube' : 'bulk_container',
      tube ? 'test_hole' : null,
      tube ? TH26_01_ID : null,
      values.sample ?? null,
      values.groupId ?? null,
    ],
  );
  return readableId;
}

test('MM-T82 T3: correct a Shelby tube’s sampling source from Correct details', async ({
  page,
}) => {
  const tag = String(randomInt(1000, 9999));
  const tube = await withDatabase(async (client) =>
    unit(client, await receipt(client, 1), 1, { prefix: 'ST', sample: `T${tag}` }),
  );
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${tube}`);
  await expect(page.getByRole('heading', { level: 1, name: tube })).toBeVisible();

  await page.getByRole('button', { name: 'Correct details' }).click();
  const form = page.getByRole('form', { name: 'Correct details' });
  await expect(form).not.toContainText('can’t be corrected here yet');
  const source = form.getByRole('group', { name: 'Sampling source' });
  await expect(source).toContainText(`TH26-01: T${tag}`);
  await source.getByRole('button', { name: 'Change sampling source' }).click();
  await source.getByRole('radio', { name: 'Standalone sampling location' }).check();
  await source.getByRole('textbox', { name: 'Location reference' }).fill(`Embankment ${tag}`);
  await source.getByLabel(/^Depth( \(optional\))?$/).fill('1.5');
  await source.getByRole('radio', { name: 'm', exact: true }).check();
  await expect(form.getByText('1 field changed')).toBeVisible();
  await form.getByLabel('Reason for the correction').fill('tag misread at receiving');
  await form.getByRole('button', { name: 'Save correction' }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: tube })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Details corrected.' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'History events' })).toContainText(
    `AT TEST changed sampling source TH26-01: T${tag} → Embankment ${tag}: T${tag} at 1.5 m · Reason: tag misread at receiving`,
  );
  // Nothing on the page runs wider than the viewport (phone width).
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);
});

test('MM-T82 T3: make a bulk soil bucket an ordinary bucket; the ID stays', async ({ page }) => {
  const tag = String(randomInt(1000, 9999));
  const [first, second] = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bulk_group (project_id, source_type, source_location_reference,
                               sample_reference, depth_from, depth_unit, created_by_user_id)
       VALUES ($1, 'standalone_location', $2, 'B1', 1, 'm', $3) RETURNING id`,
      [DEMO_PROJECT_ID, `Pit ${tag}`, ALEX_TESTER_ID],
    );
    const receiptId = await receipt(client, 2);
    return [
      await unit(client, receiptId, 1, { prefix: 'BKT', groupId: rows[0]!.id }),
      await unit(client, receiptId, 2, { prefix: 'BKT', groupId: rows[0]!.id }),
    ];
  });
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${first}`);
  const bulk = page.getByRole('region', { name: 'Bulk sample' });
  await expect(bulk.getByRole('list', { name: 'Buckets of this bulk sample' })).toContainText(
    second!,
  );

  await bulk.getByRole('button', { name: 'Make it an ordinary bucket' }).click();
  const hole = bulk.getByRole('combobox', { name: 'Find or add a test hole' });
  await hole.fill('TH26-02');
  await expect(bulk.getByRole('option', { name: 'TH26-02', exact: true })).toBeVisible();
  await hole.press('Enter');
  const summary = bulk.getByRole('group', { name: 'TH26-02 summary' });
  await summary.getByLabel('Summary type').selectOption('all');
  // A reason is required, in plain words.
  await bulk.getByRole('button', { name: 'Make it an ordinary bucket' }).click();
  await expect(bulk.getByText('Enter a reason (at least 5 characters).')).toBeVisible();
  await bulk.getByLabel('Reason').fill('ordinary grab bucket, not B1');
  await bulk.getByRole('button', { name: 'Make it an ordinary bucket' }).click();

  await expect(
    page.getByRole('status').filter({ hasText: `${first} is now an ordinary bucket.` }),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 1, name: first })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Bulk sample' })).toBeHidden();
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-02: ALL',
  );
  await expect(page.getByRole('list', { name: 'History events' })).toContainText(
    // Its place follows the received date, then the (random) storage unit ID.
    new RegExp(`bulk sample Pit ${tag}: B1 at 1 m \\(bucket [12] of 2\\) → none`),
  );

  // The other bucket is now 1 of 1.
  await page.goto(`/sample-storage/${second}`);
  const remaining = page.getByRole('region', { name: 'Bulk sample' });
  await expect(remaining).toContainText('bucket 1 of 1');
  await expect(
    remaining.getByRole('list', { name: 'Buckets of this bulk sample' }).getByRole('listitem'),
  ).toHaveCount(1);
});
