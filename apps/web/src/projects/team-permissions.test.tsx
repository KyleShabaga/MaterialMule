import type {
  AcceptanceDelegates,
  GrantReview,
  MeResponse,
  ProjectAccessHistory,
  ProjectCapabilities,
  ProjectDetail,
  ProjectGrantReviews,
  ProjectReportIssuers,
  ProjectReviewers,
  ProjectTeam,
  ProjectTeamJoinRequests,
  ReviewerAssignment,
  TeamMember,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Outlet, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '@/components/strata/toast';
import { SessionContext } from '../session/context';
import type { ProjectLayoutContext } from './project-layout-context';
import { TeamPermissionsPage } from './TeamPermissionsPage';

// Team & permissions tab (STRATA-85, MM-AO05). Rendered as the project layout's child route with
// a stub layout context. Fictional data only: DEMO-2601, Lead Project Engineer Pat Example,
// Taylor Member (supporting engineer who also reviews), Dakota Delegate, Iris Issuer and Jordan
// Lab (self-joined, pending acceptance).

const PROJECT_ID = '00000000-0000-4000-8000-000000000205';
const BASE = `/api/projects/${PROJECT_ID}`;
const PE = { id: 'u-pe', displayName: 'Pat Example', initials: 'PE' };
const snap = (userId: string, name: string, initials: string) => ({ userId, name, initials });
const PAT = snap('u-pe', 'Pat Example', 'PE');
const TAYLOR = snap('u-tm', 'Taylor Member', 'TM');
const JORDAN = snap('u-jl', 'Jordan Lab', 'JL');
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

const started = (id: string, reason: string) => ({
  id,
  startedBy: PAT,
  startedAt: '2026-10-29T15:00:00.000Z',
  startReason: reason,
  endedBy: null,
  endedAt: null,
  endReason: null,
});

const member = (person = TAYLOR): TeamMember => ({
  ...started(`tm-${person.userId}`, 'Supporting engineer on site'),
  person,
});

const reviewer = (person = TAYLOR, scope = FIELD): ReviewerAssignment => ({
  ...started(`ra-${person.userId}-${scope.code}`, 'Reviews field reports'),
  reviewer: person,
  scope,
  effective: true,
  blockedReason: null,
  approval: {
    id: `ap-${person.userId}-${scope.code}`,
    approvedBy: PAT,
    approvedAt: '2026-10-28T15:00:00.000Z',
    reason: null,
  },
  eligible: true,
  acceptedMember: true,
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
  canApprove: canManage,
  approvalHistory: [],
  active,
  history: [],
  historyTotal: 0,
});

const issuers = (canManage: boolean): ProjectReportIssuers => ({
  projectId: PROJECT_ID,
  canManage,
  active: [
    {
      ...started('ig-1', 'Signs field reports while the lead is away'),
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

const accessHistory = (): ProjectAccessHistory => ({
  projectId: PROJECT_ID,
  page: 1,
  pageSize: 20,
  total: 1,
  events: [
    {
      id: 'tm-u-tm:start',
      at: '2026-10-29T15:00:00.000Z',
      kind: 'team_member_added',
      subject: TAYLOR,
      by: PAT,
      scope: null,
      grantKind: null,
      reason: 'Supporting engineer on site',
    },
  ],
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

interface World {
  lead: boolean;
  team: ProjectTeam;
  reviewers: ProjectReviewers;
  issuers?: ProjectReportIssuers;
  grantReviews?: ProjectGrantReviews;
  joinRequests?: ProjectTeamJoinRequests;
}

function stubApi(world: World, writes: (url: URL, init: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (method !== 'GET') return writes(url, init!) ?? json(500, {});
    switch (url.pathname) {
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
        return json(200, world.issuers ?? issuers(world.lead));
      case `${BASE}/grant-reviews`:
        return world.grantReviews
          ? json(200, world.grantReviews)
          : json(404, { code: 'not_found' });
      case `${BASE}/team-join-requests`:
        return world.joinRequests
          ? json(200, world.joinRequests)
          : json(404, { code: 'not_found' });
      case `${BASE}/acceptance-delegates`:
        return json(200, delegates(world.lead));
      case `${BASE}/access-history`:
        return json(200, accessHistory());
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
      case '/api/staff/receivers':
        return json(200, [{ id: 'u-rr', initials: 'RR', displayName: 'Riley Reviewer' }]);
      default:
        return json(404, { code: 'not_found' });
    }
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderTab(user = me()) {
  const layout: ProjectLayoutContext = {
    project: detail(),
    reloadProject: vi.fn(),
    setFormOpen: vi.fn(),
  };
  const router = createMemoryRouter(
    [
      {
        path: '/projects/:projectId',
        element: <Outlet context={layout} />,
        children: [{ path: 'team', element: <TeamPermissionsPage /> }],
      },
    ],
    { initialEntries: [`/projects/${PROJECT_ID}/team`] },
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return { layout, router };
}

const calls = (fetchMock: ReturnType<typeof stubApi>, pathname: string, method = 'GET') =>
  fetchMock.mock.calls.filter(
    ([input, init]) =>
      new URL(String(input), 'http://localhost').pathname === pathname &&
      (init?.method ?? 'GET') === method,
  );

const row = async (name: string) => {
  const people = await screen.findByRole('region', { name: 'People' });
  return within(people).getByText(name).closest('tr')!;
};

beforeEach(() => {
  // Radix Select and menus use pointer capture, which jsdom lacks.
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => undefined;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Team & permissions tab (STRATA-85, MM-AO05)', () => {
  it('AC1: one person shows both responsibilities, grants apart, and no controls without authority', async () => {
    stubApi({ lead: false, team: team(false), reviewers: reviewers(false) }, () => undefined);
    renderTab(me({ id: 'u-tech', displayName: 'Terry Tech', initials: 'TT' }));

    const taylor = await row('Taylor Member');
    const cells = within(taylor).getAllByRole('cell');
    expect(cells[1]).toHaveTextContent('Field Technologist');
    expect(cells[2]).toHaveTextContent('Team member · Reviewer, Concrete field');
    expect(cells[3]).toHaveTextContent('None');
    expect(within(await row('Iris Issuer')).getAllByRole('cell')[3]).toHaveTextContent(
      'Report issuer · Concrete field',
    );
    expect(await row('Dakota Delegate')).toHaveTextContent('Acceptance delegate');
    // Said once, near the table.
    expect(screen.getAllByText(/Job titles and team places grant no approvals/).length).toBe(1);

    // Read-only for someone the server doesn't let manage: no add menu, no Needs review.
    expect(screen.queryByRole('button', { name: 'Add a person' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Needs review' })).not.toBeInTheDocument();

    // The server's explanation of what they can't do, and who could.
    const permissions = screen.getByRole('region', { name: 'Your permissions here' });
    expect(permissions).toHaveTextContent('You have no assignment on this project.');
    const close = within(permissions).getByText('Close lab programs').closest('[role=listitem]')!;
    expect(close).toHaveTextContent('not allowed');
    expect(close).toHaveTextContent('Allowed for: Lead Project Engineer.');

    const history = screen.getByRole('region', { name: 'History' });
    expect(
      await within(history).findByRole('list', { name: 'Team and permissions history' }),
    ).toHaveTextContent('Pat Example added Taylor Member to the team');
    expect(history).toHaveTextContent('“Supporting engineer on site”');
  });

  it('a row opens the person drawer with their permissions, as the server computes them', async () => {
    stubApi({ lead: false, team: team(false), reviewers: reviewers(false) }, () => undefined);
    const { router } = renderTab(me({ id: 'u-tech' }));
    const user = userEvent.setup();

    await user.click(within(await row('Taylor Member')).getByText('Taylor Member'));
    expect(router.state.location.search).toBe('?open=u-tm');
    const drawer = await screen.findByRole('dialog', { name: 'Taylor Member' });
    expect(
      within(drawer)
        .getAllByRole('listitem')
        .filter((item) => item.closest('[aria-label="Permissions of Taylor Member"]'))
        .map((item) => item.textContent),
    ).toEqual([
      'Add or remove team members: not allowedAllowed for: Lead Project Engineer, Administrator.',
      'Close lab programs: not allowedAllowed for: Lead Project Engineer.',
    ]);
    expect(drawer).toHaveTextContent('Reviewer · Concrete field');
    expect(drawer).toHaveTextContent('Job titles grant nothing here.');
    // Nobody may change anything here for this viewer.
    expect(within(drawer).queryByRole('button', { name: 'Remove from the team' })).toBeNull();
    expect(
      within(drawer).getByRole('switch', { name: 'Acceptance delegate on DEMO-2601' }),
    ).toBeDisabled();
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    expect(router.state.location.search).toBe('');
  });

  it('AC3: authority revoked mid-session: the refusal claims no success and the controls go', async () => {
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
    const { layout } = renderTab();
    const user = userEvent.setup();

    await user.click(within(await row('Taylor Member')).getByText('Taylor Member'));
    const drawer = await screen.findByRole('dialog', { name: 'Taylor Member' });
    await user.click(within(drawer).getByRole('button', { name: 'Remove from the team' }));
    const form = within(drawer).getByRole('form', { name: 'Remove Taylor Member from the team?' });
    // One primary per screen: the header's turns outline while the form is open.
    expect(layout.setFormOpen).toHaveBeenLastCalledWith(true);
    await user.click(within(form).getByRole('button', { name: 'Remove from the team' }));
    expect(form).toHaveTextContent('Enter a reason.');
    await user.type(within(form).getByLabelText('Reason (required)'), 'Left the project');
    await user.click(within(form).getByRole('button', { name: 'Remove from the team' }));

    expect(
      await screen.findByText(/You can no longer make this change here. Nothing was saved/),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Removed Taylor Member/)).not.toBeInTheDocument();
    await vi.waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Remove from the team' })).toBeNull(),
    );
    // The drawer shows the person as before; close it to read the tab.
    expect(drawer).toHaveTextContent('Team member');
    await user.click(within(drawer).getByRole('button', { name: 'Close' }));
    const permissions = await screen.findByRole('region', { name: 'Your permissions here' });
    await vi.waitFor(() =>
      expect(
        within(permissions).getByText('Add or remove team members').closest('[role=listitem]'),
      ).toHaveTextContent('not allowed'),
    );
  });

  it('MTR-25: ending an inherited grant needs a reason and updates every list', async () => {
    const IRIS = snap('u-ii', 'Iris Issuer', 'II');
    const flag: GrantReview = {
      id: 'rv-2',
      kind: 'report_issuer',
      grantId: 'ig-1',
      holder: IRIS,
      scope: 'Concrete field',
      flaggedFor: PAT,
      flaggedAt: '2026-10-30T15:00:00.000Z',
      status: 'pending',
      decidedBy: null,
      decidedAt: null,
      reason: null,
    };
    const world: World = {
      lead: true,
      team: team(true, []),
      reviewers: reviewers(true, []),
      issuers: issuers(true),
      grantReviews: {
        projectId: PROJECT_ID,
        canDecide: true,
        pending: [flag],
        history: [],
        leadChanges: [],
      },
    };
    const fetchMock = stubApi(world, (url, init) => {
      if (init.method === 'POST' && url.pathname === `${BASE}/grant-reviews/rv-2/revoke`) {
        // The server ends the grant itself; only the lists read afterwards show it.
        world.issuers = { ...issuers(true), active: [] };
        world.grantReviews = { ...world.grantReviews!, pending: [] };
        return json(200, world.grantReviews);
      }
      return undefined;
    });
    renderTab();
    const user = userEvent.setup();

    const review = await screen.findByRole('region', { name: 'Needs review' });
    expect(review).toHaveTextContent('1');
    expect(await row('Iris Issuer')).toHaveTextContent('Needs review by new lead');
    await user.click(
      within(review).getByRole('button', {
        name: 'End Report issuer: Concrete field · Iris Issuer',
      }),
    );
    const form = within(review).getByRole('form');
    expect(form).toHaveTextContent('The grant ends now. Earlier work keeps their name.');
    await user.click(within(form).getByRole('button', { name: 'End grant' }));
    expect(form).toHaveTextContent('Enter a reason.');
    expect(calls(fetchMock, `${BASE}/grant-reviews/rv-2/revoke`, 'POST')).toHaveLength(0);
    await user.type(within(form).getByLabelText('Reason (required)'), 'No longer needed');
    await user.click(within(form).getByRole('button', { name: 'End grant' }));

    expect(
      await screen.findByText('Ended Report issuer: Concrete field · Iris Issuer.'),
    ).toBeInTheDocument();
    const [, init] = calls(fetchMock, `${BASE}/grant-reviews/rv-2/revoke`, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({ reason: 'No longer needed' });
    await vi.waitFor(() =>
      expect(screen.queryByRole('region', { name: 'Needs review' })).not.toBeInTheDocument(),
    );
    await vi.waitFor(() =>
      expect(
        within(screen.getByRole('region', { name: 'People' })).queryByText('Iris Issuer'),
      ).not.toBeInTheDocument(),
    );
  });

  it('MISC-07: the lead accepts a join without a reason; declining needs one', async () => {
    const request = (person = JORDAN, id = 'jr-1') => ({
      id,
      teamMemberId: `tm-${person.userId}`,
      person,
      requestedAt: '2026-11-10T15:00:00.000Z',
      status: 'pending' as const,
      decidedBy: null,
      decidedAt: null,
      reason: null,
    });
    const world: World = {
      lead: true,
      team: team(true, [member(), member(JORDAN)]),
      reviewers: reviewers(true),
      joinRequests: {
        projectId: PROJECT_ID,
        canRequest: false,
        canDecide: true,
        mine: null,
        pending: [request()],
      },
    };
    const fetchMock = stubApi(world, (url, init) => {
      if (init.method === 'POST' && url.pathname === `${BASE}/team-join-requests/jr-1/accept`) {
        world.joinRequests = { ...world.joinRequests!, pending: [] };
        return json(200, world.joinRequests);
      }
      return undefined;
    });
    renderTab();
    const user = userEvent.setup();

    expect(await row('Jordan Lab')).toHaveTextContent('Team member · Pending LPE acceptance');
    const review = await screen.findByRole('region', { name: 'Needs review' });
    await user.click(within(review).getByRole('button', { name: 'Decline Jordan Lab' }));
    const decline = within(review).getByRole('form', { name: 'Decline Jordan Lab?' });
    await user.click(within(decline).getByRole('button', { name: 'Decline Jordan Lab' }));
    expect(decline).toHaveTextContent('Enter a reason.');
    await user.click(within(decline).getByRole('button', { name: 'Cancel' }));

    await user.click(within(review).getByRole('button', { name: 'Accept Jordan Lab' }));
    expect(await screen.findByText('Jordan Lab is accepted on the team.')).toBeInTheDocument();
    const [, init] = calls(fetchMock, `${BASE}/team-join-requests/jr-1/accept`, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toEqual({});
  });

  it('the lead adds a team member from People with a reason; the list shows the server’s result', async () => {
    const world: World = { lead: true, team: team(true), reviewers: reviewers(true) };
    const RILEY = snap('u-rr', 'Riley Reviewer', 'RR');
    const fetchMock = stubApi(world, (url, init) => {
      if (init.method === 'POST' && url.pathname === `${BASE}/team-members`) {
        world.team = team(true, [member(), member(RILEY)]);
        return json(201, world.team);
      }
      return undefined;
    });
    const { layout } = renderTab();
    const user = userEvent.setup();

    await user.click(await screen.findByRole('button', { name: 'Add a person' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Add to the team…' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add to the team' });
    expect(within(dialog).getByRole('button', { name: 'Add to team' })).toBeDisabled();
    await user.type(within(dialog).getByRole('combobox', { name: 'Add a team member' }), 'RR');
    await user.click(await screen.findByRole('option', { name: /Riley Reviewer/ }));
    await user.type(within(dialog).getByLabelText('Reason (required)'), 'Supporting engineer');
    expect(layout.setFormOpen).toHaveBeenLastCalledWith(true);
    await user.click(within(dialog).getByRole('button', { name: 'Add to team' }));

    expect(await screen.findByText('Added Riley Reviewer to the team.')).toBeInTheDocument();
    const [, init] = calls(fetchMock, `${BASE}/team-members`, 'POST')[0]!;
    expect(JSON.parse(String(init?.body))).toMatchObject({
      userId: 'u-rr',
      reason: 'Supporting engineer',
    });
    expect(await row('Riley Reviewer')).toHaveTextContent('Team member');
    await vi.waitFor(() => expect(layout.setFormOpen).toHaveBeenLastCalledWith(false));
    // Capabilities and history are read again after the change.
    expect(calls(fetchMock, `${BASE}/capabilities`).length).toBeGreaterThan(1);
    expect(calls(fetchMock, `${BASE}/access-history`).length).toBeGreaterThan(1);
  });

  it('the shared LAB account is told the tab is for personal accounts, and nothing is fetched', async () => {
    const fetchMock = stubApi(
      { lead: false, team: team(false), reviewers: reviewers(false) },
      () => undefined,
    );
    renderTab(me({ id: 'lab', accountType: 'shared_lab', permissions: ['inventory.read'] }));
    expect(
      await screen.findByText('Team & permissions is for personal accounts'),
    ).toBeInTheDocument();
    expect(calls(fetchMock, `${BASE}/team-members`)).toHaveLength(0);
  });
});
