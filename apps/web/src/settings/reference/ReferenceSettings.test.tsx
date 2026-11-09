import type {
  CompanyHoliday,
  ConcreteMixList,
  ConcreteSupplier,
  MeResponse,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// MM-V2-C37: Settings → Suppliers and Holidays, and the project mix screen's Discard draft.
// Fictional people, suppliers and mixes only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000301',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'concrete_settings.supplier.manage'],
  sessionExpiresAt: '2026-11-08T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});
const TECH = me({ roles: [], permissions: ['inventory.read'], displayName: 'Alex Tester' });
const ADMIN = me({
  roles: ['admin'],
  permissions: [
    'inventory.read',
    'concrete_settings.supplier.manage',
    'concrete_settings.holiday.manage',
  ],
});

const person = { userId: '00000000-0000-4000-8000-000000000301', initials: 'LM', name: 'Lee' };
const supplier: ConcreteSupplier = {
  id: '00000000-0000-4000-8000-000000000601',
  name: 'Example Ready-Mix',
  plantNames: ['North Plant'],
  active: true,
  linkedMixCount: 2,
  createdAt: '2026-11-01T16:00:00.000Z',
  createdBy: person,
  updatedAt: '2026-11-01T16:00:00.000Z',
  version: 1,
};
const canadaDay: CompanyHoliday = {
  id: '00000000-0000-4000-8000-000c37202605',
  holidayOn: '2026-07-01',
  name: 'Canada Day',
  source: 'alberta_general',
  createdBy: null,
  updatedAt: '2026-11-01T16:00:00.000Z',
  version: 1,
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (method: string, url: string, body: unknown) => Response | undefined;

function renderAt(path: string, session: MeResponse, handler: Handler) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      return handler(method, url, body) ?? json(404, {});
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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
  return calls;
}

beforeEach(() => {
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
  vi.restoreAllMocks();
});

describe('Settings → Suppliers (MM-V2-C37)', () => {
  it('everyone reads the list; only managers see the add and edit controls', async () => {
    renderAt('/settings/suppliers', TECH, (method, url) =>
      method === 'GET' && url.startsWith('/api/concrete/suppliers')
        ? json(200, { items: [supplier], canManage: false })
        : undefined,
    );
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Suppliers' })).toHaveAttribute(
      'href',
      '/settings/suppliers',
    );
    expect(within(nav).getByRole('link', { name: 'Holidays' })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Concrete suppliers' });
    expect(within(table).getByText('Example Ready-Mix')).toBeInTheDocument();
    expect(within(table).getByText('North Plant')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a supplier' })).toBeNull();
    expect(
      screen.getByText('Only Lab Managers and admins can change suppliers.'),
    ).toBeInTheDocument();
  });

  it('a Lab Manager adds a supplier with one plant per line', async () => {
    const calls = renderAt('/settings/suppliers', me(), (method, url) => {
      if (method === 'GET' && url.startsWith('/api/concrete/suppliers')) {
        return json(200, { items: [supplier], canManage: true });
      }
      if (method === 'POST' && url === '/api/concrete/suppliers') {
        return json(201, { ...supplier, id: '00000000-0000-4000-8000-000000000602' });
      }
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a supplier' }));
    const form = screen.getByRole('form', { name: 'Add a supplier' });
    await user.type(within(form).getByLabelText(/Supplier name/), 'Sample Concrete Co');
    await user.type(within(form).getByLabelText(/Plants/), 'East Plant{enter}West Plant');
    await user.click(within(form).getByRole('button', { name: 'Add supplier' }));
    expect(await screen.findByText(/added\./)).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({
      name: 'Sample Concrete Co',
      plantNames: ['East Plant', 'West Plant'],
    });
  });
});

describe('Settings → Holidays (MM-V2-C37)', () => {
  it('lists the year with the weekday; non-admins have no change controls', async () => {
    renderAt('/settings/holidays', me(), (method, url) =>
      method === 'GET' && url.startsWith('/api/concrete/holidays')
        ? json(200, { year: 2026, items: [canadaDay], canManage: false })
        : undefined,
    );
    const table = await screen.findByRole('table', { name: /Holidays in/ });
    expect(within(table).getByText('Canada Day')).toBeInTheDocument();
    expect(within(table).getByText('Wednesday')).toBeInTheDocument();
    expect(within(table).getByText('Alberta general holiday')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a holiday' })).toBeNull();
    expect(screen.getByText('Only admins can change the holiday calendar.')).toBeInTheDocument();
  });

  it('an admin removes a holiday with a reason', async () => {
    const calls = renderAt('/settings/holidays', ADMIN, (method, url) => {
      if (method === 'GET' && url.startsWith('/api/concrete/holidays')) {
        return json(200, { year: 2026, items: [canadaDay], canManage: true });
      }
      if (method === 'POST' && url.endsWith('/remove')) return json(200, canadaDay);
      return undefined;
    });
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Remove Canada Day' }));
    const form = screen.getByRole('form', { name: 'Remove Canada Day' });
    await user.type(within(form).getByLabelText(/Reason/), 'Fictional: office open');
    await user.click(within(form).getByRole('button', { name: 'Remove holiday' }));
    expect(await screen.findByText('Canada Day removed.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: `/api/concrete/holidays/${canadaDay.id}/remove`,
      body: { version: 1, reason: 'Fictional: office open' },
    });
  });
});

describe('Project concrete mixes: Discard draft (MM-V2-C37)', () => {
  const PROJECT = '00000000-0000-4000-8000-000000000701';
  const revision = (id: string, revisionNumber: number, state: 'draft' | 'approved') => ({
    id,
    revisionNumber,
    state,
    spec: {
      supplierName: 'Example Ready-Mix',
      mixNumber: 'M-1',
      plantNames: [],
      specifiedStrengthMpa: state === 'draft' ? 35 : 32,
      specifiedStrengthAgeDays: null,
      slumpTargetMm: 80,
      slumpToleranceMm: 30,
      airMinPercent: 5,
      airMaxPercent: 8,
      maxAggregateSizeMm: 20,
      cementType: 'GU',
      specAdmixtures: { declaration: null, items: [] },
      ticketDefaults: {
        specifiedStrengthMpa: null,
        slumpTargetMm: null,
        slumpToleranceMm: null,
        airMinPercent: null,
        airMaxPercent: null,
        maxAggregateSizeMm: null,
        cementType: null,
        admixtures: { declaration: null, items: [] },
      },
      testAges: [7, 28, 28, 'HOLD'],
    },
    createdAt: '2026-11-01T16:00:00.000Z',
    createdBy: person,
    updatedAt: '2026-11-01T16:00:00.000Z',
    approvedAt: state === 'approved' ? '2026-11-01T16:00:00.000Z' : null,
    approvedBy: state === 'approved' ? person : null,
    supersededAt: null,
    discardedAt: null,
    discardedBy: null,
    missingForApproval: [],
  });
  const list = (canManage: boolean): ConcreteMixList => ({
    projectId: PROJECT,
    items: [
      {
        id: '00000000-0000-4000-8000-000000000801',
        projectId: PROJECT,
        supplierName: 'Example Ready-Mix',
        mixNumber: 'M-1',
        supplier: null,
        status: 'revision_pending',
        effectiveRevision: revision('00000000-0000-4000-8000-000000000811', 1, 'approved'),
        draftRevision: revision('00000000-0000-4000-8000-000000000812', 2, 'draft'),
        copiedFrom: null,
        version: 3,
        createdAt: '2026-11-01T16:00:00.000Z',
        updatedAt: '2026-11-01T16:00:00.000Z',
      },
    ] as ConcreteMixList['items'],
    total: 1,
    page: 1,
    pageSize: 100,
    canManage,
    canApprove: canManage,
  });

  it('the Lead discards the draft after confirming; the approved revision stays', async () => {
    const calls = renderAt(`/projects/${PROJECT}/concrete-mixes`, TECH, (method, url) => {
      if (method === 'GET' && url.includes('/concrete-mixes')) return json(200, list(true));
      if (method === 'GET' && url.startsWith('/api/concrete/suppliers')) {
        return json(200, { items: [supplier], canManage: false });
      }
      if (method === 'POST' && url.endsWith('/discard-draft')) {
        const [mix] = list(true).items;
        return json(200, {
          ...mix,
          status: 'approved',
          draftRevision: null,
          version: 4,
          projectNumber: 'DEMO-2601',
          revisions: [],
          history: [],
          historyTotal: 0,
          canManage: true,
          canApprove: true,
        });
      }
      return undefined;
    });
    const user = userEvent.setup();
    const card = await screen.findByRole('article', { name: 'Example Ready-Mix M-1' });
    expect(within(card).getByText('Revision 1, 32 MPa')).toBeInTheDocument();
    expect(within(card).getByText('Revision 2, 35 MPa')).toBeInTheDocument();
    await user.click(within(card).getByRole('button', { name: 'Discard draft revision 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard draft revision 2?' });
    expect(within(dialog).getByText(/stays in effect, unchanged/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Note/), 'Wrong strength');
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    expect(
      await screen.findByText('Draft revision 2 of M-1 discarded. Revision 1 stays in effect.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: '/api/concrete-mixes/00000000-0000-4000-8000-000000000801/discard-draft',
      body: {
        version: 3,
        revisionId: '00000000-0000-4000-8000-000000000812',
        note: 'Wrong strength',
      },
    });
  });

  it('without mix authority there is no Discard draft button', async () => {
    renderAt(`/projects/${PROJECT}/concrete-mixes`, TECH, (method, url) => {
      if (method === 'GET' && url.includes('/concrete-mixes')) return json(200, list(false));
      if (method === 'GET' && url.startsWith('/api/concrete/suppliers')) {
        return json(200, { items: [], canManage: false });
      }
      return undefined;
    });
    const card = await screen.findByRole('article', { name: 'Example Ready-Mix M-1' });
    expect(within(card).queryByRole('button', { name: /Discard draft/ })).toBeNull();
    expect(
      screen.getByText(/Only the project.s Lead Project Engineer can change its mixes\./),
    ).toBeInTheDocument();
  });
});
