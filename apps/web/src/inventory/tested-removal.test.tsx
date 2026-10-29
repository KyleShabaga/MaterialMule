import type {
  InventoryPage,
  MeResponse,
  StorageUnitDetail,
  StorageUnitTesting,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-T36 removal after testing on the storage unit page and in Sample Storage: a tested Shelby
// tube's destroyed contents, the personal-only confirmation, and "Disposed after testing".
// Fictional data only (DEMO-2601, TH26-21, LP-0001).

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const SHELF = { id: 'loc-s', code: 'A-01', name: 'Rack A shelf 1' };
const REQUEST_ID = '00000000-0000-4000-8000-000000000901';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'storage_unit.correct', 'storage_unit.tested_removal'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const EVIDENCE: StorageUnitTesting['evidence'][number] = {
  testRequestId: REQUEST_ID,
  programId: 'p1',
  programNumber: 'LP-0001',
  testCode: 'DEMO-UCS',
  requestStatus: 'completed',
  completionEventId: 'e1',
  completedAt: '2026-10-24T17:00:00.000Z',
  completedBy: {
    account: { userId: 'lab', accountType: 'shared_lab', initials: null, name: 'LAB' },
    person: { userId: 'js', initials: 'JS', name: 'Jordan Smith' },
  },
  sameSourceConfirmation: null,
};

const TESTED: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000531',
  readableId: 'ST-2026-000004',
  unitType: 'shelby_tube',
  status: 'in_stock',
  note: null,
  receivedDate: '2026-10-23',
  minimumRetainUntil: '2027-10-23',
  version: 3,
  project: PROJECT,
  holes: [],
  sample: {
    source: { type: 'test_hole', testHoleId: 'th21', testHoleName: 'TH26-21' },
    sampleReference: 'T5',
    depthFrom: 10,
    depthTo: 12,
    depthUnit: 'ft',
  },
  bulkGroup: null,
  location: SHELF,
  locationConflict: null,
  testing: {
    reason: 'tested_shelby',
    contentsDestroyed: true,
    evidence: [EVIDENCE],
    removal: null,
    blocker: null,
  },
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

const REMOVAL = {
  id: 'rm1',
  reason: 'tested_shelby' as const,
  testRequestId: REQUEST_ID,
  programNumber: 'LP-0001',
  testCode: 'DEMO-UCS',
  previousStatus: 'in_stock' as const,
  location: SHELF,
  removedBy: { userId: 'u1', initials: 'AT', name: 'Alex Tester' },
  removedAt: '2026-10-25T17:00:00.000Z',
};

const REMOVED: StorageUnitDetail = {
  ...TESTED,
  status: 'disposed',
  version: 4,
  testing: { ...TESTED.testing!, removal: REMOVAL, blocker: 'already_removed' },
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: URL, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/locations') return json(200, []);
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    if (url.pathname.endsWith('/history')) {
      return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
    }
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
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('MM-T36 removal after testing', () => {
  it('a tested tube shows destroyed contents and no retention, and stays in stock until removal is confirmed', async () => {
    const user = userEvent.setup();
    const posts: unknown[] = [];
    let current = TESTED;
    stubApi((url, init) => {
      if (url.pathname === `/api/storage-units/${TESTED.readableId}`) return json(200, current);
      if (url.pathname === `/api/storage-units/${TESTED.id}/tested-removal`) {
        posts.push(JSON.parse(String(init?.body)));
        current = REMOVED;
        return json(201, {
          storageUnitId: TESTED.id,
          readableId: TESTED.readableId,
          status: 'disposed',
          version: 4,
          removal: REMOVAL,
          replayed: false,
        });
      }
      return undefined;
    });
    renderAt(`/sample-storage/${TESTED.readableId}`);
    const section = await screen.findByRole('region', { name: 'Testing and removal' });
    expect(within(section).getByText('Disposed after testing')).toBeInTheDocument();
    expect(section).toHaveTextContent('Can’t be tested again');
    expect(section).toHaveTextContent('LAB for JS · Jordan Smith');
    expect(screen.getByText('In stock')).toBeInTheDocument();
    const retention = screen.getByRole('region', { name: 'Location and retention' });
    expect(retention).toHaveTextContent('Not applicable — tested Shelby tube');
    expect(retention).not.toHaveTextContent('2027-10-23');

    // The confirmation is explicit: without it nothing is sent.
    const confirm = within(section).getByRole('button', { name: 'Confirm removal after testing' });
    await user.click(confirm);
    expect(within(section).getByRole('alert')).toHaveTextContent('physically left the lab');
    expect(posts).toEqual([]);

    await user.click(within(section).getByLabelText(/has physically left the lab/));
    await user.click(confirm);
    expect(
      await screen.findByText('ST-2026-000004 recorded as disposed after testing.'),
    ).toBeInTheDocument();
    expect(posts).toEqual([
      {
        testRequestId: REQUEST_ID,
        confirmPhysicalRemoval: true,
        version: 3,
        idempotencyKey: expect.any(String),
      },
    ]);
    const after = await screen.findByRole('region', { name: 'Testing and removal' });
    expect(await within(after).findByText(/last location Rack A shelf 1/)).toBeInTheDocument();
    expect(
      within(after).queryByRole('button', { name: 'Confirm removal after testing' }),
    ).toBeNull();
    expect(screen.getAllByText('Disposed after testing').length).toBeGreaterThan(0);
  });

  it('LAB sees the evidence but never the removal action', async () => {
    stubApi((url) =>
      url.pathname === `/api/storage-units/${TESTED.readableId}` ? json(200, TESTED) : undefined,
    );
    renderAt(
      `/sample-storage/${TESTED.readableId}`,
      me({ accountType: 'shared_lab', permissions: ['inventory.read', 'test.progress'] }),
    );
    const section = await screen.findByRole('region', { name: 'Testing and removal' });
    expect(within(section).queryByRole('button', { name: /Confirm removal/ })).toBeNull();
    expect(section).toHaveTextContent('needs a personal account');
  });

  it('an untested sibling tube explains that another unit’s test does not count', async () => {
    const sibling: StorageUnitDetail = {
      ...TESTED,
      readableId: 'ST-2026-000005',
      testing: {
        reason: 'tested_shelby',
        contentsDestroyed: false,
        evidence: [],
        removal: null,
        blocker: 'no_tested_evidence',
      },
    };
    stubApi((url) =>
      url.pathname === `/api/storage-units/${sibling.readableId}` ? json(200, sibling) : undefined,
    );
    renderAt(`/sample-storage/${sibling.readableId}`);
    const section = await screen.findByRole('region', { name: 'Testing and removal' });
    expect(within(section).getByText('Available for testing')).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: /Confirm removal/ })).toBeNull();
    expect(section).toHaveTextContent('another unit doesn’t count');
    expect(screen.getByRole('region', { name: 'Location and retention' })).toHaveTextContent(
      '2027-10-23',
    );
  });

  it('Sample Storage marks removed units "Disposed after testing" and tested tubes still on the shelf', async () => {
    const base = {
      project: PROJECT,
      holes: [],
      sample: null,
      bulkGroup: null,
      location: SHELF,
      receivedDate: '2026-10-23',
      unitType: 'shelby_tube' as const,
    };
    const listing: InventoryPage = {
      items: [
        {
          ...base,
          id: 'a',
          readableId: 'ST-2026-000004',
          status: 'disposed',
          testedRemovalReason: 'tested_shelby',
          contentsDestroyed: true,
        },
        {
          ...base,
          id: 'b',
          readableId: 'ST-2026-000006',
          status: 'in_stock',
          testedRemovalReason: null,
          contentsDestroyed: true,
        },
      ],
      total: 2,
      page: 1,
      pageSize: 25,
    };
    stubApi((url) => (url.pathname === '/api/inventory' ? json(200, listing) : undefined));
    renderAt('/sample-storage?status=all');
    expect(await screen.findByText('2 storage units')).toBeInTheDocument();
    const [, removed, tested] = screen.getAllByRole('row');
    expect(within(removed!).getByText('Disposed after testing')).toBeInTheDocument();
    expect(within(removed!).queryByText('Tested')).toBeNull();
    expect(within(tested!).getByText('In stock')).toBeInTheDocument();
    expect(within(tested!).getByText('Tested')).toHaveAttribute(
      'title',
      'Contents: Disposed after testing',
    );
  });
});
