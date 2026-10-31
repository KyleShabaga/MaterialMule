import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { receiveThroughApi } from './support/receiving';

// The approved dashboard (2026-10-27) at desktop and phone width. Fictional data only.

const today = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('shows a unit just received, opens it by ID, and fits the screen', async ({
  page,
}, testInfo) => {
  await signInAs(page, 'at');
  const [unit] = await receiveThroughApi(page, { receivedDate: today });
  const id = unit!.suNumber;

  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  const receive = page.getByRole('region', { name: 'Receive samples' });
  await expect(receive.getByRole('link', { name: 'Receive samples' })).toBeVisible();

  // Today's units come first (newest received date), so this one is on the list.
  const recent = page.getByRole('region', { name: 'Recently received' });
  await recent.getByRole('button', { name: 'Today' }).click();
  const table = recent.getByRole('table', { name: 'Recently received storage units' });
  const row = table.locator('tbody tr').filter({ hasText: id });
  await expect(row).toBeVisible();
  for (const text of ['DEMO-2601', 'TH26-01: ALL', 'Receiving lab', 'by AT']) {
    await expect(row).toContainText(text);
  }
  await expect(page.getByRole('region', { name: 'Recent activity' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Drafts on this computer' })).toBeVisible();
  // Not an admin: no label printer card.
  await expect(page.getByRole('region', { name: 'Label printer' })).toHaveCount(0);

  if (testInfo.project.name === 'phone-chromium') {
    // The table stacks into labelled cards.
    await expect(table.locator('thead')).toBeHidden();
    await expect(row).toHaveCSS('display', 'block');
  } else {
    await expect(table.locator('thead')).toBeVisible();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  const lookUp = page.getByRole('search', { name: 'Look up a storage unit' });
  await lookUp.getByLabel('Storage unit ID').fill(id.toLowerCase());
  await lookUp.getByRole('button', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();
});

test('admins see the label printer card from system status', async ({ page }) => {
  await signInAs(page, 'admin');
  await page.goto('/');
  const printer = page.getByRole('region', { name: 'Label printer' });
  await expect(printer).toContainText('Waiting to print');
  await expect(printer).toContainText('Not sure if printed');
  await expect(printer.getByText(/^Print queue (running|stopped)$/)).toBeVisible();
  // MTR-45: a line for the default printer (the fake printer). Other specs print in parallel and
  // one drops a job on purpose, so only the shape is fixed here; the states are unit tested.
  await expect(
    printer.getByText(
      /^(Printer OK|Printer not responding|Check the printer|Not used yet|Printer off|No default printer)$/,
    ),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await printer.getByRole('link', { name: 'Print queue in System status' }).click();
  await expect(page).toHaveURL(/\/settings\/system-status$/);
  await expect(page.getByRole('region', { name: 'Print queue' })).toBeVisible();
});
