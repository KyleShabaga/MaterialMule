import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { signInAsLabStation } from './support/lab-station';

// MM-AO06: an admin gives a person "Can create and lead projects" and a firm job title from the
// Staff drawer, each with a reason; the person sees both on My access; an admin revokes the
// capability meanwhile and Refresh shows it gone. The shared LAB account has no My access.
// Fictional fixtures only; desktop uses Jordan Smith and phone Jamie Song, so the two runs never
// touch the same person's grants.

const CSRF = { 'x-materialmule-csrf': '1' };
const PEOPLE = {
  desktop: { key: 'js-tech', id: '00000000-0000-4000-8000-000000000106', name: 'Jordan Smith' },
  phone: { key: 'js-eng', id: '00000000-0000-4000-8000-000000000107', name: 'Jamie Song' },
} as const;

test('capabilities and job titles are administered with reasons and shown on My access', async ({
  page,
}, testInfo) => {
  const person = testInfo.project.name.startsWith('phone') ? PEOPLE.phone : PEOPLE.desktop;

  await signInAs(page, 'admin');
  await page.goto('/settings/staff');
  await page.getByRole('button', { name: `Manage ${person.name}` }).click();
  const drawer = page.getByRole('dialog', { name: person.name });

  // A firm job title, with a reason.
  const title = drawer.getByRole('form', { name: 'Job title' });
  await title.getByLabel('Firm job title').fill('Senior Technician');
  await title.getByLabel('Reason').fill('Title per firm records');
  await title.getByRole('button', { name: 'Save job title' }).click();
  await expect(
    page.getByText(`Job title for ${person.name} set to Senior Technician.`),
  ).toBeVisible();

  // "Can create and lead projects", with a reason.
  const grants = drawer.getByRole('group', { name: 'Eligibility and capabilities' });
  const capability = grants.getByRole('form', { name: 'Grant capability' });
  await capability.getByLabel('Capability').selectOption('project.create_and_lead');
  await capability.getByLabel('Reason').fill('Leads small jobs');
  await capability.getByRole('button', { name: 'Grant capability' }).click();
  await expect(grants.getByRole('list', { name: 'Current grants' })).toContainText(
    'Can create and lead projects',
  );

  // The person sees it, and that the title grants nothing.
  await signInAs(page, person.key);
  await page.goto('/settings/profile');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'My access' })
    .click();
  await expect(page.getByRole('heading', { name: 'My access' })).toBeVisible();
  await expect(page.getByRole('list', { name: 'Held everywhere' })).toContainText(
    'Can create and lead projects',
  );
  await expect(page.getByText('Senior Technician (Set by an administrator)')).toBeVisible();

  // Revoked meanwhile (through the API, as another admin would).
  await signInAs(page, 'admin');
  const admin = page.request;
  const current = (await (await admin.get(`/api/staff/${person.id}/grants`)).json()) as {
    capabilities: { active: { id: string }[] };
  };
  for (const grant of current.capabilities.active) {
    const revoked = await admin.delete(`/api/staff/${person.id}/capabilities/${grant.id}`, {
      headers: CSRF,
      data: { reason: 'Back to supporting' },
    });
    expect(revoked.status()).toBe(200);
  }
  // Leave the title as Microsoft's for later runs.
  expect(
    (
      await admin.put(`/api/staff/${person.id}/job-title-override`, {
        headers: CSRF,
        data: { jobTitleOverride: null, reason: 'Test clean-up' },
      })
    ).status(),
  ).toBe(200);

  await signInAs(page, person.key);
  await page.goto('/settings/access');
  await expect(page.getByText('No reviewer eligibility or capabilities.')).toBeVisible();
  await expect(page.getByText(/Set by an administrator/)).toHaveCount(0);
});

test('the shared LAB account has no My access', async ({ page }) => {
  await signInAsLabStation(page);
  await page.goto('/settings/profile');
  await expect(
    page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'My access' }),
  ).toHaveCount(0);
  await page.goto('/settings/access');
  await expect(page.getByText(/The shared LAB account has no personal access/)).toBeVisible();
});
