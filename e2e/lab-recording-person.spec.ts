import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { E2E_LAB_STATION_ID, signInAsLabStation } from './support/lab-station';
import {
  addHole,
  bucket,
  chooseDemoProject,
  confirmDelivery,
  DEMO,
  issuedIds,
  receiptsDescribed,
  sampleRange,
  toUnits,
  uniqueTag,
} from './support/receiving';

// STRATA-16, 61, 125 (lane 1A): the shared LAB station asks "Who is working here?" after
// sign-in, shows "Recording as <person>" in the top bar, credits work to that person, and signs
// them off without signing LAB out. Attribution only: LAB keeps its own permissions. Fictional
// fixtures from apps/api/seed/dev.sql: Alex Tester (Technician), Pat Example (found with
// Someone else…).

const chip = (page: Page, name: string) =>
  page.getByRole('button', { name: `Recording as ${name}. Sign off or switch person` });

async function expectPicker(page: Page) {
  await expect(page).toHaveURL(/\/who-is-working/);
  await expect(page.getByRole('heading', { level: 1, name: 'Who is working here?' })).toBeVisible();
}

test('LAB picks who is working, receives under that name, then signs off back to the picker', async ({
  page,
}) => {
  const description = uniqueTag('S16-lab');
  await signInAsLabStation(page, { person: null });

  // Nothing attributable opens until someone is picked; the station then returns where it was.
  await page.goto('/receiving-log/new');
  await expectPicker(page);
  await expect(
    page.getByText(
      'Signed in as LAB. Receipts, moves and labels are recorded under the name you pick, until you sign off.',
    ),
  ).toBeVisible();
  await expect(page.getByRole('link', { name: 'How LAB stations work' })).toBeVisible();
  const staff = page.getByRole('list', { name: 'Receiving lab staff' });
  await staff.getByRole('button', { name: /Alex Tester/ }).click();
  await expect(page).toHaveURL(/\/receiving-log\/new$/);
  await expect(chip(page, 'Alex Tester')).toBeVisible();

  // A reload of the same tab keeps the person.
  await page.reload();
  await expect(chip(page, 'Alex Tester')).toBeVisible();

  // Received by starts blank on LAB even with someone picked (T8/AC5, STRATA-107): the picked
  // person is chosen explicitly, like anyone else.
  const receiver = page.getByRole('combobox', { name: 'Received by', exact: true });
  await expect(receiver).toHaveValue('');
  await receiver.fill('AT');
  await page.getByRole('option', { name: /^AT · Alex Tester/ }).click();
  await expect(receiver).toHaveValue(/^AT · Alex Tester/);
  await chooseDemoProject(page);
  await page.getByLabel('Description (optional)').fill(description);
  await toUnits(page);
  await addHole(bucket(page, 1), 'TH26-01');
  await sampleRange(bucket(page, 1), 'TH26-01', 'G1', 'S12');
  await confirmDelivery(page);
  expect(await issuedIds(page)).toHaveLength(1);

  // Recorded as LAB for Alex: the account is the station, the receiver the picked person.
  const [receipt] = await receiptsDescribed(description);
  expect(receipt).toMatchObject({
    account_user_id: E2E_LAB_STATION_ID,
    receiver_user_id: DEMO.at,
    receiver_initials_snapshot: 'AT',
  });

  // Sign off is first in the person menu; LAB stays signed in.
  await chip(page, 'Alex Tester').click();
  const menu = page.getByRole('menu');
  await expect(menu.getByRole('menuitem').first()).toHaveText(/Sign off Alex Tester/);
  await menu.getByRole('menuitem', { name: /Sign off Alex Tester/ }).click();
  await expectPicker(page);
  await expect(chip(page, 'Alex Tester')).toHaveCount(0);
  const me = await page.request.get('/api/me');
  expect(me.status()).toBe(200);

  // With nobody picked, any app page sends the station back to the picker.
  await page.goto('/sample-storage');
  await expectPicker(page);
});

test('LAB records as someone else found by search, and switches person from the chip', async ({
  page,
}) => {
  await signInAsLabStation(page, { person: null });
  await page.goto('/');
  await expectPicker(page);
  await page.getByRole('button', { name: 'Someone else…' }).click();
  await page.getByRole('searchbox', { name: 'Find a person' }).fill('Pat');
  await page
    .getByRole('list', { name: 'Matching staff' })
    .getByRole('button', { name: /Pat Example/ })
    .click();
  await expect(page).toHaveURL(/\/$/);
  await expect(chip(page, 'Pat Example')).toBeVisible();

  await chip(page, 'Pat Example').click();
  await page.getByRole('menuitemradio', { name: /Alex Tester/ }).click();
  await expect(chip(page, 'Alex Tester')).toBeVisible();
  await expect(page).toHaveURL(/\/$/);
});

test('a personal account has no chip and never sees the picker', async ({ page }) => {
  await signInAs(page, 'at');
  await page.goto('/who-is-working');
  await expect(page).toHaveURL(/\/$/);
  await expect(page.getByRole('button', { name: /^Recording as/ })).toHaveCount(0);
});
