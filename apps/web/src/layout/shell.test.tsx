import type { MeResponse } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeReturnTo } from '../lib/return-to';
import { routes } from '../routes';
import { SessionContext, type SessionState } from '../session/context';
import {
  accountInitials,
  accountRoleLine,
  accountRowText,
  activeDestination,
  activeSubPage,
  destinationsFor,
} from './nav';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Lab (test)',
  initials: 'LAB',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** Renders the real route tree at `path` with a fixed session and stubbed API responses. */
function renderAt(path: string, session: SessionState, api: Record<string, unknown> = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      const key = Object.keys(api).find((prefix) => url.startsWith(prefix));
      if (key) return jsonResponse(200, api[key]);
      if (url.startsWith('/api/health')) {
        return jsonResponse(200, { status: 'ok', version: '0.1.0', database: 'up' });
      }
      return jsonResponse(404, {});
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session,
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const ALL_ON = {
  labTesting: true,
  disposalRetention: true,
  concreteReview: true,
  concreteLab: true,
};
const ALL_OFF = {
  labTesting: false,
  disposalRetention: false,
  concreteReview: false,
  concreteLab: false,
};
const LAB_STAFF: Pick<MeResponse, 'accountType' | 'roles'> = {
  accountType: 'personal',
  roles: ['lab_technician'],
};
const OTHER: Pick<MeResponse, 'accountType' | 'roles'> = { accountType: 'personal', roles: [] };

function childrenOf(who: Pick<MeResponse, 'accountType' | 'roles'>, key: string) {
  return destinationsFor(who, ALL_ON).find((d) => d.key === key)!.children;
}

describe('flat destinations (page sections, concrete lab pages)', () => {
  it('lists the seven destinations in order, Projects second and Concrete last', () => {
    expect(destinationsFor(OTHER, ALL_ON).map((d) => [d.label, d.to])).toEqual([
      ['Today', '/'],
      ['Projects', '/projects'],
      ['Receive', '/receiving-log'],
      ['Inventory', '/sample-storage'],
      ['Lab programs', '/lab-testing'],
      ['Retention', '/disposal-retention'],
      ['Concrete', '/concrete'],
    ]);
  });

  it('AC7: hides later-increment areas while their flags are off', () => {
    expect(destinationsFor(OTHER, ALL_OFF).map((d) => d.label)).toEqual([
      'Today',
      'Projects',
      'Receive',
      'Inventory',
    ]);
    // Without the Concrete dashboard, Concrete opens on the review queue (one page, no group).
    expect(destinationsFor(OTHER, { ...ALL_OFF, concreteReview: true }).at(-1)).toMatchObject({
      label: 'Concrete',
      to: '/concrete/review',
      children: [],
    });
  });

  it('groups Retention and Concrete; only lab staff get Overview and the Concrete lab pages', () => {
    expect(childrenOf(OTHER, 'retention').map((c) => [c.label, c.to])).toEqual([
      ['Due and overdue', '/disposal-retention'],
      ['Disposal scan', '/disposal-retention/scan'],
    ]);
    expect(childrenOf(LAB_STAFF, 'concrete').map((c) => [c.label, c.to])).toEqual([
      ['Overview', '/concrete'],
      ['Breaks', '/lab-testing/concrete'],
      ['Receiving', '/concrete/receiving'],
      ['Specimens', '/concrete/specimens'],
      ['Holds', '/lab-testing/concrete/holds'],
      ['Review', '/concrete/review'],
    ]);
    expect(childrenOf(OTHER, 'concrete').map((c) => c.label)).toEqual([
      'Breaks',
      'Holds',
      'Review',
    ]);
    expect(
      childrenOf({ accountType: 'shared_lab', roles: [] }, 'concrete').map((c) => c.label),
    ).toEqual(['Overview', 'Breaks', 'Receiving', 'Specimens', 'Holds', 'Review']);
    // Single-page destinations have no group.
    expect(childrenOf(OTHER, 'projects')).toEqual([]);
  });

  it('STRATA-93: Overview needs lab staff and the Concrete dashboard (concreteLab)', () => {
    const overview = (
      who: Pick<MeResponse, 'accountType' | 'roles'>,
      features: typeof ALL_ON = ALL_ON,
    ) =>
      destinationsFor(who, features)
        .find((d) => d.key === 'concrete')
        ?.children.find((c) => c.label === 'Overview') ?? null;
    // Lab Technician, Lab Manager and the shared LAB station see it first in the group.
    for (const who of [
      LAB_STAFF,
      { accountType: 'personal' as const, roles: ['lab_manager' as const] },
      { accountType: 'shared_lab' as const, roles: [] },
    ]) {
      expect(overview(who), JSON.stringify(who)).toEqual({
        to: '/concrete',
        label: 'Overview',
        match: 'exact',
      });
      expect(childrenOf(who, 'concrete')[0]!.label).toBe('Overview');
    }
    // Everyone else, and lab staff without the Concrete dashboard, do not.
    expect(overview(OTHER)).toBeNull();
    expect(overview({ accountType: 'personal', roles: ['admin'] })).toBeNull();
    expect(overview(LAB_STAFF, { ...ALL_ON, concreteLab: false })).toBeNull();
  });

  it('activeDestination maps every section path to its destination', () => {
    const cases: [string, ReturnType<typeof activeDestination>][] = [
      ['/', 'today'],
      ['/projects', 'projects'],
      ['/projects/p1/team', 'projects'],
      ['/projectsx', null],
      ['/receiving-log/new', 'receive'],
      ['/labels/print/receipt/r1', 'receive'],
      ['/labels/print/unit/u1', null],
      ['/sample-storage', 'inventory'],
      ['/sample-storage/scan', 'inventory'],
      ['/inventory', 'inventory'],
      ['/storage-units/BKT-2026-000001', 'inventory'],
      ['/lab-testing', 'lab'],
      ['/lab-testing/programs/x', 'lab'],
      ['/lab-testing/concrete', 'concrete'],
      ['/lab-testing/concrete/holds', 'concrete'],
      ['/disposal-retention', 'retention'],
      ['/disposal-retention/scan', 'retention'],
      ['/concrete', 'concrete'],
      ['/concrete/review/r1', 'concrete'],
      ['/settings/profile', 'settings'],
      ['/notifications', null],
      ['/search', null],
    ];
    for (const [path, expected] of cases) expect(activeDestination(path), path).toBe(expected);
  });

  it('activeSubPage: exact for Overview, Breaks and Due and overdue, prefix for the rest', () => {
    const concrete = childrenOf(LAB_STAFF, 'concrete');
    expect(activeSubPage('/lab-testing/concrete', concrete)).toBe('/lab-testing/concrete');
    expect(activeSubPage('/lab-testing/concrete/holds', concrete)).toBe(
      '/lab-testing/concrete/holds',
    );
    expect(activeSubPage('/concrete/review/r1/issue', concrete)).toBe('/concrete/review');
    expect(activeSubPage('/concrete/specimens/s1', concrete)).toBe('/concrete/specimens');
    // STRATA-93: Overview is current only on /concrete itself.
    expect(activeSubPage('/concrete', concrete)).toBe('/concrete');
    expect(activeSubPage('/concrete/testing', concrete)).toBeNull();
    const retention = childrenOf(OTHER, 'retention');
    expect(activeSubPage('/disposal-retention', retention)).toBe('/disposal-retention');
    expect(activeSubPage('/disposal-retention/scan', retention)).toBe('/disposal-retention/scan');
  });

  it('derives initials and the role line for the account row', () => {
    expect(accountInitials({ initials: 'KCS', displayName: 'Kim Smith' })).toBe('KCS');
    expect(accountInitials({ initials: null, displayName: 'Alex Tester' })).toBe('AT');
    expect(accountInitials({ initials: null, displayName: 'Lab (test)' })).toBe('L');
    expect(accountRoleLine({ roles: ['admin', 'lab_manager'], accountType: 'personal' })).toBe(
      'Admin, Lab Manager',
    );
    expect(accountRoleLine({ roles: [], accountType: 'shared_lab' })).toBe('Shared station');
    expect(accountRowText({ accountType: 'shared_lab', displayName: 'LAB', roles: [] })).toEqual({
      name: 'LAB station',
      line: 'Shared · Receiving lab',
    });
  });
});

describe('safeReturnTo', () => {
  it('allows in-app paths and rejects anything that could leave the app', () => {
    expect(safeReturnTo('/projects?mine=1')).toBe('/projects?mine=1');
    expect(safeReturnTo(null)).toBe('/');
    expect(safeReturnTo('https://evil.example')).toBe('/');
    expect(safeReturnTo('//evil.example')).toBe('/');
  });
});

describe('route guard', () => {
  it('AC5: sends signed-out users to sign-in with a return path', async () => {
    const router = renderAt(
      '/projects',
      { status: 'signed-out' },
      {
        '/api/auth/providers': { microsoft: false, lab: false, test: true },
      },
    );
    expect(await screen.findByText('Test sign-in (development only)')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(router.state.location.search).toBe('?returnTo=%2Fprojects&expired=1');
    expect(screen.getByRole('status')).toHaveTextContent('Your session has ended');
  });

  it('MM-T61: an unreachable Material Mule says so in plain words and offers Reload', async () => {
    renderAt('/', {
      status: 'error',
      message: 'Material Mule couldn’t be reached. Check the connection, then reload the page.',
    });
    expect(
      await screen.findByRole('heading', { name: 'Material Mule is unavailable' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeInTheDocument();
    expect(screen.getByRole('alert')).not.toHaveTextContent(/API/);
  });

  it('AC2: shows pending users only the access-pending page', async () => {
    const router = renderAt('/', {
      status: 'pending',
      me: me({ status: 'pending', permissions: [] }),
    });
    expect(
      await screen.findByRole('heading', { name: 'You are signed in, but not set up yet.' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/access-pending');
    expect(screen.getByText('Waiting for approval')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Main' })).not.toBeInTheDocument();
  });
});

describe('dashboard', () => {
  it('AC1/AC3: shows identity, the shortcuts and the latest activity with links', async () => {
    renderAt(
      '/',
      { status: 'active', me: me() },
      {
        '/api/activity/recent': [
          {
            id: 'e1',
            // Today keeps only the last 24 hours.
            occurredAt: new Date(Date.now() - 3_600_000).toISOString(),
            action: 'receipt.confirmed',
            actorInitials: 'AT',
            actorName: 'Alex Tester',
            summary: 'AT received BKT-2026-000014 for DEMO-2601',
            href: '/sample-storage?receiptId=r1&status=all',
          },
        ],
      },
    );
    const account = screen.getByRole('group', { name: 'Signed in user' });
    expect(within(account).getByText('Lab (test)')).toBeInTheDocument();
    expect(within(account).getByText('LAB')).toBeInTheDocument();
    expect(within(account).getByText('Lab Manager')).toBeInTheDocument();
    expect(within(account).getByText('TEST')).toBeInTheDocument();
    expect(within(account).getByRole('button', { name: /Account menu$/ })).toBeInTheDocument();
    // Strata Today (STRATA-23): the Lab Manager's shortcuts.
    expect(
      within(screen.getByRole('navigation', { name: 'Shortcuts' })).getByRole('link', {
        name: 'Retention due',
      }),
    ).toHaveAttribute('href', '/disposal-retention');
    const link = await screen.findByRole('link', {
      name: 'AT received BKT-2026-000014 for DEMO-2601',
    });
    expect(link).toHaveAttribute('href', '/sample-storage?receiptId=r1&status=all');
  });

  it('MTR-136: a menu link moves focus to the new page heading, not the old link', async () => {
    const user = userEvent.setup();
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    await screen.findByText('Nothing recorded in the last 24 hours.');
    // The first page load keeps the browser's own focus.
    expect(screen.getByRole('heading', { level: 1 })).not.toHaveFocus();
    const link = screen.getByRole('link', { name: 'Projects' });
    link.focus();
    await user.keyboard('{Enter}');
    const heading = await screen.findByRole('heading', { level: 1, name: 'Projects' });
    await waitFor(() => expect(heading).toHaveFocus());
    expect(heading).toHaveAttribute('tabindex', '-1');
  });

  /** Dashboard first, with GET /api/projects/p1 held until the test releases it (a 404). */
  async function dashboardWithSlowProject() {
    let release = () => undefined as void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const router = renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    const stub = vi.mocked(fetch);
    const original = stub.getMockImplementation()!;
    stub.mockImplementation(async (input, init) => {
      if (String(input).startsWith('/api/projects/p1')) {
        await held;
        return jsonResponse(404, { code: 'not_found', message: 'Project not found.' });
      }
      return original(input, init);
    });
    await screen.findByText('Nothing recorded in the last 24 hours.');
    return { router, release };
  }

  it('card #115: focus chosen while the page heading loads stays where the user put it', async () => {
    const { router, release } = await dashboardWithSlowProject();
    await act(async () => {
      await router.navigate('/projects/p1');
    });
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    const settings = screen.getByRole('link', { name: 'Inventory' });
    act(() => settings.focus());
    await act(async () => release());
    expect(await screen.findByRole('heading', { level: 1, name: 'Project' })).toBeInTheDocument();
    expect(settings).toHaveFocus();
  });

  it('card #115: an untouched initiating link still yields focus to the late heading', async () => {
    const { router, release } = await dashboardWithSlowProject();
    const link = screen.getByRole('link', { name: 'Projects' });
    act(() => link.focus());
    await act(async () => {
      await router.navigate('/projects/p1');
    });
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    await act(async () => release());
    const heading = await screen.findByRole('heading', { level: 1, name: 'Project' });
    await waitFor(() => expect(heading).toHaveFocus());
  });

  it('shows the empty state when nothing has happened yet', async () => {
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    expect(await screen.findByText('Nothing recorded in the last 24 hours.')).toBeInTheDocument();
  });

  it('shows a retryable error when activity fails to load', async () => {
    renderAt('/', { status: 'active', me: me() });
    expect(await screen.findByText(/The last 24 hours couldn’t load/)).toBeInTheDocument();
    const activity = screen.getByRole('region', { name: 'Last 24 hours' });
    expect(within(activity).getByRole('button', { name: 'Try again' })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown paths inside the app', async () => {
    renderAt('/nowhere', { status: 'active', me: me() });
    expect(
      await screen.findByRole('heading', { name: 'This page doesn’t exist.' }),
    ).toBeInTheDocument();
  });
});
