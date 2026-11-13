import type { LabelPreview, MeResponse, PrintJob } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, MemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson, TEST_STATION_PERSON } from '../session/station-test-person';
import { LabelPreviewPanel } from './LabelPreviewPanel';

// MM-T39 (T2): preview panel states and zoom, and the print view.

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" width="3.5in" height="1.5in" viewBox="0 0 1050 450">' +
  '<text>&lt;script&gt;alert(1)&lt;/script&gt;</text></svg>';

function preview(overrides: Partial<LabelPreview> = {}): LabelPreview {
  return {
    storageUnitId: '00000000-0000-4000-8000-000000000501',
    readableId: 'BKT-2026-000014',
    svg: SVG,
    templateVersion: 'sticker-v1',
    warnings: [],
    disposed: false,
    ...overrides,
  };
}

function printJob(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: 'job-1',
    kind: 'reprint',
    printerId: 'receiving',
    printerName: 'Receiving ZD621',
    templateVersion: 'sticker-v1',
    status: 'queued',
    attempts: 0,
    lastError: null,
    printerMessage: null,
    requestedBy: { userId: 'u1', initials: null, name: 'LAB' },
    receiver: null,
    createdAt: '2026-10-26T16:00:00.000Z',
    updatedAt: '2026-10-26T16:00:00.000Z',
    sentAt: null,
    physicallyConfirmedAt: null,
    physicallyConfirmedBy: null,
    target: 'storage_unit',
    items: [{ storageUnitId: 'id-0', readableId: 'BKT-2026-000014', position: 1 }],
    locations: [],
    ...overrides,
  };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function stubApi(handler: (url: string, init?: RequestInit) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    return handler(String(input), init) ?? json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

const me: MeResponse = {
  id: 'u1',
  displayName: 'Lab station',
  initials: null,
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
};

function renderRoute(path: string, user: MeResponse = me) {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  pickStationPerson(user);
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

function renderPanel(props: Parameters<typeof LabelPreviewPanel>[0]) {
  render(
    <MemoryRouter>
      <LabelPreviewPanel {...props} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('LabelPreviewPanel', () => {
  it('shows the label as an image at true size, with zoom, and never injects the SVG', async () => {
    const fetchMock = stubApi((url) =>
      url === '/api/storage-units/BKT-2026-000014/label/preview' ? json(200, preview()) : undefined,
    );
    const user = userEvent.setup();
    renderPanel({ storageUnit: 'BKT-2026-000014' });

    expect(screen.getByText('Loading label preview…')).toHaveAttribute('aria-busy', 'true');
    const image = await screen.findByRole('img', {
      name: 'Label for storage unit BKT-2026-000014',
    });
    expect(image.getAttribute('src')).toBe(
      `data:image/svg+xml;charset=utf-8,${encodeURIComponent(SVG)}`,
    );
    // The SVG is an image source, never markup in the page.
    // (Lucide icons are the only inline SVGs.)
    expect(document.querySelector('svg:not(.lucide)')).toBeNull();
    expect(document.querySelector('svg text')).toBeNull();
    expect(document.body.innerHTML).not.toContain('<script>');
    expect(screen.getByText('Shown at the real size, 3.5 × 1.5 in.')).toBeInTheDocument();
    expect(screen.getByText(/the ZD621 print is the final check/)).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Fit warnings' })).toBeNull();

    const zoom = screen.getByRole('button', { name: 'Zoom in' });
    expect(zoom).toHaveAttribute('aria-pressed', 'false');
    await user.click(zoom);
    expect(zoom).toHaveAttribute('aria-pressed', 'true');
    expect(image.parentElement).toHaveClass('zoomed');
    expect(screen.getByText('Zoomed to twice the real size.')).toBeInTheDocument();
    await user.click(zoom);
    expect(image.parentElement).not.toHaveClass('zoomed');

    expect(screen.getByRole('link', { name: 'Print / Save as PDF' })).toHaveAttribute(
      'href',
      '/labels/print/unit/BKT-2026-000014',
    );
    // Previewing is a read: no print job is requested.
    expect(fetchMock.mock.calls.every(([, init]) => (init?.method ?? 'GET') === 'GET')).toBe(true);
  });

  it('lists fit warnings in plain language and offers the receipt print view', async () => {
    stubApi(() =>
      json(
        200,
        preview({
          warnings: ['Project name shortened to fit', '2 test holes not shown; the sticker says'],
        }),
      ),
    );
    renderPanel({ storageUnit: 'BKT-2026-000014', receipt: { id: 'r1', quantity: 3 } });
    const warnings = await screen.findByRole('list', { name: 'Fit warnings' });
    expect(
      within(warnings)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual(['Project name shortened to fit', '2 test holes not shown; the sticker says']);
    expect(
      screen.getByRole('link', { name: 'Print / Save all 3 labels of this receipt' }),
    ).toHaveAttribute('href', '/labels/print/receipt/r1?from=BKT-2026-000014');
  });

  it('opens print views in a new tab from the receiving wizard', async () => {
    stubApi(() => json(200, preview()));
    renderPanel({ storageUnit: 'BKT-2026-000014', openInNewTab: true });
    expect(await screen.findByRole('link', { name: 'Print / Save as PDF' })).toHaveAttribute(
      'target',
      '_blank',
    );
  });

  it('MM-T55: dual layout puts the preview card beside the print view card', async () => {
    stubApi(() => json(200, preview({ warnings: ['Project name shortened to fit'] })));
    renderPanel({ storageUnit: 'BKT-2026-000014', layout: 'dual', id: 'label-preview' });

    const previewCard = await screen.findByRole('group', { name: 'Preview label' });
    expect(previewCard).toHaveAttribute('id', 'label-preview');
    expect(await within(previewCard).findByText('Template sticker-v1')).toBeInTheDocument();
    expect(
      within(previewCard).getByRole('img', { name: 'Label for storage unit BKT-2026-000014' }),
    ).toBeInTheDocument();
    expect(within(previewCard).getByRole('heading', { name: 'Fit warnings' })).toBeInTheDocument();
    const pdf = within(previewCard).getByRole('link', { name: 'Print / Save as PDF' });
    expect(pdf).toHaveAttribute('href', '/labels/print/unit/BKT-2026-000014');
    expect(pdf).toHaveAttribute('target', '_blank');

    const printView = screen.getByRole('group', { name: 'Print view · 1 label' });
    expect(within(printView).getByText('Opens in a new tab')).toBeInTheDocument();
    expect(within(printView).getByText(/100% \(Actual size\)/)).toBeInTheDocument();
    expect(within(printView).getByText(/creates no print job/)).toBeInTheDocument();
    const pages = within(printView).getByLabelText('Pages in the print view');
    expect(within(pages).getByText('Page 1 of 1')).toBeInTheDocument();
    expect(
      within(pages).getByRole('img', { name: 'Page 1: label for storage unit BKT-2026-000014' }),
    ).toBeInTheDocument();
  });

  it('MTR-48: a disposed unit keeps its watermarked preview but offers no print view', async () => {
    stubApi((url) =>
      url === '/api/storage-units/BKT-2026-000014/label/preview'
        ? json(200, preview({ disposed: true }))
        : undefined,
    );
    renderPanel({ storageUnit: 'BKT-2026-000014', layout: 'dual' });
    expect(await screen.findByRole('img', { name: /BKT-2026-000014/ })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Print \/ Save as PDF/ })).toBeNull();
    expect(screen.getAllByText(/its label is not printed again/).length).toBeGreaterThan(0);
    expect(screen.queryByLabelText('Pages in the print view')).toBeNull();
  });

  it('shows an error with Retry, then the label', async () => {
    let calls = 0;
    stubApi(() => {
      calls += 1;
      return calls === 1 ? json(500, {}) : json(200, preview());
    });
    const user = userEvent.setup();
    renderPanel({ storageUnit: 'BKT-2026-000014' });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Material Mule had a problem with that request. Try again.');
    expect(alert).not.toHaveTextContent('500');
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('img')).toBeInTheDocument();
  });

  it('says when the unit does not exist', async () => {
    stubApi(() => json(404, { code: 'storage_unit_not_found' }));
    renderPanel({ storageUnit: 'BKT-2026-999999' });
    expect(
      await screen.findByText('No storage unit found, so there is no label to preview.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull();
  });
});

describe('LabelPrintPage', () => {
  it('holds every label of a receipt in order, one 3.5 × 1.5 in page each, with no app chrome', async () => {
    const ids = ['BKT-2026-000015', 'BKT-2026-000014', 'ST-2026-000003'];
    stubApi((url) =>
      url === '/api/receipts/r1/labels/preview'
        ? json(200, {
            receiptId: 'r1',
            labels: ids.map((readableId, index) =>
              preview({ readableId, storageUnitId: `id-${index}` }),
            ),
          })
        : undefined,
    );
    renderRoute('/labels/print/receipt/r1');

    expect(await screen.findByRole('heading', { name: 'Print labels' })).toBeInTheDocument();
    expect(screen.getByText('Labels for the 3 units on this receipt.')).toBeInTheDocument();
    const sheet = screen.getByLabelText('Labels to print');
    expect(
      within(sheet)
        .getAllByRole('img')
        .map((img) => img.getAttribute('alt')),
    ).toEqual(ids.map((id) => `Label for storage unit ${id}`));
    expect(screen.getByText(/100% \(Actual size\)/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save as PDF' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print 3 labels' })).toBeInTheDocument();
    // Choose the labels: one checkbox per unit, plus all of them.
    expect(screen.getByRole('checkbox', { name: 'Print all 3 labels' })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: 'Print ST-2026-000003' })).toBeChecked();
    const styles = [...document.querySelectorAll('style')].map((style) => style.textContent);
    expect(styles.join(' ')).toContain('@page { size: 3.5in 1.5in; margin: 0; }');
    // No app chrome: no sidebar on the print view, only the breadcrumb.
    expect(document.querySelector('[data-slot="sidebar"]')).toBeNull();
    expect(screen.getByRole('navigation', { name: 'breadcrumb' })).toBeInTheDocument();
  });

  it('prints one unit with the browser print dialog and never requests a print job', async () => {
    const fetchMock = stubApi((url) =>
      url === '/api/storage-units/BKT-2026-000014/label/preview' ? json(200, preview()) : undefined,
    );
    const print = vi.fn();
    vi.stubGlobal('print', print);
    const user = userEvent.setup();
    renderRoute('/labels/print/unit/BKT-2026-000014');

    expect(await screen.findByRole('heading', { name: 'Print label' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'BKT-2026-000014' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000014',
    );
    expect(screen.getByText("A PDF isn't recorded as a print.")).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Save as PDF' }));
    expect(print).toHaveBeenCalledOnce();
    // Only the preview: no print job (the station's staff list is the Recording as chip's).
    expect(
      fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url !== '/api/staff/active'),
    ).toEqual(['/api/storage-units/BKT-2026-000014/label/preview']);
  });

  it('MM-T61: a receipt print view opened from a unit links back to that unit', async () => {
    const ids = ['BKT-2026-000014', 'BKT-2026-000015'];
    stubApi((url) =>
      url === '/api/receipts/r1/labels/preview'
        ? json(200, {
            receiptId: 'r1',
            labels: ids.map((readableId, index) =>
              preview({ readableId, storageUnitId: `id-${index}` }),
            ),
          })
        : undefined,
    );
    renderRoute('/labels/print/receipt/r1?from=BKT-2026-000015');
    expect(await screen.findByRole('heading', { name: 'Print labels' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'BKT-2026-000015' })).toHaveAttribute(
      'href',
      '/sample-storage/BKT-2026-000015',
    );
  });

  it('MM-T61: ignores a "from" unit that is not on the receipt', async () => {
    stubApi((url) =>
      url === '/api/receipts/r1/labels/preview'
        ? json(200, { receiptId: 'r1', labels: [preview()] })
        : undefined,
    );
    renderRoute('/labels/print/receipt/r1?from=BKT-2026-000099');
    expect(await screen.findByRole('heading', { name: 'Print label' })).toBeVisible();
    expect(screen.getByRole('link', { name: 'Inventory' })).toHaveAttribute(
      'href',
      '/sample-storage',
    );
    expect(screen.queryByRole('link', { name: 'BKT-2026-000099' })).toBeNull();
  });

  it('MTR-48: a disposed unit has no printable label, only the reason', async () => {
    stubApi((url) =>
      url === '/api/storage-units/BKT-2026-000014/label/preview'
        ? json(200, preview({ disposed: true }))
        : undefined,
    );
    renderRoute('/labels/print/unit/BKT-2026-000014');
    expect(await screen.findByRole('heading', { name: 'Print label' })).toBeVisible();
    expect(screen.getByRole('status')).toHaveTextContent(
      'This storage unit is disposed; its label is not printed again.',
    );
    expect(screen.queryByLabelText('Labels to print')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Print/ })).toBeNull();
  });

  it('MTR-48: a receipt print view skips disposed units and names them', async () => {
    stubApi((url) =>
      url === '/api/receipts/r1/labels/preview'
        ? json(200, {
            receiptId: 'r1',
            labels: [
              preview({ readableId: 'BKT-2026-000014', storageUnitId: 'a' }),
              preview({ readableId: 'BKT-2026-000015', storageUnitId: 'b', disposed: true }),
              preview({ readableId: 'BKT-2026-000016', storageUnitId: 'c' }),
            ],
          })
        : undefined,
    );
    renderRoute('/labels/print/receipt/r1');
    expect(await screen.findByRole('heading', { name: 'Print labels' })).toBeInTheDocument();
    expect(screen.getByRole('status')).toHaveTextContent(
      'Disposed units are not printed again: BKT-2026-000015.',
    );
    expect(
      within(screen.getByLabelText('Labels to print'))
        .getAllByRole('img')
        .map((img) => img.getAttribute('alt')),
    ).toEqual(['Label for storage unit BKT-2026-000014', 'Label for storage unit BKT-2026-000016']);
  });

  it('says when the receipt does not exist', async () => {
    stubApi(() => json(404, { code: 'receipt_not_found' }));
    renderRoute('/labels/print/receipt/missing');
    expect(await screen.findByText('No receipt found.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save as PDF' })).toBeNull();
  });

  it('STRATA-125: on a LAB station Printed by is the recording person, sent with each copy', async () => {
    const posts: unknown[] = [];
    stubApi((url, init) => {
      if (url === '/api/storage-units/BKT-2026-000014/label/preview') return json(200, preview());
      if (url === '/api/print-jobs' && init?.method === 'POST') {
        posts.push(JSON.parse(String(init.body)));
        return json(201, printJob({ id: `job-${posts.length}`, status: 'sent' }));
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute('/labels/print/unit/BKT-2026-000014');

    const printedBy = await screen.findByLabelText('Printed by');
    expect(printedBy).toHaveValue('AT · Alex Tester');
    expect(printedBy).toHaveAttribute('readonly');
    // Not an administrator: the default printer from Settings › Printers.
    expect(screen.getByRole('combobox', { name: 'Printer' })).toHaveTextContent(
      'Default label printer',
    );
    await user.clear(screen.getByLabelText('Copies'));
    await user.type(screen.getByLabelText('Copies'), '2');
    await user.click(screen.getByRole('button', { name: 'Print 1 label' }));

    expect(await screen.findByText('Copy 2 of 2')).toBeInTheDocument();
    expect(screen.getAllByText('Sent to printer')).toHaveLength(2);
    expect(screen.queryByText('Printed (confirmed)')).toBeNull();
    const request = {
      storageUnitIds: [preview().storageUnitId],
      kind: 'reprint',
      receiverUserId: TEST_STATION_PERSON.id,
    };
    expect(posts).toEqual([request, request]);
  });

  it('a personal account has no Printed by and is told when copies are out of range', async () => {
    stubApi((url) =>
      url === '/api/storage-units/BKT-2026-000014/label/preview' ? json(200, preview()) : undefined,
    );
    const user = userEvent.setup();
    renderRoute('/labels/print/unit/BKT-2026-000014', {
      ...me,
      displayName: 'Alex Tester',
      initials: 'AT',
      accountType: 'test',
    });
    await screen.findByRole('heading', { name: 'Print label' });
    expect(screen.queryByLabelText('Printed by')).toBeNull();
    await user.clear(screen.getByLabelText('Copies'));
    await user.type(screen.getByLabelText('Copies'), '11');
    expect(screen.getByText('Enter 1 to 10.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Print 1 label' })).toBeDisabled();
  });

  it("failure: the printer didn't answer, Try again reprints the same units, PDF stays", async () => {
    const posts: unknown[] = [];
    stubApi((url, init) => {
      if (url === '/api/receipts/r1/labels/preview') {
        return json(200, {
          receiptId: 'r1',
          labels: ['BKT-2026-000014', 'BKT-2026-000015', 'BKT-2026-000016'].map(
            (readableId, index) => preview({ readableId, storageUnitId: `id-${index}` }),
          ),
        });
      }
      if (url === '/api/print-jobs' && init?.method === 'POST') {
        const body = JSON.parse(String(init.body)) as { storageUnitIds: string[] };
        posts.push(body);
        const items = body.storageUnitIds.map((storageUnitId, index) => ({
          storageUnitId,
          readableId: storageUnitId,
          position: index + 1,
        }));
        return json(
          201,
          posts.length === 1
            ? printJob({ id: 'job-1', status: 'failed', attempts: 3, items })
            : printJob({ id: 'job-2', status: 'sent', items }),
        );
      }
      return undefined;
    });
    const user = userEvent.setup();
    renderRoute('/labels/print/receipt/r1');

    await screen.findByRole('heading', { name: 'Print labels' });
    // Leave one label out; the preview pages through the chosen ones.
    await user.click(screen.getByRole('checkbox', { name: 'Print BKT-2026-000015' }));
    expect(screen.getByText('2 of 3 units chosen')).toBeInTheDocument();
    expect(screen.getByText('1 of 2')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next label' }));
    expect(screen.getByText('2 of 2')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Print 2 labels' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("The printer didn't answer.");
    expect(screen.queryByRole('button', { name: 'Print 2 labels' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Save as PDF' })).toBeEnabled();

    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Sent to printer')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    // Try again is a new job for exactly the same units: no ID changes, no receipt call.
    expect(posts[1]).toEqual(posts[0]);
    expect(posts[0]).toMatchObject({ storageUnitIds: ['id-0', 'id-2'], kind: 'reprint' });
  });
});
