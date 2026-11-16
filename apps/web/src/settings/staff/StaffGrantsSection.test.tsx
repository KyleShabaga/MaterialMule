import type { MeResponse, StaffGrants, StaffMember } from '@materialmule/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';
import { StaffPage } from './StaffPage';

// MM-AO06 in the Staff drawer: the job-title override and reviewer eligibility, each with a
// reason, shown only once the server confirms. Fictional data only (Jordan Smith).

const ADMIN = { userId: 'admin-id', initials: 'ADM', name: 'Admin (test)' };
const FIELD = { code: 'concrete_field', label: 'Concrete field reports' };
const STRENGTH = { code: 'concrete_strength', label: 'Concrete strength reports' };

const ME: MeResponse = {
  id: 'admin-id',
  displayName: 'Admin (test)',
  initials: 'ADM',
  accountType: 'test',
  status: 'active',
  roles: ['admin'],
  permissions: ['staff.manage'],
  sessionExpiresAt: '2026-10-30T06:00:00.000Z',
};

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
  statusHistory: [],
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
  position: 'technician',
  effectiveEligibility: [
    { scope: FIELD, eligible, individualGrant: eligible, positionRule: false, excluded: false },
  ],
  exclusions: { active: [], history: [] },
  reviewerEligibility: {
    active: eligible
      ? [
          {
            id: 're-1',
            startedBy: ADMIN,
            startedAt: '2026-10-29T15:00:00.000Z',
            startReason: 'Qualified field reviewer',
            endedBy: null,
            endedAt: null,
            endReason: null,
            scope: FIELD,
          },
        ]
      : [],
    history: [],
  },
  capabilities: { active: [], history: [] },
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi() {
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
          eligible = false;
          return json(200, grants(false));
        }
        return json(500, {});
      }
      if (url === '/api/review-scopes') return json(200, [FIELD, STRENGTH]);
      if (url === '/api/staff/u-js/grants') return json(200, grants(eligible));
      if (url === '/api/staff' || url.startsWith('/api/staff?')) return json(200, [member]);
      return json(404, {});
    }),
  );
  return writes;
}

beforeAll(() => {
  if (!HTMLElement.prototype.hasPointerCapture) {
    HTMLElement.prototype.setPointerCapture = () => undefined;
    HTMLElement.prototype.releasePointerCapture = () => undefined;
    HTMLElement.prototype.hasPointerCapture = () => false;
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
  act(() => {
    toast.dismiss();
  });
});

async function openDrawer() {
  const user = userEvent.setup();
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: ME },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <MemoryRouter initialEntries={['/admin/staff']}>
        <StaffPage />
      </MemoryRouter>
      <StrataToaster />
    </SessionContext.Provider>,
  );
  await user.click(await screen.findByRole('button', { name: 'Manage Jordan Smith' }));
  return { user, drawer: await screen.findByRole('dialog', { name: 'Jordan Smith' }) };
}

describe('Staff drawer: job title, eligibility and capabilities (MM-AO06)', () => {
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
  });

  it('AC2: grants and revokes reviewer eligibility with reasons, shown once the server confirms', async () => {
    const writes = stubApi();
    const { user, drawer } = await openDrawer();
    const section = await within(drawer).findByRole('group', {
      name: 'Eligibility and capabilities',
    });
    const form = await within(section).findByRole('form', { name: 'Grant reviewer eligibility' });
    await user.click(within(form).getByRole('combobox', { name: 'Reviewer eligibility' }));
    await user.click(await screen.findByRole('option', { name: 'Concrete field reports' }));
    expect(within(form).getByRole('button', { name: 'Grant eligibility' })).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason'), 'Qualified field reviewer');
    await user.click(within(form).getByRole('button', { name: 'Grant eligibility' }));
    expect(
      await screen.findByText('Jordan Smith is now an eligible Concrete field reports reviewer.'),
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
    const dialog = screen.getByRole('alertdialog', {
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
