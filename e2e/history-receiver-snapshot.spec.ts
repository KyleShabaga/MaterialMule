import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';
import { receiveThroughApi, uniqueTag } from './support/receiving';

// MM-T56 T4: a unit's history keeps the receiver as they were at receipt after they are renamed
// and given new initials. The receiver is a fictional per-test person, so renaming them can't
// affect tests running in parallel.

test('T4: Sample Storage history shows the receiver at receipt after a rename', async ({
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

  await signInAs(page, 'at');
  const [unit] = await receiveThroughApi(page, { receiverUserId: receiverId });

  await withDatabase((client) =>
    client.query(`UPDATE app_user SET display_name = $2, official_initials = 'CR' WHERE id = $1`, [
      receiverId,
      `${tag} Renamed`,
    ]),
  );

  await page.goto(`/sample-storage/${unit!.suNumber}`);
  await expect(page.getByRole('heading', { level: 1, name: unit!.suNumber })).toBeVisible();
  const history = page.getByRole('list', { name: 'History events' });
  await expect(history.getByRole('listitem')).toHaveCount(2);
  for (const item of await history.getByRole('listitem').all()) {
    await expect(item).toContainText(`for CQ · ${tag} Pending`);
  }
  await expect(history).not.toContainText('Renamed');
  await expect(history).not.toContainText('CR —');
});
