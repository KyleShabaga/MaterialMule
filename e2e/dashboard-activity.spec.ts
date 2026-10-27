import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { receiveThroughApi, uniqueTag } from './support/receiving';

// MM-T49 (MM-T34 coverage): a new receipt appears first in the dashboard's Recent activity.
// Fictional data: a DEMO-2601 bucket received by AT.
//
// Other workers (and the other viewport) confirm receipts at the same time, so "first" means: no
// event listed above ours is older than ours. Run alone, ours is the very first item.

test('a new receipt is the newest entry in Recent activity and links to the receipt', async ({
  page,
}) => {
  await signInAs(page, 'at');
  // An earlier receipt of our own, so the list always has an older event to compare with.
  const [earlier] = await receiveThroughApi(page, { description: uniqueTag('T49-earlier') });
  const [unit] = await receiveThroughApi(page, { description: uniqueTag('T49-activity') });
  const id = unit!.suNumber;

  await page.goto('/');
  const activity = page.getByRole('region', { name: 'Recent activity' });
  const ours = activity
    .getByRole('listitem')
    .filter({ hasText: `AT received ${id} for DEMO-2601` });
  await expect(ours).toHaveCount(1);

  const items = await activity.getByRole('listitem').evaluateAll((elements) =>
    elements.map((element) => ({
      text: element.textContent ?? '',
      at: element.querySelector('time')?.getAttribute('datetime') ?? '',
    })),
  );
  const index = items.findIndex((item) => item.text.includes(`received ${id} `));
  expect(index).toBeGreaterThanOrEqual(0);
  const oursAt = Date.parse(items[index]!.at);
  for (const above of items.slice(0, index)) {
    expect(Date.parse(above.at), `listed above ours: ${above.text}`).toBeGreaterThanOrEqual(oursAt);
  }
  // Our earlier receipt is listed below it, and everything below is older.
  const earlierIndex = items.findIndex((item) =>
    item.text.includes(`received ${earlier!.suNumber} `),
  );
  expect(earlierIndex).toBeGreaterThan(index);
  for (const below of items.slice(index + 1)) {
    expect(Date.parse(below.at), `listed below ours: ${below.text}`).toBeLessThanOrEqual(oursAt);
  }

  // It links to its receipt. (The receipt page itself is not built yet: MM-T10.)
  const receiptId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ receipt_id: string }>(
      'SELECT receipt_id FROM storage_unit WHERE readable_id = $1',
      [id],
    );
    return rows[0]!.receipt_id;
  });
  await expect(ours.getByRole('link')).toHaveAttribute('href', `/receiving-log/${receiptId}`);
});
