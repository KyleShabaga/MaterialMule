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
  accountBadge,
  accountInitials,
  accountRoleLine,
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

describe('navigation (Field Ledger rail)', () => {
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

  it('groups Retention and Concrete; only lab staff get the Concrete lab pages', () => {
    expect(childrenOf(OTHER, 'retention').map((c) => [c.label, c.to])).toEqual([
      ['Due and overdue', '/disposal-retention'],
      ['Disposal scan', '/disposal-retention/scan'],
    ]);
    expect(childrenOf(LAB_STAFF, 'concrete').map((c) => [c.label, c.to])).toEqual([
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
    ).toContain('Receiving');
    // Single-page destinations have no group.
    expect(childrenOf(OTHER, 'projects')).toEqual([]);
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

  it('activeSubPage: exact for Breaks and Due and overdue, prefix for the rest', () => {
    const concrete = childrenOf(LAB_STAFF, 'concrete');
    expect(activeSubPage('/lab-testing/concrete', concrete)).toBe('/lab-testing/concrete');
    expect(activeSubPage('/lab-testing/concrete/holds', concrete)).toBe(
      '/lab-testing/concrete/holds',
    );
    expect(activeSubPage('/concrete/review/r1/issue', concrete)).toBe('/concrete/review');
    expect(activeSubPage('/concrete/specimens/s1', concrete)).toBe('/concrete/specimens');
    expect(activeSubPage('/concrete', concrete)).toBeNull();
    const retention = childrenOf(OTHER, 'retention');
    expect(activeSubPage('/disposal-retention', retention)).toBe('/disposal-retention');
    expect(activeSubPage('/disposal-retention/scan', retention)).toBe('/disposal-retention/scan');
  });

  it('labels each account type', () => {
    expect(accountBadge(me({ accountType: 'shared_lab' })).label).toBe('Shared station: LAB');
    expect(accountBadge(me({ accountType: 'test' })).label).toBe('TEST');
    expect(accountBadge(me({ accountType: 'personal' })).label).toBe('Personal');
  });

  it('derives initials and the role line for the account row', () => {
    expect(accountInitials({ initials: 'KCS', displayName: 'Kim Smith' })).toBe('KCS');
    expect(accountInitials({ initials: null, displayName: 'Alex Tester' })).toBe('AT');
    expect(accountInitials({ initials: null, displayName: 'Lab (test)' })).toBe('L');
    expect(accountRoleLine({ roles: ['admin', 'lab_manager'], accountType: 'personal' })).toBe(
      'Admin, Lab Manager',
    );
    expect(accountRoleLine({ roles: [], accountType: 'shared_lab' })).toBe('Shared station');
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
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
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
  it('AC1/AC3: shows identity, Receive samples and the latest activity with links', async () => {
    renderAt(
      '/',
      { status: 'active', me: me() },
      {
        '/api/activity/recent': [
          {
            id: 'e1',
            occurredAt: '2026-10-25T16:42:00.000Z',
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
    expect(within(account).getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // Switch user and the session end are for the shared LAB station only.
    expect(within(account).queryByRole('button', { name: 'Switch user' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Receive samples' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    const link = await screen.findByRole('link', {
      name: 'AT received BKT-2026-000014 for DEMO-2601',
    });
    expect(link).toHaveAttribute('href', '/sample-storage?receiptId=r1&status=all');
  });

  it('MTR-136: a menu link moves focus to the new page heading, not the old link', async () => {
    const user = userEvent.setup();
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    await screen.findByText('No activity yet. Receive the first storage unit.');
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
    await screen.findByText('No activity yet. Receive the first storage unit.');
    return { router, release };
  }

  it('card #115: focus chosen while the page heading loads stays where the user put it', async () => {
    const { router, release } = await dashboardWithSlowProject();
    await act(async () => {
      await router.navigate('/projects/p1');
    });
    expect(await screen.findByText('Loading…')).toBeInTheDocument();
    const settings = screen.getByRole('link', { name: 'Settings' });
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
    expect(
      await screen.findByText('No activity yet. Receive the first storage unit.'),
    ).toBeInTheDocument();
  });

  it('shows a retryable error when activity fails to load', async () => {
    renderAt('/', { status: 'active', me: me() });
    expect(await screen.findByText(/Recent activity couldn't load/)).toBeInTheDocument();
    const activity = screen.getByRole('region', { name: 'Recent activity' });
    expect(within(activity).getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown paths inside the app', async () => {
    renderAt('/nowhere', { status: 'active', me: me() });
    expect(
      await screen.findByRole('heading', { name: 'Nothing is at this address.' }),
    ).toBeInTheDocument();
  });
});

describe('desktop rail', () => {
  it('lists the destinations, marks the current one and opens its group by itself', async () => {
    const user = userEvent.setup();
    renderAt('/disposal-retention/scan', { status: 'active', me: me() });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(
      within(nav)
        .getAllByRole('link')
        .slice(0, 9)
        .map((a) => a.textContent),
    ).toEqual([
      'Material Mule',
      'Today',
      'Projects',
      'Receive',
      'Inventory',
      'Lab programs',
      'Retention',
      'Due and overdue',
      'Disposal scan',
    ]);
    expect(within(nav).getByRole('link', { name: 'Retention' })).toHaveAttribute(
      'aria-current',
      'true',
    );
    expect(within(nav).getByRole('link', { name: 'Disposal scan' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Due and overdue' })).not.toHaveAttribute(
      'aria-current',
    );
    const hide = within(nav).getByRole('button', { name: 'Hide Retention pages' });
    expect(hide).toHaveAttribute('aria-expanded', 'true');
    expect(hide).toHaveAttribute('aria-controls', 'rail-group-retention');
    await user.click(hide);
    expect(within(nav).queryByRole('link', { name: 'Disposal scan' })).toBeNull();
    expect(within(nav).getByRole('button', { name: 'Show Retention pages' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    // The Concrete group stays closed outside its section until its chevron opens it.
    expect(within(nav).queryByRole('link', { name: 'Breaks' })).toBeNull();
    await user.click(within(nav).getByRole('button', { name: 'Show Concrete pages' }));
    const concrete = within(nav).getByRole('list', { name: 'Concrete pages' });
    expect(
      within(concrete)
        .getAllByRole('link')
        .map((a) => a.textContent),
    ).toEqual(['Breaks', 'Receiving', 'Specimens', 'Holds', 'Review']);
  });

  it('ink-fills Settings on a settings page; Help & Feedback and dark mode sit in the footer', async () => {
    renderAt('/settings/profile', { status: 'active', me: me() });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Settings' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Help & Feedback' })).toHaveAttribute(
      'href',
      '/help',
    );
    expect(within(nav).getByRole('link', { name: 'Today' })).not.toHaveAttribute('aria-current');
    expect(within(nav).getByRole('switch', { name: 'Dark mode' })).toBeInTheDocument();
    // No Pending actions without action_item.read.
    expect(within(nav).queryByRole('link', { name: /^Pending actions/ })).toBeNull();
  });

  it('the top bar holds the search field and nothing from the rail', async () => {
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    const top = await screen.findByRole('banner');
    expect(within(top).getByRole('search', { name: 'Search' })).toBeInTheDocument();
    expect(within(top).getByRole('textbox', { name: 'Search' })).toHaveAttribute(
      'placeholder',
      'Search units, samples, projects, programs…',
    );
    expect(within(top).queryByRole('link', { name: 'Material Mule' })).toBeNull();
  });

  it('shows Switch user and the session end for the shared LAB station', async () => {
    renderAt(
      '/',
      {
        status: 'active',
        me: me({ accountType: 'shared_lab', displayName: 'LAB', initials: null, roles: [] }),
      },
      { '/api/activity/recent': [] },
    );
    const account = await screen.findByRole('group', { name: 'Signed in user' });
    expect(within(account).getByText('Shared station: LAB')).toBeInTheDocument();
    expect(within(account).getByText(/Session ends/)).toBeInTheDocument();
    expect(within(account).getByRole('button', { name: 'Switch user' })).toBeInTheDocument();
  });
});

/** matchMedia answering true for the phone query only. */
function stubPhone() {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query === '(max-width: 640px)',
    media: query,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  }));
}

describe('phone bottom bar and More sheet (MTR-137)', () => {
  it('has five slots, the current one marked, and no rail', async () => {
    stubPhone();
    renderAt('/receiving-log', { status: 'active', me: me() });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    expect(screen.getAllByRole('navigation', { name: 'Main' })).toHaveLength(1);
    expect(
      within(nav)
        .getAllByRole('listitem')
        .map((li) => li.textContent),
    ).toEqual(['Today', 'Find', 'Scan', 'Receive', 'More']);
    expect(within(nav).getByRole('link', { name: 'Receive' })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(within(nav).getByRole('link', { name: 'Find' })).toHaveAttribute('href', '/search');
    expect(within(nav).getByRole('link', { name: 'Scan' })).toHaveAttribute(
      'href',
      '/sample-storage/scan',
    );
    expect(screen.queryByRole('link', { name: 'Projects' })).toBeNull();
  });

  it('makes the covered page inert, focuses the first link, and closes on Escape or an outside tap', async () => {
    stubPhone();
    const user = userEvent.setup();
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    const more = await screen.findByRole('button', { name: 'More' });
    const main = document.getElementById('main')!;
    const header = screen.getByRole('banner');
    expect(main).not.toHaveAttribute('inert');

    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    expect(main).toHaveAttribute('inert');
    expect(header).toHaveAttribute('inert');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Projects' })).toHaveFocus();
    expect(within(nav).getByRole('link', { name: 'Settings' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Help & Feedback' })).toBeInTheDocument();
    expect(within(nav).getByRole('group', { name: 'Signed in user' })).toBeInTheDocument();
    expect(within(nav).getByRole('switch', { name: 'Dark mode' })).toBeInTheDocument();
    // The bar's own destinations aren't repeated in the sheet.
    expect(within(nav).getAllByRole('link', { name: 'Today' })).toHaveLength(1);

    await user.keyboard('{Escape}');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
    expect(main).not.toHaveAttribute('inert');
    expect(within(nav).queryByRole('link', { name: 'Projects' })).toBeNull();

    await user.click(more);
    expect(more).toHaveAttribute('aria-expanded', 'true');
    // A tap inside the sheet keeps it open; one outside closes it.
    await user.click(within(nav).getByText('Lab Manager'));
    expect(more).toHaveAttribute('aria-expanded', 'true');
    await user.click(document.body);
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveFocus();
  });

  it('closes the sheet once a destination is chosen, and marks More for its pages', async () => {
    stubPhone();
    const user = userEvent.setup();
    const router = renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    const more = await screen.findByRole('button', { name: 'More' });
    await user.click(more);
    await user.click(screen.getByRole('link', { name: 'Projects' }));
    expect(router.state.location.pathname).toBe('/projects');
    expect(more).toHaveAttribute('aria-expanded', 'false');
    expect(more).toHaveClass('is-current');
  });
});
