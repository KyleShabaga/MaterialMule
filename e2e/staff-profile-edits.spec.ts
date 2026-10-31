import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-T43 and MM-T44 against the mock Microsoft tenant. Each browser project uses its own
// fictional new starter (the database is shared), and no other spec signs these two in.

async function signInWithMicrosoft(page: Page, name: string) {
  await page.request.post('/api/auth/sign-out', { headers: { 'x-materialmule-csrf': '1' } });
  await page.goto('/sign-in');
  await page.getByRole('link', { name: 'Sign in with Microsoft' }).click();
  await expect(page.getByRole('heading', { name: 'Mock Microsoft sign-in' })).toBeVisible();
  await page.getByRole('link', { name }).click();
}

test('an admin assigns initials and a position; the person sees the initials but never the position', async ({
  page,
}, testInfo) => {
  const desktop = testInfo.project.name === 'desktop-chromium';
  const name = desktop ? 'Casey Example' : 'Drew Example';
  const initials = desktop ? 'CXE' : 'DXE';

  // Onboarding: no position step (MISC-06); the new starter waits for approval.
  await signInWithMicrosoft(page, name);
  await expect(page.getByRole('heading', { name: 'Access pending' })).toBeVisible();

  // The admin approves them, assigns official initials and sets the position.
  await signInAs(page, 'admin');
  await page.goto('/settings/staff');
  const pending = page.getByRole('region', { name: /Waiting for approval/ });
  await pending.getByRole('button', { name: `Approve ${name}` }).click();
  await expect(page.getByRole('status').filter({ hasText: `${name} is approved.` })).toBeVisible();
  await page.getByLabel('Search staff').fill(name);
  await page.getByRole('button', { name: `Manage ${name}` }).click();
  const drawer = page.getByRole('dialog', { name });
  await drawer.getByLabel('Official initials').fill(initials);
  // Keyboard: choose Technologist on the focused select; exactly four positions and Not set.
  const position = drawer.getByLabel('Position');
  await expect(position.locator('option')).toHaveText([
    'Not set',
    'Technician',
    'Technologist',
    'Engineer',
    'Lab Manager',
  ]);
  await position.focus();
  await position.selectOption({ label: 'Technologist' });
  await drawer.getByRole('button', { name: 'Save profile' }).press('Enter');
  await expect(page.getByRole('status').filter({ hasText: `Saved ${name}.` })).toBeVisible();
  await expect(drawer.getByRole('button', { name: /Confirm initials/ })).toHaveCount(0);

  // Their next sign-in goes straight into the app.
  await signInWithMicrosoft(page, name);
  await expect(page).toHaveURL(/\/$/);

  // My profile shows the admin-assigned initials as confirmed (MM-T44) and no position.
  await page.goto('/settings/profile');
  await expect(page.locator('dt:has-text("Official initials") + dd')).toHaveText(initials);
  await expect(page.getByText('Not confirmed yet')).toHaveCount(0);
  await expect(page.getByText('Technologist')).toHaveCount(0);
  const me = await (await page.request.get('/api/me/profile')).json();
  expect(me).toMatchObject({ officialInitials: initials, initialsConfirmed: true });
  expect(me).not.toHaveProperty('position');
});
