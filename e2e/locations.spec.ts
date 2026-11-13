import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T37 on Lab admin › Locations (STRATA-102/128): T7 (add, rename, print, retire), the blocked
// retirement, and T9 (two independent LAB stations, no borrowed administration rights). The
// drawer for one location sits beside the list from 1024 px and is a Sheet (dialog) on phones.
// Codes are random so the desktop and phone projects never collide. Fictional data only.

function uniqueCode(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function openLocations(page: Page) {
  await page.goto('/admin/locations');
  await expect(page.getByRole('heading', { name: 'Locations', level: 1 })).toBeVisible();
  await expect(page.getByRole('table', { name: 'Locations' })).toBeVisible();
}

function row(page: Page, text: string) {
  return page.getByRole('table', { name: 'Locations' }).locator('tbody tr', { hasText: text });
}

/** The location drawer: a region beside the list (desktop) or a Sheet dialog (phone). */
function drawer(page: Page, name: string) {
  return page.getByRole('region', { name }).or(page.getByRole('dialog', { name }));
}

async function openDrawer(page: Page, code: string, name: string) {
  await row(page, code).getByRole('button', { name }).click();
  const found = drawer(page, name);
  await expect(found).toBeVisible();
  return found;
}

async function search(page: Page, text: string) {
  const tools = page.getByRole('toolbar', { name: 'Locations tools' });
  await tools.getByRole('button', { name: 'Search' }).click();
  await tools.getByRole('searchbox', { name: 'Search locations' }).fill(text);
}

test('T7: a Lab Manager adds, renames, prints, confirms and retires a location', async ({
  page,
}) => {
  const code = uniqueCode('WH');
  await signInAs(page, 'lab'); // "Lab (test)": a Lab Manager
  await openLocations(page);

  await page.getByRole('button', { name: 'Add location' }).click();
  const add = page.getByRole('dialog', { name: 'Add location' });
  await add.getByRole('textbox', { name: 'Code' }).fill(code.toLowerCase());
  await expect(add.getByRole('textbox', { name: 'Code' })).toHaveValue(code);
  await add.getByRole('textbox', { name: 'Name' }).fill('E2E warehouse bay');
  await add.getByRole('textbox', { name: 'Area or group (optional)' }).fill('Warehouse E2E');
  await add.getByRole('button', { name: 'Add location' }).click();
  await expect(page.getByText('E2E warehouse bay was added.')).toBeVisible();
  // The tree: the location sits under its area's row.
  await search(page, code);
  await expect(
    page
      .getByRole('table', { name: 'Locations' })
      .getByRole('rowheader', { name: /^Warehouse E2E/ }),
  ).toBeVisible();

  // Rename in the drawer.
  const first = await openDrawer(page, code, 'E2E warehouse bay');
  await first.getByRole('textbox', { name: 'Name' }).fill('E2E bay renamed');
  await first.getByRole('button', { name: 'Save changes' }).click();
  // The drawer takes the new name (on a phone it is a modal Sheet over the table).
  const open = drawer(page, 'E2E bay renamed');
  await expect(open).toBeVisible();

  // Print through the queue to the fake Zebra printer; "sent" is not "printed".
  await expect(open.getByText(`LOC-${code}`, { exact: true })).toBeVisible();
  await open.getByRole('button', { name: 'Print label' }).click();
  const label = open.getByRole('region', { name: 'Label' });
  await expect(label.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });
  await expect(open.getByText('Sent or queued; not yet confirmed as printed')).toBeVisible();
  await label.getByRole('button', { name: 'Labels came out OK' }).click();
  await expect(label.getByText('Printed (confirmed)')).toBeVisible();
  await expect(open.getByText(/Confirmed printed/)).toBeVisible();

  // The code is locked now; the name could still change.
  await expect(open.getByRole('textbox', { name: 'Code' })).toHaveAttribute('readonly', '');

  // Retire with a reason; hidden until "Include retired".
  await open.getByRole('button', { name: 'Retire location…' }).click();
  const retire = page.getByRole('alertdialog', { name: `Retire ${code}?` });
  await retire.getByRole('textbox', { name: 'Reason' }).fill('E2E bay closed');
  await retire.getByRole('button', { name: 'Retire location' }).click();
  await expect(page.getByText('E2E bay renamed was retired.')).toBeVisible();
  await expect(row(page, code)).toHaveCount(0);
  await open.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: 'Filter' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Include retired' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, code)).toContainText('Retired');

  const audit = await withDatabase(async (client) => {
    const { rows } = await client.query<{ action: string }>(
      `SELECT e.action FROM audit_event e JOIN location l ON l.id = e.entity_id
       WHERE e.entity_type = 'location' AND l.code_normalized = $1 ORDER BY e.occurred_at, e.id`,
      [code],
    );
    return rows.map((r) => r.action);
  });
  expect(audit).toEqual([
    'location.created',
    'location.updated',
    'location.label_printed',
    'location.retired',
  ]);
});

test('a location holding units can’t be retired: the dialog says how many and opens the shelf', async ({
  page,
}) => {
  const code = uniqueCode('OC');
  await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, 'E2E occupied shelf', 'warehouse')
       RETURNING id`,
      [code],
    );
    // Move one existing fictional unit there (T28 will do this through scanning).
    await client.query(
      `UPDATE storage_unit SET current_location_id = $1
       WHERE id = (SELECT id FROM storage_unit WHERE status = 'in_stock' ORDER BY created_at LIMIT 1)`,
      [rows[0]!.id],
    );
  });
  await signInAs(page, 'admin');
  await openLocations(page);
  await search(page, code);
  await expect(row(page, code).getByRole('link', { name: `1 unit at ${code}` })).toHaveAttribute(
    'href',
    /\/sample-storage\?locationId=/,
  );
  const open = await openDrawer(page, code, 'E2E occupied shelf');
  await open.getByRole('button', { name: 'Retire location…' }).click();
  const blocked = page.getByRole('alertdialog', { name: /can.t be retired/ });
  await expect(blocked.getByText(/1 storage unit is at this location/)).toBeVisible();
  await expect(blocked.getByRole('textbox', { name: 'Reason' })).toHaveCount(0);
  await blocked.getByRole('link', { name: 'Open shelf page' }).click();
  await expect(page).toHaveURL(new RegExp(`/sample-storage/locations/${code}$`));
});

test('T9/AC8: two LAB stations read and print independently and never administer locations', async ({
  browser,
}) => {
  const code = uniqueCode('LB');
  await withDatabase((client) =>
    client.query(
      `INSERT INTO location (code, name, kind) VALUES ($1, 'E2E station bench', 'lab')`,
      [code],
    ),
  );
  const stationA = await browser.newContext();
  const stationB = await browser.newContext();
  try {
    const pageA = await stationA.newPage();
    const pageB = await stationB.newPage();
    await signInAsLabStation(pageA);
    await signInAsLabStation(pageB);
    for (const page of [pageA, pageB]) {
      await openLocations(page);
      await expect(page.getByRole('button', { name: 'Add location' })).toHaveCount(0);
      await search(page, code);
      await expect(row(page, code)).toBeVisible();
      // Even with an administrator chosen as the person, the station can't manage locations.
      const forbidden = await page.request.post('/api/locations', {
        headers: { 'x-materialmule-csrf': '1' },
        data: {
          code: uniqueCode('NO'),
          name: 'Borrowed rights',
          kind: 'lab',
          receiverUserId: '00000000-0000-4000-8000-000000000103',
        },
      });
      expect(forbidden.status()).toBe(403);
      const resolved = await page.request.get(`/api/scan/resolve?payload=LOC-${code}`);
      expect(await resolved.json()).toMatchObject({ type: 'location', location: { code } });
    }

    // Station A prints as its Recording as person (Alex Tester; Printed by follows the chip,
    // read-only, STRATA-125); the print-only drawer has no edit or retire (MISC-04); station B
    // is unaffected and still signed in.
    const drawerA = await openDrawer(pageA, code, 'E2E station bench');
    await expect(drawerA.getByRole('button', { name: 'Save changes' })).toHaveCount(0);
    await expect(drawerA.getByRole('button', { name: /Retire/ })).toHaveCount(0);
    await expect(drawerA.getByRole('textbox', { name: /Printed by/ })).toHaveValue(/Alex Tester/);
    await drawerA.getByRole('button', { name: 'Print label' }).click();
    await expect(
      drawerA.getByRole('region', { name: 'Label' }).getByText('Sent to printer'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawerA.getByRole('table')).toContainText('Alex Tester');

    await pageB.reload();
    await expect(pageB.getByRole('heading', { name: 'Locations', level: 1 })).toBeVisible();
    await expect(pageB.getByRole('textbox', { name: /Printed by/ })).toHaveCount(0);
  } finally {
    await stationA.close();
    await stationB.close();
  }
});
