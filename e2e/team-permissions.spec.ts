import { expect, test } from '@playwright/test';
import { signInAs } from './support/auth';
import { withDatabase } from './support/db';

// MM-AO05: a Lead Project Engineer manages the project team and a scoped reviewer on Team &
// Permissions, by keyboard, and sees both responsibilities on the same supporting engineer. A
// colleague without authority sees the same people and no controls. Fictional data only: the
// project number is unique per run and viewport; Dana Example is made eligible for "Concrete
// field" review by the admin first.

const CSRF = { 'x-materialmule-csrf': '1' };
const PE_ID = '00000000-0000-4000-8000-000000000101';
const DE_ID = '00000000-0000-4000-8000-000000000105';

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
  await page.goto(`/projects/${projectId}`);
  await page.getByRole('link', { name: 'Team & Permissions' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Team & Permissions' })).toBeVisible();

  // Add Dana to the team, keyboard only.
  const team = page.getByRole('region', { name: 'Project team' });
  await expect(team).toContainText('No team members yet.');
  const person = team.getByRole('combobox', { name: 'Add a team member' });
  await person.fill('DE');
  await expect(page.getByRole('option', { name: /^DE · Dana Example/ })).toHaveAttribute(
    'aria-selected',
    'true',
  );
  await person.press('Enter');
  await team
    .getByRole('form', { name: 'Add team member' })
    .getByLabel('Reason')
    .fill('Supporting engineer on site');
  await team.getByRole('button', { name: 'Add to team' }).press('Enter');
  await expect(
    page.getByRole('status').filter({ hasText: 'Added Dana Example to the team.' }),
  ).toBeVisible();
  await expect(team.getByRole('list', { name: 'Team members' })).toContainText('DE · Dana Example');

  // Assign her as the Concrete field reviewer.
  const review = page.getByRole('region', { name: 'Review responsibilities' });
  const assign = review.getByRole('form', { name: 'Assign reviewer' });
  await assign.getByLabel('Review scope', { exact: true }).selectOption('concrete_field');
  await assign.getByLabel('Reviewer', { exact: true }).selectOption(DE_ID);
  await review
    .getByRole('form', { name: 'Assign reviewer' })
    .getByLabel('Reason')
    .fill('Reviews field reports');
  await assign.getByRole('button', { name: 'Assign reviewer' }).click();
  await expect(review.getByRole('list', { name: 'Reviewers: Concrete field' })).toContainText(
    'DE · Dana Example',
  );

  // Both responsibilities on one person; grants listed apart.
  const people = page.getByRole('region', { name: 'People on this project' });
  const dana = people.getByRole('row').filter({ hasText: 'DE · Dana Example' });
  await expect(dana).toContainText('Team member; Reviewer: Concrete field');
  await expect(page.getByRole('region', { name: 'History' })).toContainText(
    'Concrete field reports reviewer Dana Example assigned by PE · Pat Example (Reviews field reports)',
  );
  const mine = page.getByRole('region', { name: 'Your permissions here' });
  await expect(
    mine.getByRole('row').filter({ hasText: 'Add or remove team members' }),
  ).toContainText('As Lead Project Engineer');

  // A colleague with no authority here: same people, no controls, and the reason why.
  await signInAs(page, 'at');
  await page.goto(`/projects/${projectId}/team`);
  await expect(
    page.getByRole('region', { name: 'People on this project' }).getByRole('row', {
      name: /Dana Example/,
    }),
  ).toContainText('Reviewer: Concrete field');
  await expect(page.getByRole('form', { name: 'Add team member' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: /^Remove / })).toHaveCount(0);
  await expect(
    page
      .getByRole('region', { name: 'Your permissions here' })
      .getByRole('row')
      .filter({ hasText: 'Assign or remove reviewers' }),
  ).toContainText(/Allowed for: .*Lead Project Engineer/);

  // MTR-21: each person shows a job title column and expands to their permissions here, with the
  // source of each.
  const colleagues = page.getByRole('region', { name: 'People on this project' });
  await expect(colleagues.getByRole('columnheader', { name: 'Job title' })).toBeVisible();
  const pat = colleagues.getByRole('row').filter({ hasText: 'PE · Pat Example' });
  await pat.getByText(/^Permissions here/).click();
  const patPermissions = pat.getByRole('list', { name: 'Permissions of Pat Example' });
  await expect(
    patPermissions.getByRole('listitem').filter({ hasText: 'Add or remove team members' }),
  ).toHaveText('Add or remove team members: Yes · As Lead Project Engineer');
  const danaRow = colleagues.getByRole('row').filter({ hasText: 'DE · Dana Example' });
  await danaRow.getByText(/^Permissions here/).click();
  await expect(
    danaRow
      .getByRole('list', { name: 'Permissions of Dana Example' })
      .getByRole('listitem')
      .filter({ hasText: 'Add or remove team members' }),
  ).toHaveText(/: No · Allowed for: .*Lead Project Engineer/);
});
