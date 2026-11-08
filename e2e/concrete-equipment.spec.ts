import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-V2-C27 T3: Settings → Equipment against the real API. Fictional people (Lab (test) is the
// fixtures' Lab Manager, Alex Tester a technician) and invented equipment IDs. The register is
// server-wide and holds one testing machine, so only the desktop run changes it; the phone run
// checks the screen read-only, and the two never race for the same machine.

test('T3: the Lab Manager registers the testing machine, records calibrations and an air meter', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'changes the server-wide register');
  await signInAs(page, 'lab');
  await page.goto('/settings/equipment');
  await expect(
    page.getByRole('navigation', { name: 'Settings' }).getByRole('link', { name: 'Equipment' }),
  ).toBeVisible();

  const machine = page.getByRole('region', { name: 'Testing machine' });
  await expect(machine.getByText('No testing machine is registered.')).toBeVisible();
  const register = machine.getByRole('form', { name: 'Register the testing machine' });
  await register.getByLabel('Make').fill('Example Instruments');
  await register.getByLabel('Model').fill('Compression 3000');
  await register.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Testing machine registered.')).toBeVisible();
  await expect(machine.getByText('Compression 3000', { exact: true })).toBeVisible();
  await expect(machine.getByText('No calibration recorded for this date')).toBeVisible();

  // AC1: an old calibration whose next-due date has passed flags use, and still saves.
  const calibrate = machine.getByRole('form', { name: 'Record a calibration' });
  await calibrate.getByLabel(/Calibration date/).fill('2024-01-10');
  await calibrate.getByLabel(/Next calibration due/).fill('2025-01-10');
  await calibrate.getByLabel(/Performed by/).fill('Example Calibration Co.');
  await calibrate.getByRole('button', { name: 'Record calibration' }).click();
  await expect(page.getByText('Calibration recorded. Earlier entries stay in the history.')).toBeVisible();
  await expect(machine.getByText('Calibration overdue')).toBeVisible();

  // AC2: a newer calibration keeps the earlier entry in the history.
  await calibrate.getByLabel(/Calibration date/).fill('2026-11-01');
  await calibrate.getByLabel(/Next calibration due/).fill('2099-11-01');
  await calibrate.getByLabel(/Performed by/).fill('Example Calibration Co.');
  await calibrate.getByLabel('Result').fill('Within tolerance');
  await calibrate.getByRole('button', { name: 'Record calibration' }).click();
  const history = machine.getByRole('table', { name: 'Calibration history' });
  await expect(history.getByRole('row')).toHaveCount(3);
  await expect(history.getByText('2025-01-10')).toBeVisible();
  await expect(history.getByText('2099-11-01')).toBeVisible();
  await expect(machine.getByText('No flags')).toBeVisible();

  // Edit the details: version-checked and audited.
  await machine.getByRole('button', { name: 'Edit details' }).click();
  const edit = machine.getByRole('form', { name: 'Edit equipment' });
  await edit.getByLabel('Model').fill('Compression 3000X');
  await edit.getByLabel('Reason for the change').fill('Nameplate');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(machine.getByText('Compression 3000X', { exact: true })).toBeVisible();

  // An air meter, registered and opened.
  const meters = page.getByRole('region', { name: 'Air meters' });
  const meterId = `AM-E2E-${Date.now()}`;
  await meters.getByRole('button', { name: 'Register an air meter' }).click();
  const meterForm = meters.getByRole('form', { name: 'Register an air meter' });
  await meterForm.getByLabel(/Air meter ID/).fill(meterId);
  await meterForm.getByLabel('Description').fill('Type B pressure meter');
  await meterForm.getByRole('button', { name: 'Register' }).click();
  await expect(page.getByText('Air meter registered.')).toBeVisible();
  await expect(
    meters.getByRole('table', { name: 'Air meters' }).getByText(meterId, { exact: true }),
  ).toBeVisible();
  await expect(meters.getByRole('region', { name: 'Air meter details' })).toBeVisible();
});

test('T3/AC3: anyone else sees the register read-only, and the server refuses their edits', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await page.goto('/settings/equipment');
  const machine = page.getByRole('region', { name: 'Testing machine' });
  await expect(machine.getByRole('heading', { name: 'Testing machine' })).toBeVisible();
  await expect(machine.getByText('Only Lab Managers can change equipment.')).toBeVisible();
  await expect(machine.getByRole('button', { name: 'Edit details' })).toHaveCount(0);
  await expect(machine.getByRole('form', { name: 'Record a calibration' })).toHaveCount(0);

  const response = await page.request.post('/api/concrete/testing-machine', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { kind: 'testing_machine', idempotencyKey: crypto.randomUUID() },
  });
  expect(response.status()).toBe(403);
});
