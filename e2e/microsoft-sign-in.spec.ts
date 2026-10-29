import { expect, test, type Page } from '@playwright/test';

// MM-T05 against the mock Microsoft tenant (apps/api/src/test-support/mock-oidc.ts). Every
// account here is fictional. Real-account verification (card T6) is manual and needs IT's
// app registration.

async function signInWithMicrosoft(page: Page, name: string) {
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Sign in with Microsoft' }).click();
  await expect(page.getByRole('heading', { name: 'Mock Microsoft sign-in' })).toBeVisible();
  await page.getByRole('link', { name }).click();
}

test('T5: position setup interrupted, resumed and saved once', async ({ page }, testInfo) => {
  // Each browser project uses its own fictional new starter, since the database is shared.
  const name = testInfo.project.name === 'desktop-chromium' ? 'Riley Example' : 'Morgan Example';

  await signInWithMicrosoft(page, name);
  await expect(page).toHaveURL(/\/onboarding\/position$/);
  await expect(page.getByRole('heading', { name: `Welcome, ${name}` })).toBeVisible();
  await expect(page.getByText('From Microsoft: Field Technician')).toBeVisible();

  // Interrupted: going elsewhere comes back to setup.
  await page.goto('/projects');
  await expect(page).toHaveURL(/\/onboarding\/position$/);

  // Leaving and signing in again resumes setup (nothing was saved).
  await page.getByRole('button', { name: 'Sign out' }).click();
  await expect(page).toHaveURL(/\/sign-in/);
  await signInWithMicrosoft(page, name);
  await expect(page).toHaveURL(/\/onboarding\/position$/);

  await page.getByRole('radio', { name: /Engineer \(Eng\)/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  // New people wait for an administrator before seeing any data.
  await expect(page.getByRole('heading', { name: 'Access pending' })).toBeVisible();

  // Saved once: the API refuses a second save, and the next sign-in skips setup.
  const again = await page.request.post('/api/me/position', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { position: 'technician' },
  });
  expect(again.status()).toBe(409);
  await page.getByRole('button', { name: 'Sign out' }).click();
  // Wait for sign-out's own navigation; a page.goto during it is aborted (net::ERR_ABORTED).
  await expect(page).toHaveURL(/\/sign-in/);
  await signInWithMicrosoft(page, name);
  await expect(page.getByRole('heading', { name: 'Access pending' })).toBeVisible();
  const me = await (await page.request.get('/api/me')).json();
  expect(me).toMatchObject({ status: 'pending', position: 'engineer', permissions: [] });
});

test('AC1: the bootstrap administrator gets in as an active admin', async ({ page }, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'One bootstrap account per run');
  await signInWithMicrosoft(page, 'Avery Bootstrap');
  await expect(page).toHaveURL(/\/onboarding\/position$/);
  await page.getByRole('radio', { name: /Project Engineer/ }).check();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByLabel('Signed in user')).toContainText('Avery Bootstrap');
  const me = await (await page.request.get('/api/me')).json();
  expect(me).toMatchObject({ status: 'active', roles: ['admin'] });

  await page.goto('/settings/profile');
  await expect(page.getByText('Operations Manager')).toBeVisible();
  await expect(page.getByText('Microsoft 365 profile', { exact: true })).toBeVisible();
});

test('a cancelled Microsoft sign-in explains itself and signs nobody in', async ({ page }) => {
  await page.goto('/sign-in?switch=1');
  await page.getByRole('link', { name: 'Sign in with Microsoft' }).click();
  // Switch user: Microsoft is asked to show the account picker.
  await expect(page.getByText('Prompt: select_account')).toBeVisible();
  await page.getByRole('link', { name: 'Cancel' }).click();
  await expect(page.getByRole('heading', { name: 'Sign-in was cancelled' })).toBeVisible();
  expect((await page.request.get('/api/me')).status()).toBe(401);
});
