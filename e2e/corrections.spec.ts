import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { insertInventoryFixture } from './support/inventory';
import { signInAsLabStation } from './support/lab-station';

// MM-T13: correct a confirmed storage unit from its detail page. Fictional, per-test data.

test('T7: correct a summary from the detail page; the history shows it and the ID stays', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${data.a1}`);
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();

  await page.getByRole('button', { name: 'Correct details' }).click();
  const form = page.getByRole('form', { name: 'Correct details' });
  await expect(form.getByLabel('Received date')).toHaveValue('2026-10-01');
  const sampleTo = form.getByLabel('Sample to');
  await expect(sampleTo).toHaveValue('S12');
  await sampleTo.fill('S10');
  await expect(form.getByText('Changed', { exact: true })).toBeVisible();
  await expect(form.getByText('1 field changed')).toBeVisible();
  await expect(form).toContainText('Printed labels show the values at print time.');

  // A reason is required.
  await form.getByRole('button', { name: 'Save correction' }).click();
  await expect(form.getByText('Enter a reason (at least 5 characters).')).toBeVisible();
  await form.getByLabel('Reason for the correction').fill('wrong range on tag');
  await form.getByRole('button', { name: 'Save correction' }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByRole('status').filter({ hasText: 'Details corrected.' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Location and retention' })).toContainText(
    data.warehouse,
  );
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-01: G1–S10',
  );
  await expect(page.getByRole('list', { name: 'History events' })).toContainText(
    // MTR-3: Alex Tester is a test account, so the TEST badge follows the initials.
    'AT TEST changed test holes TH26-01: G1–S12 → TH26-01: G1–S10 · Reason: wrong range on tag',
  );

  // The change survives a reload.
  await page.reload();
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-01: G1–S10',
  );
});

// MM-T70 T4 (owner decision 2026-10-28: refuse): a unit approved for disposal can't change
// project; Correct details says so in plain words and links to Disposal & Retention.
test('MM-T70 T4: correcting the project of an approved unit is refused with a plain message', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  // Fictional approval recorded directly (the unit isn't date-eligible yet in real time).
  await withDatabase(async (client) => {
    await client.query(
      `INSERT INTO disposal_approval (storage_unit_id, project_id, batch_id, approved_by_user_id,
         approved_by_name_snapshot, effective_retain_until, idempotency_key, request_hash)
       SELECT su.id, su.project_id, gen_random_uuid(), '00000000-0000-4000-8000-000000000101',
              'Pat Example', '2027-10-01', gen_random_uuid(), 'e2e'
       FROM storage_unit su WHERE su.readable_id = $1`,
      [data.a1],
    );
    await client.query(
      `UPDATE storage_unit SET status = 'approved_for_disposal', version = version + 1
       WHERE readable_id = $1`,
      [data.a1],
    );
  });
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${data.a1}`);
  await page.getByRole('button', { name: 'Correct details' }).click();
  const form = page.getByRole('form', { name: 'Correct details' });
  await form.getByRole('button', { name: 'Change project' }).click();
  const search = form.getByRole('combobox', { name: /Find project/ });
  await search.fill(data.projectB);
  await expect(page.getByRole('option', { name: new RegExp(data.projectB) })).toBeVisible();
  await search.press('Enter');
  await expect(form.getByLabel('Project number')).toHaveValue(data.projectB);
  const hole = form.getByRole('combobox', { name: 'Find or add a test hole' });
  await hole.fill('TH26-01');
  await expect(form.getByRole('option', { name: 'TH26-01', exact: true })).toBeVisible();
  await hole.press('Enter');
  await form
    .getByRole('group', { name: 'TH26-01 summary' })
    .getByLabel('Summary type')
    .selectOption('all');
  await form.getByLabel('Reason for the correction').fill('received under the wrong project');
  await form.getByRole('button', { name: 'Save correction' }).click();

  await expect(form.getByRole('alert').filter({ hasText: 'approved for disposal' })).toContainText(
    `${data.a1} is approved for disposal under ${data.projectA}. Revoke the approval on the ` +
      'Disposal & Retention page first, then correct the project.',
  );
  await expect(form.getByRole('link', { name: 'Open Disposal & Retention' })).toHaveAttribute(
    'href',
    /disposal-retention[?]projectId=/,
  );
  // Nothing changed: same project, no correction in the unit's history.
  const project = await withDatabase(async (client) => {
    const { rows } = await client.query<{ project_number: string; corrected: number }>(
      `SELECT p.project_number,
              (SELECT count(*)::int FROM audit_event e
               WHERE e.action = 'storage_unit.corrected' AND e.entity_id = su.id) AS corrected
       FROM storage_unit su JOIN project p ON p.id = su.project_id
       WHERE su.readable_id = $1`,
      [data.a1],
    );
    return rows[0]!;
  });
  expect(project).toEqual({ project_number: data.projectA, corrected: 0 });
});

// MM-T49: corrections are refused for LAB in the browser. Uses a real LAB station session (the
// E2E-only shared_lab account, as e2e/critical does), never the shared LAB password, which only
// lab-login.spec.ts may set (it signs out every LAB station).
test('T3/AC2: a LAB station sees no Correct action and its correction request gets 403', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  const before = await correctionState(data.a1);
  await signInAsLabStation(page);
  await page.goto(`/sample-storage/${data.a1}`);
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByText('Corrections need a personal account.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct details' })).toHaveCount(0);
  await expect(page.getByRole('form', { name: 'Correct details' })).toHaveCount(0);

  // The server refuses it too: the same request the form would send, from this LAB session.
  const response = await page.request.patch(`/api/storage-units/${data.a1}`, {
    headers: { 'x-materialmule-csrf': '1' },
    data: { version: before.version, reason: 'LAB try', changes: { note: 'Changed by LAB' } },
  });
  expect(response.status()).toBe(403);

  await page.reload();
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Correct details' })).toHaveCount(0);
  expect(await correctionState(data.a1)).toEqual(before);
});

/** The unit's row version, note and number of correction events: none may change for LAB. */
async function correctionState(readableId: string) {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{
      version: number;
      note: string | null;
      corrections: number;
    }>(
      `SELECT su.version, su.note,
              (SELECT count(*)::int FROM audit_event a
               WHERE a.entity_id = su.id AND a.action = 'storage_unit.corrected') AS corrections
       FROM storage_unit su WHERE su.readable_id = $1`,
      [readableId],
    );
    return rows[0]!;
  });
}
