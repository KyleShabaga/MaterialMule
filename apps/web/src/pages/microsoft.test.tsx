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
  it('forces the account picker after Switch user', async () => {
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
  });
});

describe('Microsoft callback page', () => {
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
    ['wrong_tenant', 'This Microsoft account can’t sign in here'],
    ['guest_account', 'Guest accounts can’t sign in'],
    ['cancelled', 'Sign-in was cancelled'],
    ['consent_denied', 'Permission wasn’t granted'],
    ['account_disabled', 'Your access has been removed'],
    ['rate_limited', 'Too many sign-in attempts'],
  ])('explains %s', async (code, title) => {
    renderAt(
      '/sign-in/microsoft/callback?error=access_denied&state=xyz',
      { status: 'signed-out' },
      { '/api/auth/microsoft/callback': () => ({ status: 403, body: { code } }) },
    );
    expect(await screen.findByRole('heading', { name: title })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Try again' })).toHaveAttribute(
      'href',
      '/api/auth/microsoft/start?switch=1',
    );
  });
});

describe('No position step (MISC-06)', () => {
  it('sends a pending person straight to Access pending, and an active one to the app', async () => {
    const { router } = renderAt('/access-pending', { status: 'pending', me: NEW_STAFF });
    expect(await screen.findByRole('heading', { name: 'Access pending' })).toBeVisible();
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
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeVisible();
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
    expect(screen.getByRole('link', { name: 'Review and retry' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Profile refreshed from Microsoft.')).toBeInTheDocument();
    // MM-T55: the email shows in "Signed in as" and in the My profile card.
    const card = screen.getByRole('region', { name: 'My profile' });
    expect(within(card).getByText('riley.mail@example.test')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/me/profile/refresh')).toBe(true);
  });
});
