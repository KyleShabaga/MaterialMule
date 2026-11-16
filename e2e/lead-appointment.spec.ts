import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';

// MM-AO04 / STRATA-85: a project added while receiving waits for its Lead Project Engineer. The
// nomination grants nobody authority: the nominee still can't manage the team, and the API says
// so. An admin finds the project under "Waiting for a lead" and confirms on the Team &
// permissions tab; a reason is optional to confirm (MISC-03) and required to reject. Fictional
// data only; the project number is unique per run and viewport.

const CSRF = { 'x-materialmule-csrf': '1' };

test('a nominated lead waits for an admin, who confirms without a reason', async ({
  page,
}, testInfo) => {
  const projectNumber = `AO4-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;

  // Alex adds the project and nominates Pat; that makes nobody the lead.
  await signInAs(page, 'at');
  const staff = (await (await page.request.get('/api/staff/active')).json()) as {
    id: string;
    displayName: string;
  }[];
  const pat = staff.find((s) => s.displayName === 'Pat Example')!;
  const created = await page.request.post('/api/projects', {
    headers: CSRF,
    data: {
      projectNumber,
      name: 'Example Ridge',
      client: 'Example Client',
      leadNomineeUserId: pat.id,
      nominationNote: 'Pat ran phase 1',
    },
  });
  expect(created.status()).toBe(201);
  const projectId = ((await created.json()) as { id: string }).id;

  await page.goto(`/projects/${projectId}/team`);
  const section = page.getByRole('region', { name: 'Leadership' });
  await expect(section).toContainText('Waiting for a lead');
  await expect(section).toContainText('Nomination waiting for an admin');
  await expect(section).toContainText('Pat Example nominated by you');
  await expect(section).toContainText('Note for the admin: “Pat ran phase 1”');
  await expect(section).toContainText('An admin confirms it. Nominating gives nobody authority.');
  // Only an admin decides.
  await expect(section.getByRole('button', { name: /^Confirm / })).toHaveCount(0);

  // The nominee has no authority yet: no controls, and the API refuses.
  await signInAs(page, 'pe');
  await page.goto(`/projects/${projectId}/team`);
  await expect(
    page.getByRole('region', { name: 'People' }).getByRole('button', { name: 'Add a person' }),
  ).toHaveCount(0);
  const refused = await page.request.post(`/api/projects/${projectId}/team-members`, {
    headers: CSRF,
    data: { userId: pat.id, reason: 'Not yet the lead', idempotencyKey: crypto.randomUUID() },
  });
  expect(refused.status()).toBe(403);

  // The admin finds it under "Waiting for a lead" and decides on the Team tab.
  await signInAs(page, 'admin');
  await page.goto(`/projects/${projectId}/team`);
  const adminSection = page.getByRole('region', { name: 'Leadership' });
  await expect(adminSection).toContainText('Nomination waiting for you, as an admin');
  const decision = adminSection.getByRole('form', { name: 'Decide the nomination' });
  await expect(decision).toContainText('Needed to reject. Optional when you confirm.');
  // Rejecting needs a reason: nothing is sent without one.
  await decision.getByRole('button', { name: 'Reject' }).click();
  await expect(decision).toContainText('Enter a reason to reject.');
  await expect(adminSection).toContainText('Waiting for a lead');
  // Confirm with the reason left blank.
  await decision.getByRole('button', { name: 'Confirm Pat Example as lead' }).click();
  await expect(page.getByText('Pat Example is now the Lead Project Engineer.')).toBeVisible();
  await expect(adminSection).toContainText('Pat Example · Lead Project Engineer');
  await adminSection.getByRole('button', { name: /Nomination history/ }).click();
  await expect(adminSection.getByRole('list', { name: 'Nomination history' })).toContainText(
    'Pat Example: Confirmed by',
  );
  await expect(page.getByRole('region', { name: 'History' })).toContainText(
    'appointed Pat Example as Lead Project Engineer',
  );
});
