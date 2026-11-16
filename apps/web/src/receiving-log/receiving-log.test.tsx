import type {
  MeResponse,
  ReceiptDetail,
  ReceiptDraftOwnership,
  ReceiptHistoryPage,
  ReceiptLogItem,
  ReceiptLogPage,
} from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EMPTY_TABLE_QUERY } from '@/components/strata/table-query';
import { newDraft } from '../receiving/draft';
import { newRecord, type StoredDraft } from '../receiving/drafts/record';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import {
  normalizeFilters,
  projectFilter,
  receiptLogQueryFor,
  receiptLogSearchParams,
  receiverFilter,
} from './url-state';

// Receiving log and receipt page (MM-T51, STRATA-78) and draft deletion (STRATA-108). Fictional
// data only: DEMO-2601 / DEMO-2602, TH26-01, Alex Tester, Jordan Smith, Pat Example.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const OTHER_PROJECT = {
  ...PROJECT,
  id: '00000000-0000-4000-8000-000000000202',
  projectNumber: 'DEMO-2602',
};
const ME_ID = '00000000-0000-4000-8000-000000000101';
const JORDAN = '00000000-0000-4000-8000-000000000301';
const PAT = '00000000-0000-4000-8000-000000000302';
const RECEIPT_ID = '00000000-0000-4000-8000-000000000601';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: ME_ID,
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'receipt.draft'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

function receipt(id: string, overrides: Partial<ReceiptLogItem> = {}): ReceiptLogItem {
  return {
    id,
    receivedDate: '2026-01-15',
    project: PROJECT,
    receiver: { userId: JORDAN, initials: 'JS', name: 'Jordan Smith' },
    account: { initials: null, name: 'LAB', sharedStation: true },
    quantity: 2,
    confirmedAt: '2026-01-15T21:05:00.000Z',
    status: 'confirmed',
    unitIds: ['BKT-2026-000014', 'BKT-2026-000015'],
    ...overrides,
  };
}

const page = (items: ReceiptLogItem[], total = items.length, pageNumber = 1): ReceiptLogPage => ({
  items,
  total,
  page: pageNumber,
  pageSize: 25,
});

const holes = [
  {
    testHoleId: 'th1',
    testHoleName: 'TH26-01',
    type: 'sample_range' as const,
    sampleFrom: 'G1',
    sampleTo: 'S12',
    depthFrom: null,
    depthTo: null,
    depthUnit: null,
    customText: null,
    note: null,
  },
];
const location = { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' };

const DETAIL: ReceiptDetail = {
  ...receipt(RECEIPT_ID, { status: 'corrected' }),
  description: 'Two buckets from TH26-01',
  lastCorrection: { at: '2026-01-20T17:00:00.000Z', by: 'Pat Example' },
  units: [
    {
      id: 'su-1',
      readableId: 'BKT-2026-000014',
      unitType: 'bucket',
      status: 'in_stock',
      receivedDate: '2026-01-17',
      project: OTHER_PROJECT,
      sample: null,
      bulkGroup: null,
      holes,
      location,
    },
    {
      id: 'su-2',
      readableId: 'BKT-2026-000015',
      unitType: 'bucket',
      status: 'disposed',
      receivedDate: '2026-01-15',
      project: PROJECT,
      sample: null,
      bulkGroup: null,
      holes,
      location,
    },
  ],
};

const HISTORY: ReceiptHistoryPage = {
  items: [
    {
      id: 'e1',
      occurredAt: '2026-01-20T17:00:00.000Z',
      action: 'storage_unit.corrected',
      actor: { initials: 'PE', name: 'Pat Example', accountType: 'personal' },
      receiver: null,
      reason: 'Tube label read DEMO-2602',
      before: null,
      after: null,
      readableId: 'BKT-2026-000014',
    },
  ],
  total: 1,
  page: 1,
  pageSize: 20,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: URL, init?: RequestInit) => Response | Promise<Response> | undefined;

function stubApi(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    return (await handler(url, init)) ?? json(404, { code: 'not_found' });
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

const logCalls = (fetchMock: ReturnType<typeof stubApi>) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/receipts');

function ownershipOf(draftId: string, overrides: Partial<ReceiptDraftOwnership> = {}) {
  return {
    draftId,
    registered: true,
    starter: { userId: ME_ID, initials: 'AT', name: 'Alex Tester' },
    startedOnStation: false,
    createdAt: '2026-01-15T16:00:00.000Z',
    deletedAt: null,
    canDelete: true,
    reason: 'starter',
    ...overrides,
  } satisfies ReceiptDraftOwnership;
}

/** A stored personal draft for DEMO-2601, registered already so nothing re-registers it. */
async function storedDraft(accountId = ME_ID, overrides: Partial<StoredDraft> = {}) {
  const record: StoredDraft = {
    ...newRecord(
      { ...newDraft(null, '2026-01-15'), project: { ...PROJECT, leadProjectEngineer: null } },
      { id: accountId, accountType: 'personal', displayName: 'Alex Tester', initials: 'AT' },
    ),
    registeredAt: '2026-01-15T16:00:01.000Z',
    ...overrides,
  };
  await indexedDbDraftStore.put(record);
  return record;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('receiving log URL state (STRATA-78)', () => {
  it('turns the table tools into the server query, leaving defaults out', () => {
    const { query } = receiptLogQueryFor(
      {
        ...EMPTY_TABLE_QUERY,
        search: ' riverbank ',
        filters: [projectFilter(PROJECT.id), receiverFilter(JORDAN), 'status:corrected'],
        sort: { key: 'units', dir: 'desc' },
      },
      new URLSearchParams('page=2'),
    );
    expect(Object.fromEntries(receiptLogSearchParams(query))).toEqual({
      search: 'riverbank',
      projectId: PROJECT.id,
      receiverUserId: JORDAN,
      status: 'corrected',
      sort: 'units',
      dir: 'desc',
      page: '2',
    });
    // Both statuses on is every receipt.
    const both = receiptLogQueryFor(
      { ...EMPTY_TABLE_QUERY, filters: ['status:confirmed', 'status:corrected'] },
      new URLSearchParams(),
    );
    expect(both.query.status).toBeUndefined();
  });

  it('keeps one project and one person; picking another replaces it', () => {
    expect(
      normalizeFilters([
        projectFilter(PROJECT.id),
        'status:confirmed',
        projectFilter(OTHER_PROJECT.id),
      ]),
    ).toEqual(['status:confirmed', projectFilter(OTHER_PROJECT.id)]);
  });

  it('leaves out invalid values from a hand-edited link and says so', () => {
    const { query, ignored } = receiptLogQueryFor(
      EMPTY_TABLE_QUERY,
      new URLSearchParams('receivedFrom=yesterday&page=2'),
    );
    expect(ignored).toBe(true);
    expect(query.receivedFrom).toBeUndefined();
    expect(query.page).toBe(2);
  });
});

describe('Receiving log (STRATA-78)', () => {
  it('lists receipts with the received date and time as the link, units, receiver and status', async () => {
    stubApi((url) =>
      url.pathname === '/api/receipts'
        ? json(
            200,
            page([
              receipt(RECEIPT_ID),
              receipt('00000000-0000-4000-8000-000000000602', {
                status: 'corrected',
                quantity: 4,
                unitIds: ['BKT-2026-000020', 'BKT-2026-000021', 'BKT-2026-000022'],
              }),
            ]),
          )
        : undefined,
    );
    renderAt('/receiving-log');
    expect(await screen.findByRole('heading', { name: 'Receiving log', level: 1 })).toBeVisible();
    const table = await screen.findByRole('table', { name: 'Confirmed receipts' });
    expect(
      within(table).getAllByRole('link', {
        name: /^Open receipt: DEMO-2601, received 2026-01-15 by JS · Jordan Smith/,
      }),
    ).toHaveLength(2);
    expect(within(table).getByText('Confirmed')).toBeInTheDocument();
    expect(within(table).getByText('Corrected')).toBeInTheDocument();
    expect(within(table).getByText('+3')).toBeInTheDocument();
    expect(within(table).getAllByText('JS · Jordan Smith').length).toBeGreaterThan(0);
    expect(screen.getByText('2 receipts')).toBeInTheDocument();
  });

  it('sends a filter chosen in the toolbar to the server and shows it as a chip', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)])) : undefined,
    );
    renderAt('/receiving-log');
    await screen.findByRole('table', { name: 'Confirmed receipts' });
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Corrected' }));
    await waitFor(() =>
      expect(logCalls(fetchMock).some((u) => u.searchParams.get('status') === 'corrected')).toBe(
        true,
      ),
    );
    await user.keyboard('{Escape}');
    expect(
      within(screen.getByRole('group', { name: 'Active sort and filters' })).getByText('Corrected'),
    ).toBeInTheDocument();
  });

  it('turns an older link with projectId into a project filter', async () => {
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)])) : undefined,
    );
    const router = renderAt(`/receiving-log?projectId=${PROJECT.id}`);
    await waitFor(() =>
      expect(router.state.location.search).toBe(
        `?filter=${encodeURIComponent(projectFilter(PROJECT.id))}`,
      ),
    );
    await waitFor(() =>
      expect(logCalls(fetchMock).at(-1)!.searchParams.get('projectId')).toBe(PROJECT.id),
    );
  });

  it('shows "No receipts yet" with Receive samples when nothing has been confirmed', async () => {
    stubApi((url) => (url.pathname === '/api/receipts' ? json(200, page([])) : undefined));
    renderAt('/receiving-log');
    expect(await screen.findByText('No receipts yet.')).toBeInTheDocument();
  });

  it('shows "No receipts match these filters" with Clear filters', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/receipts' ? json(200, page([])) : undefined,
    );
    const router = renderAt('/receiving-log?search=nothing');
    expect(await screen.findByText('No receipts match these filters.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Clear filters' }));
    await waitFor(() => expect(router.state.location.search).toBe(''));
    await waitFor(() => expect(logCalls(fetchMock).at(-1)!.searchParams.get('search')).toBeNull());
  });

  it('a server error offers Try again, never an empty history', async () => {
    const user = userEvent.setup();
    let fail = true;
    stubApi((url) =>
      url.pathname === '/api/receipts'
        ? fail
          ? json(500, {})
          : json(200, page([receipt(RECEIPT_ID)]))
        : undefined,
    );
    renderAt('/receiving-log');
    expect(await screen.findByText('Receipts didn’t load')).toBeInTheDocument();
    expect(screen.queryByText('No receipts yet.')).not.toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('table', { name: 'Confirmed receipts' })).toBeInTheDocument();
  });

  it('pages with Previous and Next', async () => {
    const user = userEvent.setup();
    const fetchMock = stubApi((url) =>
      url.pathname === '/api/receipts'
        ? json(200, page([receipt(RECEIPT_ID)], 60, Number(url.searchParams.get('page') ?? 1)))
        : undefined,
    );
    renderAt('/receiving-log');
    await screen.findByText('Page 1 of 3');
    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 3');
    expect(logCalls(fetchMock).at(-1)!.searchParams.get('page')).toBe('2');
  });
});

describe('Drafts on this computer (STRATA-108)', () => {
  const receipts: Handler = (url) =>
    url.pathname === '/api/receipts' ? json(200, page([receipt(RECEIPT_ID)])) : undefined;

  it('lists the person’s drafts as drafts, never receipts: Continue, no IDs, others hidden', async () => {
    const mine = await storedDraft();
    await storedDraft(PAT);
    stubApi((url, init) => {
      if (url.pathname === '/api/receipt-drafts' && (init?.method ?? 'GET') === 'GET') {
        return json(200, { items: [ownershipOf(mine.draftId)] });
      }
      return receipts(url, init);
    });
    renderAt('/receiving-log');
    const drafts = await screen.findByRole('list', { name: 'Drafts on this computer' });
    expect(within(drafts).getAllByRole('listitem')).toHaveLength(1);
    expect(within(drafts).getByText('Draft · Receipt')).toBeInTheDocument();
    expect(within(drafts).getByText(/Started by you/)).toBeInTheDocument();
    expect(
      within(drafts).getByRole('link', { name: 'Continue draft for DEMO-2601' }),
    ).toHaveAttribute('href', `/receiving-log/new?draft=${mine.draftId}`);
    expect(within(drafts).queryByText(/BKT-|ST-|CRE-|CT-/)).not.toBeInTheDocument();
  });

  it('disables Delete draft for anyone but the starter or a Lab Manager, with the reason', async () => {
    const record = await storedDraft();
    stubApi((url, init) => {
      if (url.pathname === '/api/receipt-drafts') {
        return json(200, {
          items: [
            ownershipOf(record.draftId, {
              starter: { userId: JORDAN, initials: 'JL', name: 'Jordan Lab' },
              canDelete: false,
              reason: 'not_starter',
            }),
          ],
        });
      }
      return receipts(url, init);
    });
    renderAt('/receiving-log');
    const button = await screen.findByRole('button', {
      name: 'Delete draft. Only Jordan Lab or a Lab Manager can delete it',
    });
    expect(button).toBeDisabled();
  });

  it('asks first; Keep draft sends nothing and keeps it', async () => {
    const user = userEvent.setup();
    const record = await storedDraft();
    const fetchMock = stubApi((url, init) => {
      if (url.pathname === '/api/receipt-drafts') {
        return json(200, { items: [ownershipOf(record.draftId)] });
      }
      return receipts(url, init);
    });
    renderAt('/receiving-log');
    const button = await screen.findByRole('button', { name: 'Delete draft' });
    await waitFor(() => expect(button).toBeEnabled());
    await user.click(button);
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this draft?' });
    await user.click(within(dialog).getByRole('button', { name: 'Keep draft' }));
    expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/delete'))).toBe(false);
    expect(await indexedDbDraftStore.get(record.draftId)).not.toBeNull();
  });

  it('removes the local copy only after the server authorizes the deletion', async () => {
    const user = userEvent.setup();
    const record = await storedDraft();
    let refuse = true;
    const fetchMock = stubApi((url, init) => {
      if (url.pathname === `/api/receipt-drafts/${record.draftId}/delete`) {
        return refuse
          ? json(403, { code: 'draft_delete_forbidden', reason: 'not_starter', starter: null })
          : json(200, {
              draftId: record.draftId,
              deletedAt: '2026-01-16T10:00:00.000Z',
              reason: 'starter',
            });
      }
      if (url.pathname === '/api/receipt-drafts') {
        return json(200, { items: [ownershipOf(record.draftId)] });
      }
      return receipts(url, init);
    });
    renderAt('/receiving-log');
    const deleteOnce = async () => {
      const button = await screen.findByRole('button', { name: 'Delete draft' });
      await waitFor(() => expect(button).toBeEnabled());
      await user.click(button);
      const dialog = await screen.findByRole('alertdialog');
      await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    };
    await deleteOnce();
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/delete'))).toBe(true),
    );
    // Refused: still on this computer.
    expect(await indexedDbDraftStore.get(record.draftId)).not.toBeNull();
    refuse = false;
    await deleteOnce();
    await waitFor(async () => expect(await indexedDbDraftStore.get(record.draftId)).toBeNull());
    await waitFor(() =>
      expect(
        screen.queryByRole('list', { name: 'Drafts on this computer' }),
      ).not.toBeInTheDocument(),
    );
  });

  it('a draft saved before ownership was recorded says only a Lab Manager can delete it', async () => {
    const record = await storedDraft(ME_ID, { legacy: true, starter: null, registeredAt: null });
    const fetchMock = stubApi((url, init) => {
      if (url.pathname === '/api/receipt-drafts') {
        return json(200, {
          items: [
            ownershipOf(record.draftId, {
              registered: false,
              starter: null,
              canDelete: false,
              reason: 'unregistered',
            }),
          ],
        });
      }
      return receipts(url, init);
    });
    renderAt('/receiving-log');
    expect(
      await screen.findByRole('button', { name: 'Delete draft. Only a Lab Manager can delete it' }),
    ).toBeDisabled();
    // A legacy draft is never registered: no ownership is invented for it.
    expect(
      fetchMock.mock.calls.some(
        ([input, init]) => String(input).endsWith('/api/receipt-drafts') && init?.method === 'POST',
      ),
    ).toBe(false);
  });
});

describe('Receipt page (STRATA-78)', () => {
  const api: Handler = (url) => {
    if (url.pathname === `/api/receipts/${RECEIPT_ID}`) return json(200, DETAIL);
    if (url.pathname === `/api/receipts/${RECEIPT_ID}/history`) return json(200, HISTORY);
    return undefined;
  };

  it('names the receipt by date and receiver, says who entered it, and highlights corrections', async () => {
    stubApi(api);
    renderAt(`/receiving-log/${RECEIPT_ID}`);
    expect(
      await screen.findByRole('heading', { name: 'Receipt 2026-01-15 · Jordan Smith', level: 1 }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('LAB (shared station), for Jordan Smith').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Corrected').length).toBeGreaterThan(0);
    const original = screen.getByRole('region', { name: 'Original receipt record' });
    expect(within(original).getAllByText(/corrected to/)).toHaveLength(2);
    const units = screen.getByRole('table', { name: 'Storage units in this receipt' });
    expect(within(units).getByRole('link', { name: 'Open BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    // The disposed unit can't be reprinted.
    expect(screen.getByText(/Prints 1 label\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print all labels' })).toBeInTheDocument();
    const history = await screen.findByRole('list', {
      name: 'Corrections and history, newest first',
    });
    expect(
      within(history).getByText(/Details corrected · BKT-2026-000014 — Pat Example/),
    ).toBeInTheDocument();
    expect(within(history).getByText('“Tube label read DEMO-2602”')).toBeInTheDocument();
  });

  it('an unknown receipt says No receipt found', async () => {
    stubApi(() => json(404, { code: 'receipt_not_found' }));
    renderAt(`/receiving-log/${RECEIPT_ID}`);
    expect(await screen.findByText('No receipt found')).toBeInTheDocument();
  });
});
