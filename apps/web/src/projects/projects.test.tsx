import type {
  MeResponse,
  ProjectDetail,
  ProjectListItem,
  ProjectListPage,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { projectListSearchParams, readOnlyMine, readProjectListQuery } from './url-state';

// Fictional data only (MM-T35): DEMO-2601, TH26-01, PM/PE "PE".

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
  permissions: ['inventory.read', 'test_hole.create'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const listItem = (overrides: Partial<ProjectListItem> = {}): ProjectListItem => ({
  id: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: PE,
  reviewEngineer: null,
  testHoleCount: 2,
  inStockUnitCount: 3,
  lastReceiptDate: '2026-10-20',
  ...overrides,
});

const listPage = (items: ProjectListItem[], total = items.length): ProjectListPage => ({
  items,
  total,
  page: 1,
  pageSize: 25,
});

const detail = (overrides: Partial<ProjectDetail> = {}): ProjectDetail => ({
  id: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: PE,
  reviewEngineer: null,
  serverFolderPath: 'P:\\Projects\\DEMO-2601',
  version: 4,
  numberLocked: true,
  canEdit: true,
  canChangePmPe: true,
  unitCount: 3,
  inStockUnitCount: 3,
  testHoles: [
    { id: 'th1', projectId: PROJECT_ID, name: 'TH26-01', unitCount: 2 },
    { id: 'th2', projectId: PROJECT_ID, name: 'TH26-02', unitCount: 0 },
  ],
  receipts: [
    {
      id: 'r2',
      receivedDate: '2026-10-20',
      receiver: { name: 'Alex Tester', initials: 'AT' },
      unitCount: 1,
    },
    {
      id: 'r1',
      receivedDate: '2026-10-01',
      receiver: { name: 'Alex Tester', initials: 'AT' },
      unitCount: 2,
    },
  ],
  receiptCount: 2,
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: URL, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    if (url.pathname === '/api/inventory')
      return json(200, { items: [], total: 0, page: 1, pageSize: 25 });
    if (url.pathname === '/api/staff/active') return json(200, [PE, DE]);
    return handler(url, init) ?? json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string, user = me()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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

describe('projects URL state', () => {
  it('round-trips the query and leaves defaults out', () => {
    const query = readProjectListQuery(
      new URLSearchParams('search=river&sort=number&page=2&pageSize=25'),
      false,
    );
    expect(projectListSearchParams(query).toString()).toBe('search=river&page=2');
  });

  it('uses the remembered "Only mine" unless the URL says otherwise', () => {
    expect(readProjectListQuery(new URLSearchParams(''), true).mine).toBe(true);
    expect(readProjectListQuery(new URLSearchParams('mine=false'), true).mine).toBe(false);
    expect(readProjectListQuery(new URLSearchParams('mine=1'), false).mine).toBe(true);
    expect(readProjectListQuery(new URLSearchParams('sort=client&page=0'), false)).toMatchObject({
      sort: 'number',
      page: 1,
    });
  });
});

describe('Projects table (MM-T35)', () => {
  it('lists projects with counts and opens a project by its ID in the URL', async () => {
    stubApi((url) =>
      url.pathname === '/api/projects' ? json(200, listPage([listItem()], 1)) : undefined,
    );
    const router = renderAt('/projects');
    expect(await screen.findByText('1 project')).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Projects' });
    const row = within(table).getAllByRole('row')[1]!;
    expect(row).toHaveTextContent('Riverbank investigation');
    expect(row).toHaveTextContent('Example Client');
    expect(row).toHaveTextContent('PE');
    expect(row).toHaveTextContent('2026-10-20');

    await userEvent.click(screen.getByRole('link', { name: 'Open project DEMO-2601' }));
    expect(router.state.location.pathname).toBe(`/projects/${PROJECT_ID}`);
  });

  it('sends search and sort to the server and shows the empty state', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/projects'
        ? json(200, url.searchParams.get('search') ? listPage([]) : listPage([listItem()]))
        : undefined,
    );
    const router = renderAt('/projects');
    await screen.findByText('1 project');
    await userEvent.type(
      screen.getByRole('searchbox', { name: 'Search projects' }),
      'nothing here',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('No projects match this search.')).toBeInTheDocument();
    expect(router.state.location.search).toBe('?search=nothing+here');

    await userEvent.selectOptions(
      screen.getByRole('combobox', { name: 'Sort by' }),
      'last_receipt:desc',
    );
    const last = callsTo(fetchMock, '/api/projects').at(-1)!.url;
    expect(last.searchParams.get('sort')).toBe('last_receipt');
    expect(last.searchParams.get('dir')).toBe('desc');
  });

  it('"Only mine" is remembered per user in local storage', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/projects' ? json(200, listPage([listItem()])) : undefined,
    );
    renderAt('/projects');
    await screen.findByText('1 project');
    await userEvent.click(screen.getByRole('checkbox', { name: 'Only mine' }));
    expect(readOnlyMine('u1')).toBe(true);
    expect(readOnlyMine('someone-else')).toBe(false);
    expect(callsTo(fetchMock, '/api/projects').at(-1)!.url.searchParams.get('mine')).toBe('true');

    // MM-T50: the filter shows as a chip; removing it turns "Only mine" off and remembers that.
    const chips = screen.getByRole('list', { name: 'Active filters' });
    expect(chips).toHaveTextContent(/Only mine:/);
    await userEvent.click(within(chips).getByRole('button', { name: 'Remove filter Only mine' }));
    expect(screen.getByRole('checkbox', { name: 'Only mine' })).not.toBeChecked();
    expect(readOnlyMine('u1')).toBe(false);
    expect(screen.queryByRole('list', { name: 'Active filters' })).not.toBeInTheDocument();
  });

  it('hides "Only mine" from the shared LAB account', async () => {
    stubApi((url) =>
      url.pathname === '/api/projects' ? json(200, listPage([listItem()])) : undefined,
    );
    renderAt('/projects', me({ accountType: 'shared_lab' }));
    await screen.findByText('1 project');
    expect(screen.queryByRole('checkbox', { name: 'Only mine' })).not.toBeInTheDocument();
  });
});

describe('Project detail (MM-T35)', () => {
  it('shows header fields, the folder path as text with Copy, holes and receipts', async () => {
    stubApi((url) =>
      url.pathname === `/api/projects/${PROJECT_ID}` ? json(200, detail()) : undefined,
    );
    renderAt(`/projects/${PROJECT_ID}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'DEMO-2601' })).toBeInTheDocument();
    const details = screen.getByRole('region', { name: 'Project details' });
    expect(details).toHaveTextContent('PE — Pat Example');
    expect(within(details).getByText('P:\\Projects\\DEMO-2601')).toBeInTheDocument();
    expect(within(details).queryByRole('link')).not.toBeInTheDocument();
    expect(within(details).getByRole('button', { name: 'Copy' })).toBeInTheDocument();

    const holes = screen.getByRole('list', { name: 'Test holes' });
    expect(within(holes).getByRole('link', { name: '2 units' })).toHaveAttribute(
      'href',
      `/sample-storage?projectId=${PROJECT_ID}&testHoleId=th1&status=all`,
    );
    expect(holes).toHaveTextContent('TH26-02 0 units');
    const receipts = screen.getByRole('table', { name: 'Receipts' });
    expect(within(receipts).getAllByRole('row')).toHaveLength(3);
    expect(screen.getByRole('link', { name: 'Open in Sample Storage' })).toHaveAttribute(
      'href',
      `/sample-storage?projectId=${PROJECT_ID}&status=all`,
    );
  });

  it('adds a test hole and reports a duplicate', async () => {
    let holes = detail().testHoles;
    stubApi((url, init) => {
      if (url.pathname === `/api/projects/${PROJECT_ID}/test-holes` && init?.method === 'POST') {
        const name = (JSON.parse(String(init.body)) as { name: string }).name.trim();
        if (name.toLowerCase() === 'th26-01') {
          return json(409, { code: 'test_hole_exists', existing: holes[0] });
        }
        const hole = { id: 'th3', projectId: PROJECT_ID, name };
        holes = [...holes, { ...hole, unitCount: 0 }];
        return json(201, hole);
      }
      if (url.pathname === `/api/projects/${PROJECT_ID}`)
        return json(200, detail({ testHoles: holes }));
      return undefined;
    });
    renderAt(`/projects/${PROJECT_ID}`);
    const input = await screen.findByRole('textbox', { name: 'Add test hole' });
    await userEvent.type(input, 'th26-01 ');
    await userEvent.click(screen.getByRole('button', { name: 'Add test hole' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'TH26-01 already exists in this project.',
    );
    await userEvent.clear(input);
    await userEvent.type(input, 'TH26-03');
    await userEvent.click(screen.getByRole('button', { name: 'Add test hole' }));
    expect(await screen.findByText('Added test hole TH26-03.')).toBeInTheDocument();
    expect(await screen.findByText('TH26-03')).toBeInTheDocument();
  });

  it('hides Edit without permission', async () => {
    stubApi((url) =>
      url.pathname === `/api/projects/${PROJECT_ID}`
        ? json(200, detail({ canEdit: false, canChangePmPe: false }))
        : undefined,
    );
    renderAt(`/projects/${PROJECT_ID}`);
    await screen.findByRole('heading', { level: 1, name: 'DEMO-2601' });
    expect(screen.queryByRole('button', { name: 'Edit project' })).not.toBeInTheDocument();
  });

  it('MM-T61: a save cut off by the network says to reload and check', async () => {
    stubApi((url, init) => {
      if (url.pathname !== `/api/projects/${PROJECT_ID}`) return undefined;
      if (init?.method === 'PATCH') throw new TypeError('Failed to fetch');
      return json(200, detail());
    });
    renderAt(`/projects/${PROJECT_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
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

  it('edit: locked number, a required reason when changing the PM/PE, and field errors', async () => {
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
        return json(200, detail({ pmPe: DE, version: 5, serverFolderPath: null }));
      }
      return json(200, detail());
    });
    renderAt(`/projects/${PROJECT_ID}`);
    await userEvent.click(await screen.findByRole('button', { name: 'Edit project' }));
    const dialog = screen.getByRole('dialog', { name: 'Edit project' });
    expect(within(dialog).getByRole('textbox', { name: 'Project number' })).toHaveAttribute(
      'readonly',
    );
    expect(dialog).toHaveTextContent("Printed on existing labels, so it can't be changed.");

    // Changing the PM/PE needs a reason before anything is sent.
    await userEvent.selectOptions(
      within(dialog).getByRole('combobox', { name: 'PM/PE' }),
      'DE — Dana Example',
    );
    const path = within(dialog).getByRole('textbox', { name: 'Server folder path' });
    await userEvent.clear(path);
    await userEvent.type(path, 'bad');
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(
      within(dialog).getByRole('textbox', { name: 'Reason for changing the PM/PE' }),
    ).toHaveAccessibleDescription('Give a reason for changing the PM/PE');
    expect(
      callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).some((c) => c.init?.method === 'PATCH'),
    ).toBe(false);

    await userEvent.type(
      within(dialog).getByRole('textbox', { name: 'Reason for changing the PM/PE' }),
      'Handover',
    );
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await within(dialog).findByText('Path is not allowed')).toBeInTheDocument();
    expect(path).toHaveAccessibleDescription(/Path is not allowed/);

    await userEvent.clear(path);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Project saved.')).toBeInTheDocument();
    const patch = callsTo(fetchMock, `/api/projects/${PROJECT_ID}`).filter(
      (c) => c.init?.method === 'PATCH',
    );
    expect(JSON.parse(String(patch.at(-1)!.init!.body))).toEqual({
      version: 4,
      pmPeId: 'u-de',
      reason: 'Handover',
      serverFolderPath: '',
    });
    expect(screen.getByRole('region', { name: 'Project details' })).toHaveTextContent(
      'DE — Dana Example',
    );
  });
});
