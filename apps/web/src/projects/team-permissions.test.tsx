import type {
  AcceptanceDelegates,
  MeResponse,
  ProjectCapabilities,
  ProjectDetail,
  ProjectReportIssuers,
  ProjectReviewers,
  ProjectTeam,
  ReviewerAssignment,
  TeamMember,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Team & Permissions (MM-AO05). Fictional data only: DEMO-2601, Lead Project Engineer Pat Example,
// Taylor Member (supporting engineer who also reviews), Dakota Delegate and Iris Issuer.

const PROJECT_ID = '00000000-0000-4000-8000-000000000205';
const BASE = `/api/projects/${PROJECT_ID}`;
const PE = { id: 'u-pe', displayName: 'Pat Example', initials: 'PE' };
const snap = (userId: string, name: string, initials: string) => ({ userId, name, initials });
const PAT = snap('u-pe', 'Pat Example', 'PE');
const TAYLOR = snap('u-tm', 'Taylor Member', 'TM');
const RILEY = snap('u-rr', 'Riley Reviewer', 'RR');
const FIELD = { code: 'concrete_field', label: 'Concrete field' };
const STRENGTH = { code: 'concrete_strength', label: 'Concrete strength' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project_access.read', 'acceptance_delegation.read'],
  sessionExpiresAt: '2026-10-30T06:00:00.000Z',
  ...overrides,
});

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: PE,
  serverFolderPath: null,
  version: 1,
  numberLocked: true,
  leadNomination: null,
  canEdit: false,
  canChangeLeadProjectEngineer: false,
  unitCount: 0,
  inStockUnitCount: 0,
  testHoles: [],
  receipts: [],
  receiptCount: 0,
  ...overrides,
});

const history = (id: string, reason: string) => ({
  id,
  startedBy: PAT,
  startedAt: '2026-10-29T15:00:00.000Z',
  startReason: reason,
  endedBy: null,
  endedAt: null,
  endReason: null,
});

const member = (person = TAYLOR): TeamMember => ({
  ...history(`tm-${person.userId}`, 'Supporting engineer on site'),
  person,
});

const reviewer = (person = TAYLOR, scope = FIELD): ReviewerAssignment => ({
  ...history(`ra-${person.userId}-${scope.code}`, 'Reviews field reports'),
  reviewer: person,
  scope,
  effective: true,
  blockedReason: null,
});

const team = (canManage: boolean, active = [member()]): ProjectTeam => ({
  projectId: PROJECT_ID,
  canManage,
  active,
  history: [],
  historyTotal: 0,
});

const reviewers = (canManage: boolean, active = [reviewer()]): ProjectReviewers => ({
  projectId: PROJECT_ID,
  canManage,
  active,
  history: [],
  historyTotal: 0,
});

const issuers = (canManage: boolean): ProjectReportIssuers => ({
  projectId: PROJECT_ID,
  canManage,
  active: [
    {
      ...history('ig-1', 'Signs field reports while the lead is away'),
      issuer: snap('u-ii', 'Iris Issuer', 'II'),
      scope: FIELD,
      approvalReference: 'QA-0001',
      expiresAt: null,
      revocationKind: null,
      effective: true,
      blockedReason: null,
    },
  ],
  history: [],
  historyTotal: 0,
});

const delegates = (canManage: boolean): AcceptanceDelegates => ({
  projectId: PROJECT_ID,
  canManage,
  active: [
    {
      id: 'ad-1',
      delegate: snap('u-dd', 'Dakota Delegate', 'DD'),
      grantedBy: PAT,
      grantedAt: '2026-10-29T15:00:00.000Z',
      grantReason: 'Covers acceptance',
      revokedBy: null,
      revokedAt: null,
      revokeReason: null,
    },
  ],
  history: [],
});

const capabilities = (lead: boolean): ProjectCapabilities => ({
  projectId: PROJECT_ID,
  involvement: lead ? ['lead_project_engineer'] : [],
  issuerScopes: lead ? [FIELD, STRENGTH] : [],
  reviewerScopes: [],
  capabilities: [
    {
      action: 'project_team.manage',
      allowed: lead,
      sources: lead ? ['lead_project_engineer'] : [],
      blocked: lead
        ? null
        : { code: 'not_permitted', grantedBy: ['lead_project_engineer', 'admin'] },
    },
    {
      action: 'program.close',
      allowed: lead,
      sources: lead ? ['lead_project_engineer'] : [],
      blocked: lead ? null : { code: 'not_permitted', grantedBy: ['lead_project_engineer'] },
    },
  ],
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  lead: boolean;
  team: ProjectTeam;
  reviewers: ProjectReviewers;
}

function stubApi(world: World, writes: (url: URL, init: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return writes(url, init!) ?? json(500, {});
    switch (url.pathname) {
      case '/api/health':
        return json(200, { status: 'ok' });
      case BASE:
        return json(200, detail());
      case `${BASE}/capabilities`:
        return json(200, capabilities(world.lead));
      case `${BASE}/people`:
        return json(200, {
          projectId: PROJECT_ID,
          people: [
            {
              userId: 'u-tm',
              initials: 'TM',
              name: 'Taylor Member',
              jobTitle: { value: 'Field Technologist', source: 'microsoft' },
              ...capabilities(false),
              projectId: undefined,
            },
          ],
        });
      case `${BASE}/team-members`:
        return json(200, world.team);
      case `${BASE}/reviewer-assignments`:
        return json(200, world.reviewers);
      case `${BASE}/report-issuers`:
        return json(200, issuers(world.lead));
      case `${BASE}/acceptance-delegates`:
        return json(200, delegates(world.lead));
      case `${BASE}/lead-nominations`:
        return json(200, {
          projectId: PROJECT_ID,
          hasLead: true,
          pending: null,
          history: [],
          canNominate: false,
          canDecide: false,
          canWithdraw: false,
        });
      case '/api/review-scopes':
        return json(200, [FIELD, STRENGTH]);
      case '/api/review-scopes/concrete_strength/eligible-reviewers':
        return json(200, [
          { id: 'u-rr', initials: 'RR', displayName: 'Riley Reviewer', position: null },
        ]);
      default:
        return json(404, { code: 'not_found' });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderPage(user = me()) {
  const router = createMemoryRouter(routes, { initialEntries: [`/projects/${PROJECT_ID}/team`] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
}

const calls = (fetchMock: ReturnType<typeof stubApi>, pathname: string, method = 'GET') =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      new URL(String(input), 'http://localhost').pathname === pathname &&
      (init?.method ?? 'GET') === method,
  );

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Team & Permissions (MM-AO05)', () => {
  it('AC1: a supporting engineer who also reviews shows both responsibilities, and grants apart', async () => {
    stubApi({ lead: false, team: team(false), reviewers: reviewers(false) }, () => undefined);
    renderPage(me({ id: 'u-tech', displayName: 'Terry Tech', initials: 'TT' }));

    const people = await screen.findByRole('region', { name: 'People on this project' });
    const taylor = within(people).getByText('TM · Taylor Member').closest('tr')!;
    const cells = within(taylor).getAllByRole('cell');
    // MTR-21: their effective job title, and their permissions here with each one's source.
    expect(cells[1]).toHaveTextContent('Field Technologist');
    expect(cells[2]).toHaveTextContent('Team member; Reviewer: Concrete field');
    expect(cells[3]).toHaveTextContent('—');
    expect(cells[4]).toHaveTextContent('Permissions here (none)');
    expect(
      within(within(taylor).getByRole('list', { name: 'Permissions of Taylor Member' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Add or remove team members: No · Allowed for: Lead Project Engineer, Administrator',
      'Close lab programs: No · Allowed for: Lead Project Engineer',
    ]);
    const iris = within(people).getByText('II · Iris Issuer').closest('tr')!;
    expect(within(iris).getAllByRole('cell')[1]).toHaveTextContent('—');
    expect(within(iris).getAllByRole('cell')[3]).toHaveTextContent('Report issuer: Concrete field');
    expect(within(people).getByText('DD · Dakota Delegate').closest('tr')).toHaveTextContent(
      'Acceptance delegate',
    );

    // Read-only for someone the server doesn't let manage: no controls at all.
    expect(screen.queryByRole('form', { name: 'Add team member' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Assign reviewer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Remove / })).not.toBeInTheDocument();

    // The server's own explanation of what they can't do, and who could.
    const permissions = screen.getByRole('region', { name: 'Your permissions here' });
    expect(permissions).toHaveTextContent('You have no assignment on this project.');
    const close = within(permissions).getByText('Close lab programs').closest('tr')!;
    expect(close).toHaveTextContent('No');
    expect(close).toHaveTextContent('Allowed for: Lead Project Engineer.');

    const timeline = screen.getByRole('list', { name: 'Team and permissions history' });
    expect(timeline).toHaveTextContent(
      'Team member Taylor Member added by PE · Pat Example (Supporting engineer on site)',
    );
  });

  it('AC2: the lead assigns a second reviewer for another scope; the list shows the server’s result', async () => {
    const world: World = { lead: true, team: team(true), reviewers: reviewers(true) };
    const fetchMock = stubApi(world, (url, init) => {
      if (url.pathname === `${BASE}/reviewer-assignments` && init.method === 'POST') {
        world.reviewers = reviewers(true, [reviewer(), reviewer(RILEY, STRENGTH)]);
        return json(201, world.reviewers);
      }
      return undefined;
    });
    renderPage();
    const user = userEvent.setup();

    const section = await screen.findByRole('region', { name: 'Review responsibilities' });
    const form = within(section).getByRole('form', { name: 'Assign reviewer' });
    expect(within(form).getByRole('button', { name: 'Assign reviewer' })).toBeDisabled();
    await user.selectOptions(within(form).getByLabelText('Review scope'), 'concrete_strength');
    await user.selectOptions(await within(form).findByLabelText('Reviewer'), 'u-rr');
    await user.type(within(form).getByLabelText('Reason'), 'Strength reviewer for the program');
    await user.click(within(form).getByRole('button', { name: 'Assign reviewer' }));

    expect(await screen.findByText('Assigned Riley Reviewer.')).toBeInTheDocument();
    const [, init] = calls(fetchMock, `${BASE}/reviewer-assignments`, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      reviewerUserId: 'u-rr',
      scopeCode: 'concrete_strength',
      reason: 'Strength reviewer for the program',
    });
    expect(
      within(section).getByRole('list', { name: 'Reviewers: Concrete field' }),
    ).toHaveTextContent('TM · Taylor Member');
    expect(
      within(section).getByRole('list', { name: 'Reviewers: Concrete strength' }),
    ).toHaveTextContent('RR · Riley Reviewer');
    // Capabilities are re-read after the change.
    expect(calls(fetchMock, `${BASE}/capabilities`).length).toBeGreaterThan(1);
  });

  it('AC3: authority revoked mid-session: the refusal hides the controls and claims no success', async () => {
    const world: World = { lead: true, team: team(true), reviewers: reviewers(true) };
    stubApi(world, (url, init) => {
      if (url.pathname.startsWith(`${BASE}/team-members/`) && init.method === 'DELETE') {
        // Meanwhile an admin removed this person as lead.
        world.lead = false;
        world.team = team(false);
        world.reviewers = reviewers(false);
        return json(403, { code: 'forbidden' });
      }
      return undefined;
    });
    renderPage();
    const user = userEvent.setup();

    const section = await screen.findByRole('region', { name: 'Project team' });
    await user.click(within(section).getByRole('button', { name: 'Remove Taylor Member' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove Taylor Member from the team?' });
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));
    expect(dialog).toHaveTextContent('Enter a reason.');
    await user.type(within(dialog).getByLabelText('Reason'), 'Left the project');
    await user.click(within(dialog).getByRole('button', { name: 'Remove' }));

    expect(
      await screen.findByText(/You can no longer make this change here. Nothing was saved/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Removed Taylor Member/)).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(
        screen.queryByRole('button', { name: 'Remove Taylor Member' }),
      ).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('form', { name: 'Add team member' })).not.toBeInTheDocument();
    expect(within(section).getByText('TM · Taylor Member')).toBeInTheDocument();
    const permissions = screen.getByRole('region', { name: 'Your permissions here' });
    expect(
      within(permissions).getByText('Add or remove team members').closest('tr'),
    ).toHaveTextContent('No');
  });

  it('keeps the person’s entries when the connection drops', async () => {
    const world: World = { lead: true, team: team(true, []), reviewers: reviewers(true, []) };
    stubApi(world, () => {
      throw new TypeError('Failed to fetch');
    });
    renderPage();
    const user = userEvent.setup();

    const section = await screen.findByRole('region', { name: 'Review responsibilities' });
    expect(section).toHaveTextContent('No designated reviewers.');
    const form = within(section).getByRole('form', { name: 'Assign reviewer' });
    await user.selectOptions(within(form).getByLabelText('Review scope'), 'concrete_strength');
    await user.selectOptions(await within(form).findByLabelText('Reviewer'), 'u-rr');
    await user.type(within(form).getByLabelText('Reason'), 'Strength reviewer');
    await user.click(within(form).getByRole('button', { name: 'Assign reviewer' }));

    expect(await screen.findByText(/couldn't be reached/)).toBeInTheDocument();
    expect(within(form).getByLabelText('Reason')).toHaveValue('Strength reviewer');
    expect(within(form).getByLabelText('Reviewer')).toHaveValue('u-rr');
  });

  it('is linked from the project page for personal accounts', async () => {
    stubApi({ lead: true, team: team(true), reviewers: reviewers(true) }, () => undefined);
    const router = createMemoryRouter(routes, { initialEntries: [`/projects/${PROJECT_ID}`] });
    render(
      <SessionContext.Provider
        value={{
          session: { status: 'active', me: me() },
          refresh: vi.fn(async () => undefined),
          signOut: vi.fn(async () => undefined),
        }}
      >
        <RouterProvider router={router} />
      </SessionContext.Provider>,
    );
    const link = await screen.findByRole('link', { name: 'Team & Permissions' });
    expect(link).toHaveAttribute('href', `/projects/${PROJECT_ID}/team`);
  });
});
