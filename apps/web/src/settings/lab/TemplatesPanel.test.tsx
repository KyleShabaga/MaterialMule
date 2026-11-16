import type { MeResponse, TestCatalogue, TestTemplate } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '@/components/strata/toast';
import { SessionContext } from '../../session/context';
import { TemplatesPanel } from './TemplatesPanel';

// Settings › Templates (MM-T23, STRATA-102). Fictional catalogue only.

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

const CATALOGUE: TestCatalogue = {
  groups: [{ id: 'g1', name: 'Soils', sortOrder: 1, version: 1, subgroups: [] }],
  tests: [
    {
      id: 't1',
      groupId: 'g1',
      groupName: 'Soils',
      subgroupId: null,
      subgroupName: null,
      code: 'DEMO_MAT-01',
      name: 'Moisture content',
      description: 'Moisture content (fictional)',
      sortOrder: 1,
      active: true,
      retiredAt: null,
      version: 1,
      sampleTagMode: 'none',
      sampleTagGroup: null,
    },
  ],
};

const template = (overrides: Partial<TestTemplate> = {}): TestTemplate => ({
  id: 'tp1',
  name: 'Index set',
  active: true,
  retiredAt: null,
  version: 4,
  items: [{ testTypeId: 't1', code: 'DEMO_MAT-01', displayName: 'Moisture content', active: true }],
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPanel(
  session: MeResponse,
  handler: (url: string, method: string) => Response | undefined = () => undefined,
) {
  const calls: { url: string; method: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (method !== 'GET') {
        calls.push({ url, method, body: JSON.parse(String(init?.body)) });
      }
      const handled = handler(url, method);
      if (handled) return handled;
      if (url === '/api/test-catalogue') return json(200, CATALOGUE);
      if (url === '/api/test-templates') {
        return json(200, [template(), template({ id: 'tp2', name: 'Old set', active: false })]);
      }
      return json(404, {});
    }),
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <TemplatesPanel />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings › Templates (STRATA-102)', () => {
  it('lists templates with their tests; retired ones only when asked', async () => {
    const user = userEvent.setup();
    renderPanel(me());
    expect(screen.getByRole('heading', { name: 'Templates', level: 2 })).toBeInTheDocument();
    const table = await screen.findByRole('table', { name: 'Templates' });
    const row = within(table).getByText('Index set').closest('tr')!;
    expect(row).toHaveTextContent('Moisture content');
    expect(row).toHaveTextContent('Available');
    expect(within(table).queryByText('Old set')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Include retired (1)' }));
    expect(within(table).getByText('Old set').closest('tr')).toHaveTextContent('Retired');
  });

  it('retires a template from its drawer with the loaded version', async () => {
    const user = userEvent.setup();
    const calls = renderPanel(me(), (url, method) =>
      url === '/api/test-templates/tp1/retire' && method === 'POST'
        ? json(200, template({ active: false, version: 5 }))
        : undefined,
    );
    await user.click(await screen.findByText('Index set'));
    const drawer = await screen.findByRole('dialog', { name: 'Index set' });
    expect(within(drawer).getByRole('button', { name: 'Save tests' })).toBeDisabled();
    await user.click(within(drawer).getByRole('button', { name: 'Retire' }));
    expect(await screen.findByText('Retired Index set.')).toBeInTheDocument();
    expect(calls).toEqual([
      { url: '/api/test-templates/tp1/retire', method: 'POST', body: { version: 4 } },
    ]);
  });

  it('adds a template and says when the name is taken', async () => {
    const user = userEvent.setup();
    renderPanel(me(), (url, method) =>
      url === '/api/test-templates' && method === 'POST'
        ? json(409, { code: 'test_template_exists' })
        : undefined,
    );
    await screen.findByRole('table', { name: 'Templates' });
    await user.click(screen.getByRole('button', { name: 'Add a template' }));
    const form = await screen.findByRole('form', { name: 'Add a template' });
    await user.type(within(form).getByLabelText('Template name'), 'Index set');
    await user.click(within(form).getByRole('button', { name: 'Add template' }));
    expect(
      await within(form).findByText('A template with this name already exists.'),
    ).toBeInTheDocument();
    expect(within(form).getByLabelText('Template name')).toHaveValue('Index set');
  });

  it('shows the load failure with Try again', async () => {
    renderPanel(me(), (url) => (url === '/api/test-templates' ? json(500, {}) : undefined));
    expect(await screen.findByText('The templates couldn’t be loaded.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('refuses anyone without test_catalog.manage', () => {
    renderPanel(me({ roles: [], permissions: ['inventory.read'] }));
    expect(
      screen.getByText('Only Lab Managers and administrators can open this page.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a template' })).toBeNull();
  });
});
