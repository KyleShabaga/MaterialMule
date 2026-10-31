import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-T07 T6. Each viewport approves its own seeded applicant (apps/api/seed/dev.sql), so the
// desktop and phone runs never race for the same person.
test('an admin approves a pending applicant', async ({ page }, testInfo) => {
  const applicant = testInfo.project.name.startsWith('phone') ? 'Casey Pending' : 'Riley Pending';
  await signInAs(page, 'admin');
  await page.goto('/settings/staff');
  await expect(page.getByRole('heading', { name: 'Staff & access' })).toBeVisible();

  const pending = page.getByRole('region', { name: /Waiting for approval/ });
  await expect(pending).toContainText(applicant);
  await pending.getByRole('button', { name: `Approve ${applicant}` }).click();

  await expect(
    page.getByRole('status').filter({ hasText: `${applicant} is approved.` }),
  ).toBeVisible();
  await expect(pending.getByText(applicant)).toHaveCount(0);
  // The directory now lists them as active.
  await page.getByLabel('Search staff').fill(applicant);
  await expect(page.getByRole('row').filter({ hasText: applicant })).toContainText('Active');

  // MTR-12: the drawer says who approved, disabled and re-enabled them, and when. Approve and
  // re-enable take no reason; disable needs one.
  await page.getByRole('button', { name: `Manage ${applicant}` }).click();
  const drawer = page.getByRole('dialog', { name: applicant });
  const history = drawer.getByRole('list', { name: 'Access history' });
  await expect(history.getByRole('listitem')).toHaveText([/^Approved by .+ on .+\d{4}$/]);
  await drawer.getByRole('button', { name: 'Disable access…' }).click();
  const confirm = page.getByRole('dialog', { name: `Disable ${applicant}?` });
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Example leave of absence');
  await confirm.getByRole('button', { name: 'Disable' }).click();
  await drawer.getByRole('button', { name: 'Re-enable access' }).click();
  await expect(history.getByRole('listitem')).toHaveText([
    /^Approved by .+ on /,
    /^Disabled by .+ on .+: Example leave of absence$/,
    /^Re-enabled by .+ on .+\d{4}$/,
  ]);
});

test('receiver selector: keyboard picks one of two people sharing "JS"', async ({ page }) => {
  // The Lab (test) fixture is a personal-style account, so it starts as its own receiver; only
  // the shared LAB station starts empty.
  await signInAs(page, 'lab');
  await page.goto('/receiving-log/new');

  const input = page.getByRole('combobox', { name: 'Received by', exact: true });
  await expect(input).toHaveValue('LAB · Lab (test)');
  await expect(page.getByText('Not listed? Ask an administrator to add them.')).toBeVisible();

  await input.click();
  await input.press('ControlOrMeta+a');
  await input.pressSequentially('JS');
  const jamie = page.getByRole('option', { name: 'JS · Jamie Song' });
  const jordan = page.getByRole('option', { name: 'JS · Jordan Smith' });
  await expect(jamie).toBeVisible();
  await expect(jordan).toBeVisible();
  // Both fit inside the viewport at phone width as well as desktop.
  await expect(jordan).toBeInViewport();

  await input.press('ArrowDown');
  await expect(jordan).toHaveAttribute('aria-selected', 'true');
  await input.press('Enter');
  await expect(input).toHaveValue('JS · Jordan Smith');
  await expect(jordan).toBeHidden();

  // Free text is never accepted: an unmatched entry clears the choice.
  await input.fill('ZZ');
  await expect(page.getByText('No active staff match.')).toBeVisible();
  await page.getByLabel('Description').click();
  await expect(page.getByText('Choose a person from the list.')).toBeVisible();
  await expect(input).toHaveAttribute('aria-invalid', 'true');
});

test('non-admins cannot manage staff, in the UI or the API', async ({ page }) => {
  await signInAs(page, 'lab');
  await page.goto('/settings/staff');
  await expect(page.getByText('Only administrators can manage staff and access.')).toBeVisible();
  const response = await page.request.get('/api/staff');
  expect(response.status()).toBe(403);
});
