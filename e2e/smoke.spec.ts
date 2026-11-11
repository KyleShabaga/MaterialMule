import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// Today shows no API/database health; admins see it under Settings → System status
// (system-status.spec.ts). Here: the app loads data at all.
test('Today loads data from the API and database', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  const ledger = page.getByRole('region', { name: 'Ledger' });
  await expect(ledger.getByText('LAST 24 H')).toBeVisible();
  await expect(ledger.getByText('Loading the ledger…')).toHaveCount(0);
  await expect(ledger.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveTitle('Today · Material Mule');
});

test('health endpoint is reachable through the web origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', database: 'up' });
});
