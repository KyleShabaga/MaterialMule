import type { MeResponse } from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '../session/context';
import { HelpPage } from './HelpPage';
import { ACCESS_PENDING_POLL_MS, AccessPendingPage, NotFoundPage } from './simple-pages';

// Field Ledger entry pages: Help & Feedback, Page not found and Access pending. Fictional people.

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
  permissions: ['inventory.read', 'staff.manage'],
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('Help & Feedback', () => {
  const help = [{ path: '/help', element: <HelpPage /> }];

  it('links each guide to a real screen and sends feedback with the page path only', async () => {
    const calls = stubFetch({
      'GET /api/health': () => ({
        status: 200,
        body: { status: 'ok', version: '1.4.0', database: 'up' },
      }),
      'POST /api/feedback': () => ({ status: 201, body: { id: 'f1' } }),
    });
    renderRoutes(
      help,
      { pathname: '/help', state: { from: '/sample-storage/move?search=DEMO-2601' } },
      { status: 'active', me: STAFF },
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Help & Feedback' })).toBeVisible();
    const guides = screen.getByRole('region', { name: 'How do I…' });
    expect(within(guides).getByRole('link', { name: /Receive a delivery/ })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    expect(within(guides).getByRole('link', { name: /Move a unit/ })).toHaveAttribute(
      'href',
      '/sample-storage/move',
    );
    expect(screen.getByText('Can an ID be changed or reused?')).toBeInTheDocument();
    expect(await screen.findByText('1.4.0')).toBeInTheDocument();
    // Not an admin: no received feedback, and nothing asks for it.
    expect(screen.queryByRole('region', { name: 'Feedback received' })).toBeNull();

    // An empty message is not sent.
    fireEvent.click(screen.getByRole('button', { name: 'Send to the administrator' }));
    expect(screen.getByText('Say what happened.')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/feedback')).toBe(false);

    fireEvent.change(screen.getByLabelText('What kind'), { target: { value: 'confusing' } });
    fireEvent.change(screen.getByLabelText('What happened'), {
      target: { value: 'The move screen asks for the shelf twice.' },
    });
    expect(screen.getByLabelText(/Include the page I was on/)).toBeChecked();
    expect(screen.getByText('/sample-storage/move')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Send to the administrator' }));
    expect(await screen.findByText(/Sent\. An administrator will read it/)).toBeInTheDocument();
    const sent = calls.find((c) => c.url === '/api/feedback');
    expect(JSON.parse(String(sent?.init?.body))).toEqual({
      kind: 'confusing',
      text: 'The move screen asks for the shelf twice.',
      page: '/sample-storage/move',
    });
    expect(screen.getByLabelText('What happened')).toHaveValue('');
  });

  it('keeps the message when sending fails', async () => {
    stubFetch({ 'POST /api/feedback': () => ({ status: 500 }) });
    renderRoutes(help, '/help', { status: 'active', me: STAFF });
    // Opened without a previous page: no page checkbox, and no page is sent.
    expect(screen.queryByLabelText(/Include the page/)).toBeNull();
    fireEvent.change(screen.getByLabelText('What happened'), { target: { value: 'Hello' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send to the administrator' }));
    expect(await screen.findByText("Your message couldn't be sent.")).toBeInTheDocument();
    expect(screen.getByLabelText('What happened')).toHaveValue('Hello');
    expect(document.body.textContent).not.toContain('500');
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
    expect(within(received).getByText('An idea')).toBeInTheDocument();
    expect(within(received).getByText('Alex Tester')).toBeInTheDocument();
  });
});

describe('Page not found', () => {
  it('says nothing changed, looks the text up on Search, and offers three ways out', async () => {
    const { router } = renderRoutes([{ path: '/nowhere', element: <NotFoundPage /> }], '/nowhere', {
      status: 'active',
      me: STAFF,
    });
    expect(
      screen.getByRole('heading', { level: 1, name: 'Nothing is at this address.' }),
    ).toBeVisible();
    expect(screen.getByText(/No record has been changed\./)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Today' })).toHaveAttribute('href', '/');
    expect(screen.getByRole('link', { name: 'Go to Inventory' })).toHaveAttribute(
      'href',
      '/sample-storage',
    );
    expect(screen.getByRole('button', { name: 'Go back' })).toBeInTheDocument();
    expect(document.title).toBe('Page not found · Material Mule');

    fireEvent.change(screen.getByRole('textbox', { name: 'Look for it' }), {
      target: { value: ' TH26-01 ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/search'));
    expect(router.state.location.search).toBe('?q=TH26-01');
  });
});

describe('Access pending', () => {
  const pending: SessionState = { status: 'pending', me: { ...STAFF, status: 'pending' } };
  const page = [{ path: '/access-pending', element: <AccessPendingPage /> }];

  it('names who approves, checks again on demand and every minute', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const refresh = vi.fn(async () => undefined);
    renderRoutes(page, '/access-pending', pending, { refresh });
    expect(
      screen.getByRole('heading', { level: 1, name: 'You are signed in, but not set up yet.' }),
    ).toBeVisible();
    expect(screen.getByText('Alex Tester')).toBeInTheDocument();
    expect(screen.getByText('An administrator, in Settings, Staff and access')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    await act(async () => {
      vi.advanceTimersByTime(ACCESS_PENDING_POLL_MS);
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
