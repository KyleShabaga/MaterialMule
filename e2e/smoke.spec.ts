import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// The dashboard no longer shows API/database health (approved design, 2026-10-27); admins see
// it under Settings → System status (system-status.spec.ts). Here: the app loads data at all.
test('dashboard loads data from the API and database', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Dashboard' })).toBeVisible();
  const recent = page.getByRole('region', { name: 'Recently received' });
  await expect(recent.getByRole('link', { name: 'See all in Sample Storage →' })).toBeVisible();
  await expect(recent.getByText(/this week$/)).toBeVisible();
  await expect(recent.getByRole('alert')).toHaveCount(0);
});

test('health endpoint is reachable through the web origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', database: 'up' });
});
