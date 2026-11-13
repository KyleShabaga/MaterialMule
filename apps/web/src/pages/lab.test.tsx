import type { MeResponse } from '@materialmule/shared';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { stationSessionKey, storeRecordingPerson } from '../session/recording-person-store';
import { SessionContext, type SessionState } from '../session/context';
import {
  isLabStationComputer,
  rememberStation,
  setLabStationComputer,
  stationKind,
} from '../session/station';
import { LAB_HINT, LAB_STATION_HINT, PAUSED_HELP, WRONG_PASSWORD_MESSAGE } from './LabSignInForm';
import { LAB_EXPIRED_MESSAGE, NO_METHOD_TITLE } from './SignInPage';

const LAB_ME: MeResponse = {
  id: 'lab',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['receipt.confirm', 'inventory.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  profileRefreshFailed: false,
};

const ADMIN_ME: MeResponse = {
  ...LAB_ME,
  id: 'admin',
  displayName: 'Admin (test)',
  initials: 'ADM',
  accountType: 'test',
  roles: ['admin'],
  permissions: ['staff.manage', 'session.revoke', 'lab_account.manage'],
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
  (lab: boolean, microsoft = false): Handler =>
  () => ({
    status: 200,
    body: { microsoft, lab, test: false },
  });

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.sessionStorage.clear();
});

const LAB_FORM = 'Shared receiving station';

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
    const form = await screen.findByRole('region', { name: LAB_FORM });
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(within(form).getByLabelText('Username')).toHaveValue('LAB');
    expect(within(form).getByText('Forgot password? Ask an administrator.')).toBeInTheDocument();
    expect(within(form).getByText(LAB_HINT)).toBeInTheDocument();
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

  it('marks a wrong password on the field, then pauses after too many attempts', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
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
    const fieldError = await screen.findByText(WRONG_PASSWORD_MESSAGE);
    expect(password).toHaveValue('');
    expect(password).toHaveAttribute('aria-invalid', 'true');
    expect(password).toHaveAccessibleDescription(WRONG_PASSWORD_MESSAGE);
    expect(fieldError.closest('[role="alert"]')).not.toBeNull();
    // Every state keeps the page's h1 above it.
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();

    status = 429;
    fireEvent.change(password, { target: { value: 'not-the-password' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as LAB' }));
    expect(await screen.findByText(/paused for about 14 minutes/)).toBeInTheDocument();
    // MM-T50: the paused state is an amber alert with the way out; Sign in as LAB is disabled.
    expect(screen.getByRole('alert')).toHaveTextContent(PAUSED_HELP);
    expect(password).not.toHaveAttribute('aria-invalid');
    fireEvent.change(password, { target: { value: 'typed-while-paused' } });
    expect(screen.getByRole('button', { name: 'Sign in as LAB' })).toBeDisabled();
    const card = screen.getByRole('region', { name: LAB_FORM });
    // A reset clears only the account count, not this computer's address count, so the card must
    // never promise it ends the pause; and LAB isn't tied to one receiving PC.
    expect(card).not.toHaveTextContent(/sooner|receiving PC/);
    expect(screen.queryByText(WRONG_PASSWORD_MESSAGE)).not.toBeInTheDocument();
    expect(document.body.textContent).not.toContain('not-the-password');

    // The pause ends by itself.
    await act(async () => {
      vi.advanceTimersByTime(840_000);
    });
    expect(screen.getByRole('button', { name: 'Sign in as LAB' })).toBeEnabled();
  });

  it('explains a server problem in plain words, without the status code', async () => {
    render_(
      '/sign-in',
      { status: 'signed-out' },
      {
        '/api/auth/providers': providers(true),
        '/api/auth/sign-out': () => ({ status: 401 }),
        '/api/auth/lab/sign-in': () => ({ status: 500, body: {} }),
      },
    );
    fireEvent.change(await screen.findByLabelText('Password'), {
      target: { value: 'generated-in-test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sign in as LAB' }));
    expect(await screen.findByText('Sign-in didn’t work. Try again.')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('500');
  });

  it('says what to do when no sign-in method is set up', async () => {
    render_('/sign-in', { status: 'signed-out' }, { '/api/auth/providers': providers(false) });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(NO_METHOD_TITLE);
    expect(alert).toHaveTextContent(
      'An administrator turns on Microsoft sign-in or the LAB account on the host PC. Ask your Lab Manager to arrange it.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByLabelText('Password')).not.toBeInTheDocument();
  });

  it('tells a LAB station its session expired and its draft is saved', async () => {
    rememberStation(true);
    render_(
      '/sign-in?returnTo=%2Freceiving-log%2Fnew&expired=1',
      { status: 'signed-out' },
      { '/api/auth/providers': providers(true, true) },
    );
    expect(await screen.findByRole('status')).toHaveTextContent(LAB_EXPIRED_MESSAGE);
    // The computer was last used as the station: it opens on the LAB form.
    expect(await screen.findByRole('region', { name: LAB_FORM })).toBeInTheDocument();
    const heading = screen.getByRole('heading', { level: 1, name: 'Sign in' });
    expect(
      heading.compareDocumentPosition(screen.getByRole('status')) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});

describe('Remember the LAB station per computer (STRATA-18)', () => {
  it('opens a normal computer on Microsoft sign-in, with a link to the LAB form', async () => {
    const { router } = render_(
      '/sign-in?returnTo=%2Fprojects',
      { status: 'signed-out' },
      { '/api/auth/providers': providers(true, true) },
    );
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(
      screen.getByText('Use your own work account. What you do is recorded under your name.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: LAB_FORM })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'Sign in as LAB' }));
    expect(await screen.findByRole('region', { name: LAB_FORM })).toBeInTheDocument();
    expect(router.state.location.search).toBe('?returnTo=%2Fprojects&method=lab');
    fireEvent.click(
      screen.getByRole('link', { name: 'Sign in with your Microsoft account instead' }),
    );
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
  });

  it('opens the marked station straight on the LAB form, and keeps the mark after sign-out', async () => {
    expect(setLabStationComputer(true)).toBe(true);
    rememberStation(false); // a deliberate sign-out clears only the last-used marker
    render_('/sign-in', { status: 'signed-out' }, { '/api/auth/providers': providers(true, true) });
    const form = await screen.findByRole('region', { name: LAB_FORM });
    expect(within(form).getByText(LAB_STATION_HINT)).toBeInTheDocument();
    expect(within(form).getByLabelText('Username')).toHaveValue('LAB');
    expect(
      screen.getByRole('link', { name: 'Sign in with your Microsoft account instead' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Sign in with Microsoft' })).toBeNull();
    expect(isLabStationComputer()).toBe(true);
  });

  it('falls back to Microsoft sign-in when the station has no LAB account set up', async () => {
    setLabStationComputer(true);
    render_(
      '/sign-in',
      { status: 'signed-out' },
      { '/api/auth/providers': providers(false, true) },
    );
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in as LAB' })).toBeNull();
  });

  it('treats a computer as a normal one when its storage was cleared or is blocked', () => {
    setLabStationComputer(true);
    window.localStorage.clear();
    expect(stationKind()).toBe('personal');
    const blocked = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    try {
      expect(isLabStationComputer()).toBe(false);
      expect(stationKind()).toBe('personal');
    } finally {
      blocked.mockRestore();
    }
  });
});

/** A LAB station with Pat Example picked, so the station guard lets the shell render. */
function pickPatExample() {
  storeRecordingPerson(stationSessionKey(LAB_ME), {
    id: 'p-pat',
    displayName: 'Pat Example',
    initials: 'PE',
    roleLine: 'Technician',
  });
}

describe('LAB account row (STRATA-15)', () => {
  it('reads as the station, with no session end time (D38 is deferred)', async () => {
    pickPatExample();
    render_(
      '/',
      { status: 'active', me: LAB_ME },
      { '/api/activity/recent': () => ({ status: 200, body: [] }) },
    );
    const account = await screen.findByRole('group', { name: 'Signed in user' });
    expect(account).toHaveTextContent('LAB station');
    expect(account).toHaveTextContent('Shared · Receiving lab');
    expect(account).not.toHaveTextContent(/Session ends/);
    expect(account.querySelector('time')).toBeNull();
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

  async function confirmReset() {
    const card = await screen.findByRole('region', { name: 'Shared receiving account (LAB)' });
    await within(card).findByText('Signed-in stations');
    fireEvent.change(within(card).getByLabelText('New LAB password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.change(within(card).getByLabelText('Repeat the new password'), {
      target: { value: 'a-long-enough-password' },
    });
    fireEvent.click(within(card).getByRole('button', { name: 'Reset LAB password' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Reset password', hidden: true }));
    return card;
  }

  it('says nothing changed when the server refuses, without the status code', async () => {
    render_(
      '/settings/staff',
      { status: 'active', me: ADMIN_ME },
      {
        '/api/admin/lab/password': () => ({ status: 409, body: {} }),
        '/api/admin/lab': () => ({ status: 200, body: account }),
      },
    );
    const card = await confirmReset();
    expect(
      await within(card).findByText('That didn’t work. Nothing was changed. Try again.'),
    ).toBeInTheDocument();
    expect(card.textContent).not.toContain('409');
  });

  it.each([500, 502, 503, 504])(
    'MM-T61: after a %i the outcome is unknown, so it says to reload and check',
    async (status) => {
      render_(
        '/settings/staff',
        { status: 'active', me: ADMIN_ME },
        {
          '/api/admin/lab/password': () => ({ status, body: {} }),
          '/api/admin/lab': () => ({ status: 200, body: account }),
        },
      );
      const card = await confirmReset();
      expect(
        await within(card).findByText(
          'Material Mule had a problem, so it isn’t clear whether this worked. Reload the page to check before trying again.',
        ),
      ).toBeInTheDocument();
      expect(card.textContent).not.toContain('Nothing was changed');
      expect(card.textContent).not.toContain(String(status));
    },
  );

  it('does not promise anything when the server could not be reached', async () => {
    render_(
      '/settings/staff',
      { status: 'active', me: ADMIN_ME },
      {
        '/api/admin/lab/password': () => {
          throw new TypeError('Failed to fetch');
        },
        '/api/admin/lab': () => ({ status: 200, body: account }),
      },
    );
    const card = await confirmReset();
    expect(await within(card).findByText(/couldn’t be reached/)).toBeInTheDocument();
    expect(card.textContent).not.toContain('Nothing was changed');
    expect(card.textContent).not.toContain('LAB password reset');
  });

  it('is not offered to people without staff.manage', async () => {
    pickPatExample();
    render_('/settings/staff', { status: 'active', me: LAB_ME }, {});
    // STRATA-100: Staff has no page for them; Settings opens on My access with a notice.
    expect(await screen.findByText('Staff isn’t available to you.')).toBeInTheDocument();
    expect(screen.queryByText('Shared receiving account (LAB)')).not.toBeInTheDocument();
  });
});
