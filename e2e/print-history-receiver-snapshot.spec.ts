import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { receiveThroughApi, uniqueTag } from './support/receiving';

// MM-T65 T4: a unit's print history keeps the receiver as they were when the job was requested,
// shown as initials · name (MM-T61). The receiver is a fictional per-test person, so renaming
// them can't affect tests running in parallel.

test('T4: Sample Storage print history shows the receiver at printing after a rename', async ({
  page,
}) => {
  const tag = uniqueTag('Casey');
  const receiverId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, 'CQ', 'personal', 'active') RETURNING id`,
      [`${tag} Pending`],
    );
    return rows[0]!.id;
  });

  await signInAs(page, 'lab');
  const [unit] = await receiveThroughApi(page, { receiverUserId: receiverId });
  // At the LAB station the receipt's receiver is credited on the print.
  const printed = await page.request.post('/api/print-jobs', {
    headers: { 'x-materialmule-csrf': '1' },
    data: { storageUnitIds: [unit!.storageUnitId], kind: 'initial' },
  });
  expect(printed.status()).toBe(201);

  await withDatabase((client) =>
    client.query(`UPDATE app_user SET display_name = $2, official_initials = 'CR' WHERE id = $1`, [
      receiverId,
      `${tag} Renamed`,
    ]),
  );

  await page.goto(`/sample-storage/${unit!.suNumber}`);
  const history = page.getByRole('table', { name: `Print history for ${unit!.suNumber}` });
  await expect(history.getByRole('row')).toHaveCount(2);
  await expect(history).toContainText(`for CQ · ${tag} Pending`);
  await expect(history).not.toContainText('Renamed');
  await expect(history).not.toContainText('CR ·');
});
