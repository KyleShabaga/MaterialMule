import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { receiveThroughApi } from './support/receiving';

// Today (Strata, the page at /) and search through the Ctrl K menu, at desktop and phone width.
// Fictional data only.

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('Today shows the welcome, shortcuts, Needs you and the last 24 hours, and fits the screen', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await receiveThroughApi(page);

  await page.goto('/');
  await expect(page).toHaveTitle('Today · Material Mule');
  // DESIGN.md "Today with an own account": the welcome greets the person by first name, and one
  // line says how many things need them.
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(
    /^Good (morning|afternoon|evening), Alex$/,
  );
  await expect(
    page.getByText(/^(Nothing needs you right now\.|\d+ things? needs? you\..*)$/),
  ).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open Inbox' })).toHaveAttribute('href', '/inbox');
  // Alex has no lab role and leads no project: the technician's shortcuts.
  const shortcuts = page.getByRole('navigation', { name: 'Shortcuts' });
  await expect(shortcuts.getByRole('link', { name: 'Receive', exact: true })).toHaveAttribute(
    'href',
    '/receiving-log/new',
  );
  await expect(shortcuts.getByRole('link', { name: 'Move storage units' })).toHaveAttribute(
    'href',
    '/sample-storage/move',
  );
  // Something was received just now, so the last 24 hours have rows (dashboard-activity.spec.ts
  // checks the order).
  await expect(
    page.getByRole('region', { name: 'Last 24 hours' }).getByRole('listitem').first(),
  ).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('a search for exactly one unit ID opens the unit; anything else lists results', async ({
  page,
}) => {
  await signInAs(page, 'at');
  const [unit] = await receiveThroughApi(page);
  const id = unit!.suNumber;

  // Strata (STRATA-14): search is the Ctrl K command menu; Enter on an exact ID opens the unit.
  await page.goto('/search');
  // The shell is up (its shortcuts listen from then on).
  await expect(page.getByRole('banner')).toBeVisible();
  await page.keyboard.press('Control+k');
  const box = page
    .getByRole('dialog', { name: 'Search or scan' })
    .getByRole('combobox', { name: 'Search or scan a label' });
  await expect(box).toBeFocused();
  await box.fill(id.toLowerCase());
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();

  await page.goto('/search?q=TH26-01');
  await expect(
    page.getByRole('heading', { level: 1, name: 'Results for “TH26-01”' }),
  ).toBeVisible();
  await expect(page).toHaveTitle('Search · Material Mule');
  const holes = page.getByRole('region', { name: 'Test holes' });
  await expect(holes.getByRole('link', { name: /^TH26-01 Test hole on DEMO-2601/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Storage units' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
