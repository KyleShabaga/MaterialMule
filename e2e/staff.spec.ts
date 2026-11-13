import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

/** STRATA-102: a person opens beside the table from 1024 px, and in a sheet on phones. */
function staffDrawer(page: Page, name: string) {
  return page
    .getByRole('region', { name, exact: true })
    .or(page.getByRole('dialog', { name, exact: true }));
}

/** The toolbar's search box opens from its Search button. */
async function searchStaff(page: Page, text: string) {
  const box = page.getByRole('searchbox', { name: 'Search staff' });
  if (!(await box.isVisible())) {
    await page
      .getByRole('toolbar', { name: 'Staff tools' })
      .getByRole('button', { name: 'Search', exact: true })
      .click();
  }
  await box.fill(text);
}

// MM-T07 T6. Each viewport approves its own seeded applicant (apps/api/seed/dev.sql), so the
// desktop and phone runs never race for the same person.
test('an admin approves a pending applicant', async ({ page }, testInfo) => {
  const applicant = testInfo.project.name.startsWith('phone') ? 'Casey Pending' : 'Riley Pending';
  await signInAs(page, 'admin');
  await page.goto('/admin/staff');
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();

  // Round 9: applicants are on the Pending tab; Approve is in their drawer.
  await page.getByRole('tab', { name: /^Pending/ }).click();
  await page.getByRole('button', { name: `Manage ${applicant}` }).click();
  const drawer = staffDrawer(page, applicant);
  await drawer.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(page.getByText(`${applicant} is approved.`)).toBeVisible();

  // MTR-12: the drawer says who approved, disabled and re-enabled them, and when. Approve and
  // re-enable take no reason; disable needs one, given inline.
  const history = drawer.getByRole('list', { name: 'Access history' });
  await expect(history.getByRole('listitem')).toHaveText([/^Approved by .+ on .+\d{4}$/]);
  await drawer.getByRole('button', { name: 'Disable access…' }).click();
  const confirm = drawer.getByRole('group', { name: `Disable ${applicant}'s access` });
  await confirm.getByRole('textbox', { name: 'Reason' }).fill('Example leave of absence');
  await confirm.getByRole('button', { name: 'Disable access', exact: true }).click();
  await drawer.getByRole('button', { name: 'Re-enable access' }).click();
  await expect(history.getByRole('listitem')).toHaveText([
    /^Approved by .+ on /,
    /^Disabled by .+ on .+: Example leave of absence$/,
    /^Re-enabled by .+ on .+\d{4}$/,
  ]);

  // The directory now lists them as active.
  await drawer.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(drawer).toHaveCount(0);
  await page.getByRole('tab', { name: /^People/ }).click();
  await searchStaff(page, applicant);
  await expect(page.getByRole('row').filter({ hasText: applicant })).toContainText('Active');
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

test('technicians cannot manage staff, in the UI or the API', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/settings/staff');
  // STRATA-100: Staff has no page for them; Settings opens on My access with a notice.
  await expect(page).toHaveURL(/\/settings\/access$/);
  await expect(page.getByText('Staff isn’t available to you.')).toBeVisible();
  const response = await page.request.get('/api/staff');
  expect(response.status()).toBe(403);
});

test('STRATA-118: a Lab Manager manages staff but not admins, the LAB account or feedback', async ({
  page,
}) => {
  await signInAs(page, 'lab'); // "Lab (test)": a Lab Manager
  await page.goto('/settings/staff');
  await expect(page).toHaveURL(/\/admin\/staff$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Staff' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add staff' })).toBeVisible();
  await expect(page.getByText('Shared receiving account (LAB)')).toHaveCount(0);
  expect((await page.request.get('/api/staff')).status()).toBe(200);
  expect((await page.request.get('/api/feedback')).status()).toBe(403);
  expect((await page.request.get('/api/admin/lab')).status()).toBe(403);
});
