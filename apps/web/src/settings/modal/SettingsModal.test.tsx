import type { MeResponse } from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';
import { pickStationPerson } from '../../session/station-test-person';

// STRATA-28, 100: Settings is one modal over the current page, each section has an address,
// and the nav shows only the sections a person can open (the server still checks everything).

const BASE: MeResponse = {
  id: 'u',
  displayName: 'Pat Example (test)',
  initials: 'PE',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: [
    'inventory.read',
    'label.print',
    'lab_program.read',
    'action_item.read',
    'personal_settings.manage',
  ],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  profileRefreshFailed: false,
};

const ADMIN: MeResponse = {
  ...BASE,
  roles: ['admin'],
  permissions: [
    ...BASE.permissions,
    'staff.manage',
    'printer.manage',
    'settings.drafts.manage',
    'location.manage',
    'test_catalog.manage',
    'system.status.read',
    'concrete_settings.supplier.manage',
    'concrete_settings.holiday.manage',
    'concrete_settings.report_header.manage',
  ],
};
const LAB_MANAGER: MeResponse = {
  ...BASE,
  roles: ['lab_manager'],
  permissions: [
    ...BASE.permissions,
    'staff.manage',
    'printer.manage',
    'settings.drafts.manage',
    'location.manage',
    'test_catalog.manage',
    'concrete_settings.testing_machine.manage',
    'concrete_settings.supplier.manage',
  ],
};
const TECHNICIAN: MeResponse = BASE;
const LAB: MeResponse = {
  ...BASE,
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  permissions: ['inventory.read', 'label.print', 'lab_program.read'],
};

function renderAt(path: string, me: MeResponse) {
  pickStationPerson(me);
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } }),
    ),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

async function navItems() {
  const dialog = await screen.findByRole('dialog', { name: 'Settings' });
  const nav = within(dialog).getByRole('navigation', { name: 'Settings' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.querySelector('.truncate')?.textContent);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings nav by permission (STRATA-100)', () => {
  it('a technician sees the Account sections only', async () => {
    renderAt('/settings/profile', TECHNICIAN);
    expect(await navItems()).toEqual(['Profile', 'Preferences', 'Notifications', 'My access']);
  });

  it('the shared LAB account sees the Account sections only (STRATA-119)', async () => {
    renderAt('/settings/profile', LAB);
    expect(await navItems()).toEqual(['Profile', 'Preferences', 'Notifications', 'My access']);
  });

  it('a Lab Manager also sees Lab and the Concrete sections they manage, not System', async () => {
    renderAt('/settings/profile', LAB_MANAGER);
    const items = await navItems();
    expect(items).toEqual(
      expect.arrayContaining(['Staff', 'Locations', 'Printers', 'Templates', 'Receiving']),
    );
    expect(items).toEqual(expect.arrayContaining(['Lab tests', 'Equipment', 'Suppliers']));
    expect(items).not.toContain('Holidays');
    expect(items).not.toContain('Report header');
    expect(items).not.toContain('System status');
  });

  it('an administrator sees System status', async () => {
    renderAt('/settings/profile', ADMIN);
    expect(await navItems()).toContain('System status');
  });

  it('marks Staff, Locations and Lab tests as opening a page (STRATA-128)', async () => {
    renderAt('/settings/profile', ADMIN);
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    expect(within(dialog).getByRole('link', { name: /Staff/ })).toHaveAttribute(
      'href',
      '/admin/staff',
    );
    expect(within(dialog).getByRole('link', { name: /Lab tests/ })).toHaveAttribute(
      'title',
      'Opens as a page',
    );
  });

  it('Search settings narrows the nav', async () => {
    const user = userEvent.setup();
    renderAt('/settings/profile', ADMIN);
    await user.type(await screen.findByRole('textbox', { name: 'Search settings' }), 'zebra');
    expect(await navItems()).toEqual(['Printers']);
  });
});

describe('Settings addresses (STRATA-100)', () => {
  it('/settings opens on Profile the first time', async () => {
    const router = renderAt('/settings', TECHNICIAN);
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/profile'));
  });

  it('/settings opens on the last section visited', async () => {
    window.localStorage.setItem('materialmule:settings-last-section', 'notifications');
    const router = renderAt('/settings', TECHNICIAN);
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/notifications'));
  });

  it.each([
    ['/settings/staff', 'Staff'],
    ['/settings/printers', 'Printers'],
    ['/settings/system-status', 'System status'],
  ])('a technician opening %s lands on My access with a notice', async (path, label) => {
    const router = renderAt(path, TECHNICIAN);
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/access'));
    expect(router.state.location.state).toMatchObject({ settingsBlocked: label });
  });

  it('a technician may still read reference data by address, and it joins the nav', async () => {
    const router = renderAt('/settings/suppliers', TECHNICIAN);
    expect(await navItems()).toEqual([
      'Profile',
      'Preferences',
      'Notifications',
      'My access',
      'Suppliers',
    ]);
    expect(router.state.location.pathname).toBe('/settings/suppliers');
  });

  it.each([
    ['/settings/staff', '/admin/staff'],
    ['/settings/locations', '/admin/locations'],
    ['/settings/tests', '/admin/lab-tests'],
  ])('an administrator opening %s gets the full page %s', async (path, page) => {
    const router = renderAt(path, ADMIN);
    await waitFor(() => expect(router.state.location.pathname).toBe(page));
  });

  it('a Lab Manager opening /admin/staff gets the Staff page (STRATA-118)', async () => {
    renderAt('/admin/staff', LAB_MANAGER);
    expect(await screen.findByRole('heading', { level: 1, name: 'Staff' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Lab administration' });
    expect(
      within(within(tabs).getByRole('list'))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Staff', 'Locations', 'Lab tests']);
  });

  it.each(['/admin/staff', '/admin/lab-tests'])(
    'a technician opening %s lands on My access',
    async (path) => {
      const router = renderAt(path, TECHNICIAN);
      await waitFor(() => expect(router.state.location.pathname).toBe('/settings/access'));
    },
  );

  it('a technician keeps the print-only Locations page by address (MISC-04)', async () => {
    renderAt('/admin/locations', TECHNICIAN);
    expect(await screen.findByRole('heading', { level: 1, name: 'Locations' })).toBeInTheDocument();
    const tabs = screen.getByRole('navigation', { name: 'Lab administration' });
    expect(
      within(within(tabs).getByRole('list'))
        .getAllByRole('link')
        .map((link) => link.textContent),
    ).toEqual(['Locations']);
  });
});

describe('Settings over the current page (STRATA-28)', () => {
  it('keeps the page behind and returns to it on Close', async () => {
    const user = userEvent.setup();
    const router = renderAt('/projects', TECHNICIAN);
    const heading = await screen.findByRole('heading', { level: 1, name: 'Projects' });
    await act(() => router.navigate('/settings/preferences'));
    await screen.findByRole('dialog', { name: 'Settings' });
    // The same element stays mounted behind the modal.
    expect(heading).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(heading).toBeInTheDocument();
  });

  it('switching sections replaces the address, so Esc still returns to the page', async () => {
    const user = userEvent.setup();
    const router = renderAt('/projects', TECHNICIAN);
    await screen.findByRole('heading', { level: 1, name: 'Projects' });
    await act(() => router.navigate('/settings/profile'));
    const dialog = await screen.findByRole('dialog', { name: 'Settings' });
    await user.click(within(dialog).getByRole('link', { name: 'Notifications' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/settings/notifications'));
    await user.keyboard('{Escape}');
    await waitFor(() => expect(router.state.location.pathname).toBe('/projects'));
  });

  it('a fresh load of a section closes to Today', async () => {
    const user = userEvent.setup();
    const router = renderAt('/settings/preferences', TECHNICIAN);
    await user.click(await screen.findByRole('button', { name: 'Close settings' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  });
});
