import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { uniqueTag } from './support/receiving';

// Help & Feedback (Field Ledger): guides link to real screens, and feedback stays on the host:
// a person sends it, an administrator reads it on the same page. Fictional text only.

test('feedback is sent on the host and an administrator reads it on Help', async ({ page }) => {
  const text = `The label preview was hard to read ${uniqueTag('help')}`;

  const technician = page;
  await signInAs(technician, 'at');
  await technician.goto('/help');
  await expect(technician).toHaveTitle('Help & Feedback · Material Mule');
  await expect(technician.getByRole('heading', { level: 2, name: 'How do I…' })).toBeVisible();
  await technician.getByLabel('What kind').selectOption({ label: 'Something is confusing' });
  await technician.getByLabel('What happened').fill(text);
  await technician.getByRole('button', { name: 'Send to the administrator' }).click();
  await expect(
    technician.getByText('Sent. An administrator will read it here in the office.'),
  ).toBeVisible();
  // Only administrators see what was sent.
  await expect(technician.getByRole('region', { name: 'Feedback received' })).toHaveCount(0);

  const admin = page;
  await signInAs(admin, 'admin');
  await admin.goto('/help');
  const received = admin.getByRole('region', { name: 'Feedback received' });
  await expect(received.getByText(text)).toBeVisible();
});

// STRATA-67 / round 10: the sign-in layout links to Help. (Reading /help signed out is a route
// change for the Help card; this only checks the link from sign-in.)
test('the sign-in page links to Help', async ({ page }) => {
  await page.goto('/sign-in');
  await expect(page.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Help', exact: true })).toHaveAttribute(
    'href',
    '/help',
  );
});
