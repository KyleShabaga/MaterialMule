import type { MeResponse, StorageUnitDetail } from '@trapezoid/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { useScanner } from './useScanner';
import { VerifyLabelsPanel } from './VerifyLabelsPanel';

// TRP-T16: the DS3678-XR is a USB keyboard that types the symbol's data and then Enter, so every
// scan here is simulated keyboard input. Fictional data only (DEMO-2601, TH26-01).

const me: MeResponse = {
  id: 'u1',
  displayName: 'Lab (shared)',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
};

const DETAIL: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000501',
  readableId: 'BKT-2026-000014',
  unitType: 'bucket',
  status: 'in_stock',
  note: null,
  receivedDate: '2026-10-23',
  minimumRetainUntil: '2027-10-23',
  version: 1,
  project: {
    id: '00000000-0000-4000-8000-000000000201',
    projectNumber: 'DEMO-2601',
    name: 'Riverbank investigation',
    client: 'Example Client',
  },
  holes: [
    {
      testHoleId: 'th1',
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
  location: { id: 'loc-r', code: 'RECEIVING', name: 'Receiving lab' },
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-23',
    project: {
      id: '00000000-0000-4000-8000-000000000201',
      projectNumber: 'DEMO-2601',
      name: 'Riverbank investigation',
      client: 'Example Client',
    },
    receiver: { initials: 'AT', name: 'Alex Tester' },
    account: { initials: null, name: 'LAB' },
    description: null,
    quantity: 1,
    confirmedAt: '2026-10-23T16:00:00.000Z',
  },
};

const KNOWN: Record<string, string> = {
  'BKT-2026-000014': '00000000-0000-4000-8000-000000000501',
  'BKT-2026-000015': '00000000-0000-4000-8000-000000000502',
  'ST-2026-000003': '00000000-0000-4000-8000-000000000503',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Fake API: lookup trims and upper-cases like the server; `down` makes every call fail. */
function stubApi(options: { down?: boolean } = {}) {
  const state = { down: options.down ?? false };
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    if (state.down) throw new TypeError('Failed to fetch');
    const url = new URL(String(input), 'http://localhost');
    if ((init?.method ?? 'GET') !== 'GET') return json(405, {});
    if (url.pathname === '/api/storage-units/lookup') {
      const code = (url.searchParams.get('code') ?? '').trim().toUpperCase();
      const id = KNOWN[code];
      return id
        ? json(200, { id, readableId: code })
        : json(404, { code: 'storage_unit_not_found' });
    }
    if (url.pathname.startsWith('/api/storage-units/')) return json(200, DETAIL);
    if (url.pathname === '/api/health') return json(200, { status: 'ok' });
    return json(404, { code: 'not_found' });
  });
  vi.stubGlobal('fetch', fetchMock);
  return { fetchMock, state };
}

const lookups = (fetchMock: ReturnType<typeof stubApi>['fetchMock']) =>
  fetchMock.mock.calls
    .map(([input]) => new URL(String(input), 'http://localhost'))
    .filter((url) => url.pathname === '/api/storage-units/lookup')
    .map((url) => url.searchParams.get('code'));

function renderAt(path: string) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
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
});

function Harness({
  onScan,
  onDuplicate,
  now,
}: {
  onScan: (value: string) => void;
  onDuplicate: (value: string) => void;
  now: () => number;
}) {
  const scanner = useScanner({ onScan, onDuplicate, now });
  return (
    <>
      <div {...scanner.containerProps}>
        <label>
          Scan
          <input {...scanner.inputProps} />
        </label>
        <button type="button">Inside control</button>
        <p>{scanner.paused ? 'paused' : 'ready'}</p>
      </div>
      <label>
        Other field
        <input />
      </label>
    </>
  );
}

describe('useScanner (T1)', () => {
  it('fires on the Enter terminator with a trimmed value, clears the field and keeps focus', async () => {
    const onScan = vi.fn();
    const onDuplicate = vi.fn();
    let now = 0;
    render(<Harness onScan={onScan} onDuplicate={onDuplicate} now={() => now} />);
    const field = screen.getByRole('textbox', { name: 'Scan' });
    expect(field).toHaveFocus();

    await userEvent.keyboard('  BKT-2026-000014 ');
    expect(onScan).not.toHaveBeenCalled();
    await userEvent.keyboard('{Enter}');
    expect(onScan).toHaveBeenCalledExactlyOnceWith('BKT-2026-000014');
    expect(field).toHaveValue('');
    expect(field).toHaveFocus();

    // Enter on an empty field is not a scan.
    await userEvent.keyboard('{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);

    // Same payload within 2 s: a duplicate, not a scan.
    now += 1_500;
    await userEvent.keyboard('BKT-2026-000014{Enter}');
    expect(onScan).toHaveBeenCalledTimes(1);
    expect(onDuplicate).toHaveBeenCalledExactlyOnceWith('BKT-2026-000014');

    // A different label at once is a scan; the first one again after 2 s is a scan too.
    await userEvent.keyboard('ST-2026-000003{Enter}');
    now += 2_500;
    await userEvent.keyboard('BKT-2026-000014{Enter}');
    expect(onScan.mock.calls).toEqual([
      ['BKT-2026-000014'],
      ['ST-2026-000003'],
      ['BKT-2026-000014'],
    ]);
  });

  it('reports paused only when focus leaves the scan panel', async () => {
    render(<Harness onScan={vi.fn()} onDuplicate={vi.fn()} now={() => 0} />);
    expect(screen.getByText('ready')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Inside control' }));
    expect(screen.getByText('ready')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('textbox', { name: 'Other field' }));
    expect(screen.getByText('paused')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('textbox', { name: 'Scan' }));
    expect(screen.getByText('ready')).toBeInTheDocument();
  });
});

describe('Scan labels page (TRP-T16 lookup mode)', () => {
  it('opens the scanned unit, and the next scan replaces it', async () => {
    const { fetchMock } = stubApi();
    renderAt('/sample-storage/scan');
    expect(await screen.findByRole('heading', { level: 1, name: 'Scan labels' })).toBeVisible();
    const field = screen.getByRole('textbox', { name: 'Scan a storage unit label' });
    await waitFor(() => expect(field).toHaveFocus());
    expect(screen.getByText('Ready to scan', { selector: '.scan-ready' })).toBeVisible();

    await userEvent.keyboard('bkt-2026-000014 {Enter}');
    expect(await screen.findByRole('status')).toHaveTextContent('Found BKT-2026-000014');
    const card = await screen.findByRole('region', { name: 'BKT-2026-000014' });
    expect(await within(card).findByText('DEMO-2601 · Riverbank investigation')).toBeVisible();
    expect(within(card).getByRole('link', { name: 'Open full record' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    // The last scanned value is shown as read (trimmed); the server normalises it.
    expect(screen.getByText('bkt-2026-000014', { selector: '.scan-last strong' })).toBeVisible();

    await userEvent.keyboard('ST-2026-000003{Enter}');
    expect(await screen.findByRole('region', { name: 'ST-2026-000003' })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'BKT-2026-000014' })).toBeNull();
    // The server does the normalising: the raw (trimmed) value is what's sent.
    expect(lookups(fetchMock)).toEqual(['bkt-2026-000014', 'ST-2026-000003']);
    // Scanning only reads.
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('AC3: unknown or malformed codes say "No storage unit found for …"', async () => {
    stubApi();
    renderAt('/sample-storage/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan labels' });
    await userEvent.keyboard('BKT-1999-000001{Enter}');
    expect(await screen.findByText('No storage unit found for BKT-1999-000001')).toBeVisible();
    await userEvent.keyboard('hello world{Enter}');
    expect(await screen.findByText('No storage unit found for hello world')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Open full record' })).toBeNull();
  });

  it('AC4: the same label twice within 2 s makes one lookup and says "Already scanned"', async () => {
    const { fetchMock } = stubApi();
    renderAt('/sample-storage/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan labels' });
    await userEvent.keyboard('BKT-2026-000014{Enter}');
    await screen.findByText('Found BKT-2026-000014');
    await userEvent.keyboard('BKT-2026-000014{Enter}');
    expect(await screen.findByText('Already scanned')).toBeVisible();
    expect(lookups(fetchMock)).toEqual(['BKT-2026-000014']);
  });

  it('AC5: server unreachable keeps the value on screen with Retry', async () => {
    const { fetchMock, state } = stubApi({ down: true });
    renderAt('/sample-storage/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan labels' });
    await userEvent.keyboard('BKT-2026-000014{Enter}');
    expect(await screen.findByRole('status')).toHaveTextContent(
      "BKT-2026-000014: Trapezoid couldn't be reached",
    );
    expect(screen.getByText('BKT-2026-000014', { selector: '.scan-last strong' })).toBeVisible();

    state.down = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Found BKT-2026-000014')).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Scan a storage unit label' })).toHaveFocus();
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('AC7: losing focus shows "Click here to resume scanning"', async () => {
    stubApi();
    renderAt('/sample-storage/scan');
    await screen.findByRole('heading', { level: 1, name: 'Scan labels' });
    await userEvent.click(screen.getByRole('heading', { level: 1, name: 'Scan labels' }));
    const resume = screen.getByRole('button', { name: /Click here to resume scanning/ });
    expect(screen.getByText('Scanning paused', { selector: '.scan-ready' })).toBeVisible();
    await userEvent.click(resume);
    expect(screen.getByRole('textbox', { name: 'Scan a storage unit label' })).toHaveFocus();
    expect(screen.queryByRole('button', { name: /resume scanning/ })).toBeNull();
  });

  it('is linked from Sample Storage', async () => {
    stubApi();
    renderAt('/sample-storage');
    expect(await screen.findByRole('link', { name: 'Scan labels' })).toHaveAttribute(
      'href',
      '/sample-storage/scan',
    );
  });
});

describe('Verify labels (TRP-T16)', () => {
  it('AC6: marks matches and warns about a third unit’s label', async () => {
    const { fetchMock } = stubApi();
    render(
      <VerifyLabelsPanel expectedIds={['BKT-2026-000014', 'BKT-2026-000015']} onClose={vi.fn()} />,
    );
    const list = screen.getByRole('list', { name: 'Expected labels' });
    expect(screen.getByText('0 of 2 labels verified')).toBeVisible();

    await userEvent.keyboard('BKT-2026-000014{Enter}');
    expect(await screen.findByText('Label matches BKT-2026-000014')).toBeVisible();
    expect(screen.getByText('1 of 2 labels verified')).toBeVisible();
    expect(within(list).getByText('BKT-2026-000014').parentElement).toHaveTextContent('Verified');

    await userEvent.keyboard('ST-2026-000003{Enter}');
    expect(
      await screen.findByText(
        'Wrong label: scanned ST-2026-000003 expected one of BKT-2026-000015',
      ),
    ).toBeVisible();
    expect(screen.getByText('1 of 2 labels verified')).toBeVisible();

    await userEvent.keyboard('BKT-2026-999999{Enter}');
    expect(await screen.findByText('No storage unit found for BKT-2026-999999')).toBeVisible();

    await userEvent.keyboard('bkt-2026-000015{Enter}');
    expect(await screen.findByText('Label matches BKT-2026-000015')).toBeVisible();
    expect(screen.getByText('2 of 2 labels verified')).toBeVisible();
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });
});
