import type { MeResponse, ProfileResponse } from '@materialmule/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext, type SessionState } from '../session/context';

const NEW_STAFF: MeResponse = {
  id: 'u-riley',
  displayName: 'Riley Example',
  initials: null,
  accountType: 'personal',
  status: 'pending',
  roles: [],
  permissions: [],
  sessionExpiresAt: '2026-10-27T03:00:00.000Z',
  profileRefreshFailed: false,
};

const PROFILE: ProfileResponse = {
  displayName: 'Riley Example',
  givenName: 'Riley',
  surname: 'Example',
  workEmail: null,
  signInUsername: 'riley@example.test',
  jobTitle: 'Field Technician',
  jobTitleOverride: null,
  effectiveJobTitle: { value: 'Field Technician', source: 'microsoft' },
  department: 'Geotechnical',
  officeLocation: 'Edmonton',
  officialInitials: null,
  initialsConfirmed: false,
  source: 'microsoft_graph',
  refreshedAt: '2026-10-26T15:00:00.000Z',
  refreshFailedAt: '2026-10-26T16:00:00.000Z',
  canRefresh: true,
};

type Handler = (init?: RequestInit) => { status: number; body?: unknown };

function renderAt(path: string, session: SessionState, api: Record<string, Handler> = {}) {
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Sign in with Microsoft', () => {
  it('forces the account picker with ?switch=1', async () => {
    renderAt(
      '/sign-in?switch=1&returnTo=%2Fprojects',
      { status: 'signed-out' },
      {
        '/api/auth/providers': () => ({
          status: 200,
          body: { microsoft: true, lab: false, test: false },
        }),
      },
    );
    const link = await screen.findByRole('link', { name: 'Sign in with Microsoft' });
    expect(link).toHaveAttribute('href', '/api/auth/microsoft/start?returnTo=%2Fprojects&switch=1');
    // The four-square mark is decoration; the text names the button.
    expect(link.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
    // No LAB account set up: no link to the LAB form.
    expect(screen.queryByRole('link', { name: 'Sign in as LAB' })).toBeNull();
  });

  it('draws the gradient as decoration and keeps the Sign in h1, office note and Help link', async () => {
    renderAt(
      '/sign-in',
      { status: 'signed-out' },
      {
        '/api/auth/providers': () => ({
          status: 200,
          body: { microsoft: true, lab: true, test: true },
        }),
      },
    );
    await screen.findByRole('link', { name: 'Sign in with Microsoft' });
    const background = screen.getByTestId('sign-in-background');
    expect(background).toHaveAttribute('aria-hidden', 'true');
    expect(background).toHaveClass('sign-in-gradient', 'pointer-events-none');
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.getByText('Material Mule')).toBeInTheDocument();
    expect(screen.getByText('Sample storage and lab testing')).toBeInTheDocument();
    expect(screen.getByText('Works on the office network only')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Help' })).toHaveAttribute('href', '/help');
    expect(screen.getByRole('link', { name: 'Test sign-in (development only)' })).toHaveAttribute(
      'href',
      '/sign-in/test?returnTo=%2F',
    );
    expect(screen.getByRole('link', { name: 'Sign in as LAB' })).toBeInTheDocument();
  });

  it('says the session ended, under the Sign in heading', async () => {
    renderAt(
      '/sign-in?returnTo=%2Fprojects&expired=1',
      { status: 'signed-out' },
      {
        '/api/auth/providers': () => ({
          status: 200,
          body: { microsoft: true, lab: false, test: false },
        }),
      },
    );
    expect(await screen.findByRole('status')).toHaveTextContent(
      'Your session has ended. Sign in to continue where you left off.',
    );
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
  });

  it('explains when the sign-in options couldn’t load, and tries again', async () => {
    let fail = true;
    const { calls } = renderAt(
      '/sign-in',
      { status: 'signed-out' },
      {
        '/api/auth/providers': () =>
          fail
            ? { status: 502 }
            : { status: 200, body: { microsoft: true, lab: false, test: false } },
      },
    );
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Sign-in options couldn’t load.');
    expect(alert).toHaveTextContent(
      'Check that this computer is on the office network, then try again. If it keeps failing, tell your Lab Manager.',
    );
    expect(alert).not.toHaveTextContent('502');
    expect(screen.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Sign in with Microsoft' })).toBeNull();

    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Sign in with Microsoft' })).toBeVisible();
    expect(calls.filter((c) => c.url === '/api/auth/providers')).toHaveLength(2);
  });
});

describe('Microsoft callback page', () => {
  it('shows Finishing Microsoft sign-in while it works, then moves on', async () => {
    let answer: (value: { status: number; body?: unknown }) => void = () => undefined;
    const pending = new Promise<{ status: number; body?: unknown }>((resolve) => {
      answer = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        const result = await pending;
        return new Response(JSON.stringify(result.body), { status: result.status });
      }),
    );
    const refresh = vi.fn(async () => undefined);
    const router = createMemoryRouter(routes, {
      initialEntries: ['/sign-in/microsoft/callback?code=abc&state=xyz'],
    });
    render(
      <SessionContext.Provider
        value={{
          session: { status: 'pending', me: NEW_STAFF },
          refresh,
          signOut: vi.fn(async () => undefined),
        }}
      >
        <RouterProvider router={router} />
      </SessionContext.Provider>,
    );
    const status = await screen.findByRole('status');
    expect(
      within(status).getByRole('heading', { level: 1, name: 'Finishing Microsoft sign-in…' }),
    ).toBeVisible();
    expect(status).toHaveTextContent('This takes a few seconds. Keep this window open.');
    answer({ status: 200, body: { next: '/access-pending' } });
    await waitFor(() => expect(router.state.location.pathname).toBe('/access-pending'));
  });

  it('posts the code and state, refreshes the session and moves on', async () => {
    const { calls, refresh, router } = renderAt(
      '/sign-in/microsoft/callback?code=abc&state=xyz',
      // The session the refreshed /api/me would report.
      { status: 'pending', me: NEW_STAFF },
      {
        '/api/me/profile': () => ({ status: 200, body: PROFILE }),
        '/api/auth/microsoft/callback': () => ({
          status: 200,
          body: { next: '/access-pending' },
        }),
      },
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const post = calls.find((c) => c.url === '/api/auth/microsoft/callback')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ state: 'xyz', code: 'abc' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/access-pending'));
    expect(calls.filter((c) => c.url === '/api/auth/microsoft/callback')).toHaveLength(1);
  });

  it.each([
    ['cancelled', 'Sign-in was cancelled.', 'try'],
    ['consent_denied', 'Material Mule wasn’t given permission.', 'back'],
    ['expired_attempt', 'The sign-in link expired.', 'try'],
    ['wrong_tenant', 'This account can’t sign in here.', 'back'],
    ['guest_account', 'Guest accounts can’t sign in.', 'back'],
    ['account_disabled', 'Your access was removed.', 'back'],
    ['rate_limited', 'Too many sign-in attempts.', 'wait'],
    ['not_configured', 'Microsoft sign-in isn’t set up on this server.', 'back'],
    ['sign_in_failed', 'Something went wrong finishing sign-in.', 'try'],
    // An unknown code is never shown; it reads as "something went wrong".
    ['made_up_code', 'Something went wrong finishing sign-in.', 'try'],
  ])('explains %s with one card and its next step', async (code, title, next) => {
    renderAt(
      '/sign-in/microsoft/callback?error=access_denied&state=xyz',
      { status: 'signed-out' },
      { '/api/auth/microsoft/callback': () => ({ status: 403, body: { code } }) },
    );
    const heading = await screen.findByRole('heading', { level: 1, name: title });
    expect(heading).toBeVisible();
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    const card = screen.getByRole('alert');
    // Codes (snake_case) never show; "cancelled" is also a plain word in its own title.
    if (code.includes('_')) expect(card).not.toHaveTextContent(code);
    expect(card).not.toHaveTextContent('403');
    expect(card).not.toHaveTextContent('access_denied');
    const tryAgain = screen.queryByRole('link', { name: 'Try again' });
    if (next === 'try') {
      expect(tryAgain).toHaveAttribute('href', '/api/auth/microsoft/start?switch=1');
    } else {
      expect(tryAgain).toBeNull();
    }
    if (next === 'wait') {
      expect(screen.getByRole('button', { name: 'Try again after the pause' })).toBeDisabled();
    }
    expect(screen.getByRole('link', { name: 'Back to sign in' })).toHaveAttribute(
      'href',
      '/sign-in',
    );
    if (code === 'not_configured') {
      expect(screen.getByRole('link', { name: 'Sign in as LAB' })).toHaveAttribute(
        'href',
        '/sign-in?method=lab',
      );
    }
  });

  it('treats a request that never arrives as something went wrong', async () => {
    renderAt(
      '/sign-in/microsoft/callback?code=abc&state=xyz',
      { status: 'signed-out' },
      {
        '/api/auth/microsoft/callback': () => {
          throw new TypeError('Failed to fetch');
        },
      },
    );
    expect(
      await screen.findByRole('heading', { name: 'Something went wrong finishing sign-in.' }),
    ).toBeVisible();
    expect(document.body.textContent).not.toContain('Failed to fetch');
  });
});

describe('No position step (MISC-06)', () => {
  it('sends a pending person straight to Access pending, and an active one to the app', async () => {
    const { router } = renderAt(
      '/access-pending',
      { status: 'pending', me: NEW_STAFF },
      { '/api/me/profile': () => ({ status: 200, body: PROFILE }) },
    );
    expect(
      await screen.findByRole('heading', { name: 'You are signed in, but not set up yet.' }),
    ).toBeVisible();
    expect(router.state.location.pathname).toBe('/access-pending');
    const active = renderAt(
      '/settings/profile',
      {
        status: 'active',
        me: { ...NEW_STAFF, status: 'active' },
      },
      { '/api/me/profile': () => ({ status: 200, body: PROFILE }) },
    );
    expect(await screen.findAllByText('Field Technician')).not.toHaveLength(0);
    expect(active.router.state.location.pathname).toBe('/settings/profile');
  });

  it('has no position setup page any more', async () => {
    renderAt('/onboarding/position', {
      status: 'active',
      me: { ...NEW_STAFF, status: 'active' },
    });
    expect(await screen.findByRole('heading', { name: 'This page doesn’t exist.' })).toBeVisible();
    expect(screen.queryByRole('radio')).toBeNull();
  });
});

describe('My profile', () => {
  const ACTIVE: MeResponse = {
    ...NEW_STAFF,
    status: 'active',
    profileRefreshFailed: true,
  };

  it('shows imported fields, their source, the username labelled as such, and a Retry', async () => {
    const { calls } = renderAt(
      '/settings/profile',
      { status: 'active', me: ACTIVE },
      {
        '/api/me/profile/refresh': () => ({
          status: 200,
          body: { ...PROFILE, refreshFailedAt: null, workEmail: 'riley.mail@example.test' },
        }),
        '/api/me/profile': () => ({ status: 200, body: PROFILE }),
      },
    );
    expect(await screen.findByText('Field Technician')).toBeInTheDocument();
    expect(screen.getByText('No mailbox address from Microsoft')).toBeInTheDocument();
    expect(screen.getByText('riley@example.test')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365 profile')).toBeInTheDocument();
    expect(screen.getByText(/Not confirmed yet/)).toBeInTheDocument();
    // MISC-06: positions show only in Settings → Staff & access, never on the profile.
    expect(screen.queryByText('Position')).toBeNull();
    // The shell's notice sits behind the Settings modal (inert while it is open).
    expect(
      screen.getByRole('link', { name: 'Review and retry', hidden: true }),
    ).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Profile refreshed from Microsoft.')).toBeInTheDocument();
    // MM-T55: the email shows in "Signed in as" and in the My profile card.
    const card = screen.getByRole('region', { name: 'Profile' });
    expect(within(card).getByText('riley.mail@example.test')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/me/profile/refresh')).toBe(true);
  });
});
