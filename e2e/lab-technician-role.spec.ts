import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { uniqueTag } from './support/receiving';

// MM-V2-C36: an admin assigns and removes the Lab Technician role on the Accounts screen through
// the existing role flow (reason, audit). Each run adds its own fictional person, so desktop and
// phone never race for the same account.
test('an admin assigns and removes the Lab Technician role', async ({ page }) => {
  await signInAs(page, 'admin');
  const tag = uniqueTag('Bench');
  const name = `Morgan ${tag}`;
  const created = await page.request.post('/api/staff', {
    headers: { 'x-materialmule-csrf': '1' },
    data: {
      displayName: name,
      officialInitials: 'MB',
      expectedUpn: `${tag.toLowerCase()}@example.test`,
    },
  });
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };
  const rolesOf = async () => {
    const list = await page.request.get(`/api/staff?search=${encodeURIComponent(tag)}`);
    const members = (await list.json()) as { id: string; roles: string[] }[];
    return members.find((m) => m.id === id)?.roles;
  };

  await page.goto('/admin/staff');
  const search = page.getByRole('searchbox', { name: 'Search staff' });
  await page
    .getByRole('toolbar', { name: 'Staff tools' })
    .getByRole('button', { name: 'Search', exact: true })
    .click();
  await search.fill(name);
  await page.getByRole('button', { name: `Manage ${name}` }).click();
  // STRATA-102: beside the table from 1024 px, a sheet on phones.
  const drawer = page
    .getByRole('region', { name, exact: true })
    .or(page.getByRole('dialog', { name, exact: true }));
  const roles = drawer.getByRole('group', { name: 'Roles' });
  const labTechnician = roles.getByRole('checkbox', { name: 'Lab Technician' });
  await expect(labTechnician).not.toBeChecked();

  // Round 9: the reason is given inline, beside Save roles.
  await labTechnician.check();
  await roles.getByRole('textbox', { name: 'Reason' }).fill('Fictional lab staff onboarding');
  await roles.getByRole('button', { name: 'Save roles' }).click();
  await expect(page.getByText(`Roles updated for ${name}.`)).toBeVisible();
  await expect(labTechnician).toBeChecked();

  // The server holds it (the staff.roles_changed audit records who and why).
  await expect.poll(rolesOf).toEqual(['lab_technician']);

  await labTechnician.uncheck();
  await roles.getByRole('textbox', { name: 'Reason' }).fill('Fictional role change');
  await roles.getByRole('button', { name: 'Save roles' }).click();
  await expect.poll(rolesOf).toEqual([]);
});

test('the seeded Lab Technician sees the role and the lab-staff permissions in /api/me', async ({
  page,
}) => {
  await signInAs(page, 'lt');
  const me = (await (await page.request.get('/api/me')).json()) as {
    roles: string[];
    permissions: string[];
  };
  expect(me.roles).toEqual(['lab_technician']);
  for (const permission of [
    'concrete_specimen.receive',
    'concrete_specimen.mass_correct',
    'concrete_test.enter',
    'concrete_specimen.dispose_record',
    'concrete_settings.air_meter.manage',
  ]) {
    expect(me.permissions).toContain(permission);
  }
  for (const permission of [
    'staff.manage',
    'test_catalog.manage',
    'concrete_settings.testing_machine.manage',
    'concrete_sync_conflict.resolve_lab',
  ]) {
    expect(me.permissions).not.toContain(permission);
  }
  // An ordinary technician holds none of the lab-staff actions.
  await signInAs(page, 'at');
  const at = (await (await page.request.get('/api/me')).json()) as { permissions: string[] };
  expect(at.permissions).not.toContain('concrete_specimen.receive');
  expect(at.permissions).not.toContain('concrete_settings.air_meter.manage');
});
