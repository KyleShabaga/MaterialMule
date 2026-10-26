import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertInventoryFixture } from './support/inventory';

// TRP-T13: correct a confirmed storage unit from its detail page. Fictional, per-test data.

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
  await expect(form.getByText('Changed')).toBeVisible();
  await expect(form).toContainText('Printed labels show the values at print time.');

  // A reason is required.
  await form.getByRole('button', { name: 'Save correction' }).click();
  await expect(form.getByText('Enter a reason (at least 5 characters).')).toBeVisible();
  await form.getByLabel('Reason for the correction').fill('wrong range on tag');
  await form.getByRole('button', { name: 'Save correction' }).click();

  await expect(form).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: data.a1 })).toBeVisible();
  await expect(page.getByText(`Saved location: ${data.warehouse}`)).toBeVisible();
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-01: G1–S10',
  );
  await expect(page.getByRole('list', { name: 'History events' })).toContainText(
    'AT changed test holes TH26-01: G1–S12 → TH26-01: G1–S10 · Reason: wrong range on tag',
  );

  // The change survives a reload.
  await page.reload();
  await expect(page.getByRole('list', { name: 'Test hole summaries' })).toContainText(
    'TH26-01: G1–S10',
  );
});

// LAB (403, no Correct action) is proven in corrections.integration.test.ts and
// corrections.test.tsx: signing in as the real LAB account needs its shared password, which only
// lab-login.spec.ts may set (it signs out every LAB station).
