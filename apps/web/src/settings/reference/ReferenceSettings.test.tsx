import type {
  CompanyHoliday,
  ConcreteMixDetail,
  ConcreteSupplier,
  MeResponse,
  ProjectDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';

// MM-V2-C37: Settings → Suppliers and Holidays, and Discard draft / supplier link on the mix
// detail page (C30's Concrete → Mixes tab).
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
      <StrataToaster />
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
    // STRATA-100: a technician reads Suppliers by address; the nav shows it only while open.
    expect(within(nav).queryByRole('link', { name: 'Holidays' })).toBeNull();
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

describe('Settings → Report header (MM-V2-C32, STRATA-102)', () => {
  const header = {
    companyName: 'Material Mule Testing Laboratory',
    address: '123 Sample Street',
    phone: null,
    version: 2,
    updatedAt: '2026-11-01T16:00:00.000Z',
    updatedBy: null,
  };
  const handler: Handler = (method, url, body) => {
    if (url !== '/api/concrete/report-header') return undefined;
    if (method === 'GET') return json(200, header);
    return json(200, { ...header, ...(body as object), version: 3 });
  };

  it('everyone reads it; only admins change it; the report layout stays a gate', async () => {
    renderAt('/settings/report-header', TECH, handler);
    const name = await screen.findByLabelText(/Company name/);
    expect(name).toHaveValue('Material Mule Testing Laboratory');
    expect(name).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save header' })).toBeNull();
    expect(screen.getByText('Only admins can change the report header.')).toBeInTheDocument();
    expect(screen.getByText('Report templates')).toBeInTheDocument();
  });

  it('an admin saves the header with its version', async () => {
    const calls = renderAt(
      '/settings/report-header',
      me({
        roles: ['admin'],
        permissions: ['inventory.read', 'concrete_settings.report_header.manage'],
      }),
      handler,
    );
    const user = userEvent.setup();
    const phone = await screen.findByLabelText('Phone');
    await user.type(phone, '555-0100');
    await user.click(screen.getByRole('button', { name: 'Save header' }));
    expect(
      await screen.findByText('Report header saved. It applies to reports issued from now on.'),
    ).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      version: 2,
      phone: '555-0100',
    });
  });
});

describe('Mix detail: Discard draft and supplier link (MM-V2-C37 on the C30 Mixes tab)', () => {
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
  const MIX = '00000000-0000-4000-8000-000000000801';
  const project: ProjectDetail = {
    id: PROJECT,
    projectNumber: 'DEMO-2601',
    name: 'Riverbank investigation',
    client: 'Example Client',
    leadProjectEngineer: { id: person.userId, displayName: 'Lee', initials: 'LM' },
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
  };
  const detail = (canManage: boolean, overrides: Partial<ConcreteMixDetail> = {}) =>
    ({
      id: MIX,
      projectId: PROJECT,
      projectNumber: 'DEMO-2601',
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
      revisions: [],
      history: [],
      historyTotal: 0,
      canManage,
      canApprove: canManage,
      ...overrides,
    }) as ConcreteMixDetail;
  const base =
    (canManage: boolean, more?: Handler): Handler =>
    (method, url, body) => {
      if (method === 'GET' && url === `/api/projects/${PROJECT}`) return json(200, project);
      if (method === 'GET' && url === `/api/concrete-mixes/${MIX}`)
        return json(200, detail(canManage));
      if (method === 'GET' && url.startsWith('/api/concrete/suppliers')) {
        return json(200, { items: [supplier], canManage: false });
      }
      return more?.(method, url, body);
    };
  const at = `/projects/${PROJECT}/concrete/mixes/${MIX}`;

  it('the old /concrete-mixes address opens the Mixes tab', async () => {
    renderAt(`/projects/${PROJECT}/concrete-mixes`, TECH, (method, url) => {
      if (method === 'GET' && url === `/api/projects/${PROJECT}`) return json(200, project);
      if (method === 'GET' && url.includes('/concrete-mixes')) {
        return json(200, {
          projectId: PROJECT,
          items: [],
          total: 0,
          page: 1,
          pageSize: 50,
          canManage: false,
          canApprove: false,
        });
      }
      return undefined;
    });
    const tabs = await screen.findByRole('navigation', { name: 'Concrete' });
    expect(within(tabs).getByRole('link', { name: 'Mixes' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });

  it('the Lead discards the draft after confirming; the approved revision stays', async () => {
    const calls = renderAt(
      at,
      TECH,
      base(true, (method, url) =>
        method === 'POST' && url.endsWith('/discard-draft')
          ? json(200, detail(true, { status: 'approved', draftRevision: null, version: 4 }))
          : undefined,
      ),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Discard draft revision 2' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard draft revision 2?' });
    expect(within(dialog).getByText(/stays in effect, unchanged/)).toBeInTheDocument();
    await user.type(within(dialog).getByLabelText(/Note/), 'Wrong strength');
    await user.click(within(dialog).getByRole('button', { name: 'Discard draft' }));
    expect(
      await screen.findByText('Draft revision 2 of M-1 discarded. Revision 1 stays in effect.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard draft/ })).toBeNull();
    expect(calls.find((c) => c.method === 'POST')).toMatchObject({
      url: `/api/concrete-mixes/${MIX}/discard-draft`,
      body: {
        version: 3,
        revisionId: '00000000-0000-4000-8000-000000000812',
        note: 'Wrong strength',
      },
    });
  });

  it('the Lead links a listed supplier', async () => {
    const calls = renderAt(
      at,
      TECH,
      base(true, (method, url) =>
        method === 'PATCH' && url === `/api/concrete-mixes/${MIX}`
          ? json(
              200,
              detail(true, {
                supplier: { id: supplier.id, name: supplier.name, active: true },
                version: 4,
              }),
            )
          : undefined,
      ),
    );
    const user = userEvent.setup();
    const select = await screen.findByLabelText('Listed supplier');
    await screen.findByRole('option', { name: 'Example Ready-Mix' });
    await user.selectOptions(select, supplier.id);
    await user.click(screen.getByRole('button', { name: 'Save link' }));
    expect(await screen.findByText('M-1 linked to Example Ready-Mix.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')).toMatchObject({
      body: { version: 3, supplierId: supplier.id },
    });
  });

  it('without mix authority there is no Discard draft or supplier picker', async () => {
    renderAt(at, TECH, base(false));
    expect(
      await screen.findByText(
        'Only the project’s Lead Project Engineer can edit or approve this mix.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Discard draft/ })).toBeNull();
    expect(screen.queryByLabelText('Listed supplier')).toBeNull();
    expect(screen.getByText('Not linked')).toBeInTheDocument();
  });
});
