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
  position: 'project_engineer',
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
  routeTag: 'Lead Project Engineer',
  routedTo: 'Lead Project Engineer',
  projectId: 'p1',
  projectNumber: 'DEMO-2601',
  href: '/lab-testing/programs/lp1',
  requestedBy: { userId: 'u-at', initials: 'AT', name: 'Alex Tester' },
  reason: 'All tests are done',
  createdAt: '2026-10-27T16:00:00.000Z',
  assignedTo: null,
  assignmentLapsed: false,
  unresolved: false,
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
    expect(await screen.findByRole('button', { name: 'Action requests, 2 open' })).toHaveAttribute(
      'aria-expanded',
      'false',
    );
    const row = await screen.findByRole('listitem', { name: 'Closure requested for LP-2026-0001' });
    expect(row).toHaveTextContent(
      'Lead Project Engineer: Closure requested for LP-2026-0001 by AT · All tests are done',
    );
    expect(within(row).getByRole('link', { name: 'Open' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/lp1',
    );
    // Nothing on the page resolves or approves an item.
    expect(within(row).queryByRole('button', { name: /approve|resolve|close/i })).toBeNull();
    expect(within(row).queryByRole('button', { name: 'Reassign' })).toBeNull();
  });

  it('MISC-02: the bell sits to the right of the signed-in user area', async () => {
    renderAt('/action-requests', me(), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      return json(200, { items: [] });
    });
    const bell = await screen.findByRole('button', { name: 'Action requests, 0 open' });
    const identity = screen.getByLabelText('Signed in user');
    expect(identity.compareDocumentPosition(bell) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(identity.nextElementSibling).toContainElement(bell);
  });

  it('MISC-10: the bell previews the newest open requests without leaving the page', async () => {
    const user = userEvent.setup();
    let failList = true;
    const fetchMock = renderAt('/projects', me(), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 2 });
      if (url.startsWith('/api/action-items?status=open&scope=mine')) {
        if (failList) return json(500, {});
        return json(200, {
          items: [
            item({ id: 'ai-old', title: 'Older request', createdAt: '2026-10-26T16:00:00.000Z' }),
            item({ id: 'ai-new', title: 'Newer request', createdAt: '2026-10-27T16:00:00.000Z' }),
          ],
        });
      }
      if (url.startsWith('/api/projects')) return json(200, { items: [] });
      return json(404, {});
    });
    const bell = await screen.findByRole('button', { name: 'Action requests, 2 open' });
    await user.click(bell);
    expect(bell).toHaveAttribute('aria-expanded', 'true');
    const panel = screen.getByRole('region', { name: 'Latest action requests' });
    expect(await within(panel).findByRole('alert')).toHaveTextContent(
      'Action requests couldn’t be loaded.',
    );
    failList = false;
    await user.click(within(panel).getByRole('button', { name: 'Retry' }));
    const links = await within(panel).findAllByRole('link');
    expect(links.map((link) => link.textContent)).toEqual([
      expect.stringContaining('Newer request'),
      expect.stringContaining('Older request'),
      'View all action requests',
    ]);
    expect(links[0]).toHaveAttribute('href', '/lab-testing/programs/lp1');
    expect(within(panel).queryByRole('button', { name: /approve|resolve|close/i })).toBeNull();
    // Still on the same page; only GETs were sent.
    expect(screen.getByRole('heading', { level: 1, name: 'Projects' })).toBeInTheDocument();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );

    // Escape closes and returns focus to the bell.
    links[0]!.focus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('region', { name: 'Latest action requests' })).toBeNull();
    expect(bell).toHaveFocus();
    expect(bell).toHaveAttribute('aria-expanded', 'false');

    // Keyboard open, then a second activation closes it.
    await user.keyboard('{Enter}');
    expect(screen.getByRole('region', { name: 'Latest action requests' })).toBeInTheDocument();
    await user.click(bell);
    expect(screen.queryByRole('region', { name: 'Latest action requests' })).toBeNull();
    expect(bell).toHaveFocus();

    // An outside click closes it.
    await user.click(bell);
    await user.click(screen.getByRole('heading', { level: 1, name: 'Projects' }));
    expect(screen.queryByRole('region', { name: 'Latest action requests' })).toBeNull();
  });

  it('MISC-10: the preview says so when nothing is waiting', async () => {
    const user = userEvent.setup();
    renderAt('/action-requests', me(), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      return json(200, { items: [] });
    });
    await user.click(await screen.findByRole('button', { name: 'Action requests, 0 open' }));
    const panel = screen.getByRole('region', { name: 'Latest action requests' });
    expect(await within(panel).findByText('Nothing is waiting on you.')).toBeInTheDocument();
    await user.click(within(panel).getByRole('link', { name: 'View all action requests' }));
    expect(screen.queryByRole('region', { name: 'Latest action requests' })).toBeNull();
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

  it('MM-AO07: Lab Managers see lapsed assignments and the unresolved queue', async () => {
    const user = userEvent.setup();
    const fetchMock = renderAt(
      '/action-requests',
      me({ roles: ['lab_manager'], permissions: ['action_item.read', 'action_item.reassign'] }),
      (url) => {
        if (url.startsWith('/api/action-items/count')) return json(200, { open: 1 });
        if (url.includes('scope=unresolved')) {
          return json(200, {
            items: [
              item({
                id: 'ai-u',
                kind: 'closure_request',
                title: 'Closure requested for LP-2026-0002',
                routedTo: 'Waiting for a Lead Project Engineer',
                unresolved: true,
              }),
            ],
          });
        }
        return json(200, {
          items: [
            item({
              kind: 'cancellation_request',
              title: 'Cancellation requested for LP-2026-0001 · MC',
              assignedTo: { userId: 'u-ls', initials: 'LS', name: 'Lou Second' },
              assignmentLapsed: true,
              routedTo:
                'Lead Project Engineer and Lab Managers (Lou Second can no longer act on it)',
              canReassign: true,
            }),
          ],
        });
      },
    );
    const row = await screen.findByRole('listitem', { name: /Cancellation requested/ });
    expect(row).toHaveTextContent('Lou Second can no longer act on it');
    expect(within(row).getByText('Assignment lapsed')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Reassign' })).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /Unresolved/ }));
    const queued = await screen.findByRole('listitem', { name: /Closure requested/ });
    expect(queued).toHaveTextContent('Waiting for a Lead Project Engineer');
    expect(within(queued).getByText('Nobody can act on this now')).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('status=open&scope=unresolved')),
    ).toBe(true);
  });

  it('MM-AO07: people without reassignment see no unresolved queue', async () => {
    renderAt('/action-requests', me(), (url) => {
      if (url.startsWith('/api/action-items/count')) return json(200, { open: 0 });
      return json(200, { items: [] });
    });
    expect(await screen.findByText('Nothing is waiting on you.')).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: /Unresolved/ })).toBeNull();
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
            jobTitleOverride: null,
            effectiveJobTitle: null,
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
    expect(screen.queryByRole('button', { name: /Action requests/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Notifications' })).toBeNull();
  });

  it('MISC-11: My profile shows Notifications without the Email me opt-in', async () => {
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
          jobTitleOverride: null,
          effectiveJobTitle: null,
          department: null,
          officeLocation: null,
          officialInitials: 'PE',
          initialsConfirmed: true,
          position: 'project_engineer',
          positionSetAt: null,
          source: 'seed',
          refreshedAt: null,
          refreshFailedAt: null,
          canRefresh: false,
        });
      }
      return json(404, {});
    });
    expect(await screen.findByRole('heading', { name: 'Notifications' })).toBeInTheDocument();
    expect(screen.queryByRole('checkbox')).toBeNull();
    expect(screen.queryByText(/Email me|switched off for everyone|work email/)).toBeNull();
    // UI only: nothing reads or writes the stored preference from this page any more.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).includes('notification-preferences')),
    ).toBe(false);
  });
});
