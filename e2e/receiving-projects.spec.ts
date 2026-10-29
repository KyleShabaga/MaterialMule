import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-T08 T5: pick an existing project, add a new project, add a hole, and the rest of the
// receipt draft stays as entered. Projects are fictional; numbers are unique per run and viewport.

test('T5: pick a project, add a project and a hole, draft fields intact', async ({
  page,
}, testInfo) => {
  const projectNumber = `E2E-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;
  await signInAs(page, 'lab');
  await page.goto('/receiving-log/new');
  await expect(page.getByRole('heading', { name: 'Receive samples' })).toBeVisible();

  // Other draft fields, entered first.
  const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
  await receiver.fill('AT');
  await page.getByRole('option', { name: 'AT · Alex Tester (Tech)' }).click();
  await page.getByLabel('Description (optional)').fill('Four buckets from the drill crew');

  // Existing project by name.
  await page.getByRole('combobox', { name: /Find project/ }).fill('riverbank');
  await page
    .getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' })
    .click();
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');
  await expect(page.getByLabel('Lead Project Engineer')).toHaveValue('Pat Example');

  // Existing hole.
  const holes = page.getByRole('combobox', { name: 'Find or add a test hole' });
  await holes.fill('th26-0');
  await page.getByRole('option', { name: 'TH26-01', exact: true }).click();
  const chips = page.getByRole('list', { name: 'Selected test holes' });
  await expect(chips).toContainText('TH26-01');

  // A new project, added inline from the typed number.
  await page.getByRole('button', { name: 'Change project' }).click();
  await page.getByRole('combobox', { name: /Find project/ }).fill(projectNumber);
  await expect(page.getByRole('option', { name: 'No matching project' })).toBeVisible();
  await page.getByRole('button', { name: 'Add project' }).click();
  const form = page.getByRole('group', { name: 'Add project' });
  await expect(form.getByLabel('Project number')).toHaveValue(projectNumber);
  await form.getByLabel('Project name').fill('Example Ridge');
  await form.getByLabel('Client').fill('Example Client');
  await form.getByLabel('Lead Project Engineer').selectOption({ label: 'PE · Pat Example' });
  await form.getByRole('button', { name: 'Save project' }).click();
  await expect(page.getByLabel('Project number')).toHaveValue(projectNumber);
  await expect(page.getByLabel('Project name')).toHaveValue('Example Ridge');

  // A new hole in the new project.
  await holes.fill('TH26-03');
  await page.getByRole('option', { name: 'Add TH26-03' }).click();
  await expect(chips).toContainText('TH26-03');

  // AC7: nothing else in the draft was cleared.
  await expect(receiver).toHaveValue('AT · Alex Tester (Tech)');
  await expect(page.getByLabel('Description (optional)')).toHaveValue(
    'Four buckets from the drill crew',
  );

  // The new project is searchable straight away.
  await page.getByRole('button', { name: 'Change project' }).click();
  await page.getByRole('combobox', { name: /Find project/ }).fill(projectNumber.toLowerCase());
  await expect(
    page.getByRole('option', { name: `${projectNumber} · Example Ridge · Example Client` }),
  ).toBeVisible();
});
