import type { MeResponse, PrintJob, StorageUnitDetail } from '@materialmule/shared';
import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { PrintLabelsPanel } from './PrintLabelsPanel';
import { PRINT_POLL_MS } from './usePrintJob';

const UNIT = { id: '00000000-0000-4000-8000-000000000501', readableId: 'BKT-2026-000014' };

const UNIT_DETAIL: StorageUnitDetail = {
  ...UNIT,
  unitType: 'bucket',
  status: 'in_stock',
  note: null,
  receivedDate: '2026-10-23',
  minimumRetainUntil: '2027-10-23',
  version: 1,
  project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Riverbank', client: 'Example Client' },
  sample: null,
  bulkGroup: null,
  holes: [],
  location: { id: 'l1', code: 'RECEIVING', name: 'Receiving lab' },
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-23',
    project: { id: 'p1', projectNumber: 'DEMO-2601', name: 'Riverbank', client: 'Example Client' },
    receiver: { initials: 'AT', name: 'Alex Tester' },
    account: { initials: 'AT', name: 'Alex Tester' },
    description: null,
    quantity: 1,
    confirmedAt: '2026-10-23T16:00:00.000Z',
  },
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

function printJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    kind: 'initial',
    printerId: 'receiving',
    printerName: 'Receiving ZD621',
    templateVersion: 'sticker-v1',
    status: 'queued',
    attempts: 0,
    lastError: null,
    printerMessage: null,
    requestedBy: { userId: 'u1', initials: 'AT', name: 'Alex Tester' },
    receiver: null,
    createdAt: '2026-10-26T16:00:00.000Z',
    updatedAt: '2026-10-26T16:00:00.000Z',
    sentAt: null,
    physicallyConfirmedAt: null,
    physicallyConfirmedBy: null,
    target: 'storage_unit',
    items: [{ storageUnitId: UNIT.id, readableId: UNIT.readableId, position: 1 }],
    locations: [],
    ...overrides,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

type Handler = (url: string, init?: RequestInit) => Response | undefined;

function stubApi(handler: Handler) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init) ?? json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function renderRoute(path: string, user = me()) {
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
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('PrintLabelsPanel', () => {
  it('queues the job, polls every 2 s while active and shows the honest result', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    let reads = 0;
    const fetchMock = stubApi((url, init) => {
      if (url === '/api/print-jobs' && init?.method === 'POST') return json(201, printJob());
      if (url.startsWith('/api/print-jobs/')) {
        reads += 1;
        return json(
          200,
          printJob(
            reads === 1
              ? { status: 'sending', attempts: 1 }
              : { status: 'sent', attempts: 1, sentAt: '2026-10-26T16:00:02.000Z' },
          ),
        );
      }
      return undefined;
    });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    render(<PrintLabelsPanel storageUnitIds={[UNIT.id]} kind="initial" buttonLabel="Print all" />);

    await user.click(screen.getByRole('button', { name: 'Print all' }));
    expect(await screen.findByText('Waiting to print')).toBeInTheDocument();
    const post = fetchMock.mock.calls.find(([url]) => url === '/api/print-jobs')!;
    expect(JSON.parse(String(post[1]!.body))).toEqual({
      storageUnitIds: [UNIT.id],
      kind: 'initial',
    });
    expect(new Headers(post[1]!.headers).get('x-materialmule-csrf')).toBe('1');

    await act(() => vi.advanceTimersByTimeAsync(PRINT_POLL_MS));
    expect(await screen.findByText('Sending to printer…')).toBeInTheDocument();
    await act(() => vi.advanceTimersByTimeAsync(PRINT_POLL_MS));
    expect(await screen.findByText('Sent to printer')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Labels came out OK' })).toBeInTheDocument();

    // Polling stops once the job is finished.
    await act(() => vi.advanceTimersByTimeAsync(PRINT_POLL_MS * 3));
    expect(reads).toBe(2);
  });

  it('shows the server’s reason when printing is refused', async () => {
    stubApi((url) =>
      url === '/api/print-jobs'
        ? json(409, {
            code: 'no_printer_configured',
            message: 'No label printer is set up yet. Ask an administrator to add one.',
          })
        : undefined,
    );
    render(<PrintLabelsPanel storageUnitIds={[UNIT.id]} kind="initial" buttonLabel="Print all" />);
    await userEvent.click(screen.getByRole('button', { name: 'Print all' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No label printer is set up yet');
  });
});

describe('storage unit labels page', () => {
  it('lists print history and offers Reprint or Mark as printed for an uncertain job', async () => {
    const uncertain = printJob({
      status: 'uncertain',
      attempts: 1,
      lastError: 'Printer dropped the connection while receiving labels',
    });
    const fetchMock = stubApi((url, init) => {
      if (url === `/api/storage-units/${UNIT.readableId}/print-history`) {
        return json(200, { storageUnit: UNIT, jobs: [uncertain] });
      }
      // The labels section sits on the storage unit detail page (MM-T12).
      if (url === `/api/storage-units/${UNIT.readableId}`) return json(200, UNIT_DETAIL);
      if (url.startsWith(`/api/storage-units/${UNIT.id}/history`)) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      if (url === `/api/print-jobs/${uncertain.id}/confirm-physical` && init?.method === 'POST') {
        return json(200, { ...uncertain, physicallyConfirmedAt: '2026-10-26T16:05:00.000Z' });
      }
      return undefined;
    });
    renderRoute(`/sample-storage/${UNIT.readableId}`);

    const history = await screen.findByRole('table');
    expect(screen.getByRole('heading', { level: 1, name: UNIT.readableId })).toBeInTheDocument();
    expect(
      within(history).getByText('Unknown — check the printer before reprinting'),
    ).toBeInTheDocument();
    expect(
      within(history).getByText('Check the printer, then Reprint or Mark as printed.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reprint label' })).toBeInTheDocument();

    await userEvent.click(within(history).getByRole('button', { name: 'Mark as printed' }));
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/confirm-physical'))).toBe(
      true,
    );
  });

  it('MM-T61: names the receiver by initials and name, so people sharing initials differ', async () => {
    const atStation = (id: string, receiver: PrintJob['receiver']) =>
      printJob({
        id,
        status: 'sent',
        attempts: 1,
        sentAt: '2026-10-26T16:00:02.000Z',
        requestedBy: { userId: 'lab', initials: null, name: 'LAB' },
        receiver,
      });
    stubApi((url) => {
      if (url === `/api/storage-units/${UNIT.readableId}/print-history`) {
        return json(200, {
          storageUnit: UNIT,
          jobs: [
            atStation('00000000-0000-4000-8000-000000000911', {
              userId: 'js1',
              initials: 'JS',
              name: 'Jordan Smith',
            }),
            atStation('00000000-0000-4000-8000-000000000912', {
              userId: 'js2',
              initials: 'JS',
              name: 'Jamie Song',
            }),
            atStation('00000000-0000-4000-8000-000000000913', {
              userId: 'nn',
              initials: null,
              name: 'Noor New',
            }),
            printJob({ status: 'sent', attempts: 1, sentAt: '2026-10-26T16:00:02.000Z' }),
          ],
        });
      }
      if (url === `/api/storage-units/${UNIT.readableId}`) return json(200, UNIT_DETAIL);
      if (url.startsWith(`/api/storage-units/${UNIT.id}/history`)) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      return undefined;
    });
    renderRoute(`/sample-storage/${UNIT.readableId}`);

    const history = await screen.findByRole('table', { name: /Print history/ });
    expect(within(history).getByText('LAB for JS · Jordan Smith')).toBeInTheDocument();
    expect(within(history).getByText('LAB for JS · Jamie Song')).toBeInTheDocument();
    expect(within(history).getByText('LAB for Noor New')).toBeInTheDocument();
    // A personal account printing for themselves is just their initials, as before.
    expect(within(history).getByText('AT')).toBeInTheDocument();
  });
});

describe('print history wording (MM-T61)', () => {
  it('says an uncertain job marked printed was uncertain and who confirmed it; failed jobs show attempts', async () => {
    const markedPrinted = printJob({
      id: '00000000-0000-4000-8000-000000000921',
      status: 'uncertain',
      attempts: 1,
      lastError: 'Printer dropped the connection while receiving labels',
      physicallyConfirmedAt: '2026-10-26T16:05:00.000Z',
      physicallyConfirmedBy: { userId: 'js', initials: 'JS', name: 'Jordan Smith' },
    });
    const failed = printJob({
      id: '00000000-0000-4000-8000-000000000922',
      status: 'failed',
      attempts: 3,
      lastError: 'Printer refused the connection',
    });
    stubApi((url) => {
      if (url === `/api/storage-units/${UNIT.readableId}/print-history`) {
        return json(200, { storageUnit: UNIT, jobs: [markedPrinted, failed] });
      }
      if (url === `/api/storage-units/${UNIT.readableId}`) return json(200, UNIT_DETAIL);
      if (url.startsWith(`/api/storage-units/${UNIT.id}/history`)) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      return undefined;
    });
    renderRoute(`/sample-storage/${UNIT.readableId}`);

    const history = await screen.findByRole('table', { name: /Print history/ });
    expect(within(history).getByText('Marked as printed')).toBeInTheDocument();
    expect(
      within(history).getByText(
        'The printer result was uncertain; JS · Jordan Smith marked it as printed.',
      ),
    ).toBeInTheDocument();
    expect(
      within(history).getByText('Tried 3 times. Fix the printer, then Reprint.'),
    ).toBeInTheDocument();
  });
});

describe('Settings → Printers', () => {
  const printers = [
    {
      id: 'receiving',
      name: 'Receiving ZD621',
      host: '10.0.0.50',
      port: 9100,
      enabled: true,
      isDefault: true,
      checkStatus: true,
    },
  ];

  it('is offered to admins and shows the configured printer', async () => {
    stubApi((url) => (url === '/api/admin/printers' ? json(200, printers) : undefined));
    renderRoute('/settings/printers', me({ roles: ['admin'], permissions: ['printer.manage'] }));
    expect(await screen.findByRole('link', { name: 'Printers' })).toBeInTheDocument();
    expect(await screen.findByDisplayValue('10.0.0.50')).toBeInTheDocument();
  });

  it('is hidden from other users', async () => {
    stubApi(() => undefined);
    renderRoute('/settings/printers');
    expect(await screen.findByText('Only administrators can change printers.')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Printers' })).not.toBeInTheDocument();
  });
});
