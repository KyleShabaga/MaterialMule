import { createHash } from 'node:crypto';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { pickOnStationPicker } from './support/lab-station';
import { withDatabase } from './support/db';
import { addUnit, confirmDelivery } from './support/receiving';

// MM-T11: receiving drafts autosaved in this browser (IndexedDB), against the real API with
// fictional DEMO-2601 data. Each test gets a fresh browser context, so it starts with no drafts.

const BKT_ID = /^BKT-\d{4}-\d{6}$/;

// Routes (e.g. the LAB /api/me rewrite) may still be in flight when a test ends.
test.afterEach(async ({ page }) => {
  if (!page.isClosed()) await page.unrouteAll({ behavior: 'ignoreErrors' });
});

const bucket = (page: Page, n: number) => page.getByRole('region', { name: `Bucket ${n}` });
const draftStatus = (page: Page) => page.locator('.draft-status');
const draftList = (page: Page) => page.getByRole('region', { name: 'Drafts on this computer' });

async function chooseProject(page: Page) {
  await page.getByRole('combobox', { name: /Find project/ }).fill('DEMO-2601');
  await page
    .getByRole('option', { name: 'DEMO-2601 · Riverbank investigation · Example Client' })
    .click();
  await expect(page.getByLabel('Project number')).toHaveValue('DEMO-2601');
}

/** Received by and Description as saved in the draft (Receive samples is one page, STRATA-76). */
async function expectDelivery(page: Page, description: string, receiver: RegExp) {
  await expect(page.getByLabel('Description (optional)')).toHaveValue(description);
  await expect(page.getByRole('combobox', { name: 'Received by', exact: true })).toHaveValue(
    receiver,
  );
}

async function addHole(unit: Locator, name: string) {
  await unit.getByRole('combobox', { name: 'Find or add a test hole' }).fill(name);
  await unit.getByRole('option', { name, exact: true }).click();
}

function summaryOf(unit: Locator, hole: string) {
  return unit.getByRole('group', { name: `${hole} summary` });
}

/**
 * The newest stored draft (this browser's IndexedDB) whose entries or receiver contain `text`:
 * its lastSavedAt, or null while no stored draft has it yet.
 */
async function storedDraftWith(page: Page, text: string): Promise<string | null> {
  return page.evaluate(
    (needle) =>
      new Promise<string | null>((resolve, reject) => {
        const open = indexedDB.open('materialmule-drafts');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          if (!db.objectStoreNames.contains('receiptDrafts')) return resolve(null);
          const all = db.transaction('receiptDrafts').objectStore('receiptDrafts').getAll();
          all.onerror = () => reject(all.error);
          all.onsuccess = () => {
            const times = (
              all.result as { data: unknown; receiver: unknown; lastSavedAt: string }[]
            )
              .filter((d) =>
                JSON.stringify({ data: d.data, receiver: d.receiver }).includes(needle),
              )
              .map((d) => d.lastSavedAt)
              .sort();
            resolve(times.at(-1) ?? null);
          };
        };
      }),
    text,
  );
}

/**
 * Waits until a stored draft holds `text` (the value just entered) and the indicator reports a
 * save; returns that draft's save time. It checks the stored content, not a clock: the page saves
 * about 1 s after the last change, but also sooner (when the draft is first registered), so no
 * time taken by the test reliably separates the save that has the edit from one that doesn't.
 */
async function savedWith(page: Page, text: string): Promise<string> {
  await expect.poll(() => storedDraftWith(page, text), { timeout: 10_000 }).not.toBeNull();
  await expect(draftStatus(page)).toHaveText(/^Draft saved \d{2}:\d{2} · Receiver: \w+$/);
  return (await storedDraftWith(page, text))!;
}

/** Signs the context out on the server only (cookie kept, so the next request gets a 401). */
async function expireSession(context: BrowserContext) {
  const cookie = (await context.cookies()).find((c) => c.name === 'materialmule_session');
  if (!cookie) throw new Error('No session cookie');
  const hash = createHash('sha256').update(decodeURIComponent(cookie.value), 'utf8').digest();
  await withDatabase((client) =>
    client.query('UPDATE session SET revoked_at = now() WHERE token_hash = $1', [hash]),
  );
}

/** Pretends the 'lab' fixture is the shared LAB station (as receiving-wizard.spec.ts does). */
async function asLabStation(page: Page) {
  await page.route('**/api/me', async (route) => {
    const response = await route.fetch();
    if (!response.ok()) return route.fulfill({ response });
    const me = (await response.json()) as Record<string, unknown>;
    await route.fulfill({ response, json: { ...me, accountType: 'shared_lab' } });
  });
}

async function chooseReceiver(page: Page, label: string, initials: string, name: RegExp) {
  const input = page.getByRole('combobox', { name: label, exact: true });
  await input.fill(initials);
  await page.getByRole('option', { name }).click();
}

async function issuedIds(page: Page): Promise<string[]> {
  const list = page.getByRole('list', { name: 'New storage units' });
  await expect(list).toBeVisible({ timeout: 15_000 });
  const ids = await list.getByRole('heading').allTextContents();
  for (const id of ids) expect(id).toMatch(BKT_ID);
  return ids;
}

test('T3/AC1: a closed tab reopens with the draft listed and every field intact', async ({
  page,
  context,
}) => {
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  await expect(draftStatus(page)).toHaveText('Draft not saved yet · Receiver: AT');
  await chooseProject(page);
  await page.getByLabel('Description (optional)').fill('Two buckets from the drill crew');
  await addHole(bucket(page, 1), 'TH26-01');
  const range = summaryOf(bucket(page, 1), 'TH26-01');
  await range.getByLabel('Summary type').selectOption('sample_range');
  await range.getByLabel('Sample from').fill('G1');
  await range.getByLabel('Sample to').fill('S12');
  await addUnit(page);
  await addHole(bucket(page, 2), 'TH26-02');
  await summaryOf(bucket(page, 2), 'TH26-02').getByLabel('Summary type').selectOption('all');
  await bucket(page, 2).getByLabel('Bucket 2 note (optional)').fill('Lid taped');
  await savedWith(page, 'Lid taped');
  await page.close();

  const reopened = await context.newPage();
  await reopened.goto('/receiving-log/new');
  const list = draftList(reopened);
  await expect(
    list.getByRole('heading', { name: 'DEMO-2601 · Riverbank investigation' }),
  ).toBeVisible();
  await expect(list).toContainText('2 storage units · Receiver: AT · Last saved');
  // The list sits above "Start a delivery".
  const listBox = (await list.boundingBox())!;
  const startBox = (await reopened
    .getByRole('button', { name: 'Start a delivery' })
    .boundingBox())!;
  expect(listBox.y).toBeLessThan(startBox.y);

  await list.getByRole('button', { name: /Resume draft DEMO-2601/ }).click();
  // Every field as it was left; rows are always open.
  await expect(reopened.getByLabel('Project number')).toHaveValue('DEMO-2601');
  await expectDelivery(reopened, 'Two buckets from the drill crew', /^AT · Alex Tester/);
  const reopenedRange = summaryOf(bucket(reopened, 1), 'TH26-01');
  await expect(reopenedRange.getByLabel('Sample from')).toHaveValue('G1');
  await expect(reopenedRange.getByLabel('Sample to')).toHaveValue('S12');
  await expect(summaryOf(bucket(reopened, 2), 'TH26-02').getByLabel('Summary type')).toHaveValue(
    'all',
  );
  await expect(bucket(reopened, 2).getByLabel('Bucket 2 note (optional)')).toHaveValue('Lid taped');
  // No IDs for a draft: nothing was issued.
  await expect(reopened.getByText(BKT_ID)).toHaveCount(0);
});

// Also in the MM-T18 critical path.
test(
  'T4/AC2: offline edits keep saving and the indicator shows the latest time',
  { tag: '@critical' },
  async ({ page, context }) => {
    await signInAs(page, 'at');
    await page.goto('/receiving-log/new');
    await chooseProject(page);

    await context.setOffline(true);
    await expect(
      page.getByText('Offline: your entries are kept here.', { exact: false }),
    ).toBeVisible();
    await page.getByLabel('Description (optional)').fill('Edited offline');
    const savedFirst = await savedWith(page, 'Edited offline');
    await bucket(page, 1).getByLabel('Bucket 1 note (optional)').fill('Still offline');
    const savedSecond = await savedWith(page, 'Still offline');
    expect(savedSecond > savedFirst).toBe(true);

    await context.setOffline(false);
    await page.close();
    const reopened = await context.newPage();
    await reopened.goto('/receiving-log/new');
    await draftList(reopened)
      .getByRole('button', { name: /Resume draft/ })
      .click();
    await expect(reopened.getByLabel('Description (optional)')).toHaveValue('Edited offline');
    await expect(bucket(reopened, 1).getByLabel('Bucket 1 note (optional)')).toHaveValue(
      'Still offline',
    );
  },
);

// Also in the MM-T18 critical path.
test(
  'T5/AC3: when IndexedDB writes fail, the indicator says so and never "saved"',
  { tag: '@critical' },
  async ({ page }) => {
    await page.addInitScript(() => {
      IDBObjectStore.prototype.put = () => {
        throw new DOMException('Quota exceeded', 'QuotaExceededError');
      };
    });
    await signInAs(page, 'at');
    await page.goto('/receiving-log/new');
    await page.getByLabel('Description (optional)').fill('Will not save');
    const alert = page.getByRole('alert').filter({ hasText: "Couldn't save draft on this device" });
    await expect(alert).toBeVisible();
    await expect(alert).toContainText('Receiver: AT');
    await expect(alert).toContainText('no storage space left');
    // A later change retries the save; it still fails and still says so.
    await chooseProject(page);
    await expect(alert).toBeVisible();
    await expect(page.getByText(/Draft saved/)).toHaveCount(0);
  },
);

test('T6/AC5/AC4: LAB session expires mid-draft; Confirm asks for sign-in, then succeeds', async ({
  page,
  context,
}) => {
  await signInAs(page, 'lab');
  await asLabStation(page);
  await page.goto('/receiving-log/new');
  await pickOnStationPicker(page);
  await expect(draftStatus(page)).toHaveText('Draft not saved yet · Receiver: not chosen');
  await chooseProject(page);
  await chooseReceiver(page, 'Received by', 'AT', /^AT · Alex Tester/);
  await page.getByLabel('Description (optional)').fill('LAB expiry check');
  await addHole(bucket(page, 1), 'TH26-01');
  await summaryOf(bucket(page, 1), 'TH26-01').getByLabel('Summary type').selectOption('all');
  await expect(draftStatus(page)).toContainText('Receiver: AT');

  await expireSession(context);
  await confirmDelivery(page);
  const expired = page.getByRole('alert').filter({ hasText: 'LAB session has expired' });
  await expect(expired).toHaveText(
    /The LAB session has expired\. Your draft is saved\. Sign in to confirm\./,
  );
  // Still on the draft.
  await expect(page.getByLabel('Description (optional)')).toHaveValue('LAB expiry check');
  await expired.getByRole('button', { name: 'Sign in' }).click();
  await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Freceiving-log%2Fnew%3Fdraft%3D/);
  await expect(page.getByRole('status')).toHaveText(
    'The LAB session has expired. Your draft is saved. Sign in to confirm.',
  );

  // Signing in again returns to the same draft, receiver unchanged (AC4).
  await signInAs(page, 'lab');
  await page.reload();
  // A new LAB session starts with no one picked.
  await pickOnStationPicker(page);
  await expect(page).toHaveURL(/\/receiving-log\/new\?draft=/);
  await expect(
    page.getByRole('region', { name: 'This draft was started for AT. Change receiver?' }),
  ).toBeVisible();
  await expect(page.getByLabel('Description (optional)')).toHaveValue('LAB expiry check');
  const request = page.waitForRequest('**/api/receipts');
  await confirmDelivery(page);
  const ids = await issuedIds(page);
  expect(ids).toHaveLength(1);
  const { idempotencyKey } = (await request).postDataJSON() as { idempotencyKey: string };

  const rows = await withDatabase(async (client) => {
    const result = await client.query<{ initials: string; description: string; units: number }>(
      `SELECT r.receiver_initials_snapshot AS initials, r.description,
              (SELECT count(*)::int FROM storage_unit su WHERE su.receipt_id = r.id) AS units
       FROM receipt r WHERE r.idempotency_key = $1`,
      [idempotencyKey],
    );
    return result.rows;
  });
  expect(rows).toEqual([{ initials: 'AT', description: 'LAB expiry check', units: 1 }]);

  // Confirmed drafts are deleted.
  await page.goto('/receiving-log/new');
  await expect(draftList(page)).toHaveCount(0);
});

test('AC4: resuming a LAB draft at the station changes the receiver only when someone picks', async ({
  page,
}) => {
  await signInAs(page, 'lab');
  await asLabStation(page);
  await page.goto('/receiving-log/new');
  await pickOnStationPicker(page);
  await chooseProject(page);
  await chooseReceiver(page, 'Received by', 'AT', /^AT · Alex Tester/);
  await page.getByLabel('Description (optional)').fill('Handover check');
  await savedWith(page, 'Handover check');

  // The next person at the station opens the list.
  await page.goto('/receiving-log/new');
  await draftList(page)
    .getByRole('button', { name: /Resume draft DEMO-2601/ })
    .click();
  const banner = page.getByRole('region', {
    name: 'This draft was started for AT. Change receiver?',
  });
  await expect(banner).toBeVisible();
  await expect(page.getByRole('combobox', { name: 'Received by', exact: true })).toHaveValue(
    /^AT · /,
  );
  await chooseReceiver(page, 'Change receiver to', 'PE', /^PE · Pat Example/);
  await savedWith(page, '"initials":"PE"');
  await expect(page.getByText('Receiver changed to PE.')).toBeVisible();
  await expect(draftStatus(page)).toContainText('Receiver: PE');

  const history = await page.evaluate(
    () =>
      new Promise<unknown[]>((resolve, reject) => {
        const open = indexedDB.open('materialmule-drafts');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result
            .transaction('receiptDrafts')
            .objectStore('receiptDrafts')
            .getAll();
          all.onsuccess = () =>
            resolve((all.result as { history: unknown[] }[]).flatMap((d) => d.history));
        };
      }),
  );
  expect(history).toContainEqual(
    expect.objectContaining({
      type: 'receiver_changed',
      from: expect.objectContaining({ initials: 'AT' }),
      to: expect.objectContaining({ initials: 'PE' }),
      accountId: expect.any(String),
      at: expect.any(String),
    }),
  );
});

test('T7/AC6: the answer to Confirm is lost and the tab closes; resuming returns the same IDs', async ({
  page,
  context,
}) => {
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  await chooseProject(page);
  await addHole(bucket(page, 1), 'TH26-01');
  await summaryOf(bucket(page, 1), 'TH26-01').getByLabel('Summary type').selectOption('all');
  await addUnit(page);
  await addHole(bucket(page, 2), 'TH26-02');
  await summaryOf(bucket(page, 2), 'TH26-02').getByLabel('Summary type').selectOption('all');

  // The server confirms, but the answer never reaches the browser (and retries fail too).
  let key = '';
  let firstIds: string[] = [];
  let committed!: () => void;
  const serverDone = new Promise<void>((resolve) => (committed = resolve));
  await page.route('**/api/receipts', async (route) => {
    if (!key) {
      key = (route.request().postDataJSON() as { idempotencyKey: string }).idempotencyKey;
      const response = await route.fetch();
      const body = (await response.json()) as { units: { suNumber: string }[] };
      firstIds = body.units.map((u) => u.suNumber);
      committed();
    }
    await route.abort('connectionreset').catch(() => undefined);
  });
  await confirmDelivery(page);
  await serverDone;
  expect(firstIds).toHaveLength(2);
  await page.close(); // the "crash"

  const reopened = await context.newPage();
  await reopened.goto('/receiving-log/new');
  const list = draftList(reopened);
  await expect(list.getByText('Confirmation interrupted')).toBeVisible();
  await list.getByRole('button', { name: /Resume draft/ }).click();
  const ids = await issuedIds(reopened);
  expect(ids).toEqual(firstIds);

  const units = await withDatabase(async (client) => {
    const result = await client.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM storage_unit su
       JOIN receipt r ON r.id = su.receipt_id WHERE r.idempotency_key = $1`,
      [key],
    );
    return result.rows[0]!.count;
  });
  expect(units).toBe(2);

  await reopened.goto('/receiving-log/new');
  await expect(draftList(reopened)).toHaveCount(0);
});

test('T8/AC7: a personal draft is not shown to another user on the same browser', async ({
  page,
}) => {
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  await chooseProject(page);
  await page.getByLabel('Description (optional)').fill("Alex's draft");
  await savedWith(page, "Alex's draft");

  await signInAs(page, 'pe');
  await page.goto('/receiving-log/new');
  await expect(page.getByRole('combobox', { name: /Find project/ })).toHaveValue('');
  await expect(draftList(page)).toHaveCount(0);
  await expect(page.getByText("Alex's draft")).toHaveCount(0);

  // Signing out and back in never deletes it.
  await signInAs(page, 'at');
  await page.goto('/receiving-log/new');
  await expect(draftList(page).getByRole('heading', { name: /DEMO-2601/ })).toBeVisible();
});
