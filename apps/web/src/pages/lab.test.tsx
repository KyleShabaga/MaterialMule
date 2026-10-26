import type { MeResponse } from '@materialmule/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext, type SessionState } from '../session/context';
import { rememberStation } from '../session/station';
import { LAB_EXPIRED_MESSAGE } from './SignInPage';

const LAB_ME: MeResponse = {
  id: 'lab',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['receipt.confirm', 'inventory.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
};

const ADMIN_ME: MeResponse = {
  ...LAB_ME,
  id: 'admin',
  displayName: 'Admin (test)',
  initials: 'ADM',
  accountType: 'test',
  roles: ['admin'],
  permissions: ['staff.manage', 'session.revoke'],
};

type Handler = (init: RequestInit | undefined) => { status: number; body?: unknown };

function render_(path: string, session: SessionState, api: Record<string, Handler>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, init });
      const key = Object.keys(api).find((prefix) => url.startsWith(prefix));
      const result = key ? api[key]!(init) : { status: 404, body: {} };
      return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  const refresh = vi.fn(async () => undefined);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider value={{ session, refresh, signOut: vi.fn(async () => undefined) }}>
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { calls, refresh, router };
}

const providers =
  (lab: boolean): Handler =>
  () => ({
    status: 200,
    body: { microsoft: false, lab, test: false },
  });

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('LAB sign-in form', () => {
  it('signs in with username and password and refreshes the session', async () => {
    const { calls, refresh } = render_(
      '/sign-in',
      { status: 'signed-out' },
      {
        '/api/auth/providers': providers(true),
        '/api/auth/sign-out': () => ({ status: 401 }),
        '/api/auth/lab/sign-in': () => ({ status: 204 }),
      },
    );
    const form = await screen.findByRole('region', { name: 'Shared receiving station (LAB)' });
    expect(within(form).getByLabelText('Username')).toHaveValue('LAB');
    expect(within(form).getByText('Forgot password? Ask an administrator.')).toBeInTheDocument();
    fireEvent.change(within(form).getByLabelText('Password'), {
      target: { value: 'generated-in-test' },
    });
    fireEvent.click(within(form).getByRole('button', { name: 'Sign in as LAB' }));

    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const signIn = calls.find((call) => call.url === '/api/auth/lab/sign-in')!;
    expect(JSON.parse(String(signIn.init?.body))).toEqual({
      username: 'LAB',
      password: 'generated-in-test',
    });
    expect(new Headers(signIn.init?.headers).get('x-materialmule-csrf')).toBe('1');
  });

  it('explains wrong passwords and lockouts without repeating the password', async () => {
    let status = 401;
    render_(
      '/sign-in',
      { status: 'signed-out' },
      {
        '/api/auth/providers': providers(true),
        '/api/auth/sign-out': () => ({ status: 401 }),
        '/api/auth/lab/sign-in': () =>
          status === 401
            ? { status, body: { code: 'invalid_credentials' } }
            : { status, body: { code: 'locked_out', retryAfterSeconds: 840 } },
      },
    );
    const password = await screen.findByLabelText('Password');
    fireEvent.change(password, { target: { value: 'not-the-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as LAB' }));
    expect(await screen.findByText('The username or password is incorrect.')).toBeInTheDocument();
    expect(password).toHaveValue('');

    status = 429;
    fireEvent.change(password, { target: { value: 'not-the-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as LAB' }));
    expect(await screen.findByText(/paused for about 14 minutes/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('not-the-password');
  });

  it('is hidden until an administrator sets the LAB password', async () => {
    render_('/sign-in', { status: 'signed-out' }, { '/api/auth/providers': providers(false) });
    expect(
      await screen.findByText('No sign-in method is set up on this server yet.'),
    ).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('tells a LAB station its session expired and its draft is saved', async () => {
    rememberStation(true);
    render_(
      '/sign-in?returnTo=%2Freceiving-log%2Fnew&expired=1',
      { status: 'signed-out' },
      { '/api/auth/providers': providers(true) },
    );
    expect(await screen.findByRole('status')).toHaveTextContent(LAB_EXPIRED_MESSAGE);
  });
});

describe('LAB header', () => {
  it('shows the shared-station badge and the fixed session end', async () => {
    render_(
      '/',
      { status: 'active', me: LAB_ME },
      { '/api/activity/recent': () => ({ status: 200, body: [] }) },
    );
    const header = screen.getByLabelText('Signed in user');
    expect(within(header).getByText('Shared station: LAB')).toBeInTheDocument();
    expect(within(header).getByText(/Session ends/)).toBeInTheDocument();
    expect(header.querySelector('time')).toHaveAttribute('datetime', LAB_ME.sessionExpiresAt);
  });
});

describe('Reset LAB password (admin)', () => {
  const account = {
    userId: '00000000-0000-4000-8000-000000000001',
    passwordSet: true,
    passwordUpdatedAt: '2026-10-01T15:00:00.000Z',
    activeSessions: 2,
    lockedUntil: null,
  };

  it('asks for confirmation, then resets the password', async () => {
    const { calls } = render_(
      '/settings/staff',
      { status: 'active', me: ADMIN_ME },
      {
        '/api/admin/lab/password': () => ({ status: 200, body: { revokedSessions: 2 } }),
        '/api/admin/lab': () => ({ status: 200, body: account }),
      },
    );
    const card = await screen.findByRole('region', { name: 'Shared receiving account (LAB)' });
    await within(card).findByText('Signed-in stations');

    fireEvent.change(within(card).getByLabelText('New LAB password'), {
      target: { value: 'short' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Reset LAB password' }));
    expect(await within(card).findByText(/at least 12 characters/)).toBeInTheDocument();

    fireEvent.change(within(card).getByLabelText('New LAB password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.change(within(card).getByLabelText('Repeat the new password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Reset LAB password' }));
    expect(calls.some((call) => call.url === '/api/admin/lab/password')).toBe(false);

    fireEvent.click(await screen.findByRole('button', { name: 'Reset password', hidden: true }));
    expect(await within(card).findByText(/LAB password reset/)).toBeInTheDocument();
    const reset = calls.find((call) => call.url === '/api/admin/lab/password')!;
    expect(JSON.parse(String(reset.init?.body))).toEqual({ newPassword: 'a-long-enough-password' });
  });

  it('is not offered to people without staff.manage', async () => {
    render_('/settings/staff', { status: 'active', me: LAB_ME }, {});
    expect(
      await screen.findByText('Only administrators can manage staff and access.'),
    ).toBeInTheDocument();
    expect(screen.queryByText('Shared receiving account (LAB)')).not.toBeInTheDocument();
  });
});
