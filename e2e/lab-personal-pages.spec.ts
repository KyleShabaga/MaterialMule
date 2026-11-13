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

/** Sign-in step 2 on the station (STRATA-16): pick who is working before any app page opens. */
async function pickStationPerson(page: Page, name: string) {
  await page.goto('/');
  await expect(page).toHaveURL(/\/who-is-working/);
  await page
    .getByRole('list', { name: 'Receiving lab staff' })
    .getByRole('button', { name: new RegExp(name) })
    .click();
  await expect(
    page.getByRole('button', { name: `Recording as ${name}. Sign off or switch person` }),
  ).toBeVisible();
}

test('LAB: personal-account pages refuse plainly and fire no 403s', async ({ page }) => {
  await signInAsLabStation(page, { person: null });
  await pickStationPerson(page, 'Alex Tester');
  const refused = collect403s(page);

  await page.goto('/action-requests');
  await expect(
    page.getByText('Action requests are for personal accounts. Sign in with your own account.'),
  ).toBeVisible();
  await expect(page.getByText('Action requests couldn’t load.')).toHaveCount(0);

  await page.goto('/settings/profile');
  await expect(page.getByRole('heading', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Settings' })).not.toContainText('Staff');

  // STRATA-119: Settings on the station shows the shared LAB account, read-only.
  await page.goto('/settings/access');
  await expect(page.getByText(/What this shared LAB account can do/)).toBeVisible();

  await page.goto(`/projects/${DEMO_PROJECT_ID}`);
  await expect(page.getByRole('heading', { name: 'DEMO-2601' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Team & Permissions' })).toHaveCount(0);

  await page.goto(`/projects/${DEMO_PROJECT_ID}/team`);
  await expect(
    page.getByText('Team & Permissions is for personal accounts. Sign in with your own account.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Retry' })).toHaveCount(0);

  await page.goto(`/disposal-retention?projectId=${DEMO_PROJECT_ID}`);
  await expect(
    page.getByRole('heading', { level: 1, name: 'Retention', exact: true }),
  ).toBeVisible();
  await expect(page.getByLabel('Units shown')).toBeVisible();

  // The picked person is attribution only: LAB still can't reach personal-account data.
  await expect(
    page.getByRole('button', { name: 'Recording as Alex Tester. Sign off or switch person' }),
  ).toBeVisible();

  // Let in-flight requests settle before the check: the last page's loads must be finished.
  await page.waitForLoadState('networkidle');
  expect(refused).toEqual([]);
  expect((await page.request.get('/api/me/access')).status()).toBe(403);
});
