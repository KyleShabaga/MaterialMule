import { expect, test, type Page } from '@playwright/test';
import { signInAsLabStation } from './support/lab-station';

// MTR-2: the shared LAB station never calls personal-account endpoints, so none of these pages
// shows a 403 in the console, and the personal pages say plainly what they are for. Fictional
// data only: the seeded project DEMO-2601.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';

function collect403s(page: Page): string[] {
  const refused: string[] = [];
  page.on('response', (response) => {
    if (response.status() === 403) refused.push(new URL(response.url()).pathname);
  });
  return refused;
}

test('LAB: personal-account pages refuse plainly and fire no 403s', async ({ page }) => {
  await signInAsLabStation(page);
  const refused = collect403s(page);

  await page.goto('/action-requests');
  await expect(
    page.getByText('Action requests are for personal accounts. Sign in with your own account.'),
  ).toBeVisible();
  await expect(page.getByText('Action requests couldn’t load.')).toHaveCount(0);

  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings' })).not.toContainText(
    'Staff & access',
  );

  await page.goto('/settings/access');
  await expect(page.getByText(/My access is for personal accounts/)).toBeVisible();

  await page.goto(`/projects/${DEMO_PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'DEMO-2601' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team & Permissions' })).toHaveCount(0);

  await page.goto(`/projects/${DEMO_PROJECT_ID}/team`);
  await expect(
    page.getByText('Team & Permissions is for personal accounts. Sign in with your own account.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);

  await page.goto(`/disposal-retention?projectId=${DEMO_PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'Disposal & Retention' })).toBeVisible();
  await expect(page.getByLabel('Units shown')).toBeVisible();

  // Let in-flight requests settle before the check: the last page's loads must be finished.
  await page.waitForLoadState('networkidle');
  expect(refused).toEqual([]);
});
