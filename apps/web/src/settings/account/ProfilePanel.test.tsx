import type { MeResponse, ProfileResponse } from '@materialmule/shared';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import {
  PERSONAL_CONTROLLER,
  RecordingPersonContext,
  type RecordingPersonController,
} from '../../session/recording-person-store';
import { ProfilePanel } from './ProfilePanel';

// STRATA-101 / STRATA-119: Profile is read-only; on the shared LAB account it describes that
// account and never the picked person's details. Fictional people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-12T23:00:00.000Z',
  ...overrides,
});

const PROFILE: ProfileResponse = {
  displayName: 'Pat Example',
  givenName: 'Pat',
  surname: 'Example',
  workEmail: 'pat.example@example.com',
  signInUsername: 'pat.example@example.com',
  jobTitle: 'Lab tech',
  jobTitleOverride: 'Senior Technician',
  effectiveJobTitle: { value: 'Senior Technician', source: 'override' },
  department: null,
  officeLocation: null,
  officialInitials: 'PE',
  initialsConfirmed: true,
  source: 'microsoft_graph',
  refreshedAt: '2026-11-11T14:31:00.000Z',
  refreshFailedAt: null,
  canRefresh: true,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stub(handler: (url: string, method: string) => Response) {
  const calls: { url: string; method: string }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      calls.push({ url, method });
      return handler(url, method);
    }),
  );
  return calls;
}

function renderPanel(user = me(), station: RecordingPersonController = PERSONAL_CONTROLLER) {
  const refresh = vi.fn(async () => undefined);
  const wrap = (children: ReactNode) => (
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh,
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RecordingPersonContext.Provider value={station}>{children}</RecordingPersonContext.Provider>
    </SessionContext.Provider>
  );
  render(wrap(<ProfilePanel />));
  return { refresh };
}

afterEach(() => vi.unstubAllGlobals());

describe('Settings › Profile (STRATA-101)', () => {
  it('shows the read-only profile with its sources and refreshes from Microsoft', async () => {
    const calls = stub((url, method) =>
      url === '/api/me/profile/refresh' && method === 'POST'
        ? json(200, { ...PROFILE, refreshedAt: '2026-11-12T15:00:00.000Z' })
        : json(200, PROFILE),
    );
    const { refresh } = renderPanel();
    const user = userEvent.setup();

    expect((await screen.findAllByText('pat.example@example.com')).length).toBe(2);
    expect(screen.getByRole('heading', { name: 'Profile' })).toBeInTheDocument();
    expect(screen.getByText('Senior Technician · Personal account')).toBeInTheDocument();
    expect(screen.getByText('Personal account · Microsoft 365')).toBeInTheDocument();
    expect(screen.getByText('Microsoft 365 profile')).toBeInTheDocument();
    expect(
      screen.getByText(/Set by an administrator\. It describes your work/),
    ).toBeInTheDocument();
    expect(screen.getByText(/^Last refreshed /)).toBeInTheDocument();
    // Nothing on Profile is editable.
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Refresh from Microsoft' }));
    await waitFor(() =>
      expect(screen.getByRole('status')).toHaveTextContent('Profile refreshed from Microsoft.'),
    );
    expect(calls.some((c) => c.url === '/api/me/profile/refresh' && c.method === 'POST')).toBe(
      true,
    );
    expect(refresh).toHaveBeenCalled();
  });

  it('LAB station: the shared account, who is picked, and nothing about their preferences', async () => {
    const calls = stub(() =>
      json(200, { ...PROFILE, displayName: 'LAB', signInUsername: 'LAB', canRefresh: false }),
    );
    const station: RecordingPersonController = {
      ...PERSONAL_CONTROLLER,
      isStation: true,
      person: { id: 'u-pe', displayName: 'Pat Example', initials: 'PE', roleLine: 'Technician' },
    };
    renderPanel(
      me({ id: 'lab', displayName: 'LAB', initials: null, accountType: 'shared_lab' }),
      station,
    );

    expect(screen.getByText('The account this computer is signed in with.')).toBeInTheDocument();
    expect(screen.getByText('Recording as Pat Example on this LAB station.')).toBeInTheDocument();
    expect(
      screen.getByText(/Pat’s own profile and preferences are changed from Pat’s own computer/),
    ).toBeInTheDocument();
    expect(await screen.findByText('Set by an administrator in Staff.')).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: 'Refresh from Microsoft' }),
    ).not.toBeInTheDocument();
    expect(calls.every((c) => c.method === 'GET' && c.url === '/api/me/profile')).toBe(true);
  });
});
