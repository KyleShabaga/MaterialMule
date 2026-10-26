import type { MeResponse, ProjectSummary, TestHole } from '@trapezoid/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { prefillFromQuery } from './prefill';

// Every project, person and hole here is fictional.

const PE = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Pat Example',
  initials: 'PE',
};
const AT = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
};

const westPine: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: '67997',
  name: 'West Pine Creek Ph.3',
  client: 'Jacobs Example',
  pmPe: PE,
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: AT.id,
  displayName: AT.displayName,
  initials: AT.initials,
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project.create', 'test_hole.create'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (body: unknown) => Response;

/** Renders /receiving-log/new with API responses keyed by "METHOD path-prefix". */
function renderReceive(api: Record<string, Handler>, session = me()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const key = Object.keys(api)
      .filter((k) => {
        const [m, prefix] = k.split(' ');
        return m === method && url.startsWith(prefix!);
      })
      .sort((a, b) => b.length - a.length)[0];
    if (key) {
      return api[key]!(init?.body ? JSON.parse(String(init.body)) : undefined);
    }
    if (url.startsWith('/api/staff/active')) return json(200, [AT, PE]);
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/receiving-log/new'] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

function setOnline(online: boolean) {
  Object.defineProperty(window.navigator, 'onLine', { configurable: true, get: () => online });
  act(() => {
    window.dispatchEvent(new Event(online ? 'online' : 'offline'));
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
  setOnline(true);
});

describe('prefillFromQuery', () => {
  it('puts number-like text in the number and anything else in the name', () => {
    expect(prefillFromQuery(' 67997 ')).toEqual({ projectNumber: '67997', name: '' });
    expect(prefillFromQuery('DEMO-2701')).toEqual({ projectNumber: 'DEMO-2701', name: '' });
    expect(prefillFromQuery('west pine')).toEqual({ projectNumber: '', name: 'west pine' });
  });
});

describe('Receive samples: project and test holes (TRP-T08)', () => {
  it('AC1: typing a number shows matches; choosing one fills the other fields read-only', async () => {
    const user = userEvent.setup();
    const fetchMock = renderReceive({ 'GET /api/projects/search': () => json(200, [westPine]) });
    await user.type(await screen.findByRole('combobox', { name: /Find project/ }), '679');
    await user.click(
      await screen.findByRole('option', { name: '67997 · West Pine Creek Ph.3 · Jacobs Example' }),
    );

    expect(screen.getByLabelText('Project number')).toHaveValue('67997');
    expect(screen.getByLabelText('Project name')).toHaveValue('West Pine Creek Ph.3');
    expect(screen.getByLabelText('Client')).toHaveAttribute('readonly');
    expect(screen.getByLabelText('PM/PE')).toHaveValue('Pat Example');
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/projects/search?q=679&limit=10',
      expect.anything(),
    );
  });

  it('adds a project prefilled from the typed number, then selects it without clearing the draft (AC7)', async () => {
    const user = userEvent.setup();
    const created: ProjectSummary = {
      id: '00000000-0000-4000-8000-000000000902',
      projectNumber: '70001',
      name: 'Example Ridge',
      client: 'Example Client',
      pmPe: PE,
    };
    let sent: unknown;
    renderReceive({
      'GET /api/projects/search': () => json(200, []),
      'POST /api/projects': (body) => {
        sent = body;
        return json(201, created);
      },
    });
    await user.type(await screen.findByLabelText('Description (optional)'), 'Four buckets');
    await user.type(screen.getByRole('combobox', { name: /Find project/ }), '70001');
    await screen.findByText('No matching project');
    await user.click(screen.getByRole('button', { name: 'Add project' }));

    const form = screen.getByRole('group', { name: 'Add project' });
    expect(within(form).getByLabelText('Project number')).toHaveValue('70001');
    await user.type(within(form).getByLabelText('Project name'), 'Example Ridge');
    await user.type(within(form).getByLabelText('Client'), 'Example Client');
    await user.selectOptions(within(form).getByLabelText('PM/PE'), PE.id);
    await user.click(within(form).getByRole('button', { name: 'Save project' }));

    expect(await screen.findByLabelText('Project name')).toHaveValue('Example Ridge');
    expect(sent).toMatchObject({
      projectNumber: '70001',
      pmPeUserId: PE.id,
      receiverUserId: AT.id,
    });
    expect(screen.getByLabelText('Description (optional)')).toHaveValue('Four buckets');
    expect(screen.getByRole('combobox', { name: 'Received by' })).toHaveValue('AT · Alex Tester');
  });

  it('AC5: shows field errors for a missing client and PM/PE without calling the API', async () => {
    const user = userEvent.setup();
    const fetchMock = renderReceive({ 'GET /api/projects/search': () => json(200, []) });
    await user.type(await screen.findByRole('combobox', { name: /Find project/ }), '70002');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const form = screen.getByRole('group', { name: 'Add project' });
    await user.type(within(form).getByLabelText('Project name'), 'Example');
    await user.click(within(form).getByRole('button', { name: 'Save project' }));

    expect(within(form).getByText('Client is required')).toBeInTheDocument();
    expect(within(form).getByText('PM/PE is required')).toBeInTheDocument();
    expect(within(form).getByLabelText('Client')).toHaveAttribute('aria-invalid', 'true');
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('offers the existing project on a duplicate number', async () => {
    const user = userEvent.setup();
    renderReceive({
      'GET /api/projects/search': () => json(200, []),
      'POST /api/projects': () => json(409, { code: 'project_exists', existing: westPine }),
    });
    await user.type(await screen.findByRole('combobox', { name: /Find project/ }), '67997');
    await user.click(screen.getByRole('button', { name: 'Add project' }));
    const form = screen.getByRole('group', { name: 'Add project' });
    await user.type(within(form).getByLabelText('Project name'), 'Again');
    await user.type(within(form).getByLabelText('Client'), 'Example Client');
    await user.selectOptions(within(form).getByLabelText('PM/PE'), PE.id);
    await user.click(within(form).getByRole('button', { name: 'Save project' }));

    expect(
      await screen.findByText('Project 67997 already exists: West Pine Creek Ph.3.'),
    ).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Use this project' }));
    expect(screen.getByLabelText('Project name')).toHaveValue('West Pine Creek Ph.3');
  });

  it('selects existing holes and adds a missing one as the last option', async () => {
    const user = userEvent.setup();
    const holes: TestHole[] = [
      { id: 'h1', projectId: westPine.id, name: 'TH26-01' },
      { id: 'h2', projectId: westPine.id, name: 'TH26-02' },
    ];
    let sent: unknown;
    renderReceive({
      'GET /api/projects/search': () => json(200, [westPine]),
      [`GET /api/projects/${westPine.id}/test-holes`]: () => json(200, holes),
      [`POST /api/projects/${westPine.id}/test-holes`]: (body) => {
        sent = body;
        return json(201, { id: 'h3', projectId: westPine.id, name: 'TH26-03' });
      },
    });
    await user.type(await screen.findByRole('combobox', { name: /Find project/ }), 'pine');
    await user.click(await screen.findByRole('option', { name: /67997/ }));

    const holeInput = screen.getByRole('combobox', { name: 'Find or add a test hole' });
    await user.type(holeInput, 'th26-0');
    const holeList = await screen.findByRole('listbox', { name: 'Test holes' });
    const options = within(holeList).getAllByRole('option');
    expect(options.map((o) => o.textContent)).toEqual(['TH26-01', 'TH26-02', 'Add th26-0']);
    await user.click(screen.getByRole('option', { name: 'TH26-01' }));

    await user.type(holeInput, ' TH26-03 ');
    await user.click(await screen.findByRole('option', { name: 'Add TH26-03' }));
    const chips = await screen.findByRole('list', { name: 'Selected test holes' });
    expect(await within(chips).findByText('TH26-03')).toBeInTheDocument();
    expect(within(chips).getByText('TH26-01')).toBeInTheDocument();
    expect(sent).toEqual({ name: 'TH26-03', receiverUserId: AT.id });

    // An exact match (ignoring case) offers the hole itself, never "Add".
    await user.type(holeInput, 'th26-02');
    const exactList = await screen.findByRole('listbox', { name: 'Test holes' });
    expect(
      within(exactList)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['TH26-02']);
  });

  it('offline: creation is disabled and typed text stays in the draft', async () => {
    const user = userEvent.setup();
    renderReceive({ 'GET /api/projects/search': () => json(200, []) });
    const search = await screen.findByRole('combobox', { name: /Find project/ });
    await user.type(search, 'DEMO-2799');
    setOnline(false);
    expect(screen.getByRole('button', { name: 'Connect to add a project' })).toBeDisabled();
    expect(search).toHaveValue('DEMO-2799');
    setOnline(true);
    expect(screen.getByRole('button', { name: 'Add project' })).toBeEnabled();
  });

  it('a LAB station has no default receiver', async () => {
    renderReceive({}, me({ accountType: 'shared_lab', id: 'lab', displayName: 'LAB' }));
    expect(await screen.findByRole('combobox', { name: 'Received by' })).toHaveValue('');
  });
});
