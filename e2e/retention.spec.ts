import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { insertConfirmedBucket } from './support/db';
import { inboxKeyFor, inboxRowByKey, inboxUrl, openInboxItem } from './support/inbox';
import { signInAsLabStation } from './support/lab-station';

// MM-T29 (card T5, T7): a Technician without authority requests a hold on one unit, the Lab
// Manager approves it on the project page (resolving the shared action request), the unit shows
// On hold with its reason, and the Lab Manager releases it with a reason. LAB can't change
// retention. Unit-scoped only, so parallel specs on DEMO-2601 are never held. Fictional data.

const DEMO_PROJECT_ID = '00000000-0000-4000-8000-000000000201';

test('T5: request → approve on the project page → On hold → release, with history', async ({
  page,
}) => {
  const unit = await insertConfirmedBucket();
  await signInAs(page, 'at');
  await page.goto(`/sample-storage/${unit.readableId}`);
  const card = page.getByRole('region', { name: 'Retention', exact: true });
  await expect(card).toContainText('Retain until 2026-11-03');
  await expect(card).toContainText('Minimum retain-until2026-11-03');
  await card.getByRole('button', { name: 'Request hold or extension' }).click();
  const form = card.getByRole('form', { name: 'Request a hold or extension' });
  await form.getByLabel('Reason (required)').fill(`Client dispute (${unit.readableId})`);
  await form.getByRole('button', { name: 'Send request' }).click();
  await expect(card.getByRole('button', { name: 'Request hold or extension' })).toBeVisible();
  await expect(card).not.toContainText('On hold');

  await signInAs(page, 'lab'); // Lab Manager
  // The Inbox row doesn't show the reason, so this request is found by it (STRATA-24).
  const title = 'Hold requested for DEMO-2601 · 1 unit';
  const reason = `Client dispute (${unit.readableId})`;
  const key = await inboxKeyFor(page, title, (i) => i.reason === reason, 'requests');
  await page.goto(inboxUrl(title, { tab: 'requests' }));
  const row = page.getByRole('listitem').filter({ has: inboxRowByKey(page, key) });
  await expect(row).toContainText('Retention');
  const item = await openInboxItem(page, row, title);
  await expect(item).toContainText(reason);
  await expect(item).toContainText('waiting on you');
  await item.getByRole('link', { name: 'Decide on retention' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${DEMO_PROJECT_ID}#retention$`));
  const section = page.getByRole('region', { name: 'Retention', exact: true });
  const request = section
    .getByRole('listitem', { name: 'Hold request' })
    .filter({ hasText: unit.readableId });
  await request.getByRole('button', { name: 'Approve' }).click();
  await expect(request).toContainText('Approved by LAB');

  await page.goto(`/sample-storage/${unit.readableId}`);
  await expect(card).toContainText('On hold');
  const hold = card.getByRole('listitem', { name: `Hold: Client dispute (${unit.readableId})` });
  await expect(hold).toContainText('Placed by LAB');
  await hold.getByRole('button', { name: 'Release' }).click();
  await hold.getByLabel('Reason for releasing (required)').fill('Dispute settled');
  await hold
    .getByRole('form', { name: 'Release' })
    .getByRole('button', { name: 'Release' })
    .click();
  await expect(hold).toContainText('Released');
  await expect(hold).toContainText('Dispute settled');
  // MTR-83: the release form closes once the hold is released.
  await expect(hold.getByRole('form', { name: 'Release' })).toHaveCount(0);
  await expect(card).not.toContainText('Retain until 2026-11-03 · On hold');

  await page.goto(inboxUrl(title, { tab: 'done' }));
  const done = page.getByRole('listitem').filter({ has: inboxRowByKey(page, key) });
  const resolved = await openInboxItem(page, done, title);
  await expect(resolved).toContainText(reason);
  await expect(resolved).toContainText('Resolved by Lab (test) · Approved');
});

test('T7: a LAB station sees retention but can neither change nor request it', async ({ page }) => {
  const unit = await insertConfirmedBucket();
  await signInAsLabStation(page);
  await page.goto(`/sample-storage/${unit.readableId}`);
  const card = page.getByRole('region', { name: 'Retention', exact: true });
  await expect(card).toContainText('Retain until 2026-11-03');
  await expect(card.getByRole('button', { name: /hold or extension/ })).toHaveCount(0);
  const attempt = await page.request.post('/api/retention/holds', {
    headers: { 'x-materialmule-csrf': '1' },
    data: {
      projectId: DEMO_PROJECT_ID,
      scope: 'units',
      unitIds: [unit.id],
      reason: 'LAB try',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  expect(attempt.status()).toBe(403);
});
