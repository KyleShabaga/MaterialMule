import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { addHole, bucket, chooseDemoProject, openWizard } from './support/receiving';

// Core boxes (Kyle, 2026-11-10): a CRE- core box belongs to one test hole and holds 1–3 runs of
// 1.52 m, 3 runs (4.56 m) by default; its runs are corrected later without changing the ID.
// Fictional data only (DEMO-2601, TH26-01 / TH26-02).

const CRE_ID = /^CRE-\d{4}-\d{6}$/;

test('a core box is received at 3 runs on one test hole, then corrected to 2 runs', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await openWizard(page);
  await chooseDemoProject(page);

  await bucket(page, 1).getByLabel('Physical holder').selectOption('core_box');
  const box = page.getByRole('region', { name: 'Core box 1' });
  await addHole(box, 'TH26-01');
  // Choosing a second hole replaces the first: a core box belongs to one test hole.
  await addHole(box, 'TH26-02');
  await expect(box.getByRole('group', { name: 'TH26-01 summary' })).toHaveCount(0);
  const summary = box.getByRole('group', { name: 'TH26-02 summary' });
  await expect(summary.getByLabel('Summary type')).toHaveValue('all');
  await expect(box.getByRole('radio', { name: '3 runs · 4.56 m' })).toBeChecked();
  await expect(box.getByText('TH26-02: All samples · 3 runs · 4.56 m')).toBeVisible();

  await page.getByRole('button', { name: 'Next: Review' }).click();
  await expect(page.getByText('3 runs · 4.56 m').first()).toBeVisible();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const list = page.getByRole('list', { name: 'New storage units' });
  await expect(list).toBeVisible({ timeout: 15_000 });
  const ids = await list.getByRole('heading').allTextContents();
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(CRE_ID);

  await page.goto(`/sample-storage/${ids[0]}`);
  await expect(page.getByRole('heading', { level: 1, name: ids[0]! })).toBeVisible();
  await expect(page.getByText('3 runs · 4.56 m')).toBeVisible();

  await page.getByRole('button', { name: 'Correct details' }).click();
  const form = page.getByRole('form', { name: 'Correct details' });
  await form.getByRole('radio', { name: '2 runs · 3.04 m' }).check();
  await form.getByLabel('Reason for the correction').fill('last box of the hole');
  await form.getByRole('button', { name: 'Save correction' }).click();
  await expect(form).toHaveCount(0);
  await expect(page.getByText('2 runs · 3.04 m').first()).toBeVisible();

  const rows = await withDatabase(async (client) => {
    const { rows } = await client.query<{
      readable_id: string;
      unit_type: string;
      core_run_count: number;
      holes: string[];
    }>(
      `SELECT su.readable_id, su.unit_type, su.core_run_count,
              array_agg(th.name ORDER BY th.name) AS holes
       FROM storage_unit su
       JOIN storage_unit_hole_summary s ON s.storage_unit_id = su.id
       JOIN test_hole th ON th.id = s.test_hole_id
       WHERE su.readable_id = $1
       GROUP BY su.id`,
      [ids[0]],
    );
    return rows;
  });
  expect(rows).toEqual([
    { readable_id: ids[0], unit_type: 'core_box', core_run_count: 2, holes: ['TH26-02'] },
  ]);
});
