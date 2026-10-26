import type { MeResponse, ProfileResponse } from '@trapezoid/shared';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
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
  position: null,
  positionSetupRequired: true,
  profileRefreshFailed: false,
};

const PROFILE: ProfileResponse = {
  displayName: 'Riley Example',
  givenName: 'Riley',
  surname: 'Example',
  workEmail: null,
  signInUsername: 'riley@example.test',
  jobTitle: 'Field Technician',
  department: 'Geotechnical',
  officeLocation: 'Edmonton',
  officialInitials: null,
  initialsConfirmed: false,
  position: 'technician',
  positionSetAt: '2026-10-26T15:00:00.000Z',
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
        '/api/me/profile': () => ({ status: 200, body: { ...PROFILE, position: null } }),
        '/api/auth/microsoft/callback': () => ({
          status: 200,
          body: { next: '/onboarding/position' },
        }),
      },
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const post = calls.find((c) => c.url === '/api/auth/microsoft/callback')!;
    expect(JSON.parse(String(post.init?.body))).toEqual({ state: 'xyz', code: 'abc' });
    await waitFor(() => expect(router.state.location.pathname).toBe('/onboarding/position'));
    expect(calls.filter((c) => c.url === '/api/auth/microsoft/callback')).toHaveLength(1);
  });

  it.each([
    ['wrong_tenant', 'This Microsoft account can’t sign in here'],
    ['guest_account', 'Guest accounts can’t sign in'],
    ['cancelled', 'Sign-in was cancelled'],
    ['consent_denied', 'Permission wasn’t granted'],
    ['account_disabled', 'Your access has been removed'],
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

describe('First-login position setup', () => {
  it('sends a person who has not chosen a position to setup first', async () => {
    const { router } = renderAt(
      '/access-pending',
      { status: 'pending', me: NEW_STAFF },
      { '/api/me/profile': () => ({ status: 200, body: { ...PROFILE, position: null } }) },
    );
    expect(await screen.findByRole('heading', { name: 'Welcome, Riley Example' })).toBeVisible();
    expect(router.state.location.pathname).toBe('/onboarding/position');
    const active = renderAt(
      '/projects',
      { status: 'active', me: { ...NEW_STAFF, status: 'active' } },
      { '/api/me/profile': () => ({ status: 200, body: PROFILE }) },
    );
    await waitFor(() => expect(active.router.state.location.pathname).toBe('/onboarding/position'));
  });

  it('shows the Microsoft job title for reference and saves the choice', async () => {
    const { calls, refresh } = renderAt(
      '/onboarding/position',
      { status: 'pending', me: NEW_STAFF },
      {
        '/api/me/profile': () => ({ status: 200, body: { ...PROFILE, position: null } }),
        '/api/me/position': () => ({ status: 204 }),
      },
    );
    expect(await screen.findByText('From Microsoft: Field Technician')).toBeInTheDocument();
    for (const label of [
      'Technician (Tech)',
      'Engineer (Eng)',
      'Project Manager / Project Engineer (PM/PE)',
      'Lab Manager',
    ]) {
      expect(
        screen.getByRole('radio', { name: new RegExp(label.replace(/[()/]/g, '.')) }),
      ).toBeVisible();
    }
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Choose the position');

    fireEvent.click(screen.getByRole('radio', { name: /Engineer \(Eng\)/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    const save = calls.find((c) => c.url === '/api/me/position')!;
    expect(JSON.parse(String(save.init?.body))).toEqual({ position: 'engineer' });
  });

  it('keeps setup open when saving fails', async () => {
    const { refresh } = renderAt(
      '/onboarding/position',
      { status: 'pending', me: NEW_STAFF },
      {
        '/api/me/profile': () => ({ status: 200, body: { ...PROFILE, position: null } }),
        '/api/me/position': () => ({ status: 500 }),
      },
    );
    fireEvent.click(await screen.findByRole('radio', { name: /Lab Manager/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('wasn’t saved');
    expect(refresh).not.toHaveBeenCalled();
  });
});

describe('My profile', () => {
  const ACTIVE: MeResponse = {
    ...NEW_STAFF,
    status: 'active',
    position: 'technician',
    positionSetupRequired: false,
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
    expect(screen.getByRole('link', { name: 'Review and retry' })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Profile refreshed from Microsoft.')).toBeInTheDocument();
    expect(screen.getByText('riley.mail@example.test')).toBeInTheDocument();
    expect(calls.some((c) => c.url === '/api/me/profile/refresh')).toBe(true);
  });
});
