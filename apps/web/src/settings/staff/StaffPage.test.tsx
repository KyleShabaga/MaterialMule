import type { MeResponse, StaffMember } from '@trapezoid/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
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
  ...overrides,
});

const RILEY = member({ id: 'riley', displayName: 'Riley Pending', status: 'pending' });
const JORDAN = member({
  id: 'jordan',
  displayName: 'Jordan Smith',
  officialInitials: 'JS',
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
});
