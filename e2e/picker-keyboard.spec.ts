import { expect, test } from '@playwright/test';
import { signInAsLabStation } from './support/lab-station';
import { bucket, openWizard } from './support/receiving';

// MM-T62 T2: the Receive samples pickers by keyboard alone, at a LAB station. Typing then Enter
// picks the first (highlighted) match in each picker. Fictional data only: DEMO-2601, TH26-01, AT.

test('T2: receiver, project and test hole are chosen with Enter alone', async ({ page }) => {
  await signInAsLabStation(page);
  await openWizard(page);

  const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
  await receiver.fill('AT');
  const firstReceiver = page.getByRole('option', { name: /^AT · Alex Tester/ });
  await expect(firstReceiver).toHaveAttribute('aria-selected', 'true');
  await receiver.press('Enter');
  await expect(receiver).toHaveValue(/^AT · Alex Tester/);

  const project = page.getByRole('combobox', { name: /Find project/ });
  await project.fill('DEMO-2601');
  await expect(
    page.getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' }),
  ).toHaveAttribute('aria-selected', 'true');
  await project.press('Enter');
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');

  const unit = bucket(page, 1);
  const hole = unit.getByRole('combobox', { name: 'Find or add a test hole' });
  await hole.fill('TH26-01');
  await expect(unit.getByRole('option', { name: 'TH26-01', exact: true })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await hole.press('Enter');
  await expect(unit.getByRole('list', { name: 'Selected test holes' })).toContainText('TH26-01');
  await expect(unit.getByRole('group', { name: 'TH26-01 summary' })).toBeVisible();
});
