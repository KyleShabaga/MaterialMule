import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// Today shows no API/database health; admins see it under Settings → System status
// (system-status.spec.ts). Here: the app loads data at all.
test('Today loads data from the API and database', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');

  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  const lastDay = page.getByRole('region', { name: 'Last 24 hours' });
  await expect(lastDay.getByRole('heading', { level: 2, name: 'Last 24 hours' })).toBeVisible();
  await expect(lastDay.getByText('Loading the last 24 hours…')).toHaveCount(0);
  await expect(lastDay.getByRole('alert')).toHaveCount(0);
  await expect(page).toHaveTitle('Today · Material Mule');
});

test('health endpoint is reachable through the web origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', database: 'up' });
});
