import type { AccessSummary, MeResponse, StaffGrants, StaffMember } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { StaffPage } from '../staff/StaffPage';
import { MyAccessPage } from './MyAccessPage';

// MM-AO06: My access and the Staff drawer's job title, eligibility and capability controls.
// Fictional data only: Jordan Smith supports DEMO-2601, reviews Concrete field there and accepts
// on DEMO-2602.

const PAT = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };
const ADMIN = { userId: 'admin-id', initials: 'ADM', name: 'Admin (test)' };
const FIELD = { code: 'concrete_field', label: 'Concrete field reports' };
const STRENGTH = { code: 'concrete_strength', label: 'Concrete strength reports' };

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
  position: 'technician',
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

describe('Staff drawer: job title, eligibility and capabilities (MM-AO06)', () => {
  const JORDAN: StaffMember = {
    id: 'u-js',
    displayName: 'Jordan Smith',
    officialInitials: 'JS',
    initialsConfirmed: true,
    position: 'technician',
    accountType: 'personal',
    status: 'active',
    roles: [],
    workEmail: null,
    signInUsername: 'jsmith@example.test',
    expectedUpn: null,
    linked: true,
    lastSignInAt: null,
    approvedAt: null,
    disabledReason: null,
    createdAt: '2026-10-26T00:00:00.000Z',
    jobTitle: 'Field Technician',
    jobTitleOverride: null,
    jobTitleOverrideSetBy: null,
    jobTitleOverrideSetAt: null,
    effectiveJobTitle: { value: 'Field Technician', source: 'microsoft' },
  };

  const grants = (eligible: boolean): StaffGrants => ({
    userId: 'u-js',
    canManage: true,
    reviewerEligibility: {
      active: eligible ? [{ ...grant('re-1', 'Qualified field reviewer'), scope: FIELD }] : [],
      history: [],
    },
    capabilities: { active: [], history: [] },
  });

  function stubApi(options: { revokeForbidden?: boolean } = {}) {
    const writes: { method: string; url: string; body: unknown }[] = [];
    let eligible = false;
    let member = JORDAN;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        const method = init?.method ?? 'GET';
        if (method !== 'GET') {
          const body = JSON.parse(String(init?.body ?? 'null')) as Record<string, unknown>;
          writes.push({ method, url, body });
          if (url.endsWith('/job-title-override')) {
            const value = body.jobTitleOverride as string | null;
            member = {
              ...member,
              jobTitleOverride: value,
              jobTitleOverrideSetBy: value ? 'Admin (test)' : null,
              jobTitleOverrideSetAt: value ? '2026-10-29T16:00:00.000Z' : null,
              effectiveJobTitle: value
                ? { value, source: 'override' }
                : { value: 'Field Technician', source: 'microsoft' },
            };
            return json(200, member);
          }
          if (url.endsWith('/reviewer-eligibility') && method === 'POST') {
            eligible = true;
            return json(201, grants(true));
          }
          if (url.includes('/reviewer-eligibility/') && method === 'DELETE') {
            if (options.revokeForbidden) return json(403, { code: 'forbidden' });
            eligible = false;
            return json(200, grants(false));
          }
          return json(500, {});
        }
        if (url === '/api/review-scopes') return json(200, [FIELD, STRENGTH]);
        if (url === '/api/staff/u-js/grants') return json(200, grants(eligible));
        if (url.startsWith('/api/admin/lab')) return json(404, {});
        if (url.includes('status=pending')) return json(200, []);
        return json(200, [member]);
      }),
    );
    return writes;
  }

  async function openDrawer() {
    const user = userEvent.setup();
    render(
      <SessionContext.Provider
        value={session(me({ id: 'admin-id', roles: ['admin'], permissions: ['staff.manage'] }))}
      >
        <MemoryRouter>
          <StaffPage />
        </MemoryRouter>
      </SessionContext.Provider>,
    );
    await user.click(await screen.findByRole('button', { name: 'Manage Jordan Smith' }));
    return { user, drawer: await screen.findByRole('dialog', { name: 'Jordan Smith' }) };
  }

  it('AC1: a job-title override needs a reason and shows beside the Microsoft title', async () => {
    const writes = stubApi();
    const { user, drawer } = await openDrawer();
    const form = within(drawer).getByRole('form', { name: 'Job title' });
    expect(form).toHaveTextContent('From MicrosoftField Technician');
    await user.type(within(form).getByLabelText('Firm job title'), 'Senior Technician');
    await user.click(within(form).getByRole('button', { name: 'Save job title' }));
    expect(within(form).getByText('Enter a reason.')).toBeVisible();
    expect(writes).toEqual([]);

    await user.type(within(form).getByLabelText('Reason'), 'Title per firm records');
    await user.click(within(form).getByRole('button', { name: 'Save job title' }));
    expect(
      await screen.findByText('Job title for Jordan Smith set to Senior Technician.'),
    ).toBeVisible();
    expect(writes).toEqual([
      {
        method: 'PUT',
        url: '/api/staff/u-js/job-title-override',
        body: { jobTitleOverride: 'Senior Technician', reason: 'Title per firm records' },
      },
    ]);
    // Nothing about grants was sent.
    expect(writes.some((w) => w.url.includes('eligibility') || w.url.includes('capabilit'))).toBe(
      false,
    );
  });

  it('AC2: grants and revokes reviewer eligibility with reasons, shown only once the server confirms', async () => {
    const writes = stubApi();
    const { user, drawer } = await openDrawer();
    const section = await within(drawer).findByRole('group', {
      name: 'Eligibility and capabilities',
    });
    const form = await within(section).findByRole('form', { name: 'Grant reviewer eligibility' });
    await user.selectOptions(within(form).getByLabelText('Reviewer eligibility'), 'concrete_field');
    expect(within(form).getByRole('button', { name: 'Grant eligibility' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason'), 'Qualified field reviewer');
    await user.click(within(form).getByRole('button', { name: 'Grant eligibility' }));
    expect(
      await within(section).findByText(
        'Jordan Smith is now an eligible Concrete field reports reviewer.',
      ),
    ).toBeVisible();
    expect(within(section).getByRole('list', { name: 'Current grants' })).toHaveTextContent(
      'Eligible reviewer: Concrete field reports',
    );
    expect(writes[0]).toMatchObject({
      method: 'POST',
      url: '/api/staff/u-js/reviewer-eligibility',
      body: { scopeCode: 'concrete_field', reason: 'Qualified field reviewer' },
    });

    await user.click(
      within(section).getByRole('button', { name: 'Revoke Concrete field reports eligibility' }),
    );
    const dialog = screen.getByRole('dialog', {
      name: 'Revoke Eligible reviewer: Concrete field reports?',
    });
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(within(dialog).getByText('Enter a reason.')).toBeVisible();
    await user.type(within(dialog).getByLabelText('Reason'), 'Qualification lapsed');
    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));
    expect(
      await within(section).findByText('No reviewer eligibility or capabilities.'),
    ).toBeVisible();
    expect(writes[1]).toMatchObject({
      method: 'DELETE',
      url: '/api/staff/u-js/reviewer-eligibility/re-1',
      body: { reason: 'Qualification lapsed' },
    });
  });
});
