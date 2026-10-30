import type { MeResponse, TestCatalogue, TestTemplate } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

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
  position: null,
  positionSetupRequired: false,
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
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const handled = extra(url, init);
    if (handled) return handled;
    if (url.startsWith('/api/test-catalogue')) return json(200, catalogue);
    if (url.startsWith('/api/test-templates')) return json(200, templates);
    if (url.startsWith('/api/lab-programs')) return json(200, { items: [], total: 0 });
    if (url.startsWith('/api/worklist')) return json(200, { items: [] });
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

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Lab Testing (MM-T23)', () => {
  it('AC11: one Lab Testing menu item opens the Worklist by default, with Programs and New program', async () => {
    const user = userEvent.setup();
    const { router } = renderAt(me(), '/lab-testing');
    expect(await screen.findByRole('heading', { name: 'Worklist' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/lab-testing');
    expect(
      await screen.findByText('Nothing waiting. Submitted programs appear here.'),
    ).toBeVisible();
    const tabs = screen.getByRole('navigation', { name: 'Lab Testing' });
    await user.click(within(tabs).getByRole('link', { name: 'Programs' }));
    expect(await screen.findByRole('heading', { name: 'Programs' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'New program' })).toBeVisible();
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
});
