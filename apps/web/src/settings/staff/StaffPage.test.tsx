import type { MeResponse, StaffMember } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
});

function renderPage(permissions: string[]) {
  return render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: me(permissions) },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <StaffPage />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('StaffPage', () => {
  it('tells non-admins they cannot manage staff, without calling the API', () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    renderPage(['inventory.read']);
    expect(screen.getByText('Only administrators can manage staff and access.')).toBeVisible();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('shows pending staff at the top and approves them', async () => {
    let approved = false;
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push(`${init?.method ?? 'GET'} ${url}`);
        const json = (body: unknown) =>
          new Response(JSON.stringify(body), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          });
        if (url.endsWith('/approve')) {
          approved = true;
          return json({ ...RILEY, status: 'active' });
        }
        if (url.includes('status=pending')) return json(approved ? [] : [RILEY]);
        return json(approved ? [{ ...RILEY, status: 'active' }, JORDAN] : [RILEY, JORDAN]);
      }),
    );
    const user = userEvent.setup();
    renderPage(['staff.manage']);

    const pending = await screen.findByRole('region', { name: /Waiting for approval/ });
    expect(within(pending).getByText('Riley Pending')).toBeVisible();
    expect(await screen.findByRole('cell', { name: 'JS' })).toBeVisible();

    await user.click(within(pending).getByRole('button', { name: 'Approve Riley Pending' }));
    expect(calls).toContain('POST /api/staff/riley/approve');
    expect(await screen.findByText('Riley Pending is approved.')).toBeVisible();
    expect(screen.queryByRole('region', { name: /Waiting for approval/ })).toBeNull();
  });

  describe('losing Admin mid-session (MM-T52)', () => {
    const LAB = {
      userId: 'lab-id',
      passwordSet: true,
      passwordUpdatedAt: '2026-10-26T00:00:00.000Z',
      activeSessions: 1,
      lockedUntil: null,
    };

    /** Serves the page as an admin until `revoke()`; then every staff request is a 403. */
    function stubApi() {
      const state = { admin: true };
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL) => {
          const url = String(input);
          const json = (status: number, body: unknown) =>
            new Response(JSON.stringify(body), {
              status,
              headers: { 'content-type': 'application/json' },
            });
          if (!state.admin) return json(403, { code: 'forbidden' });
          if (url.startsWith('/api/admin/lab')) return json(200, LAB);
          if (url.includes('status=pending')) return json(200, [RILEY]);
          return json(200, [RILEY, JORDAN]);
        }),
      );
      return state;
    }

    it('T1: a 403 hides every admin-only control and shows one message with Retry', async () => {
      const state = stubApi();
      const user = userEvent.setup();
      renderPage(['staff.manage']);
      expect(await screen.findByRole('region', { name: /Waiting for approval/ })).toBeVisible();
      expect(await screen.findByRole('region', { name: 'Shared receiving account (LAB)' }));

      state.admin = false;
      await user.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'J');

      // Wait for the whole page to hand over, not just the first copy of the message.
      await waitFor(() => expect(screen.queryByRole('button', { name: 'Add staff' })).toBeNull());
      expect(
        await screen.findByText('You no longer have permission to manage staff.'),
      ).toBeVisible();
      expect(screen.getAllByText('You no longer have permission to manage staff.')).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Add staff' })).toBeNull();
      expect(screen.queryByRole('region', { name: /Waiting for approval/ })).toBeNull();
      expect(screen.queryByRole('button', { name: /Approve/ })).toBeNull();
      expect(screen.queryByRole('region', { name: 'Shared receiving account (LAB)' })).toBeNull();
      expect(screen.queryByLabelText('New LAB password')).toBeNull();
      expect(screen.getByRole('button', { name: 'Retry' })).toBeVisible();
    });

    it('T2: after Admin is granted back, Retry restores the full page', async () => {
      const state = stubApi();
      const user = userEvent.setup();
      renderPage(['staff.manage']);
      await screen.findByRole('region', { name: /Waiting for approval/ });
      state.admin = false;
      await user.type(screen.getByRole('searchbox', { name: 'Search staff' }), 'J');
      await screen.findByText('You no longer have permission to manage staff.');

      state.admin = true;
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('region', { name: /Waiting for approval/ })).toBeVisible();
      expect(screen.getByRole('button', { name: 'Add staff' })).toBeVisible();
      expect(
        await screen.findByRole('region', { name: 'Shared receiving account (LAB)' }),
      ).toBeVisible();
      expect(screen.queryByText('You no longer have permission to manage staff.')).toBeNull();
    });
  });

  describe('profile drawer (MM-T43, MM-T44)', () => {
    const OLIVE = member({
      id: 'olive',
      displayName: 'Olive Onboarded',
      officialInitials: 'OO',
      initialsConfirmed: false,
      position: 'engineer',
      accountType: 'personal',
    });

    function stubApi() {
      const patches: unknown[] = [];
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const json = (body: unknown) =>
            new Response(JSON.stringify(body), {
              status: 200,
              headers: { 'content-type': 'application/json' },
            });
          if (init?.method === 'PATCH') {
            const body = JSON.parse(String(init.body)) as Record<string, unknown>;
            patches.push(body);
            return json({
              ...OLIVE,
              ...body,
              initialsConfirmed: 'officialInitials' in body ? true : OLIVE.initialsConfirmed,
            });
          }
          if (String(input).includes('status=pending')) return json([]);
          return json([OLIVE]);
        }),
      );
      return patches;
    }

    beforeEach(() => {
      // jsdom has no <dialog> methods.
      HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
        this.open = true;
      };
      HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
        this.open = false;
      };
    });

    async function openDrawer() {
      const user = userEvent.setup();
      renderPage(['staff.manage']);
      await user.click(await screen.findByRole('button', { name: 'Manage Olive Onboarded' }));
      return { user, drawer: await screen.findByRole('dialog', { name: 'Olive Onboarded' }) };
    }

    it('sends only the cleared position and explains that onboarding reopens', async () => {
      const patches = stubApi();
      const { user, drawer } = await openDrawer();
      const position = within(drawer).getByLabelText('Position');
      await user.selectOptions(position, 'Not set');
      expect(
        within(drawer).getByText(
          'Not set: they will be asked to choose a position again at their next sign-in.',
        ),
      ).toBeVisible();
      await user.click(within(drawer).getByRole('button', { name: 'Save profile' }));
      expect(await screen.findByText('Saved Olive Onboarded.')).toBeVisible();
      expect(patches).toEqual([{ position: null }]);
    });

    it('never sends unchanged initials, and confirms them only on request', async () => {
      const patches = stubApi();
      const { user, drawer } = await openDrawer();
      await user.click(within(drawer).getByRole('button', { name: 'Save profile' }));
      expect(await screen.findByText('No changes to save.')).toBeVisible();
      expect(patches).toEqual([]);

      await user.clear(within(drawer).getByLabelText('Display name'));
      await user.type(within(drawer).getByLabelText('Display name'), 'Olive Renamed');
      await user.click(within(drawer).getByRole('button', { name: 'Save profile' }));
      expect(await screen.findByText('Saved Olive Renamed.')).toBeVisible();
      expect(patches).toEqual([{ displayName: 'Olive Renamed' }]);

      await user.click(within(drawer).getByRole('button', { name: 'Confirm initials OO' }));
      expect(await screen.findByText('Initials OO confirmed for Olive Renamed.')).toBeVisible();
      expect(patches.at(-1)).toEqual({ officialInitials: 'OO' });
    });
  });
});
