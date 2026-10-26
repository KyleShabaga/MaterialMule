import type { MeResponse } from '@trapezoid/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// Settings → Receiving (TRP-T40 T3). Fictional people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000103',
  displayName: 'Lab (test)',
  initials: 'LAB',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'settings.drafts.manage'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});
const TECH = me({ roles: [], permissions: ['inventory.read'], displayName: 'Alex Tester' });

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const current = (enabled: boolean, afterDays: number, version: number) => ({
  draftAutoDelete: { enabled, afterDays },
  version,
});

function renderSettings(
  session: MeResponse,
  handlers: { get?: () => Response | Promise<Response>; put?: (body: unknown) => Response },
  path = '/settings/receiving',
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (url.startsWith('/api/settings/drafts') && method === 'GET' && handlers.get) {
      return handlers.get();
    }
    if (url.startsWith('/api/settings/drafts') && method === 'PUT' && handlers.put) {
      return handlers.put(JSON.parse(String(init?.body)));
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Receiving (TRP-T40)', () => {
  it('shows the Receiving tab only to Lab Managers and admins', async () => {
    renderSettings(me(), { get: () => json(200, current(false, 90, 1)) }, '/settings/profile');
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Receiving' })).toHaveAttribute(
      'href',
      '/settings/receiving',
    );
  });

  it('hides the tab from others, who see the setting read-only with an explanation', async () => {
    renderSettings(TECH, { get: () => json(200, current(true, 120, 3)) });
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).queryByRole('link', { name: 'Receiving' })).toBeNull();
    expect(
      await screen.findByText('Only Lab Managers and administrators can change this.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: 'Delete drafts automatically' })).toBeDisabled();
    expect(screen.getByRole('checkbox', { name: 'Delete drafts automatically' })).toBeChecked();
    expect(screen.getByLabelText('After this many days without changes')).toHaveValue(120);
    expect(screen.queryByRole('button', { name: 'Save' })).toBeNull();
  });

  it('shows loading, then an error with Retry that loads again', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderSettings(me(), {
      get: () => (++calls === 1 ? json(500, {}) : json(200, current(false, 90, 1))),
    });
    expect(screen.getByText('Loading receiving settings…')).toBeInTheDocument();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The draft setting couldn't load.");
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(
      await screen.findByRole('checkbox', { name: 'Delete drafts automatically' }),
    ).not.toBeChecked();
  });

  it('explains where drafts live and saves a change with the loaded version', async () => {
    const user = userEvent.setup();
    const puts: unknown[] = [];
    renderSettings(me(), {
      get: () => json(200, current(false, 90, 1)),
      put: (body) => {
        puts.push(body);
        return json(200, current(true, 60, 2));
      },
    });
    expect(
      await screen.findByText(
        /each computer deletes its own drafts .* the next time Receive samples is opened there/,
      ),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('After this many days without changes')).toHaveValue(90);
    await user.click(screen.getByRole('checkbox', { name: 'Delete drafts automatically' }));
    const days = screen.getByLabelText('After this many days without changes');
    await user.clear(days);
    await user.type(days, '60');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Draft setting saved.')).toBeInTheDocument();
    expect(puts).toEqual([current(true, 60, 1)]);
    expect(screen.getByRole('checkbox', { name: 'Delete drafts automatically' })).toBeChecked();
    expect(screen.getByLabelText('After this many days without changes')).toHaveValue(60);
  });

  it('AC5: refuses days outside 30–365 before sending, and shows the server field error', async () => {
    const user = userEvent.setup();
    const put = vi.fn(() =>
      json(400, {
        code: 'validation_failed',
        errors: [
          {
            field: 'draftAutoDelete.afterDays',
            code: 'too_big',
            message: 'Enter a whole number of days from 30 to 365',
          },
        ],
      }),
    );
    renderSettings(me(), { get: () => json(200, current(false, 90, 1)), put });
    const days = await screen.findByLabelText('After this many days without changes');
    for (const value of ['29', '366']) {
      await user.clear(days);
      await user.type(days, value);
      await user.click(screen.getByRole('button', { name: 'Save' }));
      expect(screen.getByText('Enter a whole number of days from 30 to 365')).toBeInTheDocument();
      expect(days).toHaveAttribute('aria-invalid', 'true');
    }
    expect(put).not.toHaveBeenCalled();

    await user.clear(days);
    await user.type(days, '100');
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(put).toHaveBeenCalledTimes(1);
    expect(
      await screen.findByText('Enter a whole number of days from 30 to 365'),
    ).toBeInTheDocument();
  });

  it('shows the current setting after someone else changed it', async () => {
    const user = userEvent.setup();
    renderSettings(me(), {
      get: () => json(200, current(false, 90, 1)),
      put: () => json(409, { code: 'version_conflict', current: current(true, 200, 2) }),
    });
    await user.click(await screen.findByRole('checkbox', { name: 'Delete drafts automatically' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(
      await screen.findByText(/Someone else changed this setting while you were editing/),
    ).toBeInTheDocument();
    expect(screen.getByLabelText('After this many days without changes')).toHaveValue(200);
  });
});
