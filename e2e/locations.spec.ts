import { randomBytes } from 'node:crypto';
import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { signInAsLabStation } from './support/lab-station';

// MM-T37: Settings → Locations. T7 (add, rename, print, retire from Settings), the blocked
// retirement link, and T9 (two independent LAB stations, no borrowed administration rights).
// Codes are random so the desktop and phone projects never collide. Fictional data only.

function uniqueCode(prefix: string): string {
  return `${prefix}-${randomBytes(3).toString('hex').toUpperCase()}`;
}

async function openLocations(page: Page) {
  await page.goto('/settings/locations');
  await expect(page.getByRole('heading', { name: 'Locations', level: 2 })).toBeVisible();
}

function row(page: Page, text: string) {
  return page.getByRole('table', { name: 'Locations' }).locator('tbody tr', { hasText: text });
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
  await expect(row(page, code)).toContainText('Warehouse E2E');

  // Rename.
  await row(page, code).getByRole('button', { name: 'Edit E2E warehouse bay' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit E2E warehouse bay' });
  await edit.getByRole('textbox', { name: 'Name' }).fill('E2E bay renamed');
  await edit.getByRole('button', { name: 'Save' }).click();
  await expect(row(page, code)).toContainText('E2E bay renamed');

  // Print through the queue to the fake Zebra printer; "sent" is not "printed".
  await row(page, code)
    .getByRole('button', { name: 'Label and history for E2E bay renamed' })
    .click();
  const drawer = page.getByRole('dialog', { name: 'E2E bay renamed' });
  await expect(drawer.getByText(`LOC-${code}`)).toBeVisible();
  await drawer.getByRole('button', { name: 'Print label' }).click();
  const label = drawer.getByRole('region', { name: 'Label' });
  await expect(label.getByText('Sent to printer')).toBeVisible({ timeout: 15_000 });
  await expect(drawer.getByText('Sent or queued; not yet confirmed as printed')).toBeVisible();
  await label.getByRole('button', { name: 'Labels came out OK' }).click();
  await expect(label.getByText('Printed (confirmed)')).toBeVisible();
  await expect(drawer.getByText(/Confirmed printed/)).toBeVisible();
  await drawer.getByRole('button', { name: 'Close' }).click();

  // The code is locked now; the name could still change.
  await row(page, code).getByRole('button', { name: 'Edit E2E bay renamed' }).click();
  const locked = page.getByRole('dialog', { name: 'Edit E2E bay renamed' });
  await expect(locked.getByRole('textbox', { name: 'Code' })).toHaveAttribute('readonly', '');
  await locked.getByRole('button', { name: 'Cancel' }).click();

  // Retire with a reason; hidden until "Include retired".
  await row(page, code).getByRole('button', { name: 'Retire E2E bay renamed' }).click();
  const retire = page.getByRole('dialog', { name: 'Retire E2E bay renamed' });
  await retire.getByRole('textbox', { name: 'Reason' }).fill('E2E bay closed');
  await retire.getByRole('button', { name: 'Retire location' }).click();
  await expect(page.getByText('E2E bay renamed was retired.')).toBeVisible();
  await expect(row(page, code)).toHaveCount(0);
  await page.getByRole('checkbox', { name: 'Include retired' }).check();
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

test('retiring an occupied location is blocked with the count and a link to the units', async ({
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
  await page.getByRole('searchbox', { name: 'Search locations' }).fill(code);
  await row(page, code).getByRole('button', { name: 'Retire E2E occupied shelf' }).click();
  const retire = page.getByRole('dialog', { name: 'Retire E2E occupied shelf' });
  await expect(retire.getByText(/1 unit is still at this location/)).toBeVisible();
  await retire.getByRole('textbox', { name: 'Reason' }).fill('Try anyway');
  await retire.getByRole('button', { name: 'Retire location' }).click();
  await expect(retire.getByText(/1 storage unit is still at this location/)).toBeVisible();
  await retire.getByRole('link', { name: `Show the 1 unit at ${code}` }).click();
  await expect(page).toHaveURL(/\/sample-storage\?locationId=/);
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
      await page.getByRole('searchbox', { name: 'Search locations' }).fill(code);
      await expect(row(page, code)).toBeVisible();
      await expect(row(page, code).getByRole('button', { name: /^Edit / })).toHaveCount(0);
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

    // Station A prints for one person; station B is unaffected and still signed in.
    await row(pageA, code)
      .getByRole('button', { name: 'Label and history for E2E station bench' })
      .click();
    const drawerA = pageA.getByRole('dialog', { name: 'E2E station bench' });
    await drawerA.getByRole('button', { name: 'Print label' }).click();
    await expect(drawerA.getByText('Choose who is printing this label.')).toBeVisible();
    await drawerA.getByRole('combobox', { name: /Printed by/ }).fill('Alex');
    await drawerA.getByRole('option', { name: /Alex Tester/ }).click();
    await drawerA.getByRole('button', { name: 'Print label' }).click();
    await expect(
      drawerA.getByRole('region', { name: 'Label' }).getByText('Sent to printer'),
    ).toBeVisible({
      timeout: 15_000,
    });
    await expect(drawerA.getByRole('table')).toContainText('Alex Tester');

    await pageB.reload();
    await expect(pageB.getByRole('heading', { name: 'Locations', level: 2 })).toBeVisible();
    await expect(pageB.getByRole('combobox', { name: /Printed by/ })).toHaveCount(0);
  } finally {
    await stationA.close();
    await stationB.close();
  }
});
