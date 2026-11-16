import type { MeResponse, StaffMember } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent, { type UserEvent } from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { toast } from 'sonner';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';
import { StaffPage } from './StaffPage';

const me = (permissions: string[]): MeResponse => ({
  id: 'admin-id',
  displayName: 'Admin (test)',
  initials: 'ADM',
  accountType: 'test',
  status: 'active',
  roles: ['admin'],
  permissions,
  sessionExpiresAt: '2026-10-26T20:00:00.000Z',
});

const member = (overrides: Partial<StaffMember>): StaffMember => ({
  id: 'x',
  displayName: 'X',
  officialInitials: null,
  initialsConfirmed: false,
  position: null,
  accountType: 'test',
  status: 'active',
  roles: [],
  workEmail: null,
  signInUsername: null,
  expectedUpn: null,
  linked: true,
  lastSignInAt: null,
  approvedAt: null,
  disabledReason: null,
  statusHistory: [],
  createdAt: '2026-10-26T00:00:00.000Z',
  jobTitle: null,
  jobTitleOverride: null,
  jobTitleOverrideSetBy: null,
  jobTitleOverrideSetAt: null,
  effectiveJobTitle: null,
  ...overrides,
});

const RILEY = member({ id: 'riley', displayName: 'Riley Pending', status: 'pending' });
const JORDAN = member({
  id: 'jordan',
  displayName: 'Jordan Smith',
  officialInitials: 'JS',
  initialsConfirmed: true,
  position: 'technician',
  roles: ['lab_technician'],
});
const JAMIE = member({
  id: 'jamie',
  displayName: 'Jamie Placeholder',
  status: 'disabled',
  disabledReason: 'Left the lab.',
});

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

function renderPage(permissions: string[], path = '/admin/staff') {
  return render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: me(permissions) },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <MemoryRouter initialEntries={[path]}>
        <StaffPage />
      </MemoryRouter>
      <StrataToaster />
    </SessionContext.Provider>,
  );
}

beforeAll(() => {
  // jsdom has no pointer capture; Radix Select and Sonner call it.
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

// An administrator (STRATA-118): Lab Managers hold staff.manage without these.
const ADMIN_PERMISSIONS = [
  'staff.manage',
  'admin_role.manage',
  'lab_account.manage',
  'reviewer_eligibility.manage',
];

/** The toolbar's search opens from its Search button. */
async function searchStaff(user: UserEvent, text: string) {
  const tools = await screen.findByRole('toolbar', { name: 'Staff tools' });
  await user.click(within(tools).getByRole('button', { name: 'Search' }));
  await user.type(screen.getByRole('searchbox', { name: 'Search staff' }), text);
}

async function choose(user: UserEvent, scope: HTMLElement, label: string, option: string) {
  await user.click(within(scope).getByRole('combobox', { name: label }));
  await user.click(await screen.findByRole('option', { name: option }));
}

describe('StaffPage', () => {
  it('BUG-007: says when the list was cut at the server limit and how to find the rest', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json([JORDAN], 200, { 'x-total-count': '612' })),
    );
    renderPage(['staff.manage']);
    expect(
      await screen.findByText(
        'Showing the first 1 of 612 staff. Search by name, initials or email to find the rest.',
      ),
    ).toBeInTheDocument();
  });

  it('tells people without staff management they cannot manage staff, without calling the API', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPage(['inventory.read']);
    expect(
      screen.getByText('Only Lab Managers and administrators can manage staff and access.'),
    ).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('splits People, Pending and Disabled into tabs with counts, from one request', async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) => json([RILEY, JORDAN, JAMIE]));
    vi.stubGlobal('fetch', fetchMock);
    const user = userEvent.setup();
    renderPage(['staff.manage']);
    const table = await screen.findByRole('table', { name: 'People staff' });
    expect(await within(table).findByText('Jordan Smith')).toBeVisible();
    expect(within(table).queryByText('Riley Pending')).toBeNull();
    expect(screen.getByRole('tab', { name: 'Pending 1' })).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Disabled 1' }));
    const disabled = screen.getByRole('table', { name: 'Disabled staff' });
    expect(within(disabled).getByText('Jamie Placeholder')).toBeVisible();
    expect(within(disabled).getByText(/Left the lab\./)).toBeVisible();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe('/api/staff');
  });

  it('pages 20 people at a time with a footer pager', async () => {
    const people = Array.from({ length: 25 }, (_, i) =>
      member({ id: `p${i}`, displayName: `Person ${String(i + 1).padStart(2, '0')}` }),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => json(people)),
    );
    const user = userEvent.setup();
    renderPage(['staff.manage']);
    expect(await screen.findByText('1–20 of 25 people')).toBeVisible();
    expect(screen.getByText('Person 20')).toBeVisible();
    expect(screen.queryByText('Person 21')).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Next page' }));
    expect(await screen.findByText('21–25 of 25 people')).toBeVisible();
    expect(screen.getByText('Person 25')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Page 2' })).toHaveAttribute('aria-current', 'page');
  });

  it('approves a pending applicant from the drawer', async () => {
    let approved = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        if (url.endsWith('/approve')) {
          approved = true;
          return json({ ...RILEY, status: 'active' });
        }
        if (url === '/api/staff' || url.startsWith('/api/staff?')) {
          return json(approved ? [{ ...RILEY, status: 'active' }, JORDAN] : [RILEY, JORDAN]);
        }
        return json({}, 404);
      }),
    );
    const user = userEvent.setup();
    renderPage(ADMIN_PERMISSIONS);

    await user.click(await screen.findByRole('tab', { name: 'Pending 1' }));
    await user.click(await screen.findByRole('button', { name: 'Manage Riley Pending' }));
    const drawer = await screen.findByRole('dialog', { name: 'Riley Pending' });
    await user.click(within(drawer).getByRole('button', { name: 'Approve' }));
    expect(calls).toContain('POST /api/staff/riley/approve');
    expect(await screen.findByText('Riley Pending is approved.')).toBeVisible();
    await waitFor(() =>
      expect(screen.getByRole('tab', { name: 'Pending 0', hidden: true })).toBeVisible(),
    );
  });

  it('opens the person beside the table from 1024 px, in the URL, with Previous/Next', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query === '(min-width: 1024px)',
      media: query,
      addEventListener: () => undefined,
      removeEventListener: () => undefined,
    }));
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).startsWith('/api/staff?') || String(input) === '/api/staff'
          ? json([JORDAN, member({ id: 'kai', displayName: 'Kai Kiln' })])
          : json({}, 404),
      ),
    );
    const user = userEvent.setup();
    renderPage(['staff.manage']);
    await user.click(await screen.findByRole('button', { name: 'Manage Jordan Smith' }));
    const drawer = await screen.findByRole('region', { name: 'Jordan Smith' });
    expect(within(drawer).getByText('1 of 2')).toBeVisible();
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(within(drawer).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('region', { name: 'Kai Kiln' })).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('region', { name: 'Kai Kiln' })).toBeNull();
  });

  describe('losing staff management mid-session (MM-T52)', () => {
    const LAB = {
      userId: 'lab-id',
      passwordSet: true,
      passwordUpdatedAt: '2026-10-26T00:00:00.000Z',
      activeSessions: 1,
      lockedUntil: null,
    };

    /** Serves the page until `revoke()`; then every staff request is a 403. */
    function stubApi() {
      const state = { admin: true };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          if (!state.admin) return json({ code: 'forbidden' }, 403);
          if (url.startsWith('/api/admin/lab')) return json(LAB);
          return json([RILEY, JORDAN]);
        }),
      );
      return state;
    }

    it('T1: a 403 hides every admin-only control and shows one message with Retry', async () => {
      const state = stubApi();
      const user = userEvent.setup();
      renderPage(ADMIN_PERMISSIONS);
      expect(await screen.findByRole('tab', { name: 'Pending 1' })).toBeVisible();
      expect(await screen.findByRole('region', { name: 'Shared receiving account (LAB)' }));

      state.admin = false;
      await searchStaff(user, 'J');

      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add staff' })).toBeNull());
      expect(
        await screen.findByText('You no longer have permission to manage staff.'),
      ).toBeVisible();
      expect(screen.getAllByText('You no longer have permission to manage staff.')).toHaveLength(1);
      expect(screen.queryByRole('tab', { name: /Pending/ })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Shared receiving account (LAB)' })).toBeNull();
      expect(screen.queryByLabelText('New LAB password')).toBeNull();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    });

    it('T2: after access is granted back, Retry restores the full page', async () => {
      const state = stubApi();
      const user = userEvent.setup();
      renderPage(ADMIN_PERMISSIONS);
      await screen.findByRole('tab', { name: 'Pending 1' });
      state.admin = false;
      await searchStaff(user, 'J');
      await screen.findByText('You no longer have permission to manage staff.');

      state.admin = true;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('tab', { name: 'Pending 1' })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add staff' })).toBeVisible();
      expect(
        await screen.findByRole('region', { name: 'Shared receiving account (LAB)' }),
      ).toBeVisible();
      expect(screen.queryByText('You no longer have permission to manage staff.')).toBeNull();
    });
  });

  describe('person drawer (MM-T43, MM-T44, round 9)', () => {
    const OLIVE = member({
      id: 'olive',
      displayName: 'Olive Onboarded',
      officialInitials: 'OO',
      initialsConfirmed: false,
      position: 'engineer',
      accountType: 'personal',
      roles: ['lab_technician'],
    });

    function stubApi(base: StaffMember = OLIVE) {
      const sent: { method: string; url: string; body: Record<string, unknown> }[] = [];
      let current = base;
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          const method = init?.method ?? 'GET';
          if (method !== 'GET') {
            const body = init?.body
              ? (JSON.parse(String(init.body)) as Record<string, unknown>)
              : {};
            sent.push({ method, url, body });
            if (method === 'PATCH') {
              current = {
                ...current,
                ...body,
                initialsConfirmed: 'officialInitials' in body ? true : current.initialsConfirmed,
              } as StaffMember;
            } else if (url.endsWith('/roles')) {
              current = { ...current, roles: body.roles as StaffMember['roles'] };
            } else if (url.endsWith('/disable')) {
              current = { ...current, status: 'disabled', disabledReason: String(body.reason) };
            } else if (url.endsWith('/enable')) {
              current = { ...current, status: 'active', disabledReason: null };
            }
            return json(current);
          }
          if (url === '/api/staff' || url.startsWith('/api/staff?')) return json([current]);
          return json({}, 404);
        }),
      );
      return sent;
    }

    async function openDrawer(permissions = ADMIN_PERMISSIONS, tab = 'people') {
      const user = userEvent.setup();
      renderPage(permissions, tab === 'people' ? '/admin/staff' : `/admin/staff?tab=${tab}`);
      await user.click(await screen.findByRole('button', { name: 'Manage Olive Onboarded' }));
      return { user, drawer: await screen.findByRole('dialog', { name: 'Olive Onboarded' }) };
    }

    it('MISC-06: offers exactly the four positions plus Not set, and sends only the change', async () => {
      const sent = stubApi();
      const { user, drawer } = await openDrawer();
      await user.click(within(drawer).getByRole('combobox', { name: 'Position' }));
      expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual([
        'Not set',
        'Technician',
        'Technologist',
        'Engineer',
        'Lab Manager',
      ]);
      await user.click(screen.getByRole('option', { name: 'Technologist' }));
      expect(within(drawer).getByText(/grants no permissions/)).toBeVisible();
      await user.click(within(drawer).getByRole('button', { name: 'Save profile' }));
      expect(await screen.findByText('Saved Olive Onboarded.')).toBeVisible();
      expect(sent.map((s) => s.body)).toEqual([{ position: 'technologist' }]);
      await choose(user, drawer, 'Position', 'Not set');
      await user.click(within(drawer).getByRole('button', { name: 'Save profile' }));
      await waitFor(() => expect(sent.at(-1)?.body).toEqual({ position: null }));
    });

    it('STRATA-118: a Lab Manager changes roles but not Admin, and no positions', async () => {
      stubApi();
      const { drawer } = await openDrawer(['staff.manage']);
      const roles = within(drawer).getByRole('group', { name: 'Roles' });
      expect(within(roles).getByRole('checkbox', { name: 'Lab Manager' })).toBeEnabled();
      expect(within(roles).queryByRole('checkbox', { name: 'Admin' })).toBeNull();
      const admin = within(drawer).getByRole('region', { name: 'Admin' });
      expect(
        within(admin).getByText('Only administrators can make or remove admins.'),
      ).toBeVisible();
      expect(within(admin).queryByRole('button', { name: /admin…/ })).toBeNull();
      expect(within(drawer).queryByRole('combobox', { name: 'Position' })).toBeNull();
    });

    it('STRATA-118: an administrator’s account is read-only for a Lab Manager', async () => {
      stubApi({ ...OLIVE, roles: ['admin'] });
      const { drawer } = await openDrawer(['staff.manage']);
      expect(
        within(drawer).getByText('Only administrators can change an administrator’s account.'),
      ).toBeVisible();
      expect(within(drawer).queryByRole('button', { name: 'Save profile' })).toBeNull();
      expect(within(drawer).queryByRole('button', { name: 'Save roles' })).toBeNull();
      expect(within(drawer).queryByRole('button', { name: /Disable access/ })).toBeNull();
    });

    it('roles need a reason, and an unchanged save says "No changes to save."', async () => {
      const sent = stubApi();
      const { user, drawer } = await openDrawer();
      const roles = within(drawer).getByRole('group', { name: 'Roles' });
      await user.click(within(roles).getByRole('button', { name: 'Save roles' }));
      expect(within(roles).getByText('No changes to save.')).toBeVisible();

      await user.click(within(roles).getByRole('checkbox', { name: 'Lab Manager' }));
      await user.click(within(roles).getByRole('button', { name: 'Save roles' }));
      expect(within(roles).getByText('Enter a reason.')).toBeVisible();
      expect(sent).toEqual([]);

      await user.type(within(roles).getByRole('textbox', { name: 'Reason' }), 'Covers the lab');
      await user.click(within(roles).getByRole('button', { name: 'Save roles' }));
      expect(await screen.findByText('Roles updated for Olive Onboarded.')).toBeVisible();
      expect(sent).toEqual([
        {
          method: 'PUT',
          url: '/api/staff/olive/roles',
          body: { roles: ['lab_technician', 'lab_manager'], reason: 'Covers the lab' },
        },
      ]);
    });

    it('an administrator makes someone an admin with a reason, keeping their other roles', async () => {
      const sent = stubApi();
      const { user, drawer } = await openDrawer();
      const admin = within(drawer).getByRole('region', { name: 'Admin' });
      await user.click(within(admin).getByRole('button', { name: 'Make admin…' }));
      await user.type(within(admin).getByRole('textbox', { name: 'Reason' }), 'Second admin');
      await user.click(within(admin).getByRole('button', { name: 'Make admin' }));
      expect(await screen.findByText('Olive Onboarded is now an admin.')).toBeVisible();
      expect(sent[0]?.body).toEqual({ roles: ['lab_technician', 'admin'], reason: 'Second admin' });
    });

    it('disables inline with a required reason, and re-enables without one (D08)', async () => {
      const sent = stubApi();
      const { user, drawer } = await openDrawer();
      await user.click(within(drawer).getByRole('button', { name: 'Disable access…' }));
      const confirm = within(drawer).getByRole('group', {
        name: "Disable Olive Onboarded's access",
      });
      await user.click(within(confirm).getByRole('button', { name: 'Disable access' }));
      expect(within(confirm).getByText('Enter a reason.')).toBeVisible();
      await user.type(within(confirm).getByRole('textbox', { name: 'Reason' }), 'On leave');
      await user.click(within(confirm).getByRole('button', { name: 'Disable access' }));
      expect(
        await screen.findByText('Olive Onboarded is disabled and signed out everywhere.'),
      ).toBeVisible();
      expect(sent[0]).toMatchObject({
        url: '/api/staff/olive/disable',
        body: { reason: 'On leave' },
      });

      await user.click(await within(drawer).findByRole('button', { name: 'Re-enable access' }));
      expect(
        await screen.findByText(
          'Olive Onboarded is re-enabled. Their reviewer, issuer and delegate grants were revoked for revalidation.',
        ),
      ).toBeVisible();
      expect(sent[1]).toMatchObject({ method: 'POST', url: '/api/staff/olive/enable' });
    });

    it('never sends unchanged initials, and confirms them only on request', async () => {
      const sent = stubApi();
      const { user, drawer } = await openDrawer();
      const profile = within(drawer).getByRole('form', { name: 'Profile' });
      await user.click(within(profile).getByRole('button', { name: 'Save profile' }));
      expect(within(profile).getByText('No changes to save.')).toBeVisible();
      expect(sent).toEqual([]);

      await user.clear(within(profile).getByLabelText('Display name'));
      await user.type(within(profile).getByLabelText('Display name'), 'Olive Renamed');
      await user.click(within(profile).getByRole('button', { name: 'Save profile' }));
      expect(await screen.findByText('Saved Olive Renamed.')).toBeVisible();
      expect(sent.map((s) => s.body)).toEqual([{ displayName: 'Olive Renamed' }]);

      const renamed = await screen.findByRole('dialog', { name: 'Olive Renamed' });
      await user.click(within(renamed).getByRole('button', { name: 'Confirm initials OO' }));
      expect(await screen.findByText('Initials OO confirmed for Olive Renamed.')).toBeVisible();
      expect(sent.at(-1)?.body).toEqual({ officialInitials: 'OO' });
    });

    it('MTR-12: shows who approved, disabled and re-enabled them, and when', async () => {
      stubApi({
        ...OLIVE,
        statusHistory: [
          {
            change: 'approved',
            byName: 'Avery Admin',
            at: '2026-10-20T17:00:00.000Z',
            reason: null,
          },
          {
            change: 'disabled',
            byName: 'Avery Admin',
            at: '2026-10-22T17:00:00.000Z',
            reason: 'On leave',
          },
          { change: 'enabled', byName: 'Sam Admin', at: '2026-10-24T17:00:00.000Z', reason: null },
        ],
      });
      const { drawer } = await openDrawer();
      const items = within(within(drawer).getByRole('list', { name: 'Access history' }))
        .getAllByRole('listitem')
        .map((item) => item.textContent);
      expect(items).toEqual([
        'Approved by Avery Admin on Oct 20, 2026',
        'Disabled by Avery Admin on Oct 22, 2026: On leave',
        'Re-enabled by Sam Admin on Oct 24, 2026',
      ]);
    });
  });
});
