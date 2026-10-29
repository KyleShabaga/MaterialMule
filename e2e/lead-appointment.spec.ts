import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-AO04: a project added while receiving waits for its Lead Project Engineer; an admin finds it
// with "Waiting for a lead" and confirms the nomination with a reason. Fictional data only; the
// project number is unique per run and viewport.

const CSRF = { 'x-materialmule-csrf': '1' };

test('a nominated lead waits for an admin, who confirms with a reason', async ({
  page,
}, testInfo) => {
  const projectNumber = `AO4-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;

  // Alex adds the project and nominates Pat; that makes nobody the lead.
  await signInAs(page, 'at');
  const staff = (await (await page.request.get('/api/staff/active')).json()) as {
    id: string;
    displayName: string;
  }[];
  const pat = staff.find((s) => s.displayName === 'Pat Example')!;
  const created = await page.request.post('/api/projects', {
    headers: CSRF,
    data: {
      projectNumber,
      name: 'Example Ridge',
      client: 'Example Client',
      leadNomineeUserId: pat.id,
      nominationNote: 'Pat ran phase 1',
    },
  });
  expect(created.status()).toBe(201);
  const projectId = ((await created.json()) as { id: string }).id;

  await page.goto(`/projects/${projectId}`);
  const section = page.getByRole('region', { name: 'Lead Project Engineer' });
  await expect(section).toContainText('This project has no Lead Project Engineer yet.');
  await expect(section).toContainText('Pat Example was nominated by');
  await expect(section).toContainText('Note: Pat ran phase 1');
  // Only an admin decides.
  await expect(section.getByRole('button', { name: 'Confirm' })).toHaveCount(0);

  // The admin finds it under "Waiting for a lead" and confirms.
  await signInAs(page, 'admin');
  await page.goto(`/projects?waitingForLead=true&search=${projectNumber}`);
  await expect(page.getByRole('checkbox', { name: 'Waiting for a lead' })).toBeChecked();
  await page.getByRole('link', { name: `Open project ${projectNumber}` }).click();
  const adminSection = page.getByRole('region', { name: 'Lead Project Engineer' });
  await adminSection.getByRole('button', { name: 'Confirm' }).click();
  const dialog = page.getByRole('dialog', { name: 'Confirm as Lead Project Engineer?' });
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog).toContainText('Enter a reason.');
  await dialog
    .getByRole('textbox', { name: 'Reason' })
    .fill('Checked with the engineering manager');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'is now the Lead Project Engineer' }),
  ).toBeVisible();
  await expect(adminSection).toContainText('Pat Example leads this project.');
  await adminSection.getByText(/Nomination history/).click();
  await expect(adminSection).toContainText('Confirmed by');
  await expect(adminSection).toContainText('(Checked with the engineering manager)');
});
