import type {
  DisposalScanCheck,
  DisposalScanIntent,
  DisposalScanOutcome,
  MeResponse,
} from '@materialmule/shared';
import { act, configure, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { indexedDbScanStore } from './scan-store';

// STRATA-92 Disposal scan-out: scans are intents stored on this computer, checked online, and
// recorded only after the person confirms the exact ID list (Kyle's decision STRATA-112). Offline
// scans queue as "Not disposed yet" and are checked again on reconnect, never recorded by
// themselves. A LAB station can't scan (STRATA-111). Fictional data: DEMO-2601, TH26-01.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-lm',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'storage_unit.dispose_scan', 'disposal.approve'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const unitOf = (code: string) => ({
  storageUnitId: `id-${code}`,
  readableId: code,
  projectNumber: 'DEMO-2601',
  holes: ['TH26-01'],
  location: { code: 'WH-A-B3-S1', name: 'Warehouse A bay 3 shelf 1' },
});

/** The server's check, by code: approved unless named otherwise. */
const CHECKS: Record<string, Partial<DisposalScanCheck>> = {
  'BKT-2026-000002': {
    status: 'blocked',
    blockers: [{ code: 'on_hold', label: 'On hold: Claim review' }],
    message: 'Blocked: On hold: Claim review. It stays in stock; put it back.',
  },
  'BKT-2026-000990': {
    status: 'not_found',
    unit: null,
    message: 'No storage unit has the ID BKT-2026-000990. Check the label and scan again.',
  },
};

function checkFor(intent: DisposalScanIntent): DisposalScanCheck {
  return {
    intentId: intent.intentId,
    code: intent.code,
    status: 'approved',
    unit: unitOf(intent.code),
    blockers: [],
    message: 'Approved · will be disposed',
    recorded: null,
    ...CHECKS[intent.code],
  };
}

const disposedOutcome = (code: string, replayed = false): DisposalScanOutcome => ({
  result: 'disposed',
  storageUnitId: `id-${code}`,
  readableId: code,
  blockers: [],
  message: `${code} disposed.`,
  removedAt: '2027-10-24T16:00:00.000Z',
  removedBy: { userId: 'u-lm', initials: 'LM', name: 'Lee Manager' },
  replayed,
});

type Api = (
  url: string,
  body: { intents: DisposalScanIntent[] } | null,
) => Response | Promise<Response>;

function renderScan(user: MeResponse, api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body
      ? (JSON.parse(String(init.body)) as { intents: DisposalScanIntent[] })
      : null;
    if (url.startsWith('/api/disposal/ready')) {
      return json(200, {
        asOf: '2027-10-24',
        total: 1,
        page: 1,
        pageSize: 50,
        units: [
          {
            storageUnitId: 'id-BKT-2026-000001',
            readableId: 'BKT-2026-000001',
            unitType: 'bucket',
            project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Fictional project' },
            location: { code: 'WH-A-B3-S1', name: 'Warehouse A bay 3 shelf 1' },
            effectiveRetainUntil: '2027-10-23',
            stage: 'approved',
            reason: { code: 'retention_ended', label: 'Retention ended 2027-10-23' },
            canApprove: true,
          },
        ],
      });
    }
    return api(url, body);
  });
  vi.stubGlobal('fetch', fetchMock);
  pickStationPerson(user);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider
        router={createMemoryRouter(routes, { initialEntries: ['/disposal-retention/scan'] })}
      />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

const calls = (fetchMock: ReturnType<typeof renderScan>, path: string) =>
  fetchMock.mock.calls
    .filter(([url]) => String(url) === path)
    .map(([, init]) => JSON.parse(String(init!.body)) as { intents: DisposalScanIntent[] });

function setOnline(value: boolean) {
  vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(value);
}

async function scan(user: ReturnType<typeof userEvent.setup>, code: string) {
  const input = await screen.findByLabelText('Scan each unit as it leaves the shelf');
  await waitFor(() => expect(input).toBeEnabled());
  await user.type(input, `${code}{Enter}`);
}

const rows = () => screen.findByRole('list', { name: 'Scanned units, newest first' });

// IndexedDB writes and the server checks are async; leave room when many test files run at once.
configure({ asyncUtilTimeout: 5000 });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Disposal scan-out (STRATA-92)', () => {
  it('flags units that are not approved, then records only the approved ones after the exact-ID confirmation', async () => {
    setOnline(true);
    const user = userEvent.setup();
    const fetchMock = renderScan(me(), (url, body) => {
      if (url === '/api/disposal/scan/check') {
        return json(200, { asOf: '2027-10-24', results: body!.intents.map(checkFor) });
      }
      if (url === '/api/disposal/scan/record') {
        return json(200, {
          results: body!.intents.map((intent) => ({
            intentId: intent.intentId,
            code: intent.code,
            unit: unitOf(intent.code),
            outcome: disposedOutcome(intent.code),
          })),
        });
      }
      return json(200, { open: 0 });
    });
    expect(await screen.findByRole('heading', { level: 1, name: 'Disposal scan' })).toBeVisible();
    await scan(user, 'bkt-2026-000001');
    await scan(user, 'BKT-2026-000002');
    await scan(user, 'BKT-2026-000990');
    const list = await rows();
    const approvedRow = await within(list).findByRole('listitem', { name: 'BKT-2026-000001' });
    await waitFor(() => expect(approvedRow).toHaveTextContent('Approved · will be disposed'));
    expect(approvedRow).toHaveTextContent('DEMO-2601 · TH26-01 · from WH-A-B3-S1');
    await waitFor(() =>
      expect(within(list).getByRole('listitem', { name: 'BKT-2026-000002' })).toHaveTextContent(
        'On hold: Claim review',
      ),
    );
    await waitFor(() =>
      expect(within(list).getByRole('listitem', { name: 'BKT-2026-000990' })).toHaveTextContent(
        'No storage unit has the ID BKT-2026-000990',
      ),
    );
    // Each scan is an intent with its own ID, sent as the signed-in account; nothing recorded yet.
    const sent = calls(fetchMock, '/api/disposal/scan/check').flatMap((c) => c.intents);
    expect(sent.map((i) => i.code)).toEqual(
      expect.arrayContaining(['BKT-2026-000001', 'BKT-2026-000002', 'BKT-2026-000990']),
    );
    expect(new Set(sent.map((i) => i.intentId)).size).toBe(3);
    expect(sent.every((i) => i.scannedByUserId === 'u-lm')).toBe(true);
    expect(calls(fetchMock, '/api/disposal/scan/record')).toEqual([]);

    await user.click(screen.getByRole('button', { name: 'Record disposal of 1 unit' }));
    const dialog = await screen.findByRole('alertdialog', {
      name: 'Record disposal of 1 storage unit?',
    });
    expect(dialog).toHaveTextContent('This can’t be undone.');
    expect(dialog).toHaveTextContent('2 flagged scans aren’t included and stay in stock.');
    const listed = within(dialog).getByRole('region', { name: '1 storage unit' });
    expect(listed).toHaveTextContent('BKT-2026-000001');
    expect(listed).not.toHaveTextContent('BKT-2026-000002');
    await user.click(within(dialog).getByRole('button', { name: 'Record disposal of 1 unit' }));

    expect(await screen.findByRole('heading', { name: '1 storage unit disposed' })).toBeVisible();
    const recorded = calls(fetchMock, '/api/disposal/scan/record');
    expect(recorded).toHaveLength(1);
    expect(recorded[0]!.intents.map((i) => i.code)).toEqual(['BKT-2026-000001']);
    expect(
      within(screen.getByRole('list', { name: 'Disposed storage units' })).getByText('Disposed'),
    ).toBeVisible();
    expect(screen.getByText(/Put the 2 flagged units back on their shelves/)).toBeVisible();
    // Disposal is never undone.
    expect(screen.queryByRole('button', { name: /undo/i })).toBeNull();
  });

  it('a repeated scan is counted once', async () => {
    setOnline(true);
    const user = userEvent.setup();
    const fetchMock = renderScan(me(), (url, body) =>
      url === '/api/disposal/scan/check'
        ? json(200, { asOf: '2027-10-24', results: body!.intents.map(checkFor) })
        : json(200, { open: 0 }),
    );
    await scan(user, 'BKT-2026-000001');
    await within(await rows()).findByRole('listitem', { name: 'BKT-2026-000001' });
    await scan(user, 'BKT-2026-000001');
    expect(await screen.findByText('Already scanned. Counted once.')).toBeVisible();
    const sent = calls(fetchMock, '/api/disposal/scan/check').flatMap((c) => c.intents);
    expect(new Set(sent.map((i) => i.intentId)).size).toBe(1);
  });

  it('Remove takes a checked scan off the list, and scanning it again checks it afresh', async () => {
    setOnline(true);
    const user = userEvent.setup();
    const fetchMock = renderScan(me(), (url, body) =>
      url === '/api/disposal/scan/check'
        ? json(200, { asOf: '2027-10-24', results: body!.intents.map(checkFor) })
        : json(200, { open: 0 }),
    );
    await scan(user, 'BKT-2026-000001');
    const row = await within(await rows()).findByRole('listitem', { name: 'BKT-2026-000001' });
    await waitFor(() =>
      expect(calls(fetchMock, '/api/disposal/scan/check').length).toBeGreaterThan(0),
    );
    await user.click(within(row).getByRole('button', { name: 'Remove scan of BKT-2026-000001' }));
    await waitFor(() =>
      expect(screen.queryByRole('listitem', { name: 'BKT-2026-000001' })).toBeNull(),
    );
    await scan(user, 'BKT-2026-000001');
    await within(await rows()).findByRole('listitem', { name: 'BKT-2026-000001' });
    expect(screen.queryByText('Already scanned. Counted once.')).toBeNull();
  }, 15_000);

  it('offline, scans queue as intents and nothing is sent or disposed; on reconnect they are checked, never recorded without the confirmation', async () => {
    setOnline(false);
    const user = userEvent.setup();
    const fetchMock = renderScan(me(), (url, body) =>
      url === '/api/disposal/scan/check'
        ? json(200, { asOf: '2027-10-24', results: body!.intents.map(checkFor) })
        : json(200, { open: 0 }),
    );
    expect(await screen.findByText('This computer is offline')).toBeVisible();
    await scan(user, 'BKT-2026-000001');
    const row = await within(await rows()).findByRole('listitem', { name: 'BKT-2026-000001' });
    expect(row).toHaveTextContent(/Not disposed yet/);
    expect(row).toHaveTextContent(/needs online check/);
    expect(row).not.toHaveTextContent('Disposed');
    expect(screen.getByRole('button', { name: 'Record disposal when back online' })).toBeDisabled();
    // Stored durably on this computer, under this account, with its own intent ID.
    const stored = await indexedDbScanStore.list();
    expect(stored.scans).toHaveLength(1);
    expect(stored.scans[0]).toMatchObject({
      code: 'BKT-2026-000001',
      state: 'queued',
      account: { id: 'u-lm' },
    });
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/disposal/scan/')),
    ).toBe(false);

    setOnline(true);
    act(() => {
      window.dispatchEvent(new Event('online'));
    });
    await waitFor(() => expect(row).toHaveTextContent('Approved · will be disposed'));
    expect(calls(fetchMock, '/api/disposal/scan/check')).toHaveLength(1);
    // Rechecked, but recording waits for the person.
    expect(calls(fetchMock, '/api/disposal/scan/record')).toEqual([]);
    expect(screen.getByRole('button', { name: 'Record disposal of 1 unit' })).toBeEnabled();
  });

  it('an unanswered recording is never shown as disposed; checking again reconciles it without recording twice', async () => {
    setOnline(true);
    const user = userEvent.setup();
    let recordedAlready = false;
    const fetchMock = renderScan(me(), (url, body) => {
      if (url === '/api/disposal/scan/check') {
        return json(200, {
          asOf: '2027-10-24',
          results: body!.intents.map((intent) =>
            recordedAlready
              ? {
                  ...checkFor(intent),
                  status: 'recorded',
                  message: `${intent.code} disposed.`,
                  recorded: disposedOutcome(intent.code, true),
                }
              : checkFor(intent),
          ),
        });
      }
      if (url === '/api/disposal/scan/record') {
        // It committed, but the answer was lost.
        recordedAlready = true;
        return json(503, {});
      }
      return json(200, { open: 0 });
    });
    await scan(user, 'BKT-2026-000001');
    const row = await within(await rows()).findByRole('listitem', { name: 'BKT-2026-000001' });
    await waitFor(() => expect(row).toHaveTextContent('Approved · will be disposed'));
    await user.click(screen.getByRole('button', { name: 'Record disposal of 1 unit' }));
    const dialog = await screen.findByRole('alertdialog');
    await user.click(within(dialog).getByRole('button', { name: 'Record disposal of 1 unit' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/didn’t answer/);
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    expect(row).toHaveTextContent('Not disposed until Material Mule confirms it');
    expect(within(row).queryByRole('button', { name: /Remove scan/ })).toBeNull();
    expect(screen.queryByRole('heading', { name: /disposed$/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Check again' }));
    await waitFor(() => expect(row).toHaveTextContent('Disposed'));
    expect(calls(fetchMock, '/api/disposal/scan/record')).toHaveLength(1);
  });

  it('a LAB station is told disposal scans need a personal sign-in and can scan nothing', async () => {
    setOnline(true);
    const fetchMock = renderScan(
      me({ accountType: 'shared_lab', roles: [], permissions: ['inventory.read'] }),
      () => json(403, { code: 'forbidden' }),
    );
    expect(await screen.findByText('Disposal scans need a personal sign-in')).toBeVisible();
    expect(screen.getByLabelText('Scan each unit as it leaves the shelf')).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Record disposal' })).toBeDisabled();
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/disposal/scan/')),
    ).toBe(false);
  });
});
