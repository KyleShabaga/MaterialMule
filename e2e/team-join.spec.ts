import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MISC-07: anyone signed in with a personal account joins a project team themselves, pending
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
  const people = page.getByRole('region', { name: 'People on this project' });
  const joining = page.getByRole('region', { name: 'Joining the team' });

  // Jamie joins: on the team at once, pending acceptance.
  await signInAs(page, 'js-eng');
  await page.goto(`/projects/${projectId}/team`);
  await joining.getByRole('button', { name: 'Request to join this team' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'You joined the team.' })).toBeVisible();
  await expect(joining).toContainText('Pending LPE acceptance');
  await expect(people.getByRole('row').filter({ hasText: 'Jamie Song' })).toContainText(
    'Team member (Pending LPE acceptance)',
  );
  await expect(joining.getByRole('button', { name: 'Request to join this team' })).toHaveCount(0);

  // Pat is told, opens it and accepts.
  await signInAs(page, 'pe');
  await page.goto('/action-requests');
  const request = page.getByRole('listitem', { name: `Team join request on ${projectNumber}` });
  await expect(request).toBeVisible();
  await request.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/team`));
  await joining.getByRole('button', { name: 'Accept Jamie Song' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Jamie Song is accepted on the team.' }),
  ).toBeVisible();
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
  await joining.getByRole('button', { name: 'Decline Jordan Smith' }).click();
  const dialog = page.getByRole('dialog', { name: 'Decline Jordan Smith?' });
  await dialog.getByRole('button', { name: 'Decline' }).click();
  await expect(dialog).toContainText('Enter a reason.');
  await dialog.getByRole('textbox', { name: 'Reason' }).fill('Not working on this project');
  await dialog.getByRole('button', { name: 'Decline' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Declined Jordan Smith' })).toBeVisible();
  await expect(people.getByRole('row').filter({ hasText: 'Jordan Smith' })).toHaveCount(0);

  // Jordan sees why, and asks again.
  await signInAs(page, 'js-tech');
  await page.goto(`/projects/${projectId}/team`);
  await expect(joining).toContainText('Your request to join was declined by PE · Pat Example');
  await expect(joining).toContainText(': Not working on this project. You may ask again.');
  await joining.getByRole('button', { name: 'Request to join this team' }).click();
  await expect(joining).toContainText('Pending LPE acceptance');
});
