import type { MeResponse, SystemStatusResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { formatAge, formatBytes } from '../../lib/format';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Admin (test)',
  initials: 'ADM',
  accountType: 'test',
  status: 'active',
  roles: ['admin'],
  permissions: ['staff.manage', 'system.status.read'],
  sessionExpiresAt: '2026-10-26T20:00:00.000Z',
  ...overrides,
});

function status(overrides: Partial<SystemStatusResponse> = {}): SystemStatusResponse {
  return {
    checkedAt: '2026-10-26T18:00:00.000Z',
    version: '0.2.0',
    database: 'up',
    backup: {
      state: 'ok',
      message: 'The last backup succeeded.',
      lastRunAt: '2026-10-26T08:02:00Z',
      lastRunResult: 'success',
      lastRunMessage: 'Backup copied and verified',
      lastSuccessAt: '2026-10-26T08:02:00Z',
      lastSuccessFile: 'materialmule-production-20261026T080000Z-0.2.0.dump',
      lastSuccessSizeBytes: 2_500_000,
      rpoHours: 24,
      rtoHours: 4,
      owner: 'Fictional IT owner',
      alertRecipient: 'Fictional IT monitoring',
    },
    printQueue: {
      queued: 3,
      sending: 0,
      uncertain: 1,
      failed: 0,
      oldestQueuedAt: '2026-10-26T17:48:00.000Z',
      oldestQueuedAgeSeconds: 720,
    },
    printWorker: { running: true, lastPollAt: '2026-10-26T17:59:58.000Z' },
    disks: [
      {
        label: 'Material Mule host',
        freeBytes: 120_000_000_000,
        totalBytes: 500_000_000_000,
        measuredAt: '2026-10-26T18:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function stub(body: unknown, code = 200) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input) === '/api/admin/system-status') {
      return new Response(JSON.stringify(body), {
        status: code,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response('{}', { status: 404 });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderRoute(user: MeResponse) {
  const router = createMemoryRouter(routes, { initialEntries: ['/settings/system-status'] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings → System status (MM-T21)', () => {
  it('shows version, database, backup, print backlog and disk space to admins', async () => {
    stub(status());
    renderRoute(me());
    expect(await screen.findByRole('link', { name: 'System status' })).toBeInTheDocument();
    const service = await screen.findByRole('region', { name: 'Service' });
    expect(within(service).getByText('Connected')).toBeInTheDocument();
    expect(within(service).getByText('0.2.0')).toBeInTheDocument();
    const backups = screen.getByRole('region', { name: /Backups/ });
    expect(within(backups).getByText('OK')).toBeInTheDocument();
    expect(within(backups).getByText(/– succeeded/)).toBeInTheDocument();
    expect(within(backups).getByText('24 h')).toBeInTheDocument();
    const queue = screen.getByRole('region', { name: 'Print queue' });
    expect(within(queue).getByText('3')).toBeInTheDocument();
    expect(within(queue).getByText('12 min ago')).toBeInTheDocument();
    const disks = screen.getByRole('region', { name: 'Disk space' });
    expect(within(disks).getByText('120.0 GB free of 500.0 GB')).toBeInTheDocument();
  });

  it('AC4: warns when no backup succeeded within the RPO', async () => {
    stub(
      status({
        backup: {
          ...status().backup,
          state: 'overdue',
          message: 'No successful backup in the last 24 hours (the recovery point objective).',
        },
      }),
    );
    renderRoute(me());
    expect(await screen.findByRole('alert')).toHaveTextContent('No successful backup');
    expect(screen.getByText('Overdue')).toBeInTheDocument();
  });

  it('AC3: shows a failed backup and its reason', async () => {
    stub(
      status({
        backup: {
          ...status().backup,
          state: 'failed',
          message: 'The last backup failed.',
          lastRunResult: 'failed',
          lastRunMessage: 'Backup location unavailable',
        },
      }),
    );
    renderRoute(me());
    expect(await screen.findByRole('alert')).toHaveTextContent('The last backup failed.');
    expect(screen.getByText('Backup location unavailable')).toBeInTheDocument();
  });

  it('says plainly when backups are not set up yet', async () => {
    stub(
      status({
        backup: {
          ...status().backup,
          state: 'not_configured',
          message: 'Backups are not set up on this server yet.',
        },
      }),
    );
    renderRoute(me());
    expect(await screen.findByText('Not set up')).toBeInTheDocument();
  });

  it('is hidden from non-admins and never calls the API', async () => {
    const fetchMock = stub(status());
    renderRoute(me({ roles: [], permissions: ['inventory.read'] }));
    expect(
      await screen.findByText('Only administrators can see system status.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'System status' })).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([url]) => String(url))).not.toContain(
      '/api/admin/system-status',
    );
  });
});

describe('format helpers', () => {
  it('formats sizes and ages', () => {
    expect(formatBytes(512)).toBe('512 bytes');
    expect(formatBytes(1_500_000)).toBe('1.5 MB');
    expect(formatAge(30)).toBe('under a minute');
    expect(formatAge(125 * 60)).toBe('2 h 5 min');
  });
});
