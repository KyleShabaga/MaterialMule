import type {
  MeResponse,
  ProjectSummary,
  RecentlyReceivedItem,
  RecentlyReceivedResponse,
  SystemStatusResponse,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { newDraft } from '../receiving/draft';
import { newRecord } from '../receiving/drafts/record';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { receivedWhen } from './format';

// The approved dashboard (2026-10-27). Fictional data only: DEMO-2601, TH26-01, Alex Tester.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'receipt.confirm'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000901',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  leadProjectEngineer: {
    id: '00000000-0000-4000-8000-000000000101',
    displayName: 'Pat Example',
    initials: 'PE',
  },
};

function unit(n: number, overrides: Partial<RecentlyReceivedItem> = {}): RecentlyReceivedItem {
  return {
    id: `00000000-0000-4000-8000-0000000010${String(n).padStart(2, '0')}`,
    readableId: `BKT-2026-0000${String(n).padStart(2, '0')}`,
    unitType: 'bucket',
    status: 'in_stock',
    project: {
      id: project.id,
      projectNumber: 'DEMO-2601',
      name: project.name,
      client: 'Example Client',
    },
    sample: null,
    bulkGroup: null,
    holes: [
      {
        testHoleId: '00000000-0000-4000-8000-000000000911',
        testHoleName: 'TH26-01',
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'S12',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
        customText: null,
        note: null,
      },
    ],
    location: { id: 'loc', code: 'RCV', name: 'Receiving lab' },
    receivedDate: '2026-10-20',
    receivedAt: '2026-10-20T20:32:00.000Z',
    receiver: { initials: 'JS', name: 'Jordan Smith' },
    latestPrint: null,
    ...overrides,
  };
}

const recent: RecentlyReceivedResponse = {
  items: [
    unit(19, {
      latestPrint: {
        status: 'sent',
        attempts: 1,
        printerMessage: null,
        physicallyConfirmedAt: null,
      },
    }),
    unit(18, {
      latestPrint: {
        status: 'uncertain',
        attempts: 1,
        printerMessage: null,
        physicallyConfirmedAt: null,
      },
    }),
    unit(17, {
      latestPrint: {
        status: 'sent',
        attempts: 1,
        printerMessage: null,
        physicallyConfirmedAt: '2026-10-20T21:00:00.000Z',
      },
    }),
    unit(16),
  ],
  total: 12,
  receivedThisWeek: 7,
  labelsToCheck: 2,
};

function status(overrides: Partial<SystemStatusResponse> = {}): SystemStatusResponse {
  return {
    checkedAt: '2026-10-26T20:00:00.000Z',
    version: '0.1.0',
    database: 'up',
    backup: {
      state: 'not_configured',
      message: 'Backups are not set up on this server yet.',
      lastRunAt: null,
      lastRunResult: null,
      lastRunMessage: null,
      lastSuccessAt: null,
      lastSuccessFile: null,
      lastSuccessSizeBytes: null,
      rpoHours: null,
      rtoHours: null,
      owner: null,
      alertRecipient: null,
    },
    printQueue: {
      queued: 0,
      sending: 0,
      uncertain: 1,
      failed: 0,
      oldestQueuedAt: null,
      oldestQueuedAgeSeconds: null,
    },
    printWorker: { running: true, lastPollAt: '2026-10-26T19:59:58.000Z' },
    disks: [],
    ...overrides,
  };
}

function json(statusCode: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: statusCode,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = Record<string, (url: URL) => Response>;

function renderDashboard(session: MeResponse, api: Api = {}) {
  const handlers: Api = {
    '/api/activity/recent': () => json(200, []),
    '/api/inventory/recently-received': () => json(200, recent),
    ...api,
  };
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://localhost');
    const handler = handlers[url.pathname];
    return handler ? handler(url) : json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
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
  return { router, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('receivedWhen', () => {
  const now = new Date('2026-10-27T18:00:00Z'); // 12:00 p.m. on Oct 27 in Edmonton
  it('shows the time today, "Yesterday", then the date', () => {
    expect(receivedWhen('2026-10-27', '2026-10-27T17:32:00Z', now)).toMatch(/^11:32\sa\.m\.$/);
    expect(receivedWhen('2026-10-26', '2026-10-26T22:00:00Z', now)).toBe('Yesterday');
    expect(receivedWhen('2026-10-22', '2026-10-22T22:00:00Z', now)).toBe('2026-10-22');
  });

  it('shows only the day when the receipt was entered on a later day', () => {
    // Received today per the receipt, but the confirmation time is yesterday evening in UTC terms.
    expect(receivedWhen('2026-10-27', '2026-10-26T20:00:00Z', now)).toBe('Today');
  });
});

describe('Dashboard', () => {
  it('Receive samples card links to receiving; with no drafts there is no Resume link', async () => {
    renderDashboard(me());
    const card = screen.getByRole('region', { name: 'Receive samples' });
    expect(within(card).getByRole('link', { name: 'Receive samples' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    expect(await screen.findByText('No drafts on this computer.')).toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: /Resume a draft/ })).not.toBeInTheDocument();
  });

  it('shows drafts on this computer: count, stale flag and Resume links for this person only', async () => {
    const mine = newRecord({ ...newDraft(null, '2026-10-26'), project }, me());
    const old = {
      ...newRecord(newDraft(null, '2026-09-01'), me()),
      lastSavedAt: '2026-09-01T16:00:00.000Z',
    };
    const someoneElse = newRecord(newDraft(null, '2026-10-26'), me({ id: 'someone-else' }));
    for (const record of [mine, old, someoneElse]) await indexedDbDraftStore.put(record);

    renderDashboard(me());
    const card = screen.getByRole('region', { name: 'Receive samples' });
    expect(await within(card).findByRole('link', { name: 'Resume a draft (2)' })).toHaveAttribute(
      'href',
      '/receiving-log/new',
    );
    expect(within(card).getByText('2 drafts on this computer · 1 stale')).toBeInTheDocument();

    const drafts = screen.getByRole('region', { name: 'Drafts on this computer' });
    expect(
      within(drafts).getByRole('link', {
        name: 'Resume draft DEMO-2601 · Riverbank investigation',
      }),
    ).toHaveAttribute('href', `/receiving-log/new?draft=${mine.draftId}`);
    expect(
      within(drafts).getByRole('link', { name: 'Resume draft No project chosen yet' }),
    ).toHaveAttribute('href', `/receiving-log/new?draft=${old.draftId}`);
    expect(within(drafts).getByText('Stale')).toBeInTheDocument();
    expect(within(drafts).getAllByRole('listitem')).toHaveLength(2);
  });

  it('looks up a storage unit ID and opens it', async () => {
    const user = userEvent.setup();
    const { router } = renderDashboard(me(), {
      '/api/storage-units/lookup': (url) =>
        url.searchParams.get('code') === 'bkt-2026-000014'
          ? json(200, { id: 'u14', readableId: 'BKT-2026-000014' })
          : json(404, { error: 'storage_unit_not_found' }),
    });
    const lookup = screen.getByRole('search', { name: 'Look up a storage unit' });
    const input = within(lookup).getByLabelText('Storage unit ID');
    await user.type(input, 'BKT-2026-999999{Enter}');
    expect(await within(lookup).findByRole('alert')).toHaveTextContent('No storage unit found');
    await user.clear(input);
    await user.type(input, 'bkt-2026-000014{Enter}');
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe('/sample-storage/BKT-2026-000014'),
    );
  });

  it('Recently received lists units with summaries, receiver and print status wording', async () => {
    renderDashboard(me());
    const section = screen.getByRole('region', { name: 'Recently received' });
    const table = await within(section).findByRole('table', {
      name: 'Recently received storage units',
    });
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(4);
    expect(within(rows[0]!).getByRole('link', { name: 'BKT-2026-000019' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000019',
    );
    expect(rows[0]).toHaveTextContent('DEMO-2601');
    expect(rows[0]).toHaveTextContent('TH26-01: G1–S12');
    expect(rows[0]).toHaveTextContent('Receiving lab');
    expect(rows[0]).toHaveTextContent('by JS');
    expect(rows[0]).toHaveTextContent('Sent to printer');
    expect(rows[1]).toHaveTextContent('Unknown — check the printer before reprinting');
    expect(rows[2]).toHaveTextContent('Printed (confirmed)');
    expect(rows[3]).toHaveTextContent('No label yet');
    expect(within(section).getByText('7 this week')).toBeInTheDocument();
    expect(
      within(section).getByText('Showing the 4 most recent of 12 in Sample Storage'),
    ).toBeInTheDocument();
    expect(
      within(section).getByRole('link', { name: 'See all in Sample Storage →' }),
    ).toHaveAttribute('href', '/sample-storage');
  });

  it('filters by Today and Labels to check', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderDashboard(me(), {
      '/api/inventory/recently-received': (url) =>
        url.searchParams.get('show') === 'labels'
          ? json(200, { ...recent, items: recent.items.slice(0, 2), total: 2 })
          : url.searchParams.get('show') === 'today'
            ? json(200, { ...recent, items: [], total: 0 })
            : json(200, recent),
    });
    const section = screen.getByRole('region', { name: 'Recently received' });
    const filters = within(section).getByRole('group', { name: 'Show' });
    expect(
      await within(filters).findByRole('button', { name: 'Labels to check 2' }),
    ).toBeInTheDocument();
    expect(within(filters).getByRole('button', { name: 'All' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );

    await user.click(within(filters).getByRole('button', { name: 'Labels to check 2' }));
    expect(await within(section).findByText(/Showing the 2 most recent of 2/)).toBeInTheDocument();
    expect(within(section).getAllByRole('row')).toHaveLength(3);

    await user.click(within(filters).getByRole('button', { name: 'Today' }));
    expect(await within(section).findByText('Nothing received today.')).toBeInTheDocument();
    expect(
      within(section).getByRole('link', { name: 'See all in Sample Storage →' }),
    ).toHaveAttribute(
      'href',
      expect.stringMatching(/^\/sample-storage\?receivedFrom=\d{4}-\d{2}-\d{2}&receivedTo=/),
    );
    const shows = fetchMock.mock.calls
      .map(([input]) => new URL(String(input), 'http://localhost'))
      .filter((url) => url.pathname === '/api/inventory/recently-received')
      .map((url) => url.searchParams.get('show'));
    expect(shows).toEqual(['all', 'labels', 'today']);
  });

  it('Recently received shows a retryable error', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderDashboard(me(), {
      '/api/inventory/recently-received': () => (++calls === 1 ? json(500, {}) : json(200, recent)),
    });
    const section = screen.getByRole('region', { name: 'Recently received' });
    expect(
      await within(section).findByText("Recently received couldn't load. Try again."),
    ).toBeInTheDocument();
    await user.click(within(section).getByRole('button', { name: 'Retry' }));
    expect(await within(section).findByRole('table')).toBeInTheDocument();
  });

  it('shows the label printer only to admins, from system status', async () => {
    renderDashboard(me(), { '/api/admin/system-status': () => json(200, status()) });
    await screen.findByRole('table');
    expect(screen.queryByRole('region', { name: 'Label printer' })).not.toBeInTheDocument();
    expect(
      vi.mocked(fetch).mock.calls.some(([input]) => String(input).includes('system-status')),
    ).toBe(false);
  });

  it('admins see waiting / not sure counts and the worker state', async () => {
    renderDashboard(
      me({ roles: ['admin'], permissions: ['inventory.read', 'system.status.read'] }),
      {
        '/api/admin/system-status': () =>
          json(200, status({ printWorker: { running: false, lastPollAt: null } })),
      },
    );
    const card = await screen.findByRole('region', { name: 'Label printer' });
    expect(await within(card).findByText('Stopped')).toBeInTheDocument();
    const waiting = within(card).getByText('Waiting to print').closest('div')!;
    expect(waiting).toHaveTextContent('0');
    const unsure = within(card).getByText('Not sure if printed').closest('div')!;
    expect(unsure).toHaveTextContent('1');
    expect(
      within(card).getByRole('link', { name: 'Print queue in System status' }),
    ).toHaveAttribute('href', '/settings/system-status');
  });
});
