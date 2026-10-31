import type { DisposalCandidates, DisposalReady, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-T30 UI: eligible/approved/not-eligible lists with reasons, batch approval summary, and the
// distinct online-only Disposal scan mode (disabled offline, nothing queued). Fictional data.

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

const unit = (id: string, overrides: Partial<DisposalCandidates['units'][number]> = {}) => ({
  storageUnitId: id,
  readableId: `BKT-2026-00000${id}`,
  unitType: 'bucket',
  status: 'in_stock' as const,
  location: { code: 'WH-A1', name: 'Warehouse A1' },
  receivedDate: '2026-10-23',
  effectiveRetainUntil: '2027-10-23',
  eligible: true,
  blockers: [],
  approval: null,
  retentionExempt: false,
  ...overrides,
});

const candidates: DisposalCandidates = {
  projectId: 'p1',
  asOf: '2027-10-24',
  canApprove: true,
  total: 2,
  page: 1,
  pageSize: 200,
  units: [
    unit('1'),
    unit('2', {
      eligible: false,
      effectiveRetainUntil: '2028-06-30',
      blockers: [
        { code: 'on_hold', label: 'On hold: Claim review' },
        { code: 'program_open', label: 'Program LP-2026-0004 open' },
      ],
    }),
  ],
};

function json(status: number, body: unknown) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderAt(
  path: string,
  user: MeResponse,
  api: (url: string, init?: RequestInit) => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={createMemoryRouter(routes, { initialEntries: [path] })} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Disposal (MM-T30)', () => {
  it('lists eligible units, shows why others are not, and confirms a batch with a summary', async () => {
    const user = userEvent.setup();
    const fetchMock = renderAt('/disposal-retention?projectId=p1', me(), (url, init) => {
      if (url.startsWith('/api/disposal/eligible')) return json(200, candidates);
      if (url === '/api/disposal/approvals' && init?.method === 'POST') {
        return json(201, { batchId: 'b1', approvals: [{ id: 'a1', storageUnitId: '1' }] });
      }
      return json(200, { open: 0 });
    });
    const eligible = await screen.findByRole('region', { name: 'Eligible for disposal' });
    const others = screen.getByRole('region', { name: 'Not eligible' });
    expect(others).toHaveTextContent('On hold: Claim review · Program LP-2026-0004 open');
    await user.click(within(eligible).getByRole('checkbox'));
    await user.click(within(eligible).getByRole('button', { name: 'Approve 1 for disposal' }));
    // jsdom has no showModal; the dialog element is still rendered with its summary.
    const dialog = document.querySelector<HTMLElement>('dialog.confirm-dialog')!;
    expect(dialog).toHaveTextContent('Approve 1 for disposal?');
    expect(dialog).toHaveTextContent('BKT-2026-000001 · retain until 2027-10-23');
    expect(dialog).toHaveTextContent(/Approval doesn.t dispose anything/);
    await user.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    const call = fetchMock.mock.calls.find(([url]) => String(url) === '/api/disposal/approvals');
    expect(JSON.parse(String(call![1]!.body))).toMatchObject({ unitIds: ['1'] });
  });

  it('MM-T71 T3: a tested unit shows only its exception and points to Confirm removal after testing', async () => {
    renderAt('/disposal-retention?projectId=p1', me(), (url) => {
      if (url.startsWith('/api/disposal/eligible')) {
        return json(200, {
          ...candidates,
          total: 1,
          units: [
            unit('7', {
              unitType: 'shelby_tube',
              readableId: 'ST-2026-000007',
              eligible: false,
              retentionExempt: true,
            }),
          ],
        });
      }
      return json(200, { open: 0 });
    });
    const tested = await screen.findByRole('region', { name: 'Tested: removed after testing' });
    expect(tested).toHaveTextContent('ST-2026-000007');
    expect(tested).toHaveTextContent('Retention: Not applicable');
    expect(tested).toHaveTextContent(/Confirm removal after testing/);
    expect(tested).not.toHaveTextContent(/On hold|Retain until/);
    expect(screen.getByRole('region', { name: 'Not eligible' })).toHaveTextContent('None.');
  });

  it('MM-T71 T4: pages through every current unit with the total', async () => {
    const user = userEvent.setup();
    const pages: number[] = [];
    renderAt('/disposal-retention?projectId=p1', me(), (url) => {
      if (url.startsWith('/api/disposal/eligible')) {
        const page = Number(new URL(url, 'http://x').searchParams.get('page'));
        pages.push(page);
        return json(200, {
          ...candidates,
          total: 501,
          page,
          units: page === 3 ? [unit('9', { readableId: 'BKT-2026-000501' })] : [unit('1')],
        });
      }
      return json(200, { open: 0 });
    });
    const pager = await screen.findByRole('navigation', { name: 'Pages' });
    expect(pager).toHaveTextContent('Page 1 of 3');
    expect(screen.getByText(/of 501 current units/)).toBeVisible();
    await user.click(within(pager).getByRole('button', { name: 'Next' }));
    expect(await within(pager).findByText('Page 2 of 3')).toBeVisible();
    await user.click(within(pager).getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('BKT-2026-000501')).toBeVisible();
    expect(within(pager).getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(pages).toEqual([1, 2, 3]);
  });

  it('Disposal scan is a distinct mode; offline it is disabled and nothing is sent or queued', async () => {
    vi.spyOn(window.navigator, 'onLine', 'get').mockReturnValue(false);
    const fetchMock = renderAt('/disposal-retention/scan', me(), () => json(200, { open: 0 }));
    expect(await screen.findByRole('heading', { name: 'Disposal scan' })).toBeVisible();
    expect(
      screen.getByText(/switched off while offline, and nothing is saved or queued/),
    ).toBeVisible();
    expect(screen.getByLabelText('Scan or type a storage unit ID')).toBeDisabled();
    expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/api/disposal/remove'))).toBe(
      false,
    );
  });

  it('each scan says Disposed, Not approved or Blocked with the reason', async () => {
    const user = userEvent.setup();
    const replies = [
      json(200, {
        result: 'disposed',
        storageUnitId: '1',
        readableId: 'BKT-2026-000001',
        blockers: [],
        message: 'BKT-2026-000001 disposed.',
        removedAt: '2027-10-24T16:00:00.000Z',
        removedBy: { userId: 'u-lm', initials: 'LM', name: 'Lee Manager' },
        replayed: false,
      }),
      json(422, {
        result: 'blocked',
        storageUnitId: '2',
        readableId: 'BKT-2026-000002',
        blockers: [{ code: 'on_hold', label: 'On hold: Claim review' }],
        message: 'Blocked: On hold: Claim review',
        removedAt: null,
        removedBy: null,
        replayed: false,
      }),
    ];
    renderAt('/disposal-retention/scan', me(), (url) =>
      url === '/api/disposal/remove' ? replies.shift()! : json(200, { open: 0 }),
    );
    const input = await screen.findByLabelText('Scan or type a storage unit ID');
    await user.type(input, 'BKT-2026-000001{Enter}');
    expect(await screen.findByText(/BKT-2026-000001 disposed\./)).toBeVisible();
    await user.type(input, 'BKT-2026-000002{Enter}');
    const results = screen.getByRole('list', { name: 'Scan results' });
    expect(await within(results).findByText(/Blocked: On hold: Claim review/)).toBeVisible();
    expect(within(results).getByText('Disposed')).toBeVisible();
    expect(within(results).getByText('Blocked')).toBeVisible();
  });

  it('a LAB station is told disposal scans need a personal sign-in', async () => {
    renderAt(
      '/disposal-retention/scan',
      me({ accountType: 'shared_lab', roles: [], permissions: ['inventory.read'] }),
      () => json(403, {}),
    );
    expect(await screen.findByText(/need a personal sign-in/)).toBeVisible();
    expect(screen.getByLabelText('Scan or type a storage unit ID')).toBeDisabled();
  });
});

const readyUnit = (
  id: string,
  overrides: Partial<DisposalReady['units'][number]> = {},
): DisposalReady['units'][number] => ({
  storageUnitId: id,
  readableId: `BKT-2026-00010${id}`,
  unitType: 'bucket',
  project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Fictional project' },
  location: { code: 'WH-D1', name: 'Warehouse D1 (long-term)' },
  effectiveRetainUntil: '2027-10-23',
  stage: 'awaiting_approval',
  reason: {
    code: 'retention_ended',
    label:
      'Retention ended 2027-10-23 (1 year after receipt 2026-10-23); no hold, open program or location conflict',
  },
  canApprove: true,
  ...overrides,
});

const ready = (units: DisposalReady['units']): DisposalReady => ({
  asOf: '2027-10-24',
  units,
  total: units.length,
  page: 1,
  pageSize: 50,
});

describe('Ready for disposal (MISC-13)', () => {
  it('lists ready units from every project before a project is chosen, each linked onward', async () => {
    const fetchMock = renderAt('/disposal-retention', me(), (url) => {
      if (url.startsWith('/api/disposal/ready')) {
        return json(
          200,
          ready([
            readyUnit('1'),
            readyUnit('2', {
              readableId: 'ST-2026-000102',
              unitType: 'shelby_tube',
              project: { id: 'p2', projectNumber: 'DEMO-2603', name: 'Other project' },
              stage: 'approved',
              canApprove: false,
            }),
            readyUnit('3', {
              project: { id: 'p3', projectNumber: 'DEMO-2604', name: 'Third project' },
              canApprove: false,
              reason: {
                code: 'extension_ended',
                label:
                  'Extended retention ended 2027-10-23; no hold, open program or location conflict',
              },
            }),
          ]),
        );
      }
      return json(200, { open: 0 });
    });
    const card = await screen.findByRole('region', { name: 'Ready for disposal' });
    expect(within(card).getByLabelText('Ready count')).toHaveTextContent('3 units');
    expect(card).toHaveTextContent('As of 2027-10-24, all projects');
    const rows = within(card).getAllByRole('row').slice(1);
    expect(rows).toHaveLength(3);
    const [first, approved, waiting] = rows as [HTMLElement, HTMLElement, HTMLElement];
    expect(within(first).getByRole('link', { name: 'BKT-2026-000101' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000101',
    );
    expect(within(first).getByRole('link', { name: 'DEMO-2601' })).toHaveAttribute(
      'href',
      '/disposal-retention?projectId=p1',
    );
    expect(first).toHaveTextContent('Warehouse D1 (long-term)');
    expect(first).toHaveTextContent('2027-10-23');
    expect(first).toHaveTextContent('Retention ended 2027-10-23 (1 year after receipt 2026-10-23)');
    expect(within(first).getByRole('link', { name: 'Approve in project' })).toHaveAttribute(
      'href',
      '/disposal-retention?projectId=p1',
    );
    expect(within(approved).getByRole('link', { name: 'Scan to dispose' })).toHaveAttribute(
      'href',
      '/disposal-retention/scan',
    );
    expect(waiting).toHaveTextContent('Extended retention ended 2027-10-23');
    expect(waiting).toHaveTextContent(/Waiting for the Lead Project Engineer or a Lab Manager/);
    expect(within(waiting).queryByRole('link', { name: 'Approve in project' })).toBeNull();
    // Eligibility is the server's: the page asked for no project's units to work it out.
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).startsWith('/api/disposal/eligible')),
    ).toBe(false);
  });

  it('says so when nothing is ready', async () => {
    renderAt('/disposal-retention', me(), (url) =>
      url.startsWith('/api/disposal/ready') ? json(200, ready([])) : json(200, { open: 0 }),
    );
    const card = await screen.findByRole('region', { name: 'Ready for disposal' });
    expect(
      await within(card).findByText('No storage units are ready for disposal right now.'),
    ).toBeVisible();
    expect(within(card).getByLabelText('Ready count')).toHaveTextContent('0 units');
    expect(within(card).queryByRole('table')).toBeNull();
  });

  it('shows an error with Retry when the list fails to load', async () => {
    const user = userEvent.setup();
    let fail = true;
    renderAt('/disposal-retention', me(), (url) => {
      if (url.startsWith('/api/disposal/ready')) {
        return fail ? json(500, {}) : json(200, ready([readyUnit('1')]));
      }
      return json(200, { open: 0 });
    });
    const card = await screen.findByRole('region', { name: 'Ready for disposal' });
    const alert = await within(card).findByRole('alert');
    expect(alert).toHaveTextContent(/couldn.t be loaded/);
    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await within(card).findByRole('link', { name: 'BKT-2026-000101' })).toBeVisible();
    expect(within(card).queryByRole('alert')).toBeNull();
  });

  it('reloads after an approval on the page', async () => {
    const user = userEvent.setup();
    let readyCalls = 0;
    renderAt('/disposal-retention?projectId=p1', me(), (url, init) => {
      if (url.startsWith('/api/disposal/ready')) {
        readyCalls += 1;
        return json(200, ready(readyCalls === 1 ? [readyUnit('1')] : []));
      }
      if (url.startsWith('/api/disposal/eligible')) return json(200, candidates);
      if (url === '/api/disposal/approvals' && init?.method === 'POST') {
        return json(201, { batchId: 'b1', approvals: [{ id: 'a1', storageUnitId: '1' }] });
      }
      return json(200, { open: 0 });
    });
    const card = await screen.findByRole('region', { name: 'Ready for disposal' });
    expect(await within(card).findByRole('link', { name: 'BKT-2026-000101' })).toBeVisible();
    const eligible = await screen.findByRole('region', { name: 'Eligible for disposal' });
    await user.click(within(eligible).getByRole('checkbox'));
    await user.click(within(eligible).getByRole('button', { name: 'Approve 1 for disposal' }));
    const dialog = document.querySelector<HTMLElement>('dialog.confirm-dialog')!;
    await user.click(within(dialog).getByRole('button', { name: 'Approve', hidden: true }));
    expect(
      await within(card).findByText('No storage units are ready for disposal right now.'),
    ).toBeVisible();
    expect(readyCalls).toBe(2);
  });
});
