import type { MeResponse, ReceiptDetail, StorageUnitDetail } from '@materialmule/shared';
import { cleanup, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';

// STRATA-80: the round 3 Move screen and Put away, through the real routes, queue (fake
// IndexedDB) and a fake API. Fictional data only (DEMO-2601, TH26-01).

const me: MeResponse = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'storage_unit.move'],
  sessionExpiresAt: '2026-11-13T23:00:00.000Z',
};

const RECEIVING = {
  id: '00000000-0000-4000-8000-000000000600',
  code: 'RECEIVING',
  name: 'Receiving lab',
};
const C1 = { id: '00000000-0000-4000-8000-000000000601', code: 'WH-C1', name: 'Shelf C1' };
const OLD = { id: '00000000-0000-4000-8000-000000000609', code: 'WH-OLD', name: 'Old shelf' };

const location = (place: typeof C1, extra: object = {}) => ({
  ...place,
  kind: 'warehouse',
  area: null,
  active: true,
  isSystem: false,
  retiredAt: null,
  retiredReason: null,
  codeLocked: false,
  labelPrintedAt: null,
  inStockCount: 12,
  capacity: 16,
  createdAt: '2026-10-01T00:00:00.000Z',
  updatedAt: '2026-10-01T00:00:00.000Z',
  version: 1,
  ...extra,
});

function unit(readableId: string, id: string): StorageUnitDetail {
  return {
    id,
    readableId,
    unitType: 'bucket',
    status: 'in_stock',
    note: null,
    receivedDate: '2026-11-11',
    minimumRetainUntil: '2027-11-11',
    version: 1,
    project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Riverbank', client: 'Example Client' },
    sample: null,
    bulkGroup: null,
    holes: [
      {
        testHoleId: 'th1',
        testHoleName: 'TH26-01',
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'G4',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
        customText: null,
        note: null,
      },
    ],
    location: RECEIVING,
    receipt: {
      id: 'r1',
      receivedDate: '2026-11-11',
      project: {
        id: 'p1',
        projectNumber: 'DEMO-2601',
        name: 'Riverbank',
        client: 'Example Client',
      },
      receiver: { initials: 'PE', name: 'Pat Example' },
      account: { initials: 'PE', name: 'Pat Example' },
      description: null,
      quantity: 2,
      confirmedAt: '2026-11-11T17:31:00.000Z',
    },
    recordStatus: 'received',
  };
}

const ALEX = '00000000-0000-4000-8000-000000000102';
const JORDAN = '00000000-0000-4000-8000-000000000106';
const LAB: MeResponse = {
  ...me,
  id: '00000000-0000-4000-8000-0000000e1801',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
};

const UNITS: Record<string, StorageUnitDetail> = {
  'BKT-2026-000124': unit('BKT-2026-000124', '00000000-0000-4000-8000-000000000501'),
  'BKT-2026-000125': unit('BKT-2026-000125', '00000000-0000-4000-8000-000000000502'),
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi() {
  const moves: {
    toLocationId: string;
    storageUnitId: string;
    captureContext?: { moverUserId?: string };
  }[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    const method = init?.method ?? 'GET';
    if (url.pathname === '/api/locations') {
      return json(200, [location(C1), location(OLD, { active: false })]);
    }
    if (url.pathname === '/api/scan/resolve') {
      const payload = url.searchParams.get('payload') ?? '';
      const place = [C1, OLD].find((p) => payload === `LOC-${p.code}`);
      return place
        ? json(200, {
            type: 'location',
            location: { ...place, kind: 'warehouse', area: null, active: place !== OLD },
          })
        : json(200, { type: 'unknown', reason: 'location_not_found' });
    }
    if (url.pathname === '/api/moves' && method === 'POST') {
      const body = JSON.parse(String(init?.body)) as {
        clientMoveId: string;
        toLocationId: string;
        storageUnitId: string;
      };
      moves.push(body);
      return json(201, {
        outcome: 'saved',
        clientMoveId: body.clientMoveId,
        movementEventId: crypto.randomUUID(),
        appliedToLocationId: body.toLocationId,
        resultingVersion: 2,
        savedAt: '2026-11-13T17:42:00.000Z',
        replayed: false,
      });
    }
    if (url.pathname.startsWith('/api/storage-units/')) {
      const id = decodeURIComponent(url.pathname.split('/').pop()!);
      const found = UNITS[id];
      return found ? json(200, found) : json(404, { code: 'storage_unit_not_found' });
    }
    if (url.pathname === '/api/receipts/r1') {
      const receipt: ReceiptDetail = {
        id: 'r1',
        receivedDate: '2026-11-11',
        project: {
          id: 'p1',
          projectNumber: 'DEMO-2601',
          name: 'Riverbank',
          client: 'Example Client',
        },
        receiver: { userId: 'u-pe', initials: 'PE', name: 'Pat Example' },
        account: { initials: 'PE', name: 'Pat Example', sharedStation: false },
        quantity: 2,
        confirmedAt: '2026-11-11T17:31:00.000Z',
        description: null,
        units: Object.values(UNITS).map((u) => ({
          id: u.id,
          readableId: u.readableId,
          unitType: u.unitType,
          status: u.status,
          receivedDate: u.receivedDate,
          project: u.project,
          holes: u.holes,
          sample: null,
          bulkGroup: null,
          location: RECEIVING,
        })) as ReceiptDetail['units'],
      };
      return json(200, receipt);
    }
    if (url.pathname === '/api/staff/active') {
      return json(200, [
        { id: ALEX, displayName: 'Alex Tester', initials: 'AT', position: 'technician' },
        { id: JORDAN, displayName: 'Jordan Smith', initials: 'JS', position: 'technologist' },
      ]);
    }
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { moves };
}

function renderAt(path: string, who: MeResponse = me) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: who },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

async function scan(user: ReturnType<typeof userEvent.setup>, value: string) {
  const field = await screen.findByRole('textbox', { name: 'Scan or type a label' });
  await user.click(field);
  await user.type(field, `${value}{Enter}`);
}

const row = (readableId: string) =>
  screen.getAllByTestId('move-row').find((element) => element.textContent?.includes(readableId))!;

afterEach(() => {
  // Unmount first: a page still mounted could write its list back after the clear, and the next
  // test would start with it (seen on slow CI as a Put away unit already on the list).
  cleanup();
  vi.unstubAllGlobals();
  window.sessionStorage.clear();
});

describe('Move storage units (STRATA-80)', () => {
  it('takes a unit before its shelf, then saves the move with the shelf it was given', async () => {
    const { moves } = stubApi();
    const user = userEvent.setup();
    renderAt('/sample-storage/move');
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Move storage units' }),
    ).toBeInTheDocument();
    expect(screen.getByTestId('moved-by')).toHaveTextContent(
      /Moved by.*Alex Tester· recorded when you save/,
    );

    await scan(user, 'BKT-2026-000124');
    await waitFor(() => expect(row('BKT-2026-000124')).toHaveTextContent('Scan a shelf label'));
    expect(screen.getByRole('button', { name: 'Save moves' })).toBeDisabled();

    await scan(user, 'LOC-WH-C1');
    await waitFor(() => expect(row('BKT-2026-000124')).toHaveTextContent('WH-C1'));
    expect(screen.getByTestId('move-shelf-after')).toHaveTextContent(
      'Shelf after this move: 13 of 16 places',
    );
    expect(screen.getByTestId('move-announcement')).toHaveTextContent('Moving to WH-C1');

    await user.click(screen.getByRole('button', { name: 'Save 1 move' }));
    expect(await screen.findByText('All moves saved.')).toBeInTheDocument();
    expect(moves).toEqual([
      expect.objectContaining({ storageUnitId: UNITS['BKT-2026-000124']!.id, toLocationId: C1.id }),
    ]);
    expect(within(row('BKT-2026-000124')).getByText(/^Moved /)).toBeInTheDocument();
  });

  it('shows each unit once while Save stores its moves (a linked unit, then a scanned one)', async () => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/sample-storage/move?units=BKT-2026-000124');
    // The linked unit is looked up first; CI runners can take longer than the 1 s default.
    await waitFor(() => expect(row('BKT-2026-000124')).toHaveTextContent('Scan a shelf label'), {
      timeout: 5000,
    });
    await scan(user, 'LOC-WH-C1');
    await scan(user, 'BKT-2026-000125');
    await waitFor(() => expect(screen.getAllByTestId('move-row')).toHaveLength(2));

    // Every render during the save: never two rows for one unit (the row in the list and the
    // same move again under "Waiting to send" before the row knows its queue ID).
    let most = 0;
    const count = () => {
      for (const id of ['BKT-2026-000124', 'BKT-2026-000125']) {
        const rows = screen
          .queryAllByTestId('move-row')
          .filter((element) => element.textContent?.includes(id));
        most = Math.max(most, rows.length);
      }
    };
    const observer = new MutationObserver(count);
    observer.observe(document.body, { childList: true, subtree: true, characterData: true });
    await user.click(screen.getByRole('button', { name: 'Save 2 moves' }));
    await waitFor(() =>
      expect(screen.getByRole('alert', { name: '' }).textContent).toContain('All moves saved.'),
    );
    observer.disconnect();
    count();
    expect(most).toBe(1);
    expect(screen.getAllByTestId('move-row')).toHaveLength(2);
  });

  it('keeps problems on their own rows and never blocks the rest', async () => {
    const { moves } = stubApi();
    const user = userEvent.setup();
    renderAt('/sample-storage/move');
    await scan(user, 'LOC-WH-C1');
    await scan(user, 'LOC-WH-OLD');
    await scan(user, 'BKT-2026-001190');
    await scan(user, 'BKT-2026-000125');
    await scan(user, 'BKT-2026-000125');
    await waitFor(() => expect(screen.getAllByTestId('move-row')).toHaveLength(2));
    expect(screen.getByText(/This shelf is retired and can’t receive units/)).toBeInTheDocument();
    expect(row('BKT-2026-001190')).toHaveTextContent('No storage unit has this ID');
    // Still going to WH-C1: the retired shelf changed nothing.
    expect(row('BKT-2026-000125')).toHaveTextContent('WH-C1');
    expect(screen.getByTestId('move-bar')).toHaveTextContent(
      '1 unit ready to move · 2 problems won’t be saved',
    );
    // Newest scan at the top.
    expect(screen.getAllByTestId('move-row')[0]).toHaveTextContent('BKT-2026-000125');

    await user.click(screen.getByRole('button', { name: 'Save 1 move' }));
    expect(await screen.findByText('All moves saved.')).toBeInTheDocument();
    expect(moves).toHaveLength(1);
    expect(screen.getByText(/2 labels weren’t saved/)).toBeInTheDocument();
  });

  it('Put away names the receipt and lists its units until they are scanned', async () => {
    stubApi();
    const user = userEvent.setup();
    renderAt('/sample-storage/move?units=BKT-2026-000124,BKT-2026-000125&receipt=r1');
    expect(await screen.findByRole('heading', { level: 1, name: 'Put away' })).toBeInTheDocument();
    const crumbs = screen.getByRole('navigation', { name: /breadcrumb/i });
    expect(
      await within(crumbs).findByRole('link', { name: 'Receipt 2026-11-11 · Pat Example' }),
    ).toHaveAttribute('href', '/receiving-log/r1');
    await waitFor(() => expect(screen.getAllByTestId('move-waiting-row')).toHaveLength(2));
    expect(screen.getAllByTestId('move-waiting-row')[0]).toHaveTextContent('Waiting for its label');

    await scan(user, 'LOC-WH-C1');
    await scan(user, 'BKT-2026-000125');
    await waitFor(() => expect(screen.getAllByTestId('move-waiting-row')).toHaveLength(1));
    expect(screen.getByTestId('move-bar')).toHaveTextContent(
      '1 unit ready to move · 1 still to scan',
    );
    expect(screen.getByRole('button', { name: 'Save 1 move' })).toBeEnabled();
  });

  it('on a LAB station, Moved by is the person recording here; Change credits someone else', async () => {
    const { moves } = stubApi();
    pickStationPerson(LAB);
    const user = userEvent.setup();
    renderAt('/sample-storage/move?to=WH-C1', LAB);
    const movedBy = await screen.findByTestId('moved-by');
    expect(movedBy).toHaveTextContent(/Alex Tester· recording here/);

    await user.click(
      within(movedBy).getByRole('button', { name: 'Change who is moving these units' }),
    );
    await user.click(await screen.findByRole('menuitem', { name: /Jordan Smith/ }));
    expect(movedBy).toHaveTextContent(/Jordan Smith· recorded when you save/);

    await waitFor(() =>
      expect(screen.getByTestId('move-destination')).toHaveTextContent('Shelf C1'),
    );
    await scan(user, 'BKT-2026-000124');
    await user.click(await screen.findByRole('button', { name: 'Save 1 move' }));
    expect(await screen.findByText('All moves saved.')).toBeInTheDocument();
    // Attribution only: the account stays LAB; the person is sent as the mover.
    expect(moves[0]!.captureContext?.moverUserId).toBe(JORDAN);
  });
});
