import type { AccessSummary, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { MyAccessPage } from './MyAccessPage';

// MM-AO06: My access. The Staff drawer's job title, eligibility and capability tests live in
// settings/staff/StaffGrantsSection.test.tsx.
// Fictional data only: Jordan Smith supports DEMO-2601, reviews Concrete field there and accepts
// on DEMO-2602.

const PAT = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };
const ADMIN = { userId: 'admin-id', initials: 'ADM', name: 'Admin (test)' };
const FIELD = { code: 'concrete_field', label: 'Concrete field reports' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-js',
  displayName: 'Jordan Smith',
  initials: 'JS',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'project_access.read'],
  sessionExpiresAt: '2026-10-30T06:00:00.000Z',
  ...overrides,
});

const grant = (id: string, reason: string, by = ADMIN) => ({
  id,
  startedBy: by,
  startedAt: '2026-10-29T15:00:00.000Z',
  startReason: reason,
  endedBy: null,
  endedAt: null,
  endReason: null,
});

const SUMMARY: AccessSummary = {
  userId: 'u-js',
  displayName: 'Jordan Smith',
  initials: 'JS',
  accountType: 'personal',
  status: 'active',
  effectiveJobTitle: { value: 'Senior Technician', source: 'override' },
  roles: [],
  reviewerEligibility: [{ ...grant('re-1', 'Qualified field reviewer'), scope: FIELD }],
  capabilities: [],
  projects: [
    {
      project: { id: 'p-a', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
      lead: false,
      teamMember: { since: '2026-10-29T15:00:00.000Z', by: PAT, reason: 'Supporting engineer' },
      reviewer: [
        {
          since: '2026-10-29T15:00:00.000Z',
          by: PAT,
          reason: 'Reviews field reports',
          scope: FIELD,
          effective: true,
          blockedReason: null,
        },
      ],
      acceptanceDelegate: null,
      reportIssuer: [],
      pendingLeadNomination: false,
    },
    {
      project: { id: 'p-b', projectNumber: 'DEMO-2602', name: 'Ridge road' },
      lead: false,
      teamMember: null,
      reviewer: [],
      acceptanceDelegate: { since: '2026-10-29T15:00:00.000Z', by: PAT, reason: 'Cover' },
      reportIssuer: [],
      pendingLeadNomination: false,
    },
  ],
  projectsTotal: 2,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function session(user: MeResponse) {
  return {
    session: { status: 'active' as const, me: user },
    refresh: vi.fn(async () => undefined),
    signOut: vi.fn(async () => undefined),
  };
}

beforeEach(() => {
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('My access (MM-AO06)', () => {
  function renderMyAccess(user = me()) {
    render(
      <SessionContext.Provider value={session(user)}>
        <MemoryRouter>
          <MyAccessPage />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
  }

  it('AC3/AC4: shows roles, grants held everywhere, and per-project responsibilities apart from grants', async () => {
    let state = SUMMARY;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json(200, state));
    vi.stubGlobal('fetch', fetchMock);
    renderMyAccess();

    const projects = await screen.findByRole('list', { name: 'Project access' });
    const items = within(projects).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('DEMO-2601 · Riverbank investigation');
    expect(items[0]).toHaveTextContent('Responsibilities: Team member');
    expect(items[0]).toHaveTextContent('Reviewer: Concrete field reports');
    expect(items[0]).not.toHaveTextContent('Grants:');
    expect(items[1]).toHaveTextContent('Grants: Acceptance delegate');
    expect(within(items[0]!).getByRole('link')).toHaveAttribute('href', '/projects/p-a');
    expect(screen.getByRole('list', { name: 'Held everywhere' })).toHaveTextContent(
      'Eligible reviewer: Concrete field reports',
    );
    expect(
      screen.getByText('No app roles. Staff without a role can still see everything.'),
    ).toBeVisible();
    expect(screen.getByText('Senior Technician (Set by an administrator)')).toBeVisible();
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/me/access');

    // Revoked meanwhile: Refresh shows the server's current state.
    state = { ...SUMMARY, reviewerEligibility: [] };
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('No reviewer eligibility or capabilities.')).toBeVisible();
  });

  it('the shared LAB account is told it has no personal access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(403, { code: 'forbidden' })),
    );
    renderMyAccess(me({ accountType: 'shared_lab' }));
    expect(await screen.findByText(/The shared LAB account has no personal access/)).toBeVisible();
  });

  it('offers Retry when the server can’t be reached', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new TypeError('Failed to fetch');
      }),
    );
    renderMyAccess();
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeVisible();
  });
});
