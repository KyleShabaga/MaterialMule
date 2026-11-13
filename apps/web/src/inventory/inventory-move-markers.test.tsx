import type { InventoryItem, MeResponse, MoveRequest } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { indexedDbMoveStore, type NewMove, type QueuedMove } from '../moves/store';
import { pendingMovesByUnit, usePendingMoves } from '../moves/usePendingMoves';
import type { TableView } from '../components/app-ui';
import { StorageUnitTable } from './StorageUnitTable';

// MM-T81: Conflict tag and this device's Pending marker on Sample Storage rows. Fictional data only.

const LAB = '00000000-0000-4000-8000-0000000e1801';
const TECH = '00000000-0000-4000-8000-000000000102';
const C1 = { id: '00000000-0000-4000-8000-000000000601', code: 'WH-C1', name: 'Warehouse C1' };
const C2 = { id: '00000000-0000-4000-8000-000000000602', code: 'WH-C2', name: 'Warehouse C2' };
const RECEIVING = {
  id: '00000000-0000-4000-8000-000000000600',
  code: 'RECEIVING',
  name: 'Receiving lab',
};
const U1 = { id: '00000000-0000-4000-8000-000000000501', readableId: 'BKT-2026-000014' };
const U2 = { id: '00000000-0000-4000-8000-000000000502', readableId: 'BKT-2026-000015' };

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};

function item(unit: typeof U1, overrides: Partial<InventoryItem> = {}): InventoryItem {
  return {
    id: unit.id,
    readableId: unit.readableId,
    unitType: 'bucket',
    status: 'in_stock',
    project: PROJECT,
    holes: [],
    sample: null,
    bulkGroup: null,
    location: { id: RECEIVING.id, code: RECEIVING.code, name: RECEIVING.name },
    openConflict: false,
    receivedDate: '2026-10-23',
    ...overrides,
  };
}

function newMove(
  unit: typeof U1,
  destination: typeof C1,
  options: { account?: string; state?: QueuedMove['state'] } = {},
): NewMove {
  const clientMoveId = crypto.randomUUID();
  const request: MoveRequest = {
    clientMoveId,
    storageUnitId: unit.id,
    toLocationId: destination.id,
    baseVersion: 1,
    scannedAt: '2026-10-27T09:15:00.000-06:00',
    capturedOffline: true,
    captureContext: {
      stationId: '3b4b0c5e-2d0a-4f7e-9a51-6f0c7c0b9e02',
      accountId: options.account ?? LAB,
    },
  };
  return {
    clientMoveId,
    request,
    unit,
    base: { version: 1, location: RECEIVING },
    destination,
    account: { id: options.account ?? LAB, name: 'LAB' },
    mover: null,
    state: options.state ?? 'pending',
    attempts: 0,
    message: null,
    result: null,
  };
}

function Harness({
  accountId,
  items,
  view = 'comfortable',
}: {
  accountId: string;
  items: InventoryItem[];
  view?: TableView;
}) {
  const pendingMoves = usePendingMoves(accountId);
  return (
    <MemoryRouter>
      <StorageUnitTable items={items} pendingMoves={pendingMoves} view={view} />
    </MemoryRouter>
  );
}

const row = (id: string) => within(screen.getByRole('link', { name: id }).closest('tr')!);

describe('Sample Storage conflict and Pending markers (MM-T81)', () => {
  it('AC1: an open conflict shows a Conflict tag in words in both views', () => {
    for (const view of ['comfortable', 'compact'] as const) {
      const { unmount } = render(
        <MemoryRouter>
          <StorageUnitTable view={view} items={[item(U1, { openConflict: true }), item(U2)]} />
        </MemoryRouter>,
      );
      expect(row(U1.readableId).getByText('Conflict')).toBeVisible();
      expect(row(U1.readableId).getByText('In stock')).toBeVisible();
      expect(row(U2.readableId).queryByText('Conflict')).toBeNull();
      unmount();
    }
  });

  it('AC2: a queued move on this device shows Pending beside the saved location', async () => {
    await indexedDbMoveStore.add(newMove(U1, C1));
    render(<Harness accountId={LAB} items={[item(U1), item(U2)]} />);
    const marker = await row(U1.readableId).findByTestId('pending-move');
    expect(marker).toHaveTextContent('Pending');
    expect(marker).toHaveAttribute('title', expect.stringContaining('Warehouse C1'));
    // The saved location stays; Pending never replaces it.
    expect(row(U1.readableId).getByText(RECEIVING.name)).toBeVisible();
    expect(row(U2.readableId).queryByTestId('pending-move')).toBeNull();
  });

  it('AC3: moves of another account, or already saved, show no Pending marker', async () => {
    await indexedDbMoveStore.add(newMove(U1, C1, { account: TECH }));
    await indexedDbMoveStore.add(newMove(U2, C2, { state: 'saved' }));
    render(<Harness accountId={LAB} items={[item(U1), item(U2)]} view="compact" />);
    // Let the store read settle before asserting absence.
    await waitFor(async () => expect((await indexedDbMoveStore.list()).moves).toHaveLength(2));
    await new Promise<void>((resolve) => queueMicrotask(resolve));
    expect(screen.queryByTestId('pending-move')).toBeNull();
  });

  it('keeps the latest pending or waiting move per unit for the account', () => {
    const first = { ...newMove(U1, C1), seq: 1, createdAt: '', recordVersion: 1 } as QueuedMove;
    const second = {
      ...newMove(U1, C2, { state: 'waiting' }),
      seq: 2,
      createdAt: '',
      recordVersion: 1,
    } as QueuedMove;
    const other = {
      ...newMove(U2, C2, { account: TECH }),
      seq: 3,
      createdAt: '',
      recordVersion: 1,
    } as QueuedMove;
    const byUnit = pendingMovesByUnit([first, second, other], LAB);
    expect([...byUnit.keys()]).toEqual([U1.id]);
    expect(byUnit.get(U1.id)?.destination.code).toBe('WH-C2');
  });

  it.runIf(typeof BroadcastChannel !== 'undefined')(
    're-reads the queue when another tab announces a change',
    async () => {
      render(<Harness accountId={LAB} items={[item(U1)]} />);
      expect(screen.queryByTestId('pending-move')).toBeNull();
      await indexedDbMoveStore.add(newMove(U1, C1));
      const other = new BroadcastChannel('materialmule-moves');
      other.postMessage('changed');
      other.close();
      expect(await screen.findByTestId('pending-move')).toHaveTextContent('Pending');
    },
  );
});

describe('Sample Storage rows after an offline move settles in another tab (review fix, PR #107)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const me: MeResponse = {
    id: LAB,
    displayName: 'LAB',
    initials: null,
    accountType: 'shared_lab',
    status: 'active',
    roles: [],
    permissions: ['inventory.read'],
    sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  } as unknown as MeResponse;

  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });

  /** Tab A: inventory open at `path`; `rows` answers each inventory request in turn. */
  function openInventory(path: string, rows: () => InventoryItem[]) {
    const requests: URL[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/inventory') {
          requests.push(url);
          return json({ items: rows(), total: 30, page: 2, pageSize: 25 });
        }
        if (url.pathname === '/api/locations') return json([]);
        return new Response('{}', { status: 404 });
      }),
    );
    pickStationPerson(me);
    render(
      <SessionContext.Provider
        value={{
          session: { status: 'active', me },
          refresh: vi.fn(async () => undefined),
          signOut: vi.fn(async () => undefined),
        }}
      >
        <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
      </SessionContext.Provider>,
    );
    return requests;
  }

  /** Tab B announces a queue change on the moves channel, as useMoveQueue does. */
  const announce = () => {
    const other = new BroadcastChannel('materialmule-moves');
    other.postMessage('changed');
    other.close();
  };

  it.runIf(typeof BroadcastChannel !== 'undefined')(
    'a saved move shows its new location without a manual reload, keeping filters and page',
    async () => {
      let saved = false;
      const requests = openInventory('/sample-storage?search=BKT&page=2', () => [
        item(U1, saved ? { location: { id: C1.id, code: C1.code, name: C1.name } } : {}),
      ]);
      await screen.findByRole('link', { name: U1.readableId });
      expect(row(U1.readableId).getByText(RECEIVING.name)).toBeVisible();
      // Tab B queues the move: only the Pending marker changes, nothing is fetched again.
      const move = await indexedDbMoveStore.add(newMove(U1, C1));
      announce();
      expect(await screen.findByTestId('pending-move')).toHaveTextContent('Pending');
      expect(requests).toHaveLength(1);
      // Tab B's drain saves it.
      saved = true;
      await indexedDbMoveStore.update(move.clientMoveId, { state: 'saved' });
      announce();
      expect(await row(U1.readableId).findByText(C1.name)).toBeVisible();
      expect(screen.queryByTestId('pending-move')).toBeNull();
      expect(requests).toHaveLength(2);
      expect(requests[1]!.searchParams.get('search')).toBe('BKT');
      expect(requests[1]!.searchParams.get('page')).toBe('2');
    },
  );

  it.runIf(typeof BroadcastChannel !== 'undefined')(
    'a refused move shows its open conflict on a conflict-filtered list',
    async () => {
      let refused = false;
      const requests = openInventory('/sample-storage?conflict=open&page=2', () =>
        refused ? [item(U1, { openConflict: true })] : [item(U2, { openConflict: true })],
      );
      expect(await screen.findByRole('link', { name: U2.readableId })).toBeVisible();
      // Queued and refused between two of tab A's reads: still a settlement to show.
      const move = await indexedDbMoveStore.add(newMove(U1, C1));
      refused = true;
      await indexedDbMoveStore.update(move.clientMoveId, { state: 'conflict' });
      announce();
      await screen.findByRole('link', { name: U1.readableId });
      expect(row(U1.readableId).getByText('Conflict')).toBeVisible();
      expect(requests).toHaveLength(2);
      expect(requests[1]!.searchParams.get('conflict')).toBe('open');
      expect(requests[1]!.searchParams.get('page')).toBe('2');
    },
  );
});
