import type { MeResponse } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { Outlet, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext, type SessionState } from '../session/context';
import { RECORDING_PERSON_KEY, WHO_IS_WORKING_PATH } from '../session/recording-person-store';
import { PublicHelpGate } from './public-help';

// /help without the app (STRATA-103 / STRATA-105's gate): signed out, waiting for approval, or a
// LAB station before a person is picked. Nothing private is read. Fictional people only.

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-0000000000a1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
};

function renderAt(path: string, session: SessionState) {
  const fetchMock = vi.fn(
    async () =>
      new Response(JSON.stringify({ status: 'ok', version: '1.4.0', database: 'up' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
  );
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(
    [
      {
        element: (
          <PublicHelpGate>
            <div>
              <p>Signed-in guard</p>
              <Outlet />
            </div>
          </PublicHelpGate>
        ),
        children: [
          { path: '/help', element: <h1>Help in the shell</h1> },
          { path: '/sample-storage', element: <h1>Inventory</h1> },
        ],
      },
    ],
    { initialEntries: [path] },
  );
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
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('public /help', () => {
  it('signed out: the guides without the app, Back to sign in, and only /api/health read', async () => {
    const fetchMock = renderAt('/help#lab-stations', { status: 'signed-out' });
    expect(screen.getByRole('heading', { level: 1, name: 'Help and how-tos' })).toBeVisible();
    expect(screen.queryByText('Signed-in guard')).toBeNull();
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    expect(screen.getByText(/You’re not signed in/)).toBeInTheDocument();
    // The anchor opens its guide.
    expect(screen.getByRole('button', { name: 'How LAB stations work' })).toHaveAttribute(
      'aria-expanded',
      'true',
    );
    expect(document.getElementById('lab-stations')).not.toBeNull();
    expect(document.getElementById('sidebar')).not.toBeNull();
    // Signed out: no Feedback & bugs, no feedback received.
    expect(screen.queryByRole('button', { name: /Feedback/ })).toBeNull();
    expect(screen.queryByRole('region', { name: 'Feedback received' })).toBeNull();
    expect(await screen.findByText('1.4.0')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map((call) => String((call as unknown[])[0]));
    expect(urls.every((url) => url === '/api/health')).toBe(true);
  });

  it('waiting for approval: Back goes to the waiting page', () => {
    renderAt('/help', { status: 'pending', me: { ...ME, status: 'pending' } });
    expect(screen.getByRole('link', { name: 'Back' })).toHaveAttribute('href', '/access-pending');
    expect(screen.queryByText(/You’re not signed in/)).toBeNull();
  });

  it('a LAB station before anyone is picked: Back to Who is working here?', () => {
    renderAt('/help', {
      status: 'active',
      me: { ...ME, id: 'lab', displayName: 'LAB', accountType: 'shared_lab' },
    });
    expect(screen.getByRole('link', { name: 'Back to Who is working here?' })).toHaveAttribute(
      'href',
      WHO_IS_WORKING_PATH,
    );
    expect(window.sessionStorage.getItem(RECORDING_PERSON_KEY)).toBeNull();
  });

  it('signed in: the shell’s own /help', () => {
    renderAt('/help', { status: 'active', me: ME });
    expect(screen.getByText('Signed-in guard')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Help in the shell' })).toBeInTheDocument();
  });

  it('signed out elsewhere: the guard decides as before', () => {
    renderAt('/sample-storage', { status: 'signed-out' });
    expect(screen.getByText('Signed-in guard')).toBeInTheDocument();
  });
});
