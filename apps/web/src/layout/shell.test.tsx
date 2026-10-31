import type { MeResponse } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeReturnTo } from '../lib/return-to';
import { routes } from '../routes';
import { SessionContext, type SessionState } from '../session/context';
import { NAV_ITEMS, accountBadge, visibleNavItems } from './nav';
import { NavIcon } from './NavIcon';

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

describe('navigation', () => {
  it('lists the owner-approved labels in order', () => {
    expect(NAV_ITEMS.map((i) => i.label)).toEqual([
      'Dashboard',
      'Receiving Log',
      'Sample Storage',
      'Lab Testing',
      'Disposal & Retention',
      'Projects',
      'Settings',
    ]);
  });

  it('AC7: hides later-increment areas while their flags are off', () => {
    const labels = visibleNavItems({
      labTesting: false,
      disposalRetention: false,
    }).map((i) => i.label);
    expect(labels).toEqual([
      'Dashboard',
      'Receiving Log',
      'Sample Storage',
      'Projects',
      'Settings',
    ]);
    expect(
      visibleNavItems({
        labTesting: true,
        disposalRetention: false,
      }).map((i) => i.label),
    ).toContain('Lab Testing');
  });

  it('labels each account type', () => {
    expect(accountBadge(me({ accountType: 'shared_lab' })).label).toBe('Shared station: LAB');
    expect(accountBadge(me({ accountType: 'test' })).label).toBe('TEST');
    expect(accountBadge(me({ accountType: 'personal' })).label).toBe('Personal');
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
    expect(await screen.findByRole('heading', { name: 'Access pending' })).toBeInTheDocument();
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
    const header = screen.getByLabelText('Signed in user');
    expect(within(header).getByText(/Lab \(test\)/)).toBeInTheDocument();
    expect(within(header).getByText('TEST')).toBeInTheDocument();
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
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});

describe('phone menu drawer (MTR-137)', () => {
  it('makes the covered page inert, focuses the first link, and closes on Escape or an outside tap', async () => {
    const user = userEvent.setup();
    renderAt('/', { status: 'active', me: me() }, { '/api/activity/recent': [] });
    const menu = screen.getByRole('button', { name: 'Menu' });
    const main = document.getElementById('main')!;
    const identity = screen.getByLabelText('Signed in user');
    expect(main).not.toHaveAttribute('inert');

    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    expect(main).toHaveAttribute('inert');
    expect(identity).toHaveAttribute('inert');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toHaveFocus();

    await user.keyboard('{Escape}');
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
    expect(main).not.toHaveAttribute('inert');
    expect(identity).not.toHaveAttribute('inert');

    await user.click(menu);
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    // A tap inside the drawer keeps it open; one outside closes it.
    await user.click(within(nav).getByText('Primary navigation'));
    expect(menu).toHaveAttribute('aria-expanded', 'true');
    await user.click(document.body);
    expect(menu).toHaveAttribute('aria-expanded', 'false');
    expect(menu).toHaveFocus();
  });
});

describe('menu icons (MTR-92)', () => {
  it('every menu destination has an icon, so no label sits beside a blank gap', () => {
    for (const item of NAV_ITEMS) {
      const { container, unmount } = render(<NavIcon to={item.to} />);
      expect(container.querySelector('.nav-icon svg path'), item.label).not.toBeNull();
      unmount();
    }
  });
});
