import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { inboxRow, inboxUrl, openInboxItem } from './support/inbox';

// MISC-07 / STRATA-85: anyone signed in with a personal account joins a project team themselves, pending
// the Lead Project Engineer's acceptance. Fictional data only: a project unique per run and
// viewport, led by Pat Example; Jamie Song is accepted, Jordan Smith declined and asks again.
// The shared LAB station is refused by the API (team-join.integration.test.ts).

const CSRF = { 'x-materialmule-csrf': '1' };
const PAT = '00000000-0000-4000-8000-000000000101';

async function projectLedByPat(page: Page, projectNumber: string): Promise<string> {
  await signInAs(page, 'at');
  const created = await page.request.post('/api/projects', {
    headers: CSRF,
    data: {
      projectNumber,
      name: 'Example Ridge',
      client: 'Example Client',
      leadNomineeUserId: PAT,
    },
  });
  expect(created.status()).toBe(201);
  const projectId = ((await created.json()) as { id: string }).id;
  await signInAs(page, 'admin');
  const nominations = (await (
    await page.request.get(`/api/projects/${projectId}/lead-nominations`)
  ).json()) as { pending: { id: string } };
  const confirmed = await page.request.post(
    `/api/projects/${projectId}/lead-nominations/${nominations.pending.id}/confirm`,
    { headers: CSRF, data: {} },
  );
  expect(confirmed.status()).toBe(200);
  return projectId;
}

test('self-join: pending, accepted by the lead; a declined person may ask again', async ({
  page,
}, testInfo) => {
  const projectNumber = `MISC07-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;
  const projectId = await projectLedByPat(page, projectNumber);
  const people = page.getByRole('region', { name: 'People' });
  const review = page.getByRole('region', { name: 'Needs review' });
  const joining = page.getByRole('region', { name: 'Joining the team' });

  // Jamie joins: on the team at once, pending acceptance.
  await signInAs(page, 'js-eng');
  await page.goto(`/projects/${projectId}/team`);
  await joining.getByRole('button', { name: 'Request to join this team' }).click();
  await expect(page.getByText(/^You joined the team\./)).toBeVisible();
  await expect(joining).toContainText('Pending LPE acceptance');
  await expect(people.getByRole('row').filter({ hasText: 'Jamie Song' })).toContainText(
    'Team member · Pending LPE acceptance',
  );
  await expect(joining.getByRole('button', { name: 'Request to join this team' })).toHaveCount(0);

  // Pat is told, opens it and accepts.
  await signInAs(page, 'pe');
  const title = `Team join request on ${projectNumber}`;
  await page.goto(inboxUrl(projectNumber, { tab: 'requests' }));
  const request = inboxRow(page, title);
  await expect(request).toBeVisible();
  const item = await openInboxItem(page, request, title);
  await item.getByRole('link', { name: 'Review the join request' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/team`));
  // Accepting needs no reason (MISC-07).
  await review.getByRole('button', { name: 'Accept Jamie Song' }).click();
  await expect(page.getByText('Jamie Song is accepted on the team.')).toBeVisible();
  await expect(people.getByRole('row').filter({ hasText: 'Jamie Song' })).not.toContainText(
    'Pending LPE acceptance',
  );

  // Jordan joins; Pat declines with a reason.
  await signInAs(page, 'js-tech');
  await page.goto(`/projects/${projectId}/team`);
  await joining.getByRole('button', { name: 'Request to join this team' }).click();
  await expect(joining).toContainText('Pending LPE acceptance');
  await signInAs(page, 'pe');
  await page.goto(`/projects/${projectId}/team`);
  await review.getByRole('button', { name: 'Decline Jordan Smith' }).click();
  const decline = review.getByRole('form', { name: 'Decline Jordan Smith?' });
  await decline.getByRole('button', { name: 'Decline Jordan Smith' }).click();
  await expect(decline).toContainText('Enter a reason.');
  await decline
    .getByRole('textbox', { name: 'Reason (required)' })
    .fill('Not working on this project');
  await decline.getByRole('button', { name: 'Decline Jordan Smith' }).click();
  await expect(page.getByText(/^Declined Jordan Smith/)).toBeVisible();
  await expect(people.getByRole('row').filter({ hasText: 'Jordan Smith' })).toHaveCount(0);

  // Jordan sees why, and asks again.
  await signInAs(page, 'js-tech');
  await page.goto(`/projects/${projectId}/team`);
  await expect(joining).toContainText('Your request to join was declined by Pat Example');
  await expect(joining).toContainText(': Not working on this project. You may ask again.');
  await joining.getByRole('button', { name: 'Request to join this team' }).click();
  await expect(joining).toContainText('Pending LPE acceptance');
});
