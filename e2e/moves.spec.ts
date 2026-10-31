import { randomInt } from 'node:crypto';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket, withDatabase, type TestUnit } from './support/db';
import { expireSession, signInAsLabStation } from './support/lab-station';
import { removeTestedTube, testedTube } from './support/tested-tube';

// MM-T28 test plan T4, T5, T7, T8 and T9: destination scans, queued moves and location
// conflicts, through the real browser queue (IndexedDB) and API. The handheld scanner is a
// keyboard that types the payload and Enter. Two LAB stations are two browser contexts signed in
// as the same fictional LAB account. Locations and units are fictional and unique to each test.

interface Place {
  id: string;
  code: string;
  name: string;
}

/** A fictional location with a code unique to this run (both viewports share one database). */
async function addLocation(suffix: string, name: string): Promise<Place> {
  const code = `MV${randomInt(1000, 9999)}-${suffix}`;
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
      [code, `${name} ${code}`],
    );
    return { id: rows[0]!.id, code, name: `${name} ${code}` };
  });
}

async function savedLocation(unit: TestUnit): Promise<string> {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{ code: string }>(
      `SELECT l.code_normalized AS code FROM storage_unit su
       JOIN location l ON l.id = su.current_location_id WHERE su.id = $1`,
      [unit.id],
    );
    return rows[0]!.code;
  });
}

async function moveEvents(unit: TestUnit) {
  return withDatabase(async (client) => {
    const { rows } = await client.query<{
      kind: string;
      to_code: string;
      actor_name_snapshot: string;
      mover_name_snapshot: string | null;
      source: string;
    }>(
      `SELECT e.kind, l.code_normalized AS to_code, e.actor_name_snapshot, e.mover_name_snapshot,
              e.source
       FROM movement_event e JOIN location l ON l.id = e.to_location_id
       WHERE e.storage_unit_id = $1 ORDER BY e.saved_at, e.id`,
      [unit.id],
    );
    return rows;
  });
}

/** One simulated trigger pull into the Move screen's scan field. */
async function scan(page: Page, payload: string) {
  await page.locator('.scan-field').focus();
  await page.keyboard.type(payload);
  await page.keyboard.press('Enter');
}

async function openMove(page: Page, mover?: RegExp) {
  await page.goto('/sample-storage/move');
  await expect(page.getByRole('heading', { level: 1, name: 'Move storage units' })).toBeVisible();
  if (mover) {
    const field = page.getByRole('combobox', { name: /Moved by/ });
    await field.fill(mover.source.split(' ')[0]!);
    await page.getByRole('option', { name: mover }).click();
  }
}

async function setDestination(page: Page, place: Place) {
  await scan(page, `LOC-${place.code}`);
  await expect(page.getByTestId('move-destination')).toContainText(place.name);
}

const row = (page: Page, unit: TestUnit) =>
  page.getByTestId('move-row').filter({ hasText: unit.readableId });

async function labStation(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const sessionId = await signInAsLabStation(page);
  return { context, page, sessionId };
}

test('T4/AC1: LAB scans a destination, then two units; both save with actor, person and time', async ({
  page,
}) => {
  const c2 = await addLocation('C2', 'Warehouse');
  const u1 = await insertConfirmedBucket();
  const u2 = await insertConfirmedBucket();
  await signInAsLabStation(page);
  await openMove(page, /Alex Tester/);
  await setDestination(page, c2);
  await scan(page, u1.readableId);
  await expect(row(page, u1).getByText('Saved')).toBeVisible();
  await scan(page, u2.readableId);
  await expect(row(page, u2).getByText('Saved')).toBeVisible();
  // Scanning U1 again for the same destination in this batch is ignored (P20).
  await scan(page, u1.readableId);
  await expect(
    page.getByRole('status').getByText(`${u1.readableId} is already in this batch`),
  ).toBeVisible();
  await expect(page.getByTestId('move-row')).toHaveCount(2);

  expect(await savedLocation(u1)).toBe(c2.code);
  expect(await savedLocation(u2)).toBe(c2.code);
  expect(await moveEvents(u1)).toEqual([
    expect.objectContaining({
      kind: 'move',
      to_code: c2.code,
      actor_name_snapshot: 'LAB',
      mover_name_snapshot: 'Alex Tester',
      source: 'online',
    }),
  ]);
  await page.goto(`/sample-storage/${u1.readableId}`);
  const history = page.getByRole('region', { name: 'History', exact: true });
  await expect(history).toContainText('Moved');
  // MTR-64: the move names where the unit came from and went to.
  await expect(history).toContainText(`location: Receiving lab (RECEIVING) → ${c2.name} (`);
  await expect(history).not.toContainText('[object Object]');
});

test('T5/AC2: offline scans stay Pending (saved location unchanged) and sync once on reconnect, with two tabs open', async ({
  context,
  page,
}) => {
  const c1 = await addLocation('C1', 'Warehouse');
  const c2 = await addLocation('C2', 'Warehouse');
  const u1 = await insertConfirmedBucket();
  const uncached = await insertConfirmedBucket();
  await signInAs(page, 'at');
  await openMove(page);
  // Online first: the unit and the location list are now known on this computer.
  await setDestination(page, c1);
  await scan(page, u1.readableId);
  await expect(row(page, u1).getByText('Saved')).toBeVisible();
  // A second tab of the same browser profile shares the queue (P21: one drains).
  const second = await context.newPage();
  await second.goto('/sample-storage/move');
  await expect(second.getByRole('heading', { level: 1, name: 'Move storage units' })).toBeVisible();

  await context.setOffline(true);
  await setDestination(page, c2);
  await scan(page, u1.readableId);
  await expect(
    row(page, u1).filter({ hasText: c2.name }).getByText(`Pending → ${c2.name}`),
  ).toBeVisible();
  await expect(page.getByText('Offline: 1 move waiting to sync.')).toBeVisible();
  // Never fabricated: a unit this computer hasn't seen needs online lookup and queues nothing.
  await scan(page, uncached.readableId);
  await expect(row(page, uncached).getByText('Needs online lookup')).toBeVisible();
  // The saved location is still C1 on the server.
  expect(await savedLocation(u1)).toBe(c1.code);

  await context.setOffline(false);
  await expect(row(page, u1).filter({ hasText: c2.name }).getByText('Saved')).toBeVisible();
  expect(await savedLocation(u1)).toBe(c2.code);
  const events = await moveEvents(u1);
  expect(events.map((e) => [e.to_code, e.source])).toEqual([
    [c1.code, 'online'],
    [c2.code, 'queued'],
  ]);
  // The uncached scan becomes a move only when a person confirms it after the lookup.
  await row(page, uncached).getByRole('button', { name: 'Look up and move' }).click();
  await expect(row(page, uncached).getByText('Saved')).toBeVisible();
  expect(await savedLocation(uncached)).toBe(c2.code);
  await second.close();
});

test('T7/T8/AC3/AC4/AC7/AC8: two LAB stations keep their own state; a competing move conflicts and only a personal account resolves it', async ({
  browser,
}) => {
  const staging = await addLocation('S1', 'Staging');
  const c1 = await addLocation('C1', 'Warehouse');
  const c2 = await addLocation('C2', 'Warehouse');
  const u1 = await insertConfirmedBucket();
  const u2 = await insertConfirmedBucket();
  const a = await labStation(browser);
  const b = await labStation(browser);
  try {
    await openMove(a.page, /Alex Tester/);
    await openMove(b.page, /Jordan Smith/);
    // A sees U1 online once (so it is cached), then loses the network and queues a C2 move.
    await setDestination(a.page, staging);
    await scan(a.page, u1.readableId);
    await expect(row(a.page, u1).getByText('Saved')).toBeVisible();
    await a.context.setOffline(true);
    await setDestination(a.page, c2);
    await scan(a.page, u1.readableId);
    await expect(
      row(a.page, u1).filter({ hasText: c2.name }).getByText(`Pending → ${c2.name}`),
    ).toBeVisible();

    // B, same LAB account, moves U1 to C1 and an unrelated unit too.
    await setDestination(b.page, c1);
    await scan(b.page, u1.readableId);
    await scan(b.page, u2.readableId);
    await expect(row(b.page, u1).getByText('Saved')).toBeVisible();
    await expect(row(b.page, u2).getByText('Saved')).toBeVisible();

    await a.context.setOffline(false);
    await expect(
      row(a.page, u1).filter({ hasText: c2.name }).getByText('Location conflict'),
    ).toBeVisible();
    expect(await savedLocation(u1)).toBe(c1.code);
    expect(await savedLocation(u2)).toBe(c1.code);
    // Each station kept its own destination and person.
    await expect(a.page.getByTestId('move-destination')).toContainText(c2.name);
    await expect(b.page.getByTestId('move-destination')).toContainText(c1.name);

    // B signs out; A is untouched.
    await b.page.request.post('/api/auth/sign-out', { headers: { 'x-materialmule-csrf': '1' } });
    await a.page.reload();
    await expect(a.page.getByTestId('move-destination')).toContainText(c2.name);
    await expect(a.page.getByRole('combobox', { name: /Moved by/ })).toHaveValue(/Alex Tester/);

    // LAB sees the conflict but can't resolve it.
    await a.page.goto(`/sample-storage/${u1.readableId}`);
    const labConflict = a.page.getByRole('region', { name: 'Location conflict' });
    await expect(labConflict).toContainText('A personal account must check the unit');
    await expect(labConflict.getByRole('button', { name: 'Confirm location' })).toHaveCount(0);

    // A personal technician checks the shelf and confirms C1.
    const tech = await browser.newContext();
    const techPage = await tech.newPage();
    await signInAs(techPage, 'at');
    await techPage.goto(`/sample-storage/${u1.readableId}`);
    const conflict = techPage.getByRole('region', { name: 'Location conflict' });
    await expect(conflict).toContainText('Move not applied');
    await expect(conflict).toContainText('Saved move');
    await conflict.getByLabel('Actual location').selectOption({ label: `${c1.name} (${c1.code})` });
    await conflict.getByLabel('Note (optional)').fill('Checked the shelf.');
    await conflict.getByRole('button', { name: 'Confirm location' }).click();
    await expect(techPage.getByText('Location confirmed.')).toBeVisible();
    const history = techPage.getByRole('region', { name: 'History', exact: true });
    await expect(history).toContainText('Location confirmed');
    await expect(history).toContainText('Location conflict');
    await expect(history).toContainText('Moved');
    expect((await moveEvents(u1)).map((e) => e.kind)).toEqual([
      'move',
      'move',
      'contested',
      'resolution',
    ]);
    await tech.close();
  } finally {
    await a.context.close();
    await b.context.close();
  }
});

test('T9/AC9: a queued LAB move waits through an account change and expiry, keeps its attribution, and a unit disposed meanwhile is refused', async ({
  context,
  page,
}) => {
  const staging = await addLocation('S1', 'Staging');
  const c2 = await addLocation('C2', 'Warehouse');
  const kept = await insertConfirmedBucket();
  const removed = await insertConfirmedBucket();
  const sessionId = await signInAsLabStation(page);
  await openMove(page, /Alex Tester/);
  await setDestination(page, staging);
  await scan(page, kept.readableId);
  await scan(page, removed.readableId);
  await expect(row(page, removed).getByText('Saved')).toBeVisible();

  await context.setOffline(true);
  await setDestination(page, c2);
  await scan(page, kept.readableId);
  await scan(page, removed.readableId);
  await expect(page.getByText('Offline: 2 moves waiting to sync.')).toBeVisible();
  // Meanwhile the tube/bucket is removed and disposed, and the LAB session runs out. (Set
  // directly here; MM-T80 T2 below runs the same queue against a real removal after testing.)
  await withDatabase((client) =>
    client.query(
      `UPDATE storage_unit SET status = 'disposed', version = version + 1 WHERE id = $1`,
      [removed.id],
    ),
  );
  await expireSession(sessionId);
  await context.setOffline(false);
  await expect(page.getByText(/Signed out: 2 moves waiting to sync/)).toBeVisible();

  // A different account on this computer never sends LAB's queue.
  await signInAs(page, 'at');
  await page.goto('/sample-storage/move');
  await expect(page.getByText(/2 moves scanned on this computer by LAB are waiting/)).toBeVisible();
  expect(await savedLocation(kept)).toBe(staging.code);

  // LAB signs back in: the same actions go, with their original person.
  await signInAsLabStation(page);
  await page.goto('/sample-storage/move');
  await expect(row(page, kept).filter({ hasText: c2.name }).getByText('Saved')).toBeVisible();
  await expect(
    row(page, removed).filter({ hasText: c2.name }).getByText('Needs attention'),
  ).toBeVisible();
  await expect(row(page, removed).filter({ hasText: c2.name })).toContainText('disposed');
  expect(await savedLocation(kept)).toBe(c2.code);
  expect(await savedLocation(removed)).toBe(staging.code);
  expect((await moveEvents(kept)).at(-1)).toMatchObject({
    to_code: c2.code,
    actor_name_snapshot: 'LAB',
    mover_name_snapshot: 'Alex Tester',
    source: 'queued',
  });
});

test('MM-T80 T2: a queued LAB move of a tube removed after testing (real MM-T36 route) needs attention', async ({
  browser,
  context,
  page,
}) => {
  const staging = await addLocation('S1', 'Staging');
  const c2 = await addLocation('C2', 'Warehouse');
  // A second computer for the people who test and remove the tube.
  const office = await browser.newContext();
  const officePage = await office.newPage();
  try {
    const tube = await testedTube(officePage);

    await signInAsLabStation(page);
    await openMove(page, /Alex Tester/);
    await setDestination(page, staging);
    await scan(page, tube.readableId);
    await expect(row(page, tube).getByText('Saved')).toBeVisible();

    await context.setOffline(true);
    await setDestination(page, c2);
    await scan(page, tube.readableId);
    await expect(page.getByText(/Offline: 1 move waiting to sync/)).toBeVisible();
    // Meanwhile Alex confirms the tube has left the lab.
    await removeTestedTube(officePage, tube);
    await context.setOffline(false);

    await expect(
      row(page, tube).filter({ hasText: c2.name }).getByText('Needs attention'),
    ).toBeVisible();
    await expect(row(page, tube).filter({ hasText: c2.name })).toContainText('disposed');
    expect(await savedLocation(tube)).toBe(staging.code);
    expect((await moveEvents(tube)).map((e) => e.to_code)).toEqual([staging.code]);
  } finally {
    await office.close();
  }
});

test('Lookup mode stays read-only and tells a location label apart from a unit', async ({
  page,
}) => {
  const c1 = await addLocation('C1', 'Warehouse');
  await signInAs(page, 'at');
  await page.goto('/sample-storage/scan');
  await expect(page.getByRole('textbox', { name: 'Scan a storage unit label' })).toBeFocused();
  await page.keyboard.type(`LOC-${c1.code}`);
  await page.keyboard.press('Enter');
  await expect(page.getByText(`LOC-${c1.code} is a location label`)).toBeVisible();
  await expect(page.getByRole('link', { name: 'Move units' })).toBeVisible();
});
