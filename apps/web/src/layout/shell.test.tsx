import type { MeResponse } from '@trapezoid/shared';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { safeReturnTo } from '../lib/return-to';
import { routes } from '../routes';
import { SessionContext, type SessionState } from '../session/context';
import { NAV_ITEMS, accountBadge, visibleNavItems } from './nav';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Lab (test)',
  initials: 'LAB',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
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
      'Lab Testing Worklist',
      'Testing Programs',
      'Disposal & Retention',
      'Projects',
      'Settings',
    ]);
  });

  it('AC7: hides later-increment areas while their flags are off', () => {
    const labels = visibleNavItems({
      labTestingWorklist: false,
      testingPrograms: false,
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
        labTestingWorklist: true,
        testingPrograms: false,
        disposalRetention: false,
      }).map((i) => i.label),
    ).toContain('Lab Testing Worklist');
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

  it('AC2: shows pending users only the access-pending page', async () => {
    const router = renderAt('/', {
      status: 'pending',
      me: me({ status: 'pending', permissions: [] }),
    });
    expect(await screen.findByRole('heading', { name: 'Access pending' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/access-pending');
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
            href: '/receiving-log/r1',
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
    expect(link).toHaveAttribute('href', '/receiving-log/r1');
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
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
  });

  it('shows a not-found page for unknown paths inside the app', async () => {
    renderAt('/nowhere', { status: 'active', me: me() });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });
});
