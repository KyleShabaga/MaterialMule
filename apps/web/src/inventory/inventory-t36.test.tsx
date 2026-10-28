import type {
  BulkGroupSummary,
  InventoryItem,
  InventoryPage,
  MeResponse,
  SampleIdentity,
  StorageUnitDetail,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-T36 in Sample Storage: Shelby tube and bulk soil bucket rows in the Standard and Compact
// views, and a bulk bucket's detail with its sibling buckets and the personal-only corrections.
// Fictional data only (DEMO-2601, TH26-21, Embankment Location 03).

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const RECEIVING = { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' };
const SHELF = { id: 'loc-s', code: 'A-01', name: 'Rack A shelf 1' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'storage_unit.correct'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const B1: SampleIdentity = {
  source: { type: 'test_hole', testHoleId: 'th21', testHoleName: 'TH26-21' },
  sampleReference: 'B1',
  depthFrom: 1.5,
  depthTo: 2,
  depthUnit: 'm',
};
const TUBE: SampleIdentity = {
  source: { type: 'standalone_location', locationReference: 'Embankment Location 03' },
  sampleReference: 'T5',
  depthFrom: 10,
  depthTo: 12,
  depthUnit: 'ft',
};

function item(readableId: string, overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: `id-${readableId}`,
    readableId,
    unitType: 'bucket',
    status: 'in_stock',
    project: PROJECT,
    holes: [],
    sample: null,
    bulkGroup: null,
    location: RECEIVING,
    receivedDate: '2026-10-23',
    ...overrides,
  };
}

const ROWS = [
  item('BKT-2026-000021', {
    unitType: 'bulk_container',
    sample: B1,
    bulkGroup: { groupId: 'g1', memberNumber: 1, memberCount: 2 },
  }),
  item('ST-2026-000004', { unitType: 'shelby_tube', sample: TUBE, location: SHELF }),
];

const page = (items: InventoryItem[]): InventoryPage => ({
  items,
  total: items.length,
  page: 1,
  pageSize: 25,
});

const DETAIL: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000521',
  readableId: 'BKT-2026-000021',
  unitType: 'bulk_container',
  status: 'in_stock',
  note: null,
  receivedDate: '2026-10-23',
  minimumRetainUntil: '2027-10-23',
  version: 2,
  project: PROJECT,
  holes: [],
  sample: B1,
  bulkGroup: {
    groupId: '00000000-0000-4000-8000-000000000601',
    memberNumber: 1,
    memberCount: 2,
    description: 'Clayey sand',
    version: 1,
    members: [
      {
        id: '00000000-0000-4000-8000-000000000521',
        readableId: 'BKT-2026-000021',
        status: 'in_stock',
        receivedDate: '2026-10-23',
        location: RECEIVING,
      },
      {
        id: '00000000-0000-4000-8000-000000000522',
        readableId: 'BKT-2026-000022',
        status: 'in_stock',
        receivedDate: '2026-10-23',
        location: SHELF,
      },
    ],
  },
  location: RECEIVING,
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-23',
    project: PROJECT,
    receiver: { initials: 'AT', name: 'Alex Tester' },
    account: { initials: null, name: 'LAB' },
    description: null,
    quantity: 2,
    confirmedAt: '2026-10-23T16:00:00.000Z',
  },
};

const OTHER_GROUP: BulkGroupSummary = {
  id: '00000000-0000-4000-8000-000000000602',
  projectId: PROJECT.id,
  identity: {
    source: { type: 'standalone_location', locationReference: 'Stockpile 2' },
    sampleReference: 'B1',
    depthFrom: 0.5,
    depthTo: null,
    depthUnit: 'm',
  },
  description: null,
  memberCount: 1,
  version: 1,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: URL, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/locations') return json(200, []);
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    return handler(url, init) ?? json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderAt(path: string, user = me()) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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
  return router;
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.removeItem('materialmule.sampleStorage.tableView');
});

describe('MM-T36 Sample Storage', () => {
  it('Standard view shows the tube source and the bulk sample with its bucket n of N', async () => {
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, page(ROWS)) : undefined));
    renderAt('/sample-storage');
    expect(await screen.findByText('2 storage units')).toBeInTheDocument();
    const [, bulkRow, tubeRow] = screen.getAllByRole('row');
    expect(within(bulkRow!).getByText('Bulk soil sample')).toHaveClass('type-tag');
    expect(within(bulkRow!).getByText('TH26-21: B1 at 1.5–2 m')).toBeInTheDocument();
    expect(within(bulkRow!).getByText('Bulk sample · B1 · bucket 1 of 2')).toHaveClass('badge');
    // The storage unit ID stays the BKT- ID; B1 is never shown as the unit's ID.
    expect(within(bulkRow!).getByRole('link', { name: 'BKT-2026-000021' })).toBeInTheDocument();
    expect(within(tubeRow!).getByText('Shelby tube')).toHaveClass('type-tag');
    expect(
      within(tubeRow!).getByText('Embankment Location 03: T5 at 10–12 ft'),
    ).toBeInTheDocument();
    expect(within(tubeRow!).getByText('Rack A shelf 1')).toBeInTheDocument();
  });

  it('Compact view keeps each record on one line with the full text in its title', async () => {
    window.localStorage.setItem('materialmule.sampleStorage.tableView', 'compact');
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, page(ROWS)) : undefined));
    renderAt('/sample-storage');
    expect(await screen.findByText('2 storage units')).toBeInTheDocument();
    expect(document.querySelector('.inventory-table-compact')).not.toBeNull();
    const table = screen.getByRole('table');
    const bulk = within(table).getByTitle('TH26-21: B1 at 1.5–2 m · bucket 1 of 2');
    expect(bulk).toHaveClass('hole-line');
    expect(bulk.tagName).toBe('SPAN');
    expect(within(table).getByTitle('Embankment Location 03: T5 at 10–12 ft')).toHaveClass(
      'hole-line',
    );
    // One line per record: no chip lists in compact rows.
    expect(table.querySelector('.hole-list')).toBeNull();
  });

  it('a bulk bucket lists its sibling buckets with their own IDs and locations', async () => {
    stubApi((url) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname.endsWith('/history')) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      return undefined;
    });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const section = await screen.findByRole('region', { name: /Bulk sample/ });
    expect(within(section).getByText('Bulk sample · B1 · bucket 1 of 2')).toBeInTheDocument();
    expect(within(section).getByText('TH26-21: B1 at 1.5–2 m')).toBeInTheDocument();
    const buckets = within(section).getByRole('list', { name: 'Buckets of this bulk sample' });
    expect(within(buckets).getByText('BKT-2026-000021 (this bucket)')).toBeInTheDocument();
    expect(within(buckets).getByRole('link', { name: 'BKT-2026-000022' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000022',
    );
    expect(buckets).toHaveTextContent('Rack A shelf 1');
    // Summaries show the sampling source, not a test-hole list.
    const summaries = screen.getByRole('region', { name: 'Summaries' });
    expect(within(summaries).getByText('Sampling source')).toBeInTheDocument();
    expect(within(summaries).queryByText('Test holes')).toBeNull();
  });

  it('LAB (no storage_unit.correct) sees the bulk sample but no correction actions (AC6 UI)', async () => {
    stubApi((url) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname.endsWith('/history')) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      return undefined;
    });
    renderAt(
      `/sample-storage/${DETAIL.readableId}`,
      me({ accountType: 'shared_lab', permissions: ['inventory.read', 'label.print'] }),
    );
    const section = await screen.findByRole('region', { name: /Bulk sample/ });
    expect(within(section).queryByRole('button', { name: 'Change bulk sample' })).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Correct bulk sample' })).toBeNull();
  });

  it('moves this bucket to another bulk sample with a reason', async () => {
    const user = userEvent.setup();
    const patches: unknown[] = [];
    stubApi((url, init) => {
      if (url.pathname === `/api/storage-units/${DETAIL.readableId}`) return json(200, DETAIL);
      if (url.pathname.endsWith('/history')) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url.pathname === `/api/projects/${PROJECT.id}/bulk-groups`) {
        return json(200, [
          {
            id: DETAIL.bulkGroup!.groupId,
            projectId: PROJECT.id,
            identity: B1,
            description: null,
            memberCount: 2,
            version: 1,
          },
          OTHER_GROUP,
        ]);
      }
      if (url.pathname === `/api/storage-units/${DETAIL.id}/bulk-group`) {
        patches.push(JSON.parse(String(init?.body)));
        return json(200, {
          ...DETAIL,
          version: 3,
          sample: OTHER_GROUP.identity,
          bulkGroup: {
            groupId: OTHER_GROUP.id,
            memberNumber: 2,
            memberCount: 2,
            description: null,
            version: 1,
            members: [DETAIL.bulkGroup!.members[1]!, DETAIL.bulkGroup!.members[0]!],
          },
        });
      }
      return undefined;
    });
    renderAt(`/sample-storage/${DETAIL.readableId}`);
    const section = await screen.findByRole('region', { name: /Bulk sample/ });
    await user.click(within(section).getByRole('button', { name: 'Change bulk sample' }));
    const target = within(section).getByLabelText('Move to');
    // The current group isn't offered; the other B1 is told apart by its source and depth.
    await within(section).findByRole('option', {
      name: 'Stockpile 2 · B1 · 0.5 m — 1 bucket so far',
    });
    expect(within(target).queryByRole('option', { name: /TH26-21/ })).toBeNull();
    await user.selectOptions(target, OTHER_GROUP.id);
    await user.type(within(section).getByLabelText('Reason'), 'Wrong pail chosen at receipt');
    await user.click(within(section).getByRole('button', { name: 'Save change' }));
    expect(await screen.findByText('Bulk sample changed.')).toBeInTheDocument();
    expect(patches).toEqual([
      { version: 2, reason: 'Wrong pail chosen at receipt', groupId: OTHER_GROUP.id },
    ]);
    expect(screen.getByText('Bulk sample · B1 · bucket 2 of 2')).toBeInTheDocument();
  });
});
