import type { MeResponse } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MTR-2: the shared LAB account never asks for personal-account data, so its console shows no
// 403s; the pages say plainly that they are for personal accounts.

const LAB: MeResponse = {
  id: 'lab',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['receipt.confirm', 'inventory.read', 'label.print', 'lab_program.read'],
  sessionExpiresAt: '2026-11-26T16:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
};

const PROJECT = '00000000-0000-4000-8000-000000000a01';
const PERSONAL = [
  '/api/action-items',
  '/api/me/notification-preferences',
  '/api/me/access',
  `/api/projects/${PROJECT}/capabilities`,
  `/api/projects/${PROJECT}/team-members`,
  `/api/projects/${PROJECT}/reviewer-assignments`,
  `/api/projects/${PROJECT}/report-issuers`,
  `/api/projects/${PROJECT}/acceptance-delegates`,
  '/api/review-scopes',
];

function renderAsLab(path: string) {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      urls.push(new URL(String(input), 'http://localhost').pathname);
      return new Response('{}', { status: 404, headers: { 'content-type': 'application/json' } });
    }),
  );
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: LAB },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return urls;
}

function personalCalls(urls: string[]) {
  return urls.filter((url) => PERSONAL.some((path) => url.startsWith(path)));
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MTR-2: LAB on personal-account pages', () => {
  it('Action requests shows a plain refusal and loads nothing', async () => {
    const urls = renderAsLab('/action-requests');
    expect(
      await screen.findByText(
        'Action requests are for personal accounts. Sign in with your own account.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(personalCalls(urls)).toEqual([]);
  });

  it('My access says it is for personal accounts without asking the server', async () => {
    const urls = renderAsLab('/settings/access');
    expect(await screen.findByText(/My access is for personal accounts/)).toBeInTheDocument();
    expect(personalCalls(urls)).toEqual([]);
  });

  it('Team & Permissions shows a refusal with no pointless Retry', async () => {
    const urls = renderAsLab(`/projects/${PROJECT}/team`);
    expect(
      await screen.findByText(
        'Team & Permissions is for personal accounts. Sign in with your own account.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
    expect(personalCalls(urls)).toEqual([]);
  });

  it('My profile leaves out notification preferences', async () => {
    const urls = renderAsLab('/settings/profile');
    expect(await screen.findByRole('heading', { name: 'Settings' })).toBeInTheDocument();
    expect(personalCalls(urls)).toEqual([]);
  });
});
