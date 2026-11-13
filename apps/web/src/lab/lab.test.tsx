import type { MeResponse, TestCatalogue, TestTemplate } from '@materialmule/shared';
import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';

// Lab Testing screens (MM-T23). Fictional data only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'lab_program.read', 'lab_program.manage'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});
const LAB = me({
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
});

const SOILS = '00000000-0000-4000-8000-00000000c101';
const catalogue: TestCatalogue = {
  groups: [{ id: SOILS, name: 'Soils', sortOrder: 1, version: 1, subgroups: [] }],
  tests: [
    {
      id: '00000000-0000-4000-8000-0000000000a1',
      groupId: SOILS,
      groupName: 'Soils',
      subgroupId: null,
      subgroupName: null,
      code: 'DEMO-MC',
      name: 'Moisture Content',
      description: 'Moisture content of soil (fictional)',
      sortOrder: 0,
      active: true,
      retiredAt: null,
      version: 1,
      sampleTagMode: 'none',
      sampleTagGroup: null,
    },
    {
      id: '00000000-0000-4000-8000-0000000000a2',
      groupId: SOILS,
      groupName: 'Soils',
      subgroupId: null,
      subgroupName: null,
      code: 'DEMO-OLD',
      name: null,
      description: 'Old fictional test',
      sortOrder: 0,
      active: false,
      retiredAt: '2026-10-27T00:00:00.000Z',
      sampleTagMode: 'own',
      sampleTagGroup: null,
      version: 2,
    },
  ],
};
const templates: TestTemplate[] = [
  {
    id: '00000000-0000-4000-8000-0000000000b1',
    name: 'Demo pair',
    active: true,
    retiredAt: null,
    version: 1,
    items: [
      {
        testTypeId: catalogue.tests[0]!.id,
        code: 'DEMO-MC',
        displayName: 'Moisture Content',
        active: true,
      },
      {
        testTypeId: catalogue.tests[1]!.id,
        code: 'DEMO-OLD',
        displayName: 'Old fictional test',
        active: false,
      },
    ],
  },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(
  session: MeResponse,
  path: string,
  extra: (url: string, init?: RequestInit) => Response | null = () => null,
) {
  pickStationPerson(session);
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handled = extra(url, init);
    if (handled) return handled;
    if (url.startsWith('/api/test-catalogue')) return json(200, catalogue);
    if (url.startsWith('/api/test-templates')) return json(200, templates);
    if (url.startsWith('/api/lab-programs')) return json(200, { items: [], total: 0 });
    if (url.startsWith('/api/worklist')) {
      return json(200, { items: [], total: 0, page: 1, pageSize: 100, projects: [] });
    }
    if (url.startsWith('/api/projects/search')) {
      return json(200, [
        {
          id: '00000000-0000-4000-8000-000000000201',
          projectNumber: 'DEMO-2601',
          name: 'Riverbank investigation',
          client: 'Example Client',
          leadProjectEngineer: {
            id: '00000000-0000-4000-8000-000000000101',
            displayName: 'Pat Example',
            initials: 'PE',
          },
        },
      ]);
    }
    if (url.includes('/lab-sources')) {
      return json(200, [
        {
          kind: 'test_hole',
          id: '00000000-0000-4000-8000-000000000301',
          label: 'TH26-01',
          unitCount: 2,
        },
      ]);
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
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
  return { fetchMock, router };
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

describe('Lab Testing (MM-T23)', () => {
  it('AC11: one Lab Testing menu item opens the Workboard by default, with Programs and New lab program', async () => {
    const user = userEvent.setup();
    const { router } = renderAt(me(), '/lab-testing');
    // STRATA-10: the Worklist is now the Workboard, on the same route.
    expect(await screen.findByRole('heading', { name: 'Workboard' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/lab-testing');
    expect(
      await screen.findByText('Nothing waiting. Submitted programs appear here.'),
    ).toBeVisible();
    const tabs = screen.getByRole('navigation', { name: 'Lab programs' });
    expect(within(tabs).getByRole('link', { name: 'Workboard' })).toHaveAttribute(
      'href',
      '/lab-testing',
    );
    expect(within(tabs).queryByRole('link', { name: 'Worklist' })).toBeNull();
    await user.click(within(tabs).getByRole('link', { name: 'Programs' }));
    expect(await screen.findByRole('heading', { name: 'Programs' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'New lab program' })).toBeVisible();
  });

  it('a LAB station must choose Requested by before saving, and it stays visible', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt(LAB, '/lab-testing/programs/new');
    expect(await screen.findByRole('combobox', { name: /Requested by/ })).toBeVisible();
    expect(screen.getByText('Nobody chosen yet')).toBeVisible();
    await user.type(screen.getByLabelText('Project'), 'DEMO');
    await user.click(await screen.findByRole('button', { name: /DEMO-2601/ }));
    await user.click(screen.getByRole('button', { name: 'Save draft' }));
    expect(
      await screen.findByText('Choose who this program is requested by.', {
        selector: '.notice p',
      }),
    ).toBeVisible();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('applying a template adds active tests and lists retired ones instead of adding them', async () => {
    const user = userEvent.setup();
    renderAt(me(), '/lab-testing/programs/new');
    await user.type(await screen.findByLabelText('Project'), 'DEMO');
    await user.click(await screen.findByRole('button', { name: /DEMO-2601/ }));
    await user.selectOptions(await screen.findByLabelText('Template'), 'Demo pair (2 tests)');
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    const chips = screen.getByRole('list', { name: 'Requested tests' });
    expect(within(chips).getByText(/DEMO-MC · Moisture Content/)).toBeVisible();
    expect(within(chips).queryByText(/DEMO-OLD/)).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Not added because they are retired: DEMO-OLD',
    );
    // Retired tests are never offered in search either; no screen asks for result values.
    await user.type(screen.getByLabelText('Find a test'), 'fictional');
    expect(screen.queryByRole('button', { name: /DEMO-OLD/ })).toBeNull();
    expect(screen.queryByLabelText(/result/i)).toBeNull();
  });

  it('Field Ledger: "What the lab gets" counts the tests before anything is submitted', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt(me(), '/lab-testing/programs/new');
    expect(await screen.findByRole('heading', { level: 1, name: 'New lab program' })).toBeVisible();
    const panel = screen.getByRole('region', { name: 'What the lab gets' });
    expect(within(panel).getByText('No tests chosen yet.')).toBeVisible();
    await user.type(screen.getByLabelText('Project'), 'DEMO');
    await user.click(await screen.findByRole('button', { name: /DEMO-2601/ }));
    await user.selectOptions(await screen.findByLabelText('Template'), 'Demo pair (2 tests)');
    await user.click(screen.getByRole('button', { name: 'Apply template' }));
    const tests = within(panel).getByRole('list', { name: 'Tests the lab gets' });
    expect(within(tests).getByText('DEMO-MC · Moisture Content')).toBeVisible();
    expect(within(panel).getByText('1 line · 1 test')).toBeVisible();
    expect(
      within(panel).getByText('Review the program to see which storage units the lab pulls.'),
    ).toBeVisible();
    // The submit action lives in the panel and stays off until a review is ready.
    expect(within(panel).getByRole('button', { name: 'Submit program' })).toBeDisabled();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('Field Ledger: units chosen on Inventory open a new program with them ticked', async () => {
    const UNIT = '00000000-0000-4000-8000-000000000401';
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(input);
      if (url.startsWith('/api/test-catalogue')) return json(200, catalogue);
      if (url.startsWith('/api/test-templates')) return json(200, templates);
      if (url.endsWith('/units')) {
        return json(200, [
          {
            storageUnitId: UNIT,
            readableId: 'BKT-2026-000142',
            unitType: 'bucket',
            contents: 'G1–G3',
            receivedDate: '2026-11-02',
          },
          {
            storageUnitId: '00000000-0000-4000-8000-000000000402',
            readableId: 'BKT-2026-000143',
            unitType: 'bucket',
            contents: 'G4',
            receivedDate: '2026-11-02',
          },
        ]);
      }
      if (url.includes('/lab-sources')) {
        return json(200, [
          {
            kind: 'test_hole',
            id: '00000000-0000-4000-8000-000000000301',
            label: 'TH26-01',
            unitCount: 2,
          },
        ]);
      }
      return json(200, { items: [], total: 0 });
    });
    vi.stubGlobal('fetch', fetchMock);
    const router = createMemoryRouter(routes, {
      initialEntries: [
        {
          pathname: '/lab-testing/programs/new',
          state: {
            projectId: '00000000-0000-4000-8000-000000000201',
            projectLabel: 'DEMO-2601 · Riverbank investigation',
            storageUnitIds: [UNIT],
          },
        },
      ],
    });
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
    expect(
      await screen.findByText(
        '1 unit from Inventory is ticked on 1 line. Name each sample and choose its tests.',
      ),
    ).toBeVisible();
    expect(screen.getAllByText('DEMO-2601 · Riverbank investigation').length).toBeGreaterThan(0);
    expect(screen.getByRole('radio', { name: 'Specific sample' })).toBeChecked();
    expect(await screen.findByRole('checkbox', { name: /BKT-2026-000142/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /BKT-2026-000143/ })).not.toBeChecked();
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('Field Ledger: the Workboard leads with the units to pull, each linking to its unit', async () => {
    renderAt(me(), '/lab-testing', (url) =>
      url.startsWith('/api/worklist/units-to-pull')
        ? json(200, {
            total: 1,
            units: [
              {
                storageUnitId: '00000000-0000-4000-8000-000000000401',
                readableId: 'BKT-2026-000142',
                project: { id: '00000000-0000-4000-8000-000000000201', projectNumber: 'DEMO-2601' },
                location: { code: 'C-2', name: 'Shelf 2', area: 'Bay C' },
                programs: [{ programId: 'lp1', programNumber: 'LP-2026-0001' }],
                urgent: true,
              },
            ],
          })
        : null,
    );
    const pull = await screen.findByRole('region', { name: 'To pull now · 1 unit' });
    const link = within(pull).getByRole('link', { name: /BKT-2026-000142/ });
    expect(link).toHaveAttribute('href', '/sample-storage/BKT-2026-000142');
    expect(link).toHaveTextContent('Bay C · Shelf 2');
    expect(within(pull).getByText('Urgent')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workboard' })).toBeVisible();
  });

  it('MISC-01: New lab program opens the editor; the discard dialog opens only from Discard draft', async () => {
    const user = userEvent.setup();
    renderAt(me(), '/lab-testing/programs');
    await user.click(await screen.findByRole('link', { name: 'New lab program' }));
    expect(await screen.findByLabelText('Project')).toBeVisible();
    // A closed dialog has no accessible name, so find it by its title text.
    const dialog = screen.getByRole<HTMLDialogElement>('dialog', { hidden: true });
    expect(dialog).toHaveTextContent('Discard this draft?');
    expect(dialog.open).toBe(false);
    expect(dialog).not.toHaveAttribute('open');

    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(dialog.open).toBe(true);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(dialog.open).toBe(false);

    // Escape fires the dialog's cancel event in a browser; jsdom needs it dispatched.
    await user.click(screen.getByRole('button', { name: 'Discard draft' }));
    expect(dialog.open).toBe(true);
    fireEvent(dialog, new Event('cancel'));
    expect(dialog.open).toBe(false);
  });
});
