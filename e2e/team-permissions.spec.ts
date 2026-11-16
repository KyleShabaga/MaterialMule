import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// STRATA-85 / MM-AO05: on the project's Team & permissions tab a Lead Project Engineer adds a
// supporting engineer to the team and assigns her as a scoped reviewer, by keyboard where it
// matters, and sees both responsibilities on one row of People. A colleague without authority
// sees the same people, no controls, the server's reasons, and is refused by the API directly.
// Fictional data only: the project number is unique per run and viewport; Dana Example is made
// eligible for "Concrete field" review by the admin first.

const CSRF = { 'x-materialmule-csrf': '1' };
const PE_ID = '00000000-0000-4000-8000-000000000101';
const DE_ID = '00000000-0000-4000-8000-000000000105';

/** Opens one entry of People › Add a person. */
async function addPerson(page: Page, item: string) {
  await page
    .getByRole('region', { name: 'People' })
    .getByRole('button', { name: 'Add a person' })
    .click();
  await page.getByRole('menuitem', { name: item }).click();
}

test('the lead adds a team member who also reviews; others see it read-only', async ({
  page,
}, testInfo) => {
  const projectNumber = `AO5-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;
  const projectId = await withDatabase(async (client) => {
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
       VALUES ($1, 'Example Ridge', 'Example Client', $2) RETURNING id`,
      [projectNumber, PE_ID],
    );
    return rows[0]!.id;
  });

  await signInAs(page, 'admin');
  const eligible = await page.request.post(`/api/staff/${DE_ID}/reviewer-eligibility`, {
    headers: CSRF,
    data: {
      scopeCode: 'concrete_field',
      reason: 'Qualified field reviewer',
      idempotencyKey: crypto.randomUUID(),
    },
  });
  // The other viewport may have granted it already.
  if (eligible.status() !== 201) {
    expect(((await eligible.json()) as { code: string }).code).toBe('already_granted');
  }

  await signInAs(page, 'pe');
  await page.goto(`/projects/${projectId}/team`);
  const people = page.getByRole('region', { name: 'People' });
  await expect(people).toContainText('Job titles and team places grant no approvals.');

  // Add Dana to the team, keyboard only inside the dialog.
  await addPerson(page, 'Add to the team…');
  const addTeam = page.getByRole('dialog', { name: 'Add to the team' });
  const person = addTeam.getByRole('combobox', { name: 'Add a team member' });
  await person.fill('DE');
  await expect(page.getByRole('option', { name: /^DE · Dana Example/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await person.press('Enter');
  await addTeam.getByLabel('Reason (required)').fill('Supporting engineer on site');
  await addTeam.getByRole('button', { name: 'Add to team' }).press('Enter');
  await expect(page.getByText('Added Dana Example to the team.')).toBeVisible();
  await expect(addTeam).toBeHidden();
  await expect(people.getByRole('row').filter({ hasText: 'Dana Example' })).toContainText(
    'Team member',
  );

  // Assign her as the Concrete field reviewer.
  await addPerson(page, 'Assign a reviewer…');
  const assign = page.getByRole('dialog', { name: 'Assign a reviewer' });
  await assign.getByRole('combobox', { name: 'Review scope' }).click();
  await page.getByRole('option', { name: 'Concrete field' }).click();
  await assign.getByRole('combobox', { name: 'Reviewer' }).click();
  await page.getByRole('option', { name: /Dana Example/ }).click();
  await assign.getByLabel('Reason (required)').fill('Reviews field reports');
  await assign.getByRole('button', { name: 'Assign reviewer' }).click();
  await expect(page.getByText('Assigned Dana Example as reviewer.')).toBeVisible();

  // Both responsibilities on one person; grants listed apart.
  const dana = people.getByRole('row').filter({ hasText: 'Dana Example' });
  await expect(dana).toContainText('Team member · Reviewer, Concrete field');
  await expect(page.getByRole('region', { name: 'History' })).toContainText(
    'Pat Example assigned Dana Example as reviewer, Concrete field',
  );
  await expect(
    page
      .getByRole('region', { name: 'Your permissions here' })
      .getByRole('listitem')
      .filter({ hasText: 'Add or remove team members' }),
  ).toContainText('As Lead Project Engineer');

  // A colleague with no authority here: same people, no controls, and the reason why.
  await signInAs(page, 'at');
  await page.goto(`/projects/${projectId}/team`);
  await expect(people.getByRole('row').filter({ hasText: 'Dana Example' })).toContainText(
    'Reviewer, Concrete field',
  );
  await expect(people.getByRole('button', { name: 'Add a person' })).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Needs review' })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Your permissions here' })
      .getByRole('listitem')
      .filter({ hasText: 'Assign or remove reviewers' }),
  ).toContainText(/Allowed for: .*Lead Project Engineer/);

  // The server refuses the same change asked for directly.
  const refused = await page.request.post(`/api/projects/${projectId}/team-members`, {
    headers: CSRF,
    data: { userId: DE_ID, reason: 'Trying anyway', idempotencyKey: crypto.randomUUID() },
  });
  expect(refused.status()).toBe(403);

  // MTR-21: the person drawer lists what Pat may do here, with the source of each.
  await people.getByRole('row').filter({ hasText: 'Pat Example' }).click();
  await expect(page).toHaveURL(new RegExp(`open=${PE_ID}`));
  const patPermissions = page.getByRole('list', { name: 'Permissions of Pat Example' });
  await expect(
    patPermissions.getByRole('listitem').filter({ hasText: 'Add or remove team members' }),
  ).toContainText('As Lead Project Engineer');
  await expect(page.getByRole('button', { name: 'Remove from the team' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page).not.toHaveURL(/open=/);
});
