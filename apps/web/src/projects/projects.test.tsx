import type {
  InventoryItem,
  LabProgramSummary,
  MeResponse,
  ProjectDetail,
  ProjectListItem,
  ProjectListPage,
} from '@materialmule/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { nominationLine } from './project-format';
import { projectListRequest, projectsTabParams, readProjectsTab } from './url-state';

// Fictional data only (MM-T35, STRATA-83/84): DEMO-2601, TH26-01, Lead Project Engineer "PE".

const PROJECT_ID = '00000000-0000-4000-8000-000000000201';
const PE = { id: 'u-pe', displayName: 'Pat Example', initials: 'PE' };
const DE = { id: 'u-de', displayName: 'Dana Example', initials: 'DE' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'test_hole.create', 'lab_program.read'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const listItem = (overrides: Partial<ProjectListItem> = {}): ProjectListItem => ({
  id: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: PE,
  involvement: [],
  testHoleCount: 2,
  inStockUnitCount: 3,
  lastReceiptDate: '2026-10-20',
  leadNomination: null,
  ...overrides,
});

const listPage = (items: ProjectListItem[], total = items.length): ProjectListPage => ({
  items,
  total,
  page: 1,
  pageSize: 25,
  tabCounts: { mine: 6, all: 214, waitingForLead: 3 },
});

const hole = (n: number, unitCount = 1) => ({
  id: `th${n}`,
  projectId: PROJECT_ID,
  name: `TH26-${String(n).padStart(2, '0')}`,
  unitCount,
  sampleRange: unitCount > 0 ? { from: 'SS1', to: 'SS14' } : null,
  allSamples: false,
  depthRanges: unitCount > 0 ? [{ from: 0.8, to: 9.2, unit: 'm' as const }] : [],
});

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: PE,
  serverFolderPath: 'P:\\Projects\\DEMO-2601',
  version: 4,
  numberLocked: true,
  leadNomination: null,
  canEdit: true,
  canChangeLeadProjectEngineer: true,
  unitCount: 3,
  inStockUnitCount: 3,
  testHoles: [hole(1, 2), hole(2, 0)],
  receipts: [
    {
      id: 'r2',
      receivedDate: '2026-10-20',
      receiver: { name: 'Alex Tester', initials: 'AT', userId: 'u1' },
      unitCount: 1,
      testHoleNames: ['TH26-01'],
    },
    {
      id: 'r1',
      receivedDate: '2026-10-01',
      receiver: { name: 'Alex Tester', initials: 'AT', userId: 'u1' },
      unitCount: 2,
      testHoleNames: ['TH26-01'],
    },
  ],
  receiptCount: 2,
  involvement: ['team_member'],
  labProgramCounts: { open: 1, closed: 1 },
  hasConcreteWork: false,
  canStartConcreteWork: false,
  ...overrides,
});

const program = (overrides: Partial<LabProgramSummary> = {}): LabProgramSummary => ({
  id: 'lp1',
  programNumber: 'LP-2026-0009',
  status: 'submitted',
  priority: 'urgent',
  project: { id: PROJECT_ID, projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  createdBy: { userId: 'u1', initials: 'AT', name: 'Alex Tester', accountType: 'personal' },
  requestedBy: { userId: 'u1', initials: 'AT', name: 'Alex Tester' },
  createdAt: '2026-11-10T16:00:00.000Z',
  updatedAt: '2026-11-10T16:00:00.000Z',
  submittedAt: '2026-11-10T16:00:00.000Z',
  lineCount: 2,
  testCount: 5,
  progress: { done: 2, inProgress: 1, notStarted: 2, cancelled: 0 },
  stage: 'lab',
  ...overrides,
});

const unit = (overrides: Partial<InventoryItem> = {}): InventoryItem => ({
  id: 'su1',
  readableId: 'BKT-2026-000061',
  unitType: 'bucket',
  status: 'in_stock',
  project: { id: PROJECT_ID, projectNumber: 'DEMO-2601', name: 'Riverbank', client: 'Example' },
  holes: [
    {
      testHoleId: 'th1',
      testHoleName: 'TH26-01',
      type: 'all',
      sampleFrom: null,
      sampleTo: null,
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      customText: null,
      note: null,
    },
  ],
  sample: null,
  bulkGroup: null,
  location: { id: 'l1', code: 'WH-A-B3-S2', name: 'WH-A-B3-S2' },
  receivedDate: '2026-11-10',
  recordStatus: 'long_term',
  stage: 'storage',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: URL, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const handled = handler(url, init);
    if (handled) return handled;
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    if (url.pathname === '/api/inventory')
      return json(200, { items: [], total: 0, page: 1, pageSize: 25 });
    if (url.pathname === '/api/lab-programs') return json(200, { items: [], total: 0 });
    if (url.pathname === '/api/staff/active') return json(200, [PE, DE]);
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string, user = me()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  pickStationPerson(user, { ...PE, roleLine: 'Engineer' });
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
  return router;
}

const callsTo = (fetchMock: ReturnType<typeof stubApi>, pathname: string) =>
  fetchMock.mock.calls
    .map(([input, init]) => ({ url: new URL(String(input), 'http://localhost'), init }))
    .filter((call) => call.url.pathname === pathname);

const detailApi =
  (body: ProjectDetail = detail()) =>
  (url: URL) =>
    url.pathname === `/api/projects/${PROJECT_ID}` ? json(200, body) : undefined;

async function openEdit(user = userEvent.setup()) {
  await user.click(await screen.findByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Edit project' }));
}

beforeEach(() => {
  window.localStorage.clear();
  // jsdom has no <dialog> methods.
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

describe('projects URL state (STRATA-83)', () => {
  it('opens My projects by default and keeps links from before the tabs working', () => {
    const tab = (query: string, canMine = true) =>
      readProjectsTab(new URLSearchParams(query), canMine);
    expect(tab('')).toBe('mine');
    expect(tab('tab=waiting')).toBe('waiting');
    expect(tab('waitingForLead=true&search=x')).toBe('waiting');
    expect(tab('mine=1')).toBe('mine');
    expect(tab('mine=false')).toBe('all');
    // Search › Show all in Projects searches every project.
    expect(tab('search=river')).toBe('all');
    // The shared LAB account has no "my" projects.
    expect(tab('', false)).toBe('all');
    expect(tab('tab=mine', false)).toBe('all');
    expect(projectsTabParams(new URLSearchParams('mine=1&page=3&search=x'), 'all').toString()).toBe(
      'search=x&tab=all',
    );
  });

  it('asks the server for the tab, search, sort and page', () => {
    expect(projectListRequest('mine', { search: ' river ', sort: null }, 1, 25).toString()).toBe(
      'search=river&mine=true',
    );
    expect(
      projectListRequest(
        'waiting',
        { search: '', sort: { key: 'name', dir: 'desc' } },
        2,
        25,
      ).toString(),
    ).toBe('waitingForLead=true&sort=name&dir=desc&page=2');
    // Unknown sort keys are left to the default.
    expect(
      projectListRequest(
        'all',
        { search: '', sort: { key: 'client', dir: 'asc' } },
        1,
        25,
      ).toString(),
    ).toBe('');
  });

  it('writes the nomination state under "Waiting for a lead"', () => {
    expect(nominationLine({ leadNomination: null })).toBe('No nomination');
    expect(
      nominationLine({
        leadNomination: { nomineeName: 'Morgan Demo', nominatedByName: 'Alex Tester' },
      }),
    ).toBe('Alex Tester nominated Morgan Demo · waiting for an admin');
  });
});

describe('Projects list (STRATA-83)', () => {
  it('opens on My projects with tab counts, leads and the waiting tag', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/projects'
        ? json(
            200,
            listPage([
              listItem(),
              listItem({
                id: 'p2',
                projectNumber: 'DEMO-2607',
                leadProjectEngineer: null,
                leadNomination: { nomineeName: 'Morgan Demo', nominatedByName: 'Alex Tester' },
              }),
            ]),
          )
        : undefined,
    );
    const router = renderAt('/projects');
    const table = await screen.findByRole('table', { name: 'My projects' });
    await within(table).findByText('Pat Example');
    expect(callsTo(fetchMock, '/api/projects')[0]!.url.searchParams.get('mine')).toBe('true');
    expect(screen.getByRole('tab', { name: /My projects 6/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Waiting for a lead 3/ })).toBeInTheDocument();
    expect(within(table).getByText('Pat Example')).toBeInTheDocument();
    expect(within(table).getByText('Waiting for a lead')).toBeInTheDocument();
    expect(
      within(table).getByText('Alex Tester nominated Morgan Demo · waiting for an admin'),
    ).toBeInTheDocument();
    expect(screen.getByText('1–2 of 2 projects')).toBeInTheDocument();
    expect(within(table).getByRole('link', { name: 'Open project DEMO-2601' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}`,
    );

    await userEvent.click(screen.getByRole('tab', { name: /Waiting for a lead/ }));
    expect(router.state.location.search).toBe('?tab=waiting');
    await screen.findByRole('table', { name: 'Projects waiting for a lead' });
    expect(callsTo(fetchMock, '/api/projects').at(-1)!.url.searchParams.get('waitingForLead')).toBe(
      'true',
    );
  });

  it('shows no projects yet, and no matches with Clear search', async () => {
    stubApi((url) =>
      url.pathname === '/api/projects'
        ? json(200, {
            ...listPage([], 0),
            tabCounts: { mine: 0, all: url.searchParams.get('search') ? 4 : 0, waitingForLead: 0 },
          })
        : undefined,
    );
    renderAt('/projects?tab=all');
    expect(await screen.findByText('No projects yet.')).toBeInTheDocument();
    expect(screen.getByText('Projects are added while receiving samples.')).toBeInTheDocument();
  });

  it('says when a search matches nothing', async () => {
    stubApi((url) =>
      url.pathname === '/api/projects'
        ? json(200, { ...listPage([], 0), tabCounts: { mine: 0, all: 0, waitingForLead: 0 } })
        : undefined,
    );
    const router = renderAt('/projects?tab=all&search=zzz');
    expect(await screen.findByText('No projects match this search.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Clear the search' }));
    expect(router.state.location.search).toBe('?tab=all');
  });

  it("can't load: says so with Try again", async () => {
    let fail = true;
    stubApi((url) => {
      if (url.pathname !== '/api/projects') return undefined;
      return fail ? json(500, {}) : json(200, listPage([listItem()]));
    });
    renderAt('/projects');
    expect(await screen.findByText("Projects couldn't load")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'My projects' })).toBeInTheDocument();
  });

  it('hides My projects from the shared LAB account', async () => {
    stubApi((url) => (url.pathname === '/api/projects' ? json(200, listPage([])) : undefined));
    renderAt('/projects', me({ accountType: 'shared_lab' }));
    expect(await screen.findByRole('tab', { name: /All projects/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.queryByRole('tab', { name: /My projects/ })).not.toBeInTheDocument();
  });
});

describe('Project page (STRATA-84)', () => {
  it('header: number and name, lead, three counts, Receive, and line tabs with their own URLs', async () => {
    stubApi(detailApi());
    renderAt(`/projects/${PROJECT_ID}`);
    const heading = await screen.findByRole('heading', { level: 1, name: /^DEMO-2601/ });
    expect(heading).toHaveTextContent('Riverbank investigation');
    expect(screen.getByText('Lead Project Engineer')).toBeInTheDocument();
    const counts = screen.getByRole('list', { name: 'Counts' });
    expect(counts).toHaveTextContent('2test holes');
    expect(counts).toHaveTextContent('3units in stock');
    expect(counts).toHaveTextContent('3units received');
    expect(screen.getByRole('link', { name: 'Receive for this project' })).toHaveAttribute(
      'href',
      `/receiving-log/new?new=1&projectId=${PROJECT_ID}`,
    );
    const sections = screen.getByRole('navigation', { name: 'Project sections' });
    expect(within(sections).getByRole('tab', { name: 'Overview' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(sections).getByRole('tab', { name: /Storage units 3/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/units`,
    );
    expect(within(sections).getByRole('tab', { name: /Lab programs 2/ })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/programs`,
    );
    // No concrete work and no authority to start it: no Concrete tab.
    expect(within(sections).queryByRole('tab', { name: 'Concrete' })).not.toBeInTheDocument();
    // No project_access.read: no Team tab.
    expect(within(sections).queryByRole('tab', { name: /Team/ })).not.toBeInTheDocument();
  });

  it('shows Concrete only with concrete work, and Team to those who may read access', async () => {
    stubApi(detailApi(detail({ hasConcreteWork: true })));
    renderAt(
      `/projects/${PROJECT_ID}`,
      me({ permissions: ['inventory.read', 'project_access.read'] }),
    );
    const sections = await screen.findByRole('navigation', { name: 'Project sections' });
    expect(within(sections).getByRole('tab', { name: 'Concrete' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/concrete/reports`,
    );
    expect(within(sections).getByRole('tab', { name: 'Team & permissions' })).toHaveAttribute(
      'href',
      `/projects/${PROJECT_ID}/team`,
    );
  });

  it('waiting for a lead: tag and nomination state; Receive still works', async () => {
    stubApi(
      detailApi(
        detail({
          leadProjectEngineer: null,
          leadNomination: {
            id: 'n1',
            nominee: { userId: 'u-md', initials: 'MD', name: 'Morgan Demo' },
            nominatedBy: { userId: 'u1', initials: 'AT', name: 'Alex Tester' },
            nominatedAt: '2026-11-10T16:00:00.000Z',
            note: null,
            status: 'pending',
            decidedBy: null,
            decidedAt: null,
            decisionReason: null,
          },
        }),
      ),
    );
    renderAt(`/projects/${PROJECT_ID}`);
    await screen.findByRole('heading', { level: 1, name: /^DEMO-2601/ });
    expect(
      screen.getByText('Alex Tester nominated Morgan Demo · waiting for an admin'),
    ).toBeInTheDocument();
    expect(screen.getByText('Waiting for a Lead Project Engineer')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Receive for this project' })).toBeInTheDocument();
  });

  it('no assignment: says so, and the project is still shown', async () => {
    stubApi(detailApi(detail({ involvement: [] })));
    renderAt(`/projects/${PROJECT_ID}`);
    expect(
      await screen.findByText('You have no assignment on this project. You can still see it.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Pat Example leads it.')).toBeInTheDocument();
  });

  it('not found, and couldn’t load with Try again', async () => {
    stubApi(() => undefined);
    renderAt(`/projects/${PROJECT_ID}`);
    expect(await screen.findByText('Project not found.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Projects' })).toHaveAttribute(
      'href',
      '/projects',
    );
  });

  it("couldn't load offers Try again", async () => {
    let fail = true;
    stubApi((url) =>
      url.pathname === `/api/projects/${PROJECT_ID}`
        ? fail
          ? json(500, {})
          : json(200, detail())
        : undefined,
    );
    renderAt(`/projects/${PROJECT_ID}`);
    expect(await screen.findByText("This project couldn't load")).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(
      await screen.findByRole('heading', { level: 1, name: /^DEMO-2601/ }),
    ).toBeInTheDocument();
  });

  it('More holds Edit project only for those who may edit, and Copy link', async () => {
    stubApi(detailApi(detail({ canEdit: false, canChangeLeadProjectEngineer: false })));
    renderAt(`/projects/${PROJECT_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Copy link' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Edit project' })).not.toBeInTheDocument();
  });

  it('Pin: shows the server state and pins with PUT', async () => {
    let pinned = false;
    const fetchMock = stubApi((url, init) => {
      if (url.pathname === '/api/me/pins') {
        return json(200, {
          items: pinned
            ? [
                {
                  kind: 'project',
                  id: PROJECT_ID,
                  available: true,
                  label: 'DEMO-2601',
                  name: 'Riverbank',
                  stage: 'storage',
                  href: `/projects/${PROJECT_ID}`,
                  at: '2026-11-12T16:00:00.000Z',
                },
              ]
            : [],
        });
      }
      if (url.pathname === `/api/me/pins/project/${PROJECT_ID}` && init?.method === 'PUT') {
        pinned = true;
        return json(200, { items: [] });
      }
      return detailApi()(url);
    });
    renderAt(
      `/projects/${PROJECT_ID}`,
      me({ accountType: 'personal', permissions: ['inventory.read', 'personal_settings.manage'] }),
    );
    const pin = await screen.findByRole('button', { name: 'Pin to sidebar' });
    expect(pin).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(pin);
    expect(await screen.findByRole('button', { name: 'Unpin from sidebar' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(
      callsTo(fetchMock, `/api/me/pins/project/${PROJECT_ID}`).map((c) => c.init?.method),
    ).toEqual(['PUT']);
  });
});

describe('Project Overview (STRATA-84)', () => {
  it('test holes with SAMPLE# and depth ranges, 6 rows then Show all, a hole opens its units', async () => {
    const holes = Array.from({ length: 12 }, (_, i) => hole(i + 1, i === 11 ? 0 : 2));
    stubApi(detailApi(detail({ testHoles: holes })));
    const router = renderAt(`/projects/${PROJECT_ID}`);
    const table = await screen.findByRole('table', { name: 'Test holes' });
    expect(within(table).getAllByRole('row')).toHaveLength(7);
    expect(within(table).getAllByRole('row')[1]).toHaveTextContent('TH26-012SS1–SS140.8–9.2 m');
    await userEvent.click(screen.getByRole('button', { name: 'Show all 12 test holes' }));
    expect(within(table).getAllByRole('row')).toHaveLength(13);
    expect(within(table).getByText('No units yet')).toBeInTheDocument();
    await userEvent.click(
      within(table).getByRole('link', { name: 'TH26-01: open its storage units' }),
    );
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}/units`);
    expect(router.state.location.search).toBe('?hole=th1');
  });

  it('recent receipts link to the receipt and the log; project details keep the folder path', async () => {
    stubApi(detailApi());
    renderAt(`/projects/${PROJECT_ID}`);
    const receipts = await screen.findByRole('list', { name: 'Recent receipts' });
    expect(within(receipts).getByRole('link', { name: '1 unit on 2026-10-20' })).toHaveAttribute(
      'href',
      '/receiving-log/r2',
    );
    expect(screen.getByRole('link', { name: 'Open the receiving log' })).toHaveAttribute(
      'href',
      `/receiving-log?projectId=${PROJECT_ID}`,
    );
    const details = screen.getByRole('region', { name: 'Project details' });
    expect(within(details).getByText('P:\\Projects\\DEMO-2601')).toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('adds a test hole and reports a duplicate', async () => {
    let holes = detail().testHoles;
    stubApi((url, init) => {
      if (url.pathname === `/api/projects/${PROJECT_ID}/test-holes` && init?.method === 'POST') {
        const name = (JSON.parse(String(init.body)) as { name: string }).name.trim();
        if (name.toLowerCase() === 'th26-01') {
          return json(409, { code: 'test_hole_exists', existing: holes[0] });
        }
        const added = { id: 'th3', projectId: PROJECT_ID, name };
        holes = [...holes, { ...added, unitCount: 0 }];
        return json(201, added);
      }
      return detailApi(detail({ testHoles: holes }))(url);
    });
    renderAt(`/projects/${PROJECT_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Add test hole' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add test hole' });
    const input = within(dialog).getByRole('textbox', { name: 'Test hole name' });
    await userEvent.type(input, 'th26-01 ');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add test hole' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(
      'TH26-01 already exists in this project.',
    );
    await userEvent.clear(input);
    await userEvent.type(input, 'TH26-03');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add test hole' }));
    expect(
      await screen.findByRole('link', { name: 'TH26-03: open its storage units' }),
    ).toBeInTheDocument();
  });

  it('retention coming up asks for units ending in 30 days, with Decide; lab programs show n of m', async () => {
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/inventory') {
        return json(200, {
          items: [
            unit({
              retention: {
                effectiveRetainUntil: '2099-01-01',
                onHold: false,
                eligibleByDate: false,
                retentionExempt: false,
              },
            }),
          ],
          total: 1,
          page: 1,
          pageSize: 10,
        });
      }
      if (url.pathname === '/api/lab-programs') return json(200, { items: [program()], total: 1 });
      return detailApi()(url);
    });
    renderAt(`/projects/${PROJECT_ID}`);
    const coming = await screen.findByRole('list', { name: 'Retention coming up' });
    expect(within(coming).getByRole('link', { name: 'Decide on BKT-2026-000061' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000061#retention',
    );
    const request = callsTo(fetchMock, '/api/inventory')[0]!.url.searchParams;
    expect(request.get('projectId')).toBe(PROJECT_ID);
    expect(request.get('status')).toBe('in_stock');
    expect(request.get('sort')).toBe('retain_until');
    expect(request.get('retainUntilTo')).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    const programs = await screen.findByRole('list', { name: 'Open lab programs' });
    expect(programs).toHaveTextContent('LP-2026-0009');
    expect(programs).toHaveTextContent('In lab · Lab program');
    expect(
      within(programs).getByRole('progressbar', { name: '2 of 5 tests done' }),
    ).toBeInTheDocument();
    expect(screen.getByText('1 open · 1 closed')).toBeInTheDocument();
  });
});

describe('Project Storage units tab (STRATA-84)', () => {
  it('lists the project’s units, filtered to a hole from the URL, and the chip clears it', async () => {
    const fetchMock = stubApi((url) => {
      if (url.pathname === '/api/inventory')
        return json(200, { items: [unit()], total: 1, page: 1, pageSize: 25 });
      return detailApi()(url);
    });
    const router = renderAt(`/projects/${PROJECT_ID}/units?hole=th1`);
    const table = await screen.findByRole('table', { name: 'Storage units on DEMO-2601' });
    expect(await within(table).findByRole('link', { name: 'BKT-2026-000061' })).toBeInTheDocument();
    expect(within(table).getByText('Long-term')).toBeInTheDocument();
    const request = callsTo(fetchMock, '/api/inventory').at(-1)!.url.searchParams;
    expect(request.get('projectId')).toBe(PROJECT_ID);
    expect(request.get('testHoleId')).toBe('th1');
    expect(screen.getByRole('tab', { name: /Storage units/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Remove filter Test hole TH26-01' }));
    expect(router.state.location.search).toBe('');
  });

  it('stage tabs map to the inventory filters', async () => {
    const fetchMock = stubApi(detailApi());
    renderAt(`/projects/${PROJECT_ID}/units?stage=retention`);
    await screen.findByText('No storage units match.');
    expect(callsTo(fetchMock, '/api/inventory').at(-1)!.url.searchParams.get('retention')).toBe(
      'eligible_by_date',
    );
  });
});

describe('Project Lab programs tab (STRATA-84)', () => {
  it('lists the project’s open programs with priority, n of m and status', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/lab-programs'
        ? json(200, { items: [program()], total: 1 })
        : detailApi()(url),
    );
    renderAt(`/projects/${PROJECT_ID}/programs`);
    const table = await screen.findByRole('table', { name: 'Lab programs on DEMO-2601' });
    expect(await within(table).findByRole('link', { name: 'LP-2026-0009' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1',
    );
    expect(table).toHaveTextContent('Urgent · Priority');
    expect(table).toHaveTextContent('2 of 5');
    expect(table).toHaveTextContent('In lab · Lab program');
    const request = callsTo(fetchMock, '/api/lab-programs').at(-1)!.url.searchParams;
    expect(request.get('projectId')).toBe(PROJECT_ID);
    expect(request.get('status')).toBe('submitted');
    expect(
      screen.getByText('Progress only. Results are recorded outside Material Mule.'),
    ).toBeInTheDocument();
  });
});

describe('Edit project (MM-T35)', () => {
  it('MM-T61: a save cut off by the network says to reload and check', async () => {
    stubApi((url, init) => {
      if (url.pathname !== `/api/projects/${PROJECT_ID}`) return undefined;
      if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
      return json(200, detail());
    });
    renderAt(`/projects/${PROJECT_ID}`);
    await openEdit();
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await userEvent.clear(name);
    await userEvent.type(name, 'Riverbank investigation phase 2');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      await within(dialog).findByText(
        "Material Mule couldn't be reached. Check the connection, then reload to see whether it was saved.",
      ),
    ).toBeInTheDocument();
  });

  it('edit: locked number, a required reason when changing the Lead Project Engineer, and field errors', async () => {
    const fetchMock = stubApi((url, init) => {
      if (url.pathname !== `/api/projects/${PROJECT_ID}`) return undefined;
      if (init?.method === 'PATCH') {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        if (body.serverFolderPath === 'bad') {
          return json(400, {
            code: 'validation_failed',
            errors: [{ field: 'serverFolderPath', code: 'x', message: 'Path is not allowed' }],
          });
        }
        return json(200, detail({ leadProjectEngineer: DE, version: 5, serverFolderPath: null }));
      }
      return json(200, detail());
    });
    renderAt(`/projects/${PROJECT_ID}`);
    await openEdit();
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    expect(within(dialog).getByRole('textbox', { name: 'Project number' })).toHaveAttribute(
      'readonly',
    );
    expect(dialog).toHaveTextContent("Printed on existing labels, so it can't be changed.");

    // Changing the Lead Project Engineer needs a reason before anything is sent.
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'Lead Project Engineer' }),
      'DE · Dana Example',
    );
    const path = within(dialog).getByRole('textbox', { name: 'Server folder path' });
    await userEvent.clear(path);
    await userEvent.type(path, 'bad');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      within(dialog).getByRole('textbox', {
        name: 'Reason for changing the Lead Project Engineer',
      }),
    ).toHaveAccessibleDescription('Give a reason for changing the Lead Project Engineer');
    expect(
      callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).some((c) => c.init?.method === 'PATCH'),
    ).toBe(false);

    await userEvent.type(
      within(dialog).getByRole('textbox', {
        name: 'Reason for changing the Lead Project Engineer',
      }),
      'Handover',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Path is not allowed')).toBeInTheDocument();
    expect(path).toHaveAccessibleDescription(/Path is not allowed/);

    await userEvent.clear(path);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    await vi.waitFor(() =>
      expect(screen.queryByRole('dialog', { name: 'Edit project' })).not.toBeInTheDocument(),
    );
    const patch = callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).filter(
      (c) => c.init?.method === 'PATCH',
    );
    expect(JSON.parse(String(patch.at(-1)!.init!.body))).toEqual({
      version: 4,
      leadProjectEngineerId: 'u-de',
      reason: 'Handover',
      serverFolderPath: '',
    });
    // The header shows the saved project.
    expect(screen.getByText('Dana Example')).toBeInTheDocument();
  });
});

describe('Project retention refreshes the page (MTR-83)', () => {
  it('reloads the project after a hold is released', async () => {
    const user = userEvent.setup();
    let released = false;
    const hold = {
      id: 'h1',
      projectId: PROJECT_ID,
      scope: 'project' as const,
      units: [],
      reason: 'Litigation hold (fictional)',
      placedBy: { userId: 'u-pe', initials: 'PE', name: 'Pat Example' },
      placedAt: '2026-10-27T16:00:00.000Z',
      fromRequestId: null,
      active: true,
      releasedBy: null,
      releasedAt: null,
      releaseReason: null,
      version: 1,
    };
    const fetchMock = stubApi((url) => {
      if (url.pathname === `/api/projects/${PROJECT_ID}`) return json(200, detail());
      if (url.pathname === `/api/projects/${PROJECT_ID}/retention`) {
        return json(200, {
          projectId: PROJECT_ID,
          holds: [released ? { ...hold, active: false, version: 2 } : hold],
          extensions: [],
          requests: [],
          counts: { current: 3, onHold: released ? 0 : 3 },
          canManage: true,
          canRequest: true,
        });
      }
      if (url.pathname === '/api/retention/holds/h1/release') {
        released = true;
        return json(200, { id: 'h1', version: 2 });
      }
      return undefined;
    });
    renderAt(`/projects/${PROJECT_ID}`);
    const item = await screen.findByRole('listitem', { name: 'Hold: Litigation hold (fictional)' });
    const before = callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).length;
    await user.click(within(item).getByRole('button', { name: 'Release' }));
    await user.type(within(item).getByLabelText('Reason for releasing (required)'), 'Settled');
    await user.click(
      within(within(item).getByRole('form', { name: 'Release' })).getByRole('button', {
        name: 'Release',
      }),
    );
    expect(await screen.findByText('0 of 3 current units on hold')).toBeInTheDocument();
    await vi.waitFor(() =>
      expect(callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).length).toBeGreaterThan(before),
    );
  });
});

describe('Edit project unsaved changes (MTR-26)', () => {
  it('names what changed and asks before Cancel or Escape discards it', async () => {
    const user = userEvent.setup();
    stubApi(detailApi());
    renderAt(`/projects/${PROJECT_ID}`);
    await openEdit(user);
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    const cue = within(dialog).getAllByRole('status').at(-1)!;
    expect(cue).toHaveTextContent('');

    // Nothing changed: Cancel closes at once.
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull();

    await openEdit(user);
    const again = screen.getByRole('dialog', { name: 'Edit project' });
    await user.type(within(again).getByRole('textbox', { name: 'Name' }), ' (fictional)');
    await user.type(within(again).getByRole('textbox', { name: 'Client' }), ' Ltd');
    expect(again).toHaveTextContent('Changed: name, client');

    // Cancel asks; keeping editing leaves the draft alone.
    await user.click(within(again).getByRole('button', { name: 'Cancel' }));
    const confirm = screen.getByRole('dialog', { name: 'Discard changes?' });
    expect(confirm).toHaveTextContent('Your changes to name, client haven’t been saved.');
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('dialog', { name: 'Discard changes?' })).toBeNull();
    expect(within(again).getByRole('textbox', { name: 'Name' })).toHaveValue(
      'Riverbank investigation (fictional)',
    );

    // Escape asks too; Discard changes closes the editor.
    fireEvent(again, new Event('cancel', { cancelable: true }));
    await user.click(
      within(screen.getByRole('dialog', { name: 'Discard changes?' })).getByRole('button', {
        name: 'Discard changes',
      }),
    );
    expect(screen.queryByRole('dialog', { name: 'Edit project' })).toBeNull();
  });
});
