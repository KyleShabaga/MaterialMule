import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

test('choosing a fixture signs in and shows the TEST badge; switching replaces the identity', async ({
  page,
}) => {
  await page.goto('/sign-in/test');
  await expect(page.getByRole('heading', { name: 'Test sign-in' })).toBeVisible();

  await page.getByRole('button', { name: 'Admin (test)' }).click();
  const signedIn = page.locator('.signed-in');
  await expect(signedIn).toContainText('Signed in as Admin (test)');
  await expect(signedIn).toContainText('TEST');

  await page.getByRole('button', { name: 'Lab (test)' }).click();
  await expect(signedIn).toContainText('Signed in as Lab (test)');
  const me = await (await page.request.get('/api/me')).json();
  expect(me).toMatchObject({ displayName: 'Lab (test)', roles: ['lab_manager'] });
});

test('signInAs() helper signs in through the API and replaces the previous session', async ({
  page,
}) => {
  await signInAs(page, 'admin');
  expect((await (await page.request.get('/api/me')).json()).displayName).toBe('Admin (test)');
  await signInAs(page, 'at');
  expect((await (await page.request.get('/api/me')).json()).displayName).toBe('Alex Tester');
});
