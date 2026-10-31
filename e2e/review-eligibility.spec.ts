import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MISC-08: an Admin enables position-based review eligibility, sees it take effect for an
// Engineer, and a Concrete strength exclusion override it. Rules are global, so this runs in one
// browser project only, in a scope no other spec uses. Fictional fixture people only (Dana Example, an Engineer).
test('an Admin enables a position rule and a scoped exclusion overrides it', async ({
  page,
}, testInfo) => {
  test.skip(testInfo.project.name !== 'desktop-chromium', 'Position rules are global');
  await signInAs(page, 'admin');
  await page.goto('/settings/staff');

  const rules = page.getByRole('region', { name: 'Review eligibility by position' });
  await expect(rules.getByText('No position is eligible to review.')).toBeVisible();
  const enable = rules.getByRole('form', { name: 'Enable a position rule' });
  await enable.getByLabel('Position').selectOption({ label: 'Engineer' });
  await enable.getByLabel('Review scope').selectOption({ label: 'Concrete strength reports' });
  await enable.getByLabel('Reason').fill('Engineers review strength reports');
  await enable.getByRole('button', { name: 'Enable rule' }).click();
  await expect(rules.getByText('Engineer: Concrete strength reports')).toBeVisible();

  await page.getByLabel('Search staff').fill('Dana Example');
  await page.getByRole('button', { name: 'Manage Dana Example' }).click();
  const drawer = page.getByRole('dialog', { name: 'Dana Example' });
  const effective = drawer.getByRole('list', { name: 'Effective review eligibility' });
  await expect(effective).toContainText('Concrete strength reports: Eligible to review');
  await expect(effective).toContainText('position rule');

  const exclude = drawer.getByRole('form', { name: 'Exclude from review' });
  await exclude
    .getByLabel('Exclude from review')
    .selectOption({ label: 'Concrete strength reports' });
  await exclude.getByLabel('Reason').fill('Paused pending certification');
  await exclude.getByRole('button', { name: 'Exclude' }).click();
  await expect(effective).toContainText('Concrete strength reports: Not eligible');
  await expect(
    drawer.getByText('Excluded from Concrete strength reports', { exact: true }),
  ).toBeVisible();

  // Clean up: remove the exclusion and disable the rule, each with a reason.
  await drawer
    .getByRole('button', { name: 'Remove exclusion (Concrete strength reports)' })
    .click();
  const confirm = page.getByRole('dialog', {
    name: /Remove: Excluded from Concrete strength reports/,
  });
  await confirm.getByLabel('Reason').fill('Certified again');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(effective).toContainText('Concrete strength reports: Eligible to review');
  await page.keyboard.press('Escape');
  await rules.getByRole('button', { name: 'Disable Engineer (Concrete strength reports)' }).click();
  const disable = page.getByRole('dialog', { name: /Disable Engineer/ });
  await disable.getByLabel('Reason').fill('Test finished');
  await disable.getByRole('button', { name: 'Disable' }).click();
  await expect(rules.getByText('No position is eligible to review.')).toBeVisible();
});
