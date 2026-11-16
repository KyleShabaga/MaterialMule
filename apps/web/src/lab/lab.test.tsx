import type { MeResponse, TestCatalogue, TestTemplate } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
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
    // STRATA-88: the board's empty state.
    expect(await screen.findByText('Nothing is waiting in the lab.')).toBeVisible();
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

  it('STRATA-88: programs with units to pull sit in the Units to pull column, with a Pull list link', async () => {
    renderAt(me(), '/lab-testing', (url) => {
      if (!url.startsWith('/api/worklist')) return null;
      const column = new URL(url, 'http://localhost').searchParams.get('column');
      const items =
        column === 'pull'
          ? [
              {
                programId: 'lp1',
                programNumber: 'LP-2026-0001',
                priority: 'urgent',
                project: {
                  id: '00000000-0000-4000-8000-000000000201',
                  projectNumber: 'DEMO-2601',
                  name: 'Riverbank investigation',
                },
                submittedAt: '2026-11-10T16:00:00.000Z',
                requestedBy: 'Pat Example',
                counts: {
                  requested: 2,
                  in_progress: 0,
                  completed: 0,
                  review: 0,
                  accepted: 0,
                  cancelled: 0,
                },
                openCount: 2,
                oldestOpenSeconds: 2 * 86_400,
                column: 'pull',
                unitsToPull: 1,
                canReview: false,
              },
            ]
          : [];
      return json(200, {
        items,
        total: items.length,
        urgentTotal: items.length,
        page: 1,
        pageSize: 100,
        projects: [],
      });
    });
    const pull = await screen.findByRole('list', { name: 'Units to pull' });
    const card = within(pull).getByRole('listitem', { name: 'LP-2026-0001' });
    expect(within(card).getByRole('link', { name: 'Pull list for LP-2026-0001' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1#units-to-pull',
    );
    expect(within(card).getByText('Urgent · Priority')).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Workboard' })).toBeInTheDocument();
  });

  it('STRATA-86: New lab program opens the editor, which waits for a project before starting a draft', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt(me(), '/lab-testing/programs');
    await user.click(await screen.findByRole('link', { name: 'New lab program' }));
    expect(await screen.findByRole('heading', { level: 1, name: 'New lab program' })).toBeVisible();
    expect(screen.getByLabelText('Project')).toBeVisible();
    const bar = screen.getByRole('region', { name: 'Submit' });
    expect(within(bar).getByRole('button', { name: 'Choose a project first.' })).toBeVisible();
    expect(within(bar).getByRole('button', { name: 'Submit to the lab' })).toBeDisabled();
    // Nothing is created (and nothing asks for a result) until a project is chosen.
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.queryByLabelText(/result/i)).toBeNull();
  });
});
