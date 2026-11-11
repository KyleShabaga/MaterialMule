import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { receiveThroughApi } from './support/receiving';

// Today (Field Ledger; replaces the dashboard at /) and the top-bar search, at desktop and phone
// width. Fictional data only.

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

function isPhone(page: Page): boolean {
  return (page.viewportSize()?.width ?? 1280) <= 640;
}

test('Today shows the queue, the ledger and the storage room, and fits the screen', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await receiveThroughApi(page);

  await page.goto('/');
  await expect(page).toHaveTitle('Today · Material Mule');
  await expect(page.getByRole('heading', { level: 2, name: 'Needs you' })).toBeVisible();
  // Something was received just now, so the 24-hour ledger has rows (dashboard-activity.spec.ts
  // checks the order).
  await expect(
    page.getByRole('region', { name: 'Ledger' }).getByRole('listitem').first(),
  ).toBeVisible();

  if (isPhone(page)) {
    await expect(page.getByRole('heading', { level: 1, name: 'Today' })).toBeVisible();
    await expect(page.getByRole('link', { name: /Scan a label/ })).toHaveAttribute(
      'href',
      '/sample-storage/scan',
    );
  } else {
    // The ink greeting block greets the person by first name and counts what needs them.
    await expect(page.getByRole('heading', { level: 1 })).toHaveText(
      /^Good (morning|afternoon|evening), Alex\. .+ (needs|need) you today\.$/,
    );
    await expect(page.getByRole('link', { name: 'Receive samples' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    const room = page.getByRole('region', { name: 'Storage room' });
    await expect(
      room.getByRole('img', { name: /Receiving lab: \d+ storage units?/ }),
    ).toBeVisible();
  }
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});

test('a search for exactly one unit ID opens the unit; anything else lists results', async ({
  page,
}) => {
  await signInAs(page, 'at');
  const [unit] = await receiveThroughApi(page);
  const id = unit!.suNumber;

  await page.goto('/search');
  const box = page.getByRole('search', { name: 'Search' }).getByRole('textbox', { name: 'Search' });
  await box.fill(id.toLowerCase());
  await box.press('Enter');
  await expect(page).toHaveURL(new RegExp(`/sample-storage/${id}$`));
  await expect(page.getByRole('heading', { level: 1, name: id })).toBeVisible();

  await page.goto('/search?q=TH26-01');
  await expect(page.getByRole('heading', { level: 1, name: /^\d+ results?$/ })).toBeVisible();
  await expect(page).toHaveTitle('Search · Material Mule');
  const holes = page.getByRole('region', { name: 'Test holes' });
  await expect(holes.getByRole('link', { name: /^TH26-01 Test hole on DEMO-2601/ })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Storage units' })).toBeVisible();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
