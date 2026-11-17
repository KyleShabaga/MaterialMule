import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket } from './support/db';
import { inboxKeyFor, inboxRowByKey, inboxUrl, openInboxItem } from './support/inbox';

// STRATA-133: a Technician asks for a hold on one unit, the Lab Manager approves and later
// releases it, and the Technician finds "Hold released" in their Inbox with the unit, project and
// who released it; the item opens the unit (its drawer from 1024 px, its page on a phone).
// Unit-scoped only, so parallel specs on DEMO-2601 are never held. Fictional data.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const CSRF = { 'x-materialmule-csrf': '1' };

async function post(page: Page, path: string, data: Record<string, unknown>) {
  const response = await page.request.post(path, { headers: CSRF, data });
  expect(response.ok(), `${path}: ${await response.text()}`).toBe(true);
  return (await response.json()) as Record<string, unknown>;
}

test('a released hold tells the person who asked for it, and opens the unit', async ({ page }) => {
  const unit = await insertConfirmedBucket();
  await signInAs(page, 'at');
  const asked = await post(page, '/api/retention/requests', {
    kind: 'hold',
    projectId: DEMO_PROJECT_ID,
    scope: 'units',
    unitIds: [unit.id],
    reason: `Client dispute (${unit.readableId})`,
    idempotencyKey: crypto.randomUUID(),
  });

  await signInAs(page, 'lab'); // Lab Manager
  const hold = await post(page, `/api/retention/requests/${String(asked.requestId)}/approve`, {
    idempotencyKey: crypto.randomUUID(),
  });
  await post(page, `/api/retention/holds/${String(hold.id)}/release`, {
    reason: 'Dispute settled',
    version: hold.version,
    idempotencyKey: crypto.randomUUID(),
  });

  await signInAs(page, 'at');
  const title = `Hold released on ${unit.readableId}`;
  const key = await inboxKeyFor(page, title, (i) => i.title === title, 'updates');
  await page.goto(inboxUrl(title, { tab: 'updates' }));
  const row = page.getByRole('listitem').filter({ has: inboxRowByKey(page, key) });
  await expect(row).toContainText('Hold released');
  await expect(row).toContainText('DEMO-2601');
  const item = await openInboxItem(page, row, title);
  await expect(item).toContainText('Lab (test) released the hold you asked for: Dispute settled');
  await expect(item).toContainText(unit.readableId);
  await item.getByRole('link', { name: 'Open the unit' }).click();
  if (test.info().project.name === 'phone-chromium') {
    await expect(page).toHaveURL(new RegExp(`/sample-storage/${unit.readableId}$`));
  } else {
    await expect(page).toHaveURL(new RegExp(`/sample-storage\\?open=${unit.readableId}$`));
  }
  await expect(page.getByRole('heading', { name: unit.readableId }).first()).toBeVisible();
});
