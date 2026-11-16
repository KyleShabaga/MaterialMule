import { expect, test, type Page } from '@playwright/test';
import { signInAs } from './support/auth';
import { inboxRow, inboxUrl, openInboxItem } from './support/inbox';

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
  const title = `Review inherited grants on ${projectNumber}`;
  await page.goto(inboxUrl(projectNumber, { tab: 'requests' }));
  const request = inboxRow(page, title);
  await expect(request).toBeVisible();
  const item = await openInboxItem(page, request, title);
  await item.getByRole('link', { name: 'Review the grants' }).click();
  await expect(page).toHaveURL(new RegExp(`/projects/${projectId}/team`));

  const section = page.getByRole('region', { name: 'Inherited grants to review' });
  await expect(section).toContainText('This project has a new Lead Project Engineer. 2 grants');
  const flagged = section.getByRole('list', { name: 'Grants needing review' });
  await expect(flagged.getByRole('listitem')).toHaveCount(2);
  await expect(flagged).toContainText('Needs review by new lead');
  // The badge also shows on the person's grants.
  await expect(
    page
      .getByRole('region', { name: 'People', exact: true })
      .getByRole('row')
      .filter({ hasText: 'Jamie Song' }),
  ).toContainText(/Acceptance delegate.*Needs review by new lead/);

  // Keep the delegate (a reason is needed). STRATA-85: the decision is an inline reason form
  // and the outcome a toast.
  await section.getByRole('button', { name: 'Keep Acceptance delegate · Jamie Song' }).click();
  const keep = section.getByRole('form', { name: /^Keep Acceptance delegate/ });
  await keep.getByRole('button', { name: 'Keep grant' }).click();
  await expect(keep).toContainText('Enter a reason.');
  await keep.getByRole('textbox', { name: /Reason/ }).fill('Jamie still covers acceptance');
  await keep.getByRole('button', { name: 'Keep grant' }).click();
  await expect(page.getByText(/Kept Acceptance delegate/)).toBeVisible();
  await expect(flagged.getByRole('listitem')).toHaveCount(1);

  // End the issuer grant (Revoke on the earlier page).
  await section.getByRole('button', { name: /^End Report issuer/ }).click();
  const revoke = section.getByRole('form', { name: /^End Report issuer/ });
  await revoke.getByRole('textbox', { name: /Reason/ }).fill('Dana signs field reports now');
  await revoke.getByRole('button', { name: 'End grant' }).click();
  await expect(section).toBeHidden();

  // History records the lead change and both reviews.
  const history = page.getByRole('region', { name: 'History' });
  // STRATA-85: the paged History says who did what, with the reason quoted.
  for (const text of [
    'Admin (test) appointed Dana Example as Lead Project Engineer',
    'Pat moved to another office',
    'Dana Example kept Jamie Song’s inherited acceptance delegate grant',
    'Jamie still covers acceptance',
    'Dana Example ended Jamie Song’s inherited report issuer grant',
    'Dana signs field reports now',
  ]) {
    await expect(history).toContainText(text);
  }

  // The request is resolved.
  await page.goto(inboxUrl(projectNumber, { tab: 'requests' }));
  await expect(page.getByRole('heading', { level: 1, name: 'Inbox' })).toBeVisible();
  await expect(inboxRow(page, title)).toHaveCount(0);
});
