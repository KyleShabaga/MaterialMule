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
  await page.goto('/admin/staff');

  const rules = page.getByRole('region', { name: 'Review eligibility by position' });
  await expect(rules.getByText('No position is eligible to review.')).toBeVisible();
  const enable = rules.getByRole('form', { name: 'Enable a position rule' });
  await enable.getByRole('combobox', { name: 'Position' }).click();
  await page.getByRole('option', { name: 'Engineer', exact: true }).click();
  await enable.getByRole('combobox', { name: 'Review scope' }).click();
  await page.getByRole('option', { name: 'Concrete strength reports' }).click();
  await enable.getByLabel('Reason').fill('Engineers review strength reports');
  await enable.getByRole('button', { name: 'Enable rule' }).click();
  await expect(rules.getByText('Engineer: Concrete strength reports')).toBeVisible();

  await page
    .getByRole('toolbar', { name: 'Staff tools' })
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await page.getByRole('searchbox', { name: 'Search staff' }).fill('Dana Example');
  await page.getByRole('button', { name: 'Manage Dana Example' }).click();
  // STRATA-102: the person opens beside the table (desktop only here).
  const drawer = page.getByRole('region', { name: 'Dana Example', exact: true });
  const effective = drawer.getByRole('list', { name: 'Effective review eligibility' });
  await expect(effective).toContainText('Concrete strength reports: Eligible to review');
  await expect(effective).toContainText('position rule');

  const exclude = drawer.getByRole('form', { name: 'Exclude from review' });
  await exclude.getByRole('combobox', { name: 'Exclude from review' }).click();
  await page.getByRole('option', { name: 'Concrete strength reports' }).click();
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
  const confirm = page.getByRole('alertdialog', {
    name: /Remove: Excluded from Concrete strength reports/,
  });
  await confirm.getByLabel('Reason').fill('Certified again');
  await confirm.getByRole('button', { name: 'Remove' }).click();
  await expect(effective).toContainText('Concrete strength reports: Eligible to review');
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await rules.getByRole('button', { name: 'Disable Engineer (Concrete strength reports)' }).click();
  const disable = page.getByRole('alertdialog', { name: /Disable Engineer/ });
  await disable.getByLabel('Reason').fill('Test finished');
  await disable.getByRole('button', { name: 'Disable' }).click();
  await expect(rules.getByText('No position is eligible to review.')).toBeVisible();
});
