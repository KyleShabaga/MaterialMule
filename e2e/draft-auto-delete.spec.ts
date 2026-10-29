import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-T45 T4: draft auto-delete, against the real API with fictional DEMO-2601 data. The setting
// is server-wide, so only the desktop run changes it (and puts it back); the phone run checks the
// settings screen without saving, so the two never race for the same setting.

const DAY = 86_400_000;

interface SeedDraft {
  ownerId: string;
  daysAgo: number;
  status: 'editing' | 'confirming';
  description: string;
}

/** Puts drafts straight into this browser's IndexedDB, as T11 stores them. */
async function seedDrafts(page: Page, drafts: SeedDraft[]): Promise<string[]> {
  return page.evaluate(
    ({ drafts, day }) => {
      const records = drafts.map((d) => {
        const at = new Date(Date.now() - d.daysAgo * day).toISOString();
        const key = crypto.randomUUID();
        return {
          version: 1,
          draftId: crypto.randomUUID(),
          idempotencyKey: key,
          owner: { accountId: d.ownerId, type: 'personal' },
          receiver: null,
          data: {
            idempotencyKey: key,
            project: {
              id: '00000000-0000-4000-8000-000000000201',
              projectNumber: 'DEMO-2601',
              name: 'Riverbank investigation',
              client: 'Example Client',
              leadProjectEngineer: null,
            },
            receivedDate: '2026-01-05',
            receiver: null,
            description: d.description,
            units: [{ clientRowId: crypto.randomUUID(), type: 'bucket', summaries: [] }],
          },
          step: 'details',
          status: d.status,
          createdAt: at,
          lastSavedAt: at,
          history: [{ type: 'created', at, accountId: d.ownerId, receiver: null }],
        };
      });
      return new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('materialmule-drafts', 1);
        open.onupgradeneeded = () =>
          open.result.createObjectStore('receiptDrafts', { keyPath: 'draftId' });
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const tx = open.result.transaction('receiptDrafts', 'readwrite');
          for (const record of records) tx.objectStore('receiptDrafts').put(record);
          tx.oncomplete = () => {
            open.result.close();
            resolve(records.map((r) => r.draftId));
          };
          tx.onerror = () => reject(tx.error);
        };
      });
    },
    { drafts, day: DAY },
  );
}

async function storedDescriptions(page: Page): Promise<string[]> {
  return page.evaluate(
    () =>
      new Promise<string[]>((resolve, reject) => {
        const open = indexedDB.open('materialmule-drafts');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const all = open.result
            .transaction('receiptDrafts')
            .objectStore('receiptDrafts')
            .getAll();
          all.onsuccess = () => {
            open.result.close();
            resolve(
              (all.result as { data: { description: string } }[])
                .map((d) => d.data.description)
                .sort(),
            );
          };
        };
      }),
  );
}

async function horizontalOverflow(page: Page): Promise<number> {
  return page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
}

test('T4: an admin turns on 30-day clean-up; old drafts go on the next open, confirming ones stay', async ({
  page,
}, testInfo) => {
  test.skip(!testInfo.project.name.startsWith('desktop'), 'changes the server-wide setting');
  try {
    await signInAs(page, 'admin');
    const me = (await (await page.request.get('/api/me')).json()) as { id: string };

    // Off (the default): an old draft stays, with the T11 Stale badge.
    await page.goto('/settings/receiving');
    await expect(
      page
        .getByRole('navigation', { name: 'Settings' })
        .getByRole('link', { name: 'Receiving', exact: true }),
    ).toBeVisible();
    const toggle = page.getByRole('checkbox', { name: 'Delete drafts automatically' });
    await expect(toggle).not.toBeChecked();
    await expect(page.getByLabel('After this many days without changes')).toHaveValue('90');

    await page.goto('/receiving-log/new');
    await seedDrafts(page, [
      { ownerId: me.id, daysAgo: 45, status: 'editing', description: 'Old draft' },
      { ownerId: me.id, daysAgo: 60, status: 'confirming', description: 'Interrupted' },
      { ownerId: me.id, daysAgo: 5, status: 'editing', description: 'Recent draft' },
    ]);
    await page.reload();
    const list = page.getByRole('region', { name: 'Drafts on this computer' });
    await expect(list.getByRole('listitem')).toHaveCount(3);
    await expect(list.getByText('Stale')).toHaveCount(2);
    await expect(list.getByRole('status')).toHaveCount(0);

    // Days outside 30–365 are refused; 30 is saved.
    await page.goto('/settings/receiving');
    await toggle.check();
    const days = page.getByLabel('After this many days without changes');
    await days.fill('29');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByText('Enter a whole number of days from 30 to 365')).toBeVisible();
    await days.fill('30');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Draft setting saved.' }),
    ).toBeVisible();

    // The next open of Receive samples deletes the 45-day draft, keeps the other two.
    await page.goto('/receiving-log/new');
    await expect(list.getByRole('status')).toHaveText(
      '1 draft older than 30 days was deleted from this computer (automatic clean-up set by an administrator).',
    );
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await expect(list.getByText('Confirmation interrupted')).toBeVisible();
    expect(await storedDescriptions(page)).toEqual(['Interrupted', 'Recent draft']);

    // The change is audited with before/after and the actor.
    const audit = await withDatabase((client) =>
      client.query<{ actor_user_id: string; before_values: unknown; after_values: unknown }>(
        `SELECT actor_user_id, before_values, after_values FROM audit_event
         WHERE action = 'settings.drafts_changed' ORDER BY occurred_at DESC LIMIT 1`,
      ),
    );
    expect(audit.rows[0]).toEqual({
      actor_user_id: me.id,
      before_values: { draftAutoDelete: { enabled: false, afterDays: 90 } },
      after_values: { draftAutoDelete: { enabled: true, afterDays: 30 } },
    });
  } finally {
    await withDatabase((client) =>
      client.query(
        `UPDATE draft_auto_delete_setting
         SET enabled = false, after_days = 90, version = version + 1, updated_at = now()`,
      ),
    );
  }
});

test('Settings → Receiving: Lab Managers can change it, others only see it', async ({ page }) => {
  await signInAs(page, 'lab');
  await page.goto('/settings');
  await page
    .getByRole('navigation', { name: 'Settings' })
    .getByRole('link', { name: 'Receiving', exact: true })
    .click();
  await expect(page.getByRole('heading', { name: 'Receiving drafts' })).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Delete drafts automatically' })).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Save' })).toBeVisible();
  // Keyboard: the switch, the days and Save are reachable in order.
  await page.getByRole('checkbox', { name: 'Delete drafts automatically' }).focus();
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('After this many days without changes')).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Save' })).toBeFocused();
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);

  await signInAs(page, 'at');
  await page.goto('/settings/receiving');
  await expect(
    page
      .getByRole('navigation', { name: 'Settings' })
      .getByRole('link', { name: 'Receiving', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByText('Only Lab Managers and administrators can change this.'),
  ).toBeVisible();
  await expect(page.getByRole('checkbox', { name: 'Delete drafts automatically' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Save' })).toHaveCount(0);
  const denied = await page.request.put('/api/settings/drafts', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { draftAutoDelete: { enabled: true, afterDays: 30 }, version: 1 },
  });
  expect(denied.status()).toBe(403);
  expect(await horizontalOverflow(page)).toBeLessThanOrEqual(0);
});
