import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';

// MTR-25: a new Lead Project Engineer is asked to keep or revoke the grants the project already
// has. Fictional data only: a project unique per run and viewport, first led by Pat Example, with
// Jamie Song as acceptance delegate and Concrete field report issuer; an admin hands it to Dana.

const CSRF = { 'x-materialmule-csrf': '1' };
const PAT = '00000000-0000-4000-8000-000000000101';
const DANA = '00000000-0000-4000-8000-000000000105';
const JAMIE = '00000000-0000-4000-8000-000000000107';

async function created(page: Page, path: string, data: object) {
  const response = await page.request.post(path, { headers: CSRF, data });
  expect(response.status(), await response.text()).toBeLessThan(300);
  return (await response.json()) as { id: string };
}

test('the new lead keeps one inherited grant and revokes another; the request resolves', async ({
  page,
}, testInfo) => {
  const projectNumber = `MTR25-${testInfo.project.name.startsWith('phone') ? 'P' : 'D'}${Date.now()}`;

  // Alex adds the project nominating Pat; the admin confirms with no reason (MISC-03).
  await signInAs(page, 'at');
  const { id: projectId } = await created(page, '/api/projects', {
    projectNumber,
    name: 'Example Ridge',
    client: 'Example Client',
    leadNomineeUserId: PAT,
  });
  await signInAs(page, 'admin');
  const nominations = (await (
    await page.request.get(`/api/projects/${projectId}/lead-nominations`)
  ).json()) as { pending: { id: string } };
  await created(
    page,
    `/api/projects/${projectId}/lead-nominations/${nominations.pending.id}/confirm`,
    {},
  );

  // Pat grants Jamie two authorizations.
  await signInAs(page, 'pe');
  await created(page, `/api/projects/${projectId}/acceptance-delegates`, {
    delegateUserId: JAMIE,
    reason: 'Covers acceptance while Pat is on site',
    idempotencyKey: crypto.randomUUID(),
  });
  await created(page, `/api/projects/${projectId}/report-issuers`, {
    issuerUserId: JAMIE,
    scopeCode: 'concrete_field',
    reason: 'Signs field reports',
    idempotencyKey: crypto.randomUUID(),
  });

  // The admin hands the project to Dana.
  await signInAs(page, 'admin');
  const { version } = (await (await page.request.get(`/api/projects/${projectId}`)).json()) as {
    version: number;
  };
  const patched = await page.request.patch(`/api/projects/${projectId}`, {
    headers: CSRF,
    data: { version, leadProjectEngineerId: DANA, reason: 'Pat moved to another office' },
  });
  expect(patched.status()).toBe(200);

  // Dana's inbox has one "Review inherited grants" request; it opens Team & Permissions.
  await signInAs(page, 'de');
  await page.goto('/action-requests');
  const request = page.getByRole('listitem', {
    name: `Review inherited grants on ${projectNumber}`,
  });
  await expect(request).toBeVisible();
  await request.getByRole('link', { name: 'Open' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/team`));

  const section = page.getByRole('region', { name: 'Inherited grants to review' });
  await expect(section).toContainText('This project has a new Lead Project Engineer. 2 grants');
  const flagged = section.getByRole('list', { name: 'Grants needing review' });
  await expect(flagged.getByRole('listitem')).toHaveCount(2);
  await expect(flagged).toContainText('Needs review by new lead');
  // The badge also shows on the person's grants.
  await expect(
    page
      .getByRole('region', { name: 'People on this project' })
      .getByRole('row')
      .filter({ hasText: 'Jamie Song' }),
  ).toContainText('Acceptance delegate (Needs review by new lead)');

  // Keep the delegate (a reason is needed).
  await section.getByRole('button', { name: 'Keep Acceptance delegate · JS · Jamie Song' }).click();
  const keep = page.getByRole('dialog', { name: /^Keep Acceptance delegate/ });
  await keep.getByRole('button', { name: 'Keep' }).click();
  await expect(keep).toContainText('Enter a reason.');
  await keep.getByRole('textbox', { name: 'Reason' }).fill('Jamie still covers acceptance');
  await keep.getByRole('button', { name: 'Keep' }).click();
  await expect(
    page.getByRole('status').filter({ hasText: 'Kept Acceptance delegate' }),
  ).toBeVisible();
  await expect(flagged.getByRole('listitem')).toHaveCount(1);

  // Revoke the issuer grant.
  await section.getByRole('button', { name: /^Revoke Report issuer/ }).click();
  const revoke = page.getByRole('dialog', { name: /^Revoke Report issuer/ });
  await revoke.getByRole('textbox', { name: 'Reason' }).fill('Dana signs field reports now');
  await revoke.getByRole('button', { name: 'Revoke' }).click();
  await expect(section).toBeHidden();

  // History records the lead change and both reviews.
  const history = page.getByRole('region', { name: 'History' });
  await expect(history).toContainText(
    'Lead Project Engineer changed to DE · Dana Example by ADM · Admin (test) (Pat moved to another office)',
  );
  await expect(history).toContainText(
    'Inherited acceptance delegate grant of Jamie Song kept by DE · Dana Example (Jamie still covers acceptance)',
  );
  await expect(history).toContainText(
    'Inherited report issuer grant of Jamie Song revoked by DE · Dana Example (Dana signs field reports now)',
  );

  // The request is resolved.
  await page.goto('/action-requests');
  await expect(
    page.getByRole('listitem', { name: `Review inherited grants on ${projectNumber}` }),
  ).toHaveCount(0);
});
