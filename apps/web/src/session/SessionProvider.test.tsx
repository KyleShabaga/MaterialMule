import type { MeResponse } from '@materialmule/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { apiFetch } from '../api/client';
import { routes } from '../routes';
import { SessionProvider } from './SessionProvider';

// MM-T61 review follow-up: a successful /api/me answer whose body isn't readable JSON (empty, an
// HTML page from a proxy, cut off mid-way) must end in the recoverable "unavailable" state with a
// Reload button, never an endless "Loading…". A 401 still goes to sign-in.

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubMe(response: () => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/me') return response();
      return new Response('{}', { status: 404 });
    }),
  );
}

function renderApp(path = '/') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionProvider>
      <RouterProvider router={router} />
    </SessionProvider>,
  );
  return router;
}

/** A 200 whose body fails while being read, as when the connection drops mid-answer. */
function brokenBody() {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('{"id":'));
      controller.error(new TypeError('network error'));
    },
  });
  return new Response(body, { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('SessionProvider with an unreadable successful /api/me answer', () => {
  it.each([
    ['an empty body', () => new Response('', { status: 200 })],
    [
      'malformed JSON',
      () =>
        new Response('{"id": "u1", ', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        }),
    ],
    [
      'an HTML page',
      () =>
        new Response('<!doctype html><title>Proxy</title>', {
          status: 200,
          headers: { 'content-type': 'text/html' },
        }),
    ],
    ['a body that fails mid-read', brokenBody],
  ])('shows the unavailable state with Reload for %s', async (_name, response) => {
    stubMe(response);
    renderApp('/sample-storage');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Material Mule is unavailable');
    expect(alert).toHaveTextContent('Reload the page to try again.');
    expect(alert).not.toHaveTextContent(/API|JSON|Unexpected/);
    expect(screen.getByRole('button', { name: 'Reload' })).toBeInTheDocument();
    expect(screen.queryByText('Loading…')).not.toBeInTheDocument();
  });

  it('still sends a 401 to sign-in', async () => {
    stubMe(() => new Response(JSON.stringify({ code: 'unauthenticated' }), { status: 401 }));
    const router = renderApp('/sample-storage');

    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/sign-in'));
    expect(router.state.location.search).toContain('returnTo=%2Fsample-storage');
    expect(screen.queryByRole('alert', { name: /unavailable/ })).not.toBeInTheDocument();
  });
});

// MTR-11: an admin whose role is removed mid-session loses the admin-only Settings tabs after the
// first refused request (403 `forbidden`) or when the window regains focus, without a reload.
describe('SessionProvider keeps roles current', () => {
  const ADMIN: MeResponse = {
    id: 'drew',
    displayName: 'Drew Example',
    initials: 'DE',
    accountType: 'test',
    status: 'active',
    roles: ['admin'],
    permissions: ['inventory.read', 'printer.manage', 'system.status.read', 'staff.manage'],
    sessionExpiresAt: '2026-11-26T16:00:00.000Z',
    position: null,
    positionSetupRequired: false,
    profileRefreshFailed: false,
  };
  const DEMOTED: MeResponse = { ...ADMIN, roles: [], permissions: ['inventory.read'] };

  function stubApi(meNow: () => MeResponse, forbiddenBody: object = { code: 'forbidden' }) {
    const meCalls = vi.fn();
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/me') {
          meCalls();
          return new Response(JSON.stringify(meNow()), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        }
        if (url.pathname === '/api/staff') {
          return new Response(JSON.stringify(forbiddenBody), {
            status: 403,
            headers: { 'content-type': 'application/json' },
          });
        }
        return new Response('{}', { status: 404 });
      }),
    );
    return meCalls;
  }

  async function tabs() {
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    return within(nav)
      .getAllByRole('link')
      .map((link) => link.textContent);
  }

  it('re-reads /api/me after a 403 forbidden and drops the admin-only tabs', async () => {
    let me = ADMIN;
    const meCalls = stubApi(() => me);
    renderApp('/settings/profile');
    expect(await tabs()).toEqual(expect.arrayContaining(['Printers', 'System status']));
    const before = meCalls.mock.calls.length;

    me = DEMOTED;
    await apiFetch('/api/staff');

    await waitFor(async () => expect(await tabs()).not.toContain('Printers'));
    expect(await tabs()).not.toContain('System status');
    expect(await tabs()).not.toContain('Staff & access');
    expect(meCalls.mock.calls.length).toBe(before + 1);
  });

  it('re-reads /api/me when the window regains focus', async () => {
    let me = ADMIN;
    stubApi(() => me);
    renderApp('/settings/profile');
    expect(await tabs()).toContain('Printers');

    me = DEMOTED;
    fireEvent.focus(window);

    await waitFor(async () => expect(await tabs()).not.toContain('Printers'));
  });

  it('ignores other 403 codes and settles when /api/me is unchanged (no loop)', async () => {
    const meCalls = stubApi(() => ADMIN, { code: 'pending_approval' });
    renderApp('/settings/profile');
    expect(await tabs()).toContain('Printers');
    const before = meCalls.mock.calls.length;

    await apiFetch('/api/staff');
    fireEvent.focus(window);
    await waitFor(() => expect(meCalls.mock.calls.length).toBe(before + 1));
    // An unchanged answer leaves the session object alone, so nothing re-renders into a refetch.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(meCalls.mock.calls.length).toBe(before + 1);
    expect(await tabs()).toContain('Printers');
  });
});
