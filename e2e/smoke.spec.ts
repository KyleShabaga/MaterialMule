import { expect, test } from '@playwright/test';

test('web shell shows the API and database as healthy', async ({ page }) => {
  await page.goto('/');

  await expect(page.getByRole('heading', { name: 'Trapezoid' })).toBeVisible();
  const status = page.locator('.status');
  await expect(status).toContainText('OK');
  await expect(status).toContainText('Connected');
  await expect(status).toContainText(/\d+\.\d+\.\d+/);
});

test('health endpoint is reachable through the web origin', async ({ request }) => {
  const response = await request.get('/api/health');
  expect(response.status()).toBe(200);
  expect(await response.json()).toMatchObject({ status: 'ok', database: 'up' });
});
