import type { MeResponse } from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { Outlet, createMemoryRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '../session/context';
import { FeedbackDialogProvider } from '../feedback/FeedbackDialog';
import { HelpPage } from './HelpPage';
import {
  ACCESS_PENDING_POLL_MS,
  APPROVER_LINE,
  AccessPendingPage,
  ErrorPage,
  NotFoundPage,
} from './simple-pages';

// The shell's Ctrl K menu (search agent): a stand-in, so Page not found's Search can be checked
// without the real dialog. `current: null` is a page rendered outside the shell.
const commandMenu = vi.hoisted(() => ({
  current: null as null | { open: (initialQuery?: string) => void },
}));
vi.mock('../search/command-menu', () => ({
  useCommandMenu: () => {
    if (!commandMenu.current) throw new Error('useCommandMenu outside <CommandMenuProvider>');
    return {
      ...commandMenu.current,
      close: () => undefined,
      toggle: () => undefined,
      isOpen: false,
    };
  },
}));

// Entry pages: Help and how-tos, Page not found and Access pending. Fictional people.

const STAFF: MeResponse = {
  id: '00000000-0000-4000-8000-0000000000a1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  profileRefreshFailed: false,
};

const ADMIN: MeResponse = {
  ...STAFF,
  id: '00000000-0000-4000-8000-0000000000a2',
  displayName: 'Kit Admin',
  roles: ['admin'],
  permissions: ['inventory.read', 'staff.manage', 'feedback.read'],
};

type Handler = (init?: RequestInit) => { status: number; body?: unknown };

function stubFetch(handlers: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const path = new URL(url, 'http://localhost').pathname;
      const handler = handlers[`${init?.method ?? 'GET'} ${path}`];
      const answer = handler ? handler(init) : { status: 404, body: {} };
      return new Response(JSON.stringify(answer.body ?? {}), {
        status: answer.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  return calls;
}

function renderRoutes(
  routes: RouteObject[],
  path: string | { pathname: string; state: unknown },
  session: SessionState,
  extra: { refresh?: () => Promise<void> } = {},
) {
  const router = createMemoryRouter([...routes, { path: '*', element: <p>Elsewhere</p> }], {
    initialEntries: [path],
  });
  const refresh = extra.refresh ?? vi.fn(async () => undefined);
  const wrap = (children: ReactNode) => (
    <SessionContext.Provider value={{ session, refresh, signOut: vi.fn(async () => undefined) }}>
      {children}
    </SessionContext.Provider>
  );
  render(wrap(<RouterProvider router={router} />));
  return { router, refresh };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Help and how-tos', () => {
  const help = [{ path: '/help', element: <HelpPage /> }];

  it('lists the guide groups with anchors, Common questions and the version; no form', async () => {
    stubFetch({
      'GET /api/health': () => ({
        status: 200,
        body: { status: 'ok', version: '1.4.0', database: 'up' },
      }),
    });
    renderRoutes(help, '/help', { status: 'active', me: STAFF });
    expect(screen.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
    for (const group of [
      'Getting around',
      'Receiving',
      'Shelves, labels and retention',
      'Lab tests',
      'Concrete',
      'Access and accounts',
      'Keyboard shortcuts',
    ]) {
      expect(screen.getByRole('heading', { level: 2, name: group })).toBeInTheDocument();
    }
    expect(screen.getByRole('link', { name: 'Receiving' })).toHaveAttribute(
      'href',
      '/help#group-receiving',
    );
    expect(document.getElementById('lab-stations')).not.toBeNull();
    expect(screen.getByText('Does an ID ever change?')).toBeInTheDocument();
    expect(await screen.findByText('1.4.0')).toBeInTheDocument();
    // The Feedback & bugs dialog replaced the form; not an admin: no received feedback.
    expect(screen.queryByLabelText('What happened')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Feedback received' })).toBeNull();
  });

  it('shows administrators the feedback received, newest first', async () => {
    stubFetch({
      'GET /api/feedback': () => ({
        status: 200,
        body: [
          {
            id: 'f2',
            submittedAt: '2026-11-10T16:00:00.000Z',
            name: 'Alex Tester',
            initials: 'AT',
            accountType: 'personal',
            kind: 'idea',
            text: 'Show the shelf on the label.',
            page: '/sample-storage',
          },
        ],
      }),
    });
    renderRoutes(help, '/help', { status: 'active', me: ADMIN });
    const received = await screen.findByRole('region', { name: 'Feedback received' });
    expect(await within(received).findByText('Show the shelf on the label.')).toBeVisible();
    expect(within(received).getByText('Idea')).toBeInTheDocument();
    expect(within(received).getByText('Alex Tester')).toBeInTheDocument();
  });
});

describe('Page not found', () => {
  it('says the page doesn’t exist, shows the address, and offers Today and Search (Ctrl K)', () => {
    const open = vi.fn();
    commandMenu.current = { open };
    try {
      renderRoutes([{ path: '/nowhere', element: <NotFoundPage /> }], '/nowhere?from=old-link', {
        status: 'active',
        me: STAFF,
      });
      expect(
        screen.getByRole('heading', { level: 1, name: 'This page doesn’t exist.' }),
      ).toBeVisible();
      expect(screen.getByText('Check the address, or go back to Today.')).toBeInTheDocument();
      expect(screen.getByText('/nowhere?from=old-link')).toBeInTheDocument();
      expect(screen.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/');
      expect(document.title).toBe('Page not found · Material Mule');
      const search = screen.getByRole('button', { name: /^Search/ });
      expect(search).toHaveAttribute('aria-keyshortcuts', 'Control+K');
      fireEvent.click(search);
      expect(open).toHaveBeenCalledTimes(1);
    } finally {
      commandMenu.current = null;
    }
  });

  it('goes to the search page when no command menu is around', async () => {
    const { router } = renderRoutes([{ path: '/nowhere', element: <NotFoundPage /> }], '/nowhere', {
      status: 'active',
      me: STAFF,
    });
    fireEvent.click(screen.getByRole('button', { name: /^Search/ }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
  });
});

describe('Something went wrong', () => {
  function Broken(): never {
    throw new Error('secret stack detail at line 42');
  }

  it('shows Reload and Go to Today inside the shell, never the error itself', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderRoutes(
      [
        {
          path: '/',
          element: (
            <div>
              <nav aria-label="Sidebar">Sidebar stays</nav>
              <Outlet />
            </div>
          ),
          children: [
            {
              errorElement: <ErrorPage inShell />,
              children: [{ path: 'broken', element: <Broken /> }],
            },
          ],
        },
      ],
      '/broken',
      { status: 'active', me: STAFF },
    );
    expect(
      screen.getByRole('heading', {
        level: 1,
        name: 'Something went wrong while showing this page.',
      }),
    ).toBeVisible();
    expect(screen.getByRole('navigation', { name: 'Sidebar' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/');
    expect(document.body.textContent).not.toContain('secret stack detail');
  });

  it('offers Feedback & bugs inside the shell, with the page it happened on', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderRoutes(
      [
        {
          path: '/',
          element: (
            <FeedbackDialogProvider>
              <Outlet />
            </FeedbackDialogProvider>
          ),
          children: [
            {
              errorElement: <ErrorPage inShell />,
              children: [{ path: 'broken', element: <Broken /> }],
            },
          ],
        },
      ],
      '/broken',
      { status: 'active', me: STAFF },
    );
    fireEvent.click(screen.getByRole('button', { name: 'Feedback & bugs' }));
    const dialog = await screen.findByRole('dialog', { name: 'Feedback & bugs' });
    expect(dialog).toHaveTextContent('/broken');
  });

  it('uses the sign-in layout at the root', () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    renderRoutes(
      [{ path: '/broken', element: <Broken />, errorElement: <ErrorPage /> }],
      '/broken',
      { status: 'signed-out' },
    );
    expect(screen.getByRole('alert')).toHaveTextContent(
      'Something went wrong while showing this page.',
    );
    expect(screen.getByTestId('sign-in-background')).toHaveAttribute('aria-hidden', 'true');
    expect(document.body.textContent).not.toContain('secret stack detail');
  });
});

describe('Waiting for approval', () => {
  const pending: SessionState = { status: 'pending', me: { ...STAFF, status: 'pending' } };
  const page = [{ path: '/access-pending', element: <AccessPendingPage /> }];

  it('names who is signed in and who approves, checks again on demand and every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    stubFetch({
      'GET /api/me/profile': () => ({
        status: 200,
        body: { workEmail: 'alex.tester@materialmule-demo.example', signInUsername: null },
      }),
    });
    const refresh = vi.fn(async () => undefined);
    renderRoutes(page, '/access-pending', pending, { refresh });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You are signed in, but not set up yet.' }),
    ).toBeVisible();
    expect(screen.getByText('Alex Tester')).toBeInTheDocument();
    expect(screen.getByText(APPROVER_LINE)).toBeInTheDocument();
    expect(APPROVER_LINE).toBe('An administrator, in Settings, Staff, Pending.');
    expect(
      screen.getByText('This page opens the app by itself once you are approved.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    // D38: nothing says when the session ends.
    expect(document.body.textContent).not.toMatch(/session ends|expires/i);

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Checked just now. Still waiting for approval.',
    );
    await act(async () => {
      vi.advanceTimersByTime(ACCESS_PENDING_POLL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it('truncates a long name and email instead of overflowing', async () => {
    const email = 'alexandra.montgomery-fairweather.example@materialmule-demo.example';
    stubFetch({
      'GET /api/me/profile': () => ({
        status: 200,
        body: { workEmail: email, signInUsername: null },
      }),
    });
    const longName = 'Alexandra Montgomery-Fairweather-Example';
    renderRoutes(page, '/access-pending', {
      status: 'pending',
      me: { ...STAFF, status: 'pending', displayName: longName, initials: null },
    });
    expect(screen.getByText(longName)).toHaveClass('truncate');
    expect(await screen.findByText(email)).toHaveClass('truncate');
    expect(screen.getByText('AM')).toBeInTheDocument();
  });

  it('opens the app by itself once approved', () => {
    const { router } = renderRoutes(page, '/access-pending', { status: 'active', me: STAFF });
    expect(router.state.location.pathname).toBe('/');
  });
});
