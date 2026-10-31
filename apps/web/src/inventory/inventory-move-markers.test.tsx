import type { InventoryItem, MoveRequest } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { indexedDbMoveStore, type NewMove, type QueuedMove } from '../moves/store';
import { pendingMovesByUnit, usePendingMoves } from '../moves/usePendingMoves';
import { StorageUnitTable, type StorageUnitTableView } from './StorageUnitTable';

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
  view = 'standard',
}: {
  accountId: string;
  items: InventoryItem[];
  view?: StorageUnitTableView;
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
    for (const view of ['standard', 'compact'] as const) {
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
