import { expect, test } from '@playwright/test';
import { expireSession, signInAsLabStation } from '../support/lab-station';
import {
  addHole,
  bucket,
  chooseDemoProject,
  chooseReceiver,
  issuedIds,
  openWizard,
  receiptsDescribed,
  summaryOf,
  uniqueTag,
} from '../support/receiving';

// MM-T18 critical path, scenarios that need MM-T11 (local autosaved drafts): the shared LAB
// station's session runs out mid-draft; the draft survives, signing in again returns to it with
// the same receiver, and confirming creates exactly one receipt. Uses a real shared_lab session
// (e2e/support/lab-station.ts), not a rewritten /api/me.

test(
  'LAB session expires mid-draft; after signing in again the same draft confirms once',
  { tag: '@critical' },
  async ({ page }) => {
    const description = uniqueTag('T18-expiry');
    const firstSession = await signInAsLabStation(page);
    await openWizard(page);
    await chooseReceiver(page, 'AT', /^AT · Alex Tester/);
    await chooseDemoProject(page);
    await page.getByLabel('Description (optional)').fill(description);
    await addHole(bucket(page, 1), 'TH26-01');
    await summaryOf(bucket(page, 1), 'TH26-01').getByLabel('Summary type').selectOption('all');
    await page.getByRole('button', { name: 'Next: Review' }).click();
    await expect(page.locator('.draft-status')).toContainText('Receiver: AT');

    // The month is up while the receipt is on screen.
    await expireSession(firstSession);
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const expired = page.getByRole('alert').filter({ hasText: 'LAB session has expired' });
    await expect(expired).toContainText('Your draft is saved. Sign in to confirm.');
    await expect(page.getByText(description)).toBeVisible();
    expect(await receiptsDescribed(description)).toEqual([]);
    await expired.getByRole('button', { name: 'Sign in' }).click();
    await expect(page).toHaveURL(/\/sign-in\?returnTo=%2Freceiving-log%2Fnew%3Fdraft%3D/);
    const returnTo = decodeURIComponent(new URL(page.url()).searchParams.get('returnTo')!);

    // The station signs in again and comes back to the same draft, receiver unchanged.
    await signInAsLabStation(page);
    await page.goto(returnTo);
    await expect(
      page.getByRole('region', { name: 'This draft was started for AT. Change receiver?' }),
    ).toBeVisible();
    await expect(page.getByText(description)).toBeVisible();
    await page.getByRole('button', { name: 'Confirm receipt' }).click();
    const [id] = await issuedIds(page);
    expect(await receiptsDescribed(description)).toMatchObject([
      { quantity: 1, readable_ids: [id], receiver_initials_snapshot: 'AT' },
    ]);
  },
);
