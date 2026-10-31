import type { MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// Settings sub-nav: each tab is shown only to the people who can use it (MTR-88, MISC-05,
// MISC-04).

const BASE: MeResponse = {
  id: 'u',
  displayName: 'Someone (test)',
  initials: 'ST',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'lab_program.read', 'action_item.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  position: null,
  positionSetupRequired: false,
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
  ],
};
const LAB_MANAGER: MeResponse = {
  ...BASE,
  roles: ['lab_manager'],
  permissions: [
    ...BASE.permissions,
    'settings.drafts.manage',
    'location.manage',
    'test_catalog.manage',
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
}

async function settingsTabs() {
  const nav = await screen.findByRole('navigation', { name: 'Settings' });
  return within(nav)
    .getAllByRole('link')
    .map((link) => link.textContent);
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings sub-nav', () => {
  it('MTR-88 / MISC-05: Staff & access is shown to admins only', async () => {
    renderAt('/settings/profile', ADMIN);
    expect(await settingsTabs()).toContain('Staff & access');
  });

  it.each([
    ['a Lab Manager', LAB_MANAGER],
    ['a Technician', TECHNICIAN],
    ['the shared LAB account', LAB],
  ])('MTR-88 / MISC-05: hides Staff & access from %s', async (_who, me) => {
    renderAt('/settings/profile', me);
    expect(await settingsTabs()).not.toContain('Staff & access');
  });

  it.each([
    ['an admin', ADMIN],
    ['a Lab Manager', LAB_MANAGER],
  ])('MISC-04: shows Locations, Tests and Templates to %s', async (_who, me) => {
    renderAt('/settings/profile', me);
    expect(await settingsTabs()).toEqual(
      expect.arrayContaining(['Locations', 'Tests', 'Templates']),
    );
  });

  it.each([
    ['a Technician', TECHNICIAN],
    ['the shared LAB account', LAB],
  ])(
    'MISC-04: %s keeps the print-only Locations tab but not Tests or Templates',
    async (_who, me) => {
      renderAt('/settings/profile', me);
      const tabs = await settingsTabs();
      expect(tabs).toContain('Locations');
      expect(tabs).not.toContain('Tests');
      expect(tabs).not.toContain('Templates');
    },
  );

  it.each(['/settings/tests', '/settings/templates'])(
    'MISC-04: a Technician opening %s directly gets a plain refusal and no catalogue form',
    async (path) => {
      renderAt(path, TECHNICIAN);
      expect(
        await screen.findByText('Only Lab Managers and administrators can open this page.'),
      ).toBeInTheDocument();
      expect(screen.queryByRole('form')).not.toBeInTheDocument();
      expect(screen.queryByRole('table')).not.toBeInTheDocument();
    },
  );

  it('MISC-05: a direct URL to Staff & access gets a friendly refusal, not the page', async () => {
    renderAt('/settings/staff', LAB_MANAGER);
    expect(
      await screen.findByText('Only administrators can manage staff and access.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add staff' })).not.toBeInTheDocument();
  });
});
