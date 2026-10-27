import { expect, test, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { insertInventoryFixture } from './support/inventory';
import { signInAsLabStation } from './support/lab-station';

// MM-T16: DS3678-XR handheld scanning. The scanner is a USB keyboard that types the symbol's
// data (exactly PREFIX-YYYY-NNNNNN for both Code 128 and QR, T14) followed by Enter, so each scan
// here is the same keystrokes from Playwright's keyboard into whatever has focus. Fictional data.

/** One simulated trigger pull: the payload, then the scanner's Enter suffix. */
async function scan(page: Page, payload: string) {
  await page.keyboard.type(payload);
  await page.keyboard.press('Enter');
}

/** Every API call the page makes; scanning must only ever read. */
function recordApiCalls(page: Page) {
  const calls: { method: string; path: string; code: string | null }[] = [];
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (url.pathname.startsWith('/api/')) {
      calls.push({
        method: request.method(),
        path: url.pathname,
        code: url.searchParams.get('code'),
      });
    }
  });
  return {
    lookups: () => calls.filter((c) => c.path === '/api/storage-units/lookup').map((c) => c.code),
    writes: () => calls.filter((c) => c.method !== 'GET'),
  };
}

async function unitState(readableIds: string[]) {
  return withDatabase(async (client) => {
    const { rows } = await client.query(
      `SELECT readable_id, status, current_location_id, version FROM storage_unit
       WHERE readable_id = ANY($1) ORDER BY readable_id`,
      [readableIds],
    );
    return rows;
  });
}

test('T2/AC1/AC4: a simulated scan opens the unit; the same label within 2 s is ignored', async ({
  page,
}) => {
  const data = await insertInventoryFixture();
  const before = await unitState([data.a1, data.b1]);
  await signInAs(page, 'at');
  await page.goto('/sample-storage');
  await page.getByRole('link', { name: 'Scan labels' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Scan labels' })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Scan a storage unit label' });
  await expect(field).toBeFocused();
  await expect(page.getByText('Ready to scan', { exact: true }).first()).toBeVisible();
  const api = recordApiCalls(page);

  // No click first: the scan field already has focus, as it would for the handheld.
  await scan(page, data.a1);
  const status = page.getByRole('status').filter({ hasText: data.a1 });
  await expect(status).toHaveText(`Success: Found ${data.a1}`);
  const card = page.getByRole('region', { name: data.a1 });
  await expect(card).toContainText(data.projectA);
  await expect(card).toContainText(data.warehouse);
  await expect(field).toBeFocused();
  await expect(field).toHaveValue('');

  // AC4: the same label again at once (e.g. its QR after its Code 128): one lookup only.
  await scan(page, data.a1);
  await expect(page.getByText('Already scanned')).toBeVisible();
  expect(api.lookups()).toEqual([data.a1]);

  // The next label replaces the first, read as typed and normalised by the server.
  await scan(page, ` ${data.b1.toLowerCase()} `);
  await expect(page.getByRole('region', { name: data.b1 })).toBeVisible();
  await expect(page.getByRole('region', { name: data.a1 })).toHaveCount(0);

  await page.getByRole('link', { name: 'Open full record' }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.b1 })).toBeVisible();

  // Scanning never moves or changes anything.
  expect(api.writes()).toEqual([]);
  expect(await unitState([data.a1, data.b1])).toEqual(before);
});

// MM-T49: the receiving station looks units up by scan while signed in as a real LAB station
// session (the E2E-only shared_lab account, as e2e/critical does; never the shared LAB password).
test('T2/AC1: a LAB station scans a label and sees the unit, read-only', async ({ page }) => {
  const data = await insertInventoryFixture();
  const before = await unitState([data.a1, data.aReceiving]);
  await signInAsLabStation(page);
  await page.goto('/sample-storage');
  await page.getByRole('link', { name: 'Scan labels' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Scan labels' })).toBeVisible();
  const field = page.getByRole('textbox', { name: 'Scan a storage unit label' });
  await expect(field).toBeFocused();
  const api = recordApiCalls(page);

  await scan(page, data.a1);
  await expect(page.getByRole('status').filter({ hasText: data.a1 })).toHaveText(
    `Success: Found ${data.a1}`,
  );
  const card = page.getByRole('region', { name: data.a1 });
  await expect(card).toContainText(data.projectA);
  await expect(card).toContainText(data.warehouse);
  await expect(field).toBeFocused();

  // A unit still at the Receiving lab, as a station would scan right after labelling.
  await scan(page, data.aReceiving);
  await expect(page.getByRole('region', { name: data.aReceiving })).toContainText('Receiving lab');
  expect(api.lookups()).toEqual([data.a1, data.aReceiving]);

  await page.getByRole('link', { name: 'Open full record' }).click();
  await expect(page.getByRole('heading', { level: 1, name: data.aReceiving })).toBeVisible();
  expect(api.writes()).toEqual([]);
  expect(await unitState([data.a1, data.aReceiving])).toEqual(before);
});

test('T3/AC3/AC5/AC7: unknown code, server down with Retry, lost focus', async ({ page }) => {
  const data = await insertInventoryFixture();
  const before = await unitState([data.a1]);
  await signInAs(page, 'at');
  await page.goto('/sample-storage/scan');
  const field = page.getByRole('textbox', { name: 'Scan a storage unit label' });
  await expect(field).toBeFocused();
  const api = recordApiCalls(page);

  // AC3: unknown and malformed codes.
  await scan(page, 'BKT-1999-000001');
  await expect(page.getByText('No storage unit found for BKT-1999-000001')).toBeVisible();
  await scan(page, 'SU-2026-000001');
  await expect(page.getByText('No storage unit found for SU-2026-000001')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Open full record' })).toHaveCount(0);

  // AC5: the server can't be reached. The value stays on screen with Retry.
  await page.route('**/api/storage-units/lookup**', (route) => route.abort('connectionrefused'));
  await scan(page, data.a1);
  await expect(page.getByRole('status').filter({ hasText: data.a1 })).toContainText(
    "couldn't be reached",
  );
  await expect(page.locator('.scan-last')).toContainText(data.a1);
  await page.unroute('**/api/storage-units/lookup**');
  await page.getByRole('button', { name: 'Retry' }).click();
  await expect(page.getByRole('region', { name: data.a1 })).toBeVisible();
  await expect(field).toBeFocused();

  // AC7: focus leaves the scan field. An obvious prompt appears and a scan types nowhere.
  await page.getByRole('heading', { level: 1, name: 'Scan labels' }).click();
  const resume = page.getByRole('button', { name: /Click here to resume scanning/ });
  await expect(resume).toBeVisible();
  const lookupsBefore = api.lookups().length;
  await scan(page, data.b1);
  expect(api.lookups()).toHaveLength(lookupsBefore);
  const typedSomewhere = await page.evaluate(
    (payload) =>
      [...document.querySelectorAll('input, textarea')].some((element) =>
        (element as HTMLInputElement).value.includes(payload),
      ),
    data.b1,
  );
  expect(typedSomewhere).toBe(false);
  await resume.click();
  await expect(field).toBeFocused();
  await expect(resume).toHaveCount(0);
  await scan(page, data.b1);
  await expect(page.getByRole('region', { name: data.b1 })).toBeVisible();

  expect(api.writes()).toEqual([]);
  expect(await unitState([data.a1])).toEqual(before);
});

// Receiving helpers (as in receiving-wizard.spec.ts).
const bucket = (page: Page, n: number) => page.getByRole('region', { name: `Bucket ${n}` });

async function addRange(unit: Locator, from: string, to: string) {
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill('TH26-01');
  await unit.getByRole('option', { name: 'TH26-01', exact: true }).click();
  const group = unit.getByRole('group', { name: 'TH26-01 summary' });
  await group.getByLabel('Summary type').selectOption('sample_range');
  await group.getByLabel('Sample from').fill(from);
  await group.getByLabel('Sample to').fill(to);
}

test('T4/AC6: Verify labels marks matches and warns about a third unit’s label', async ({
  page,
}) => {
  const other = await insertInventoryFixture();
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  await page.getByRole('combobox', { name: /Find project/ }).fill('DEMO-2601');
  await page
    .getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' })
    .click();
  await addRange(bucket(page, 1), 'G1', 'S12');
  await page.getByRole('button', { name: 'Add bucket' }).click();
  await addRange(bucket(page, 2), 'G13', 'S32');
  await page.getByRole('button', { name: 'Next: Review' }).click();
  await page.getByRole('button', { name: 'Confirm receipt' }).click();
  const list = page.getByRole('list', { name: 'New storage units' });
  await expect(list).toBeVisible();
  const ids = await list.getByRole('heading').allTextContents();
  expect(ids).toHaveLength(2);
  const api = recordApiCalls(page);

  await page.getByRole('button', { name: 'Verify labels' }).click();
  const panel = page.getByRole('region', { name: 'Verify labels' });
  await expect(panel.getByRole('textbox', { name: 'Scan a printed label' })).toBeFocused();
  await expect(panel.getByText('0 of 2 labels verified')).toBeVisible();

  await scan(page, ids[0]!);
  await expect(panel.getByText(`Label matches ${ids[0]}`)).toBeVisible();
  await expect(panel.getByText('1 of 2 labels verified')).toBeVisible();

  // A third unit's label: wrong-label warning naming what's still expected.
  await scan(page, other.a1);
  await expect(panel.getByRole('status')).toHaveText(
    `Check: Wrong label: scanned ${other.a1} expected one of ${ids[1]}`,
  );
  await expect(panel.getByText('1 of 2 labels verified')).toBeVisible();

  await scan(page, ids[1]!);
  await expect(panel.getByText(`Label matches ${ids[1]}`)).toBeVisible();
  await expect(panel.getByText('2 of 2 labels verified')).toBeVisible();
  const expected = panel.getByRole('list', { name: 'Expected labels' });
  await expect(expected.getByRole('listitem').filter({ hasText: 'Verified' })).toHaveCount(2);

  expect(api.writes()).toEqual([]);
});
