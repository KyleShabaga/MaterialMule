import type { ActionRequest, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-T27 UI: header bell count, Action requests page (Open/Resolved, who asked and why, Open
// link, Resolved by), reassignment for Lab Managers and the profile notification preference.
// Fictional data only (DEMO-2601, LP-2026-0001).

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'action_item.read'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  position: 'pm_pe',
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});

const item = (overrides: Partial<ActionRequest> = {}): ActionRequest => ({
  id: 'ai-1',
  kind: 'closure_request',
  status: 'open',
  resolution: null,
  title: 'Closure requested for LP-2026-0001',
  routeTag: 'PM/PE',
  routedTo: 'Project PM/PE',
  projectId: 'p1',
  projectNumber: 'DEMO-2601',
  href: '/lab-testing/programs/lp1',
  requestedBy: { userId: 'u-at', initials: 'AT', name: 'Alex Tester' },
  reason: 'All tests are done',
  createdAt: '2026-10-27T16:00:00.000Z',
  assignedTo: null,
  resolvedBy: null,
  resolvedAt: null,
  canReassign: false,
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(
  path: string,
  user: MeResponse,
  api: (url: string, init?: RequestInit) => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe('Action requests (MM-T27)', () => {
  it('T5: the bell shows the open count and the page lists who asked, why, and an Open link', async () => {
    renderAt('/action-requests', me(), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 2 });
      if (url.startsWith('/api/action-items?status=open')) return json(200, { items: [item()] });
      return json(404, {});
    });
    expect(await screen.findByRole('link', { name: 'Action requests, 2 open' })).toHaveAttribute(
      'href',
      '/action-requests',
    );
    const row = await screen.findByRole('listitem', { name: 'Closure requested for LP-2026-0001' });
    expect(row).toHaveTextContent(
      'PM/PE: Closure requested for LP-2026-0001 by AT · All tests are done',
    );
    expect(within(row).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1',
    );
    // Nothing on the page resolves or approves an item.
    expect(within(row).queryByRole('button', { name: /approve|resolve|close/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('Resolved filter shows who resolved it for everyone', async () => {
    const user = userEvent.setup();
    renderAt('/action-requests', me({ roles: ['lab_manager'] }), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      if (url.includes('status=resolved')) {
        return json(200, {
          items: [
            item({
              id: 'ai-2',
              kind: 'correction',
              title: 'Correction returned for LP-2026-0001 · MC',
              routeTag: 'LM',
              status: 'resolved',
              resolution: 'correction_done',
              resolvedBy: { userId: 'u-lm', initials: 'LM', name: 'Lee Manager' },
              resolvedAt: '2026-10-27T17:00:00.000Z',
            }),
          ],
        });
      }
      return json(200, { items: [] });
    });
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Resolved' }));
    expect(await screen.findByText(/Resolved by LM · Correction done/)).toBeInTheDocument();
  });

  it('a Lab Manager reassigns with a required reason', async () => {
    const user = userEvent.setup();
    const fetchMock = renderAt(
      '/action-requests',
      me({ roles: ['lab_manager'], permissions: ['action_item.read', 'action_item.reassign'] }),
      (url, init) => {
        if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
        if (url.endsWith('/assignees')) {
          return json(200, {
            people: [{ userId: 'u-ls', initials: 'LS', name: 'Lou Second' }],
          });
        }
        if (url.endsWith('/reassign') && init?.method === 'POST') {
          return json(200, item({ canReassign: false }));
        }
        return json(200, { items: [item({ canReassign: true })] });
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Reassign' }));
    const form = screen.getByRole('form', { name: 'Reassign' });
    await user.selectOptions(
      within(form).getByLabelText('Reassign to'),
      await within(form).findByRole('option', { name: 'Lou Second (LS)' }),
    );
    const submit = within(form).getByRole('button', { name: 'Reassign' });
    expect(submit).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason (required)'), 'Pat is on leave');
    await user.click(submit);
    const call = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/reassign'));
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({
      toUserId: 'u-ls',
      reason: 'Pat is on leave',
    });
  });

  it('LAB has no bell and no preference card', async () => {
    renderAt(
      '/settings/profile',
      me({ accountType: 'shared_lab', permissions: ['inventory.read'] }),
      (url) => {
        if (url.startsWith('/api/me/notification-preferences')) return json(403, {});
        if (url.startsWith('/api/me/profile')) {
          return json(200, {
            displayName: 'LAB',
            givenName: null,
            surname: null,
            workEmail: null,
            signInUsername: null,
            jobTitle: null,
            department: null,
            officeLocation: null,
            officialInitials: 'LAB',
            initialsConfirmed: true,
            position: null,
            positionSetAt: null,
            source: null,
            refreshedAt: null,
            refreshFailedAt: null,
            canRefresh: false,
          });
        }
        return json(404, {});
      },
    );
    expect(await screen.findByRole('heading', { name: 'My profile' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Action requests/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Notifications' })).toBeNull();
  });

  it('My profile: email for action requests defaults off and explains sending is switched off', async () => {
    const user = userEvent.setup();
    const fetchMock = renderAt('/settings/profile', me(), (url, init) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      if (url.startsWith('/api/me/notification-preferences')) {
        return init?.method === 'PUT'
          ? json(200, {
              emailActionRequests: true,
              emailSendingEnabled: false,
              hasWorkEmail: true,
              version: 1,
            })
          : json(200, {
              emailActionRequests: false,
              emailSendingEnabled: false,
              hasWorkEmail: true,
              version: 0,
            });
      }
      if (url.startsWith('/api/me/profile')) {
        return json(200, {
          displayName: 'Pat Example',
          givenName: 'Pat',
          surname: 'Example',
          workEmail: 'pat@example.test',
          signInUsername: null,
          jobTitle: null,
          department: null,
          officeLocation: null,
          officialInitials: 'PE',
          initialsConfirmed: true,
          position: 'pm_pe',
          positionSetAt: null,
          source: 'seed',
          refreshedAt: null,
          refreshFailedAt: null,
          canRefresh: false,
        });
      }
      return json(404, {});
    });
    const box = await screen.findByRole('checkbox', {
      name: 'Email me when an action request needs my decision',
    });
    expect(box).not.toBeChecked();
    expect(screen.getByText(/switched off for everyone until IT approves it/)).toBeInTheDocument();
    await user.click(box);
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT');
    expect(JSON.parse(String(put![1]!.body))).toEqual({ emailActionRequests: true, version: 0 });
  });
});
