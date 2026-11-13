import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-T21: Settings → System status. The E2E server has no BACKUP_STATUS_FILE, as a host has until
// IT decides the backup design (D39), so the page says backups are not set up.
test('an admin sees system status; other staff do not', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto('/settings');
  await page.getByRole('link', { name: 'System status' }).click();
  await expect(page).toHaveURL(/\/settings\/system-status$/);

  const service = page.getByRole('region', { name: 'Service' });
  await expect(service).toContainText('Connected');
  const backups = page.getByRole('region', { name: /Backups/ });
  await expect(backups).toContainText('Not set up');
  await expect(page.getByRole('region', { name: 'Print queue' })).toContainText('Waiting to print');
  await expect(page.getByRole('region', { name: 'Disk space' })).toContainText(
    'Material Mule host',
  );

  await signInAs(page, 'at');
  await page.goto('/settings/system-status');
  // STRATA-100: a hidden section has no page; Settings opens on My access with a notice.
  await expect(page).toHaveURL(/\/settings\/access$/);
  await expect(page.getByText('System status isn’t available to you.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'System status' })).toHaveCount(0);
});
