import type { MeResponse, TestCatalogue, TestType } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '@/components/strata/toast';
import { SessionContext } from '../../session/context';
import { LabTestsPage } from './LabTestsPage';

// Lab admin › Lab tests (MM-T23, MM-T69, STRATA-128). Fictional catalogue only. jsdom has no
// matchMedia, so the drawer is the narrow-screen sheet here.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000103',
  displayName: 'Lab (test)',
  initials: 'LAB',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'test_catalog.manage'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function test_(overrides: Partial<TestType>): TestType {
  return {
    id: 't1',
    groupId: 'g1',
    groupName: 'Soils',
    subgroupId: null,
    subgroupName: null,
    code: 'DEMO_MAT-01',
    name: 'Moisture content',
    description: 'Moisture content of soil (fictional)',
    sortOrder: 1,
    active: true,
    retiredAt: null,
    version: 1,
    sampleTagMode: 'none',
    sampleTagGroup: null,
    ...overrides,
  };
}

const CATALOGUE: TestCatalogue = {
  groups: [
    {
      id: 'g1',
      name: 'Soils',
      sortOrder: 1,
      version: 1,
      subgroups: [{ id: 's1', groupId: 'g1', name: 'Index', sortOrder: 1, version: 1 }],
    },
  ],
  tests: [
    test_({}),
    test_({
      id: 't2',
      subgroupId: 's1',
      subgroupName: 'Index',
      code: 'DEMO_MAT-02',
      name: 'Hydrometer',
      description: 'Hydrometer (fictional)',
      sampleTagMode: 'shared',
      sampleTagGroup: 'Grain size',
    }),
    test_({
      id: 't3',
      code: 'DEMO_MAT-03',
      name: null,
      description: 'Organic content (fictional)',
      active: false,
      retiredAt: '2026-10-01T00:00:00.000Z',
    }),
  ],
};

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Handler = (url: string, method: string, body: unknown) => Response | undefined;

function renderPage(session: MeResponse, handler: Handler = () => undefined, path = '/') {
  let catalogue = structuredClone(CATALOGUE);
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (method !== 'GET') calls.push({ url, method, body });
      const handled = handler(url, method, body);
      if (handled) {
        if (handled.ok && method !== 'GET') {
          const saved = (await handled.clone().json()) as TestType;
          if (saved?.id) {
            catalogue = {
              ...catalogue,
              tests: [...catalogue.tests.filter((t) => t.id !== saved.id), saved],
            };
          }
        }
        return handled;
      }
      if (url === '/api/test-catalogue') return json(200, catalogue);
      return json(404, {});
    }),
  );
  const router = createMemoryRouter([{ path: '/', element: <LabTestsPage /> }], {
    initialEntries: [path],
  });
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
  return { calls, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Lab tests (STRATA-128)', () => {
  it('groups the catalogue by group and subgroup, hiding retired tests until asked', async () => {
    const user = userEvent.setup();
    renderPage(me());
    const soils = await screen.findByRole('table', { name: 'Soils' });
    expect(within(soils).getByText('DEMO_MAT-01')).toBeInTheDocument();
    expect(within(soils).getByText('No tag')).toBeInTheDocument();
    const index = screen.getByRole('table', { name: 'Soils › Index' });
    expect(within(index).getByText('Shared: Grain size')).toBeInTheDocument();
    expect(screen.queryByText('DEMO_MAT-03')).toBeNull();

    await user.click(screen.getByRole('checkbox', { name: 'Include retired (1)' }));
    const row = screen.getByText('DEMO_MAT-03').closest('tr')!;
    expect(row).toHaveTextContent('Retired');
    expect(row).toHaveTextContent('Organic content (fictional)');
  });

  it('searches code, name and description', async () => {
    const user = userEvent.setup();
    renderPage(me());
    await user.type(await screen.findByLabelText('Search tests'), 'hydro');
    expect(screen.getByText('DEMO_MAT-02')).toBeInTheDocument();
    expect(screen.queryByText('DEMO_MAT-01')).toBeNull();
    expect(screen.queryByRole('table', { name: 'Soils' })).toBeNull();
    await user.clear(screen.getByLabelText('Search tests'));
    await user.type(screen.getByLabelText('Search tests'), 'nothing like it');
    expect(screen.getByText('No test matches')).toBeInTheDocument();
  });

  it('adds a test from the drawer and opens it', async () => {
    const user = userEvent.setup();
    const { calls, router } = renderPage(me(), (url, method, body) =>
      url === '/api/test-types' && method === 'POST'
        ? json(201, test_({ ...(body as Partial<TestType>), id: 't9', groupName: 'Soils' }))
        : undefined,
    );
    await user.click(await screen.findByRole('button', { name: 'Add test' }));
    const form = await screen.findByRole('form', { name: 'Add a test' });
    await user.type(within(form).getByLabelText('Code'), 'DEMO_UI-01');
    await user.type(within(form).getByLabelText('Full description'), 'Fictional, kept in full.');
    await user.click(within(form).getByRole('button', { name: 'Add test' }));
    expect(await screen.findByText('Added DEMO_UI-01.')).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: '/api/test-types',
      method: 'POST',
      body: {
        groupId: 'g1',
        subgroupId: null,
        code: 'DEMO_UI-01',
        name: null,
        description: 'Fictional, kept in full.',
        sampleTagMode: 'own',
        sampleTagGroup: null,
      },
    });
    expect(router.state.location.search).toBe('?open=t9');
    expect(await screen.findByRole('form', { name: 'Edit DEMO_UI-01' })).toBeInTheDocument();
  });

  it('shows a server field error beside its field and keeps the input', async () => {
    const user = userEvent.setup();
    renderPage(me(), (url, method) =>
      url === '/api/test-types' && method === 'POST'
        ? json(400, {
            code: 'validation_failed',
            errors: [{ field: 'code', code: 'too_big', message: 'must be at most 40 characters' }],
          })
        : undefined,
    );
    await user.click(await screen.findByRole('button', { name: 'Add test' }));
    const form = await screen.findByRole('form', { name: 'Add a test' });
    await user.type(within(form).getByLabelText('Code'), 'DEMO_LONG');
    await user.type(within(form).getByLabelText('Full description'), 'Fictional.');
    await user.click(within(form).getByRole('button', { name: 'Add test' }));
    expect(await within(form).findByText('Must be at most 40 characters')).toBeInTheDocument();
    expect(within(form).getByLabelText('Code')).toHaveAttribute('aria-invalid', 'true');
    expect(within(form).getByLabelText('Code')).toHaveValue('DEMO_LONG');
  });

  it('retires a test from its drawer with the loaded version, and restores it', async () => {
    const user = userEvent.setup();
    const { calls } = renderPage(me(), (url, method) => {
      if (url === '/api/test-types/t1/retire' && method === 'POST') {
        return json(
          200,
          test_({ active: false, retiredAt: '2026-11-13T00:00:00.000Z', version: 2 }),
        );
      }
      if (url === '/api/test-types/t1/restore' && method === 'POST') {
        return json(200, test_({ version: 3 }));
      }
      return undefined;
    });
    await user.click(await screen.findByText('DEMO_MAT-01'));
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByRole('heading', { name: 'Moisture content' })).toBeInTheDocument();
    expect(within(drawer).getByLabelText('Code')).toHaveValue('DEMO_MAT-01');
    await user.click(within(drawer).getByRole('button', { name: 'Retire' }));
    expect(await screen.findByText('Retired DEMO_MAT-01.')).toBeInTheDocument();
    expect(calls[0]).toEqual({
      url: '/api/test-types/t1/retire',
      method: 'POST',
      body: { version: 1 },
    });
    await user.click(await within(drawer).findByRole('button', { name: 'Restore' }));
    expect(await screen.findByText('Restored DEMO_MAT-01.')).toBeInTheDocument();
    expect(calls[1]?.body).toEqual({ version: 2 });
  });

  it('says so when someone else changed the test first', async () => {
    const user = userEvent.setup();
    renderPage(
      me(),
      (url, method) =>
        url === '/api/test-types/t1/retire' && method === 'POST'
          ? json(409, { code: 'version_conflict' })
          : undefined,
      '/?open=t1',
    );
    const drawer = await screen.findByRole('dialog');
    await user.click(within(drawer).getByRole('button', { name: 'Retire' }));
    expect(
      await within(drawer).findByText(
        'Someone else changed this first. The list has been refreshed; try again.',
      ),
    ).toBeInTheDocument();
  });

  it('shows the load failure with Try again', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderPage(me(), (url) =>
      url === '/api/test-catalogue' && ++calls === 1 ? json(500, {}) : undefined,
    );
    expect(await screen.findByText('The catalogue couldn’t be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Soils' })).toBeInTheDocument();
  });

  it('refuses anyone without test_catalog.manage', () => {
    renderPage(me({ roles: [], permissions: ['inventory.read'] }));
    expect(
      screen.getByText('Only Lab Managers and administrators can open this page.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add test' })).toBeNull();
  });
});
