import type { MeResponse, PrintJob, StorageLocation } from '@materialmule/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// Settings → Locations (MM-T37 T7 at component level, plus permission, conflict and LAB checks).
// Fictional locations and people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000201',
  displayName: 'Morgan Manager',
  initials: 'MM',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'label.print', 'location.manage'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  position: null,
  positionSetupRequired: false,
  profileRefreshFailed: false,
  ...overrides,
});
const MANAGER = me();
const TECH = me({ roles: [], permissions: ['inventory.read', 'label.print'], displayName: 'Tess' });
const LAB = me({
  id: '00000000-0000-4000-8000-000000000299',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
  roles: [],
  permissions: ['inventory.read', 'label.print'],
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function location(overrides: Partial<StorageLocation> = {}): StorageLocation {
  return {
    id: '00000000-0000-4000-8000-0000000000c1',
    code: 'WH-C1',
    name: 'Warehouse C1',
    kind: 'warehouse',
    area: 'Warehouse C',
    active: true,
    isSystem: false,
    retiredAt: null,
    retiredReason: null,
    codeLocked: false,
    labelPrintedAt: null,
    inStockCount: 0,
    createdAt: '2026-10-27T15:00:00.000Z',
    updatedAt: '2026-10-27T15:00:00.000Z',
    version: 1,
    ...overrides,
  };
}

const RECEIVING = location({
  id: '00000000-0000-4000-8000-0000000000a1',
  code: 'RECEIVING',
  name: 'Receiving lab',
  kind: 'receiving_lab',
  area: null,
  isSystem: true,
});

function job(overrides: Partial<PrintJob> = {}): PrintJob {
  return {
    id: '00000000-0000-4000-8000-000000000901',
    kind: 'initial',
    printerId: 'receiving',
    printerName: 'Receiving ZD621',
    templateVersion: 'location-v1',
    status: 'sent',
    attempts: 1,
    lastError: null,
    printerMessage: null,
    requestedBy: { userId: MANAGER.id, initials: 'MM', name: 'Morgan Manager' },
    receiver: null,
    createdAt: '2026-10-27T16:00:00.000Z',
    updatedAt: '2026-10-27T16:00:01.000Z',
    sentAt: '2026-10-27T16:00:01.000Z',
    physicallyConfirmedAt: null,
    physicallyConfirmedBy: null,
    target: 'location',
    items: [],
    locations: [
      {
        locationId: '00000000-0000-4000-8000-0000000000c1',
        code: 'WH-C1',
        name: 'Warehouse C1',
        payload: 'LOC-WH-C1',
        position: 1,
      },
    ],
    ...overrides,
  };
}

interface Call {
  method: string;
  url: string;
  body: unknown;
}

/** An in-memory fake of the locations API, recording every call. */
function fakeApi(
  initial: StorageLocation[],
  handlers: Partial<Record<string, (call: Call) => Response>> = {},
) {
  let locations = [...initial];
  let jobs: PrintJob[] = [];
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const call = { method, url, body };
    calls.push(call);
    const path = url.split('?')[0]!;
    const custom = handlers[`${method} ${path}`];
    if (custom) return custom(call);
    if (method === 'GET' && path === '/api/locations') {
      const params = new URL(url, 'http://x').searchParams;
      const search = (params.get('search') ?? '').toLowerCase();
      return json(
        200,
        locations.filter(
          (item) =>
            (params.get('includeRetired') === 'true' || item.active) &&
            (!search || `${item.code} ${item.name}`.toLowerCase().includes(search)),
        ),
      );
    }
    const detail = path.match(/^\/api\/locations\/([^/]+)$/);
    if (method === 'GET' && detail) {
      const found = locations.find((item) => item.id === detail[1]);
      return found
        ? json(200, { location: found, events: [], printJobs: jobs })
        : json(404, { code: 'location_not_found' });
    }
    if (method === 'GET' && /\/label\/preview$/.test(path)) {
      return json(200, {
        locationId: 'x',
        svg: '<svg xmlns="http://www.w3.org/2000/svg"/>',
        payload: 'LOC-WH-C1',
        templateVersion: 'location-v1',
        warnings: [],
      });
    }
    if (method === 'POST' && path === '/api/locations') {
      const created = location({
        id: '00000000-0000-4000-8000-0000000000c9',
        code: body.code,
        name: body.name,
        kind: body.kind,
        area: body.area,
      });
      locations = [...locations, created];
      return json(201, created);
    }
    if (method === 'PATCH' && detail) {
      const found = locations.find((item) => item.id === detail[1])!;
      const updated = { ...found, ...body, version: found.version + 1 };
      locations = locations.map((item) => (item.id === found.id ? updated : item));
      return json(200, updated);
    }
    const labels = path.match(/^\/api\/locations\/([^/]+)\/labels$/);
    if (method === 'POST' && labels) {
      const queued = job({
        status: 'queued',
        attempts: 0,
        sentAt: null,
        kind: jobs.length > 0 ? 'reprint' : 'initial',
      });
      jobs = [{ ...queued, id: `${queued.id.slice(0, -1)}${jobs.length}` }, ...jobs];
      locations = locations.map((item) =>
        item.id === labels[1] ? { ...item, codeLocked: true } : item,
      );
      return json(201, jobs[0]);
    }
    if (method === 'GET' && path === '/api/staff/receivers') {
      return json(200, [
        {
          id: '00000000-0000-4000-8000-000000000301',
          initials: 'JS',
          displayName: 'Jordan Smith',
          position: 'technician',
        },
      ]);
    }
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return { calls, setJobs: (next: PrintJob[]) => (jobs = next) };
}

function renderPage(session: MeResponse, path = '/settings/locations') {
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

beforeEach(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Locations (MM-T37)', () => {
  it('BUG-007: says when the list was cut at the server limit and how to find the rest', async () => {
    fakeApi([RECEIVING], {
      'GET /api/locations': () =>
        new Response(JSON.stringify([RECEIVING]), {
          status: 200,
          headers: { 'content-type': 'application/json', 'x-total-count': '734' },
        }),
    });
    renderPage(MANAGER);
    expect(
      await screen.findByText(
        'Showing the first 1 of 734 locations. Search by code, name or area to find the rest.',
      ),
    ).toBeTruthy();
  });

  it('replaces the placeholder with the list: name, code, kind, area, status, in-stock count', async () => {
    fakeApi([RECEIVING, location({ inStockCount: 3 })]);
    renderPage(MANAGER);
    const table = await screen.findByRole('table', { name: 'Locations' });
    expect(screen.queryByText(/arrives with MM-T37/)).toBeNull();
    const row = within(table).getByRole('row', { name: /Warehouse C1/ });
    expect(within(row).getByText('WH-C1')).toBeTruthy();
    expect(within(row).getByText('Warehouse')).toBeTruthy();
    expect(within(row).getByText('Warehouse C')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByRole('link', { name: '3 units at WH-C1' }).getAttribute('href')).toBe(
      '/sample-storage?locationId=00000000-0000-4000-8000-0000000000c1',
    );
    // Receiving lab: system, editable, never retirable.
    const system = within(table).getByRole('row', { name: /Receiving lab/ });
    expect(within(system).getByText('System')).toBeTruthy();
    expect(within(system).getByRole('button', { name: 'Edit Receiving lab' })).toBeTruthy();
    expect(within(system).queryByRole('button', { name: /Retire/ })).toBeNull();
    // Other Settings tabs are still there.
    const nav = screen.getByRole('navigation', { name: 'Settings' });
    for (const tab of ['My profile', 'My access', 'Locations']) {
      expect(within(nav).getByRole('link', { name: tab })).toBeTruthy();
    }
  });

  it('searches and includes retired locations only when asked', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi([
      location(),
      location({
        id: 'r',
        code: 'OLD-1',
        name: 'Old bay',
        active: false,
        retiredAt: '2026-10-01T00:00:00Z',
        retiredReason: 'Gone',
      }),
    ]);
    renderPage(MANAGER);
    await screen.findByRole('table', { name: 'Locations' });
    expect(screen.queryByText('Old bay')).toBeNull();
    await user.click(screen.getByRole('checkbox', { name: 'Include retired' }));
    expect(await screen.findByText('Old bay')).toBeTruthy();
    expect(screen.getByText('Retired')).toBeTruthy();
    await user.type(screen.getByRole('searchbox', { name: 'Search locations' }), 'old');
    await waitFor(() =>
      expect(calls.at(-1)!.url).toBe('/api/locations?search=old&includeRetired=true'),
    );
  });

  it('T7: adds a location with an upper-case code and shows inline errors first', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi([RECEIVING]);
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(
      within(dialog).getByText(/Use 2–20 letters, digits or hyphens/, { selector: '.field-error' }),
    ).toBeTruthy();
    expect(within(dialog).getByText('Name is required')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByRole('textbox', { name: 'Code' }), 'wh-c2');
    expect((within(dialog).getByRole('textbox', { name: 'Code' }) as HTMLInputElement).value).toBe(
      'WH-C2',
    );
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Warehouse C2');
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(await screen.findByText('Warehouse C2 was added.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'POST')!.body).toEqual({
      code: 'WH-C2',
      name: 'Warehouse C2',
      kind: 'warehouse',
      area: null,
    });
  });

  it('MTR-136: closing the Add location panel returns focus to Add location', async () => {
    const user = userEvent.setup();
    fakeApi([RECEIVING]);
    renderPage(MANAGER);
    const trigger = await screen.findByRole('button', { name: 'Add location' });
    await user.click(trigger);
    let dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull();
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    dialog = await screen.findByRole('dialog', { name: 'Add location' });
    fireEvent(dialog, new Event('cancel', { cancelable: true }));
    expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('shows a duplicate code as a field error', async () => {
    const user = userEvent.setup();
    fakeApi([location()], {
      'POST /api/locations': () =>
        json(409, {
          code: 'location_code_exists',
          message: 'A location with code WH-C1 already exists.',
          field: 'code',
        }),
    });
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Code' }), 'wh-c1');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Again');
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(
      await within(dialog).findByText('A location with code WH-C1 already exists.'),
    ).toBeTruthy();
    expect(within(dialog).getByRole('textbox', { name: 'Code' }).getAttribute('aria-invalid')).toBe(
      'true',
    );
  });

  it('edits only changed fields, keeps a locked code read-only, and reloads on a version conflict', async () => {
    const user = userEvent.setup();
    const locked = location({ codeLocked: true, version: 4 });
    const { calls } = fakeApi([locked], {
      'PATCH /api/locations/00000000-0000-4000-8000-0000000000c1': () =>
        json(409, {
          code: 'version_conflict',
          message: 'Someone else changed this location. Review the current details and try again.',
          current: { ...locked, name: 'Warehouse C1 (east)', version: 5 },
        }),
    });
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Edit Warehouse C1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Warehouse C1' });
    const code = within(dialog).getByRole('textbox', { name: 'Code' }) as HTMLInputElement;
    expect(code.readOnly).toBe(true);
    expect(within(dialog).getByText(/can’t change/)).toBeTruthy();
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Warehouse C1 north');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      name: 'Warehouse C1 north',
      version: 4,
    });
    expect(await screen.findByText(/Someone else changed this location/)).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'Edit Warehouse C1' })).toBeNull();
    // The list is read again.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url === '/api/locations').length,
      ).toBeGreaterThan(1),
    );
  });

  it('edit re-reads the location, so a code locked since the list loaded is read-only', async () => {
    const user = userEvent.setup();
    fakeApi([location()], {
      // The list row is stale; the server already has the code locked by a print.
      'GET /api/locations/00000000-0000-4000-8000-0000000000c1': () =>
        json(200, {
          location: location({ codeLocked: true, version: 2 }),
          events: [],
          printJobs: [],
        }),
    });
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Edit Warehouse C1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit Warehouse C1' });
    const code = (await within(dialog).findByRole('textbox', { name: 'Code' })) as HTMLInputElement;
    expect(code.readOnly).toBe(true);
  });

  it('retire asks for a reason and, when blocked, says how many units and links to them', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi([location()], {
      'POST /api/locations/00000000-0000-4000-8000-0000000000c1/retire': () =>
        json(409, {
          code: 'location_occupied',
          message:
            '3 storage units are still at this location. Move them before retiring the location.',
          inStockCount: 3,
        }),
    });
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Retire Warehouse C1' }));
    const dialog = await screen.findByRole('dialog', { name: 'Retire Warehouse C1' });
    await user.click(within(dialog).getByRole('button', { name: 'Retire location' }));
    expect(within(dialog).getByText('Give a reason')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/retire'))).toBe(false);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Rack removed');
    await user.click(within(dialog).getByRole('button', { name: 'Retire location' }));
    expect(
      await within(dialog).findByText(/3 storage units are still at this location/),
    ).toBeTruthy();
    expect(
      within(dialog).getByRole('link', { name: 'Show the 3 units at WH-C1' }).getAttribute('href'),
    ).toBe('/sample-storage?locationId=00000000-0000-4000-8000-0000000000c1');
    expect(calls.find((call) => call.url.endsWith('/retire'))!.body).toEqual({
      reason: 'Rack removed',
      version: 1,
    });
  });

  it('a Technician reads and prints but has no add, edit or retire actions', async () => {
    fakeApi([location()]);
    renderPage(TECH);
    const table = await screen.findByRole('table', { name: 'Locations' });
    expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Retire / })).toBeNull();
    expect(
      screen.getByText(/Only Lab Managers and administrators can add or change locations/),
    ).toBeTruthy();
    expect(
      within(table).getByRole('button', { name: 'Label and history for Warehouse C1' }),
    ).toBeTruthy();
  });

  it('a forbidden save (role removed meanwhile) is explained, not silently dropped', async () => {
    const user = userEvent.setup();
    fakeApi([RECEIVING], { 'POST /api/locations': () => json(403, { code: 'forbidden' }) });
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Code' }), 'WH-C5');
    await user.type(within(dialog).getByRole('textbox', { name: 'Name' }), 'Warehouse C5');
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(
      await within(dialog).findByText('Only Lab Managers and administrators can change locations.'),
    ).toBeTruthy();
  });

  it('prints a label through the queue and shows it waiting, not printed', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location()]);
    renderPage(MANAGER);
    await user.click(
      await screen.findByRole('button', { name: 'Label and history for Warehouse C1' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Warehouse C1' });
    expect(await within(drawer).findByText('LOC-WH-C1')).toBeTruthy();
    expect(within(drawer).getByText('Not printed yet')).toBeTruthy();
    expect(within(drawer).getByText(/Printing locks the code/)).toBeTruthy();
    await user.click(within(drawer).getByRole('button', { name: 'Print label' }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.endsWith('/labels'))!.body).toEqual({}),
    );
    expect((await within(drawer).findAllByText('Waiting to print')).length).toBeGreaterThan(0);
    // While the job is with the worker there is nothing to reprint yet.
    expect(within(drawer).queryByRole('button', { name: 'Reprint label' })).toBeNull();
    expect(within(drawer).getByText('Sent or queued; not yet confirmed as printed')).toBeTruthy();
  });

  it('"Sent to printer" is not a physical print: a person confirms, then Reprint is offered', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location({ codeLocked: true })]);
    api.setJobs([job()]);
    renderPage(MANAGER);
    await user.click(
      await screen.findByRole('button', { name: 'Label and history for Warehouse C1' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Warehouse C1' });
    expect((await within(drawer).findAllByText('Sent to printer')).length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Sent or queued; not yet confirmed as printed')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Reprint label' })).toBeTruthy();
    await user.click(within(drawer).getAllByRole('button', { name: 'Labels came out OK' })[0]!);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/confirm-physical'))).toBe(true),
    );
  });

  it('AC8: a LAB station must choose who is printing and never sees administration', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location()]);
    renderPage(LAB);
    const table = await screen.findByRole('table', { name: 'Locations' });
    // MISC-04 (Kyle 2026-10-30): a print-only view; no add, edit or retire for LAB.
    expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Edit / })).toBeNull();
    expect(within(table).queryByRole('button', { name: /^Retire / })).toBeNull();
    await user.click(
      within(table).getByRole('button', { name: 'Label and history for Warehouse C1' }),
    );
    const drawer = await screen.findByRole('dialog', { name: 'Warehouse C1' });
    await user.click(await within(drawer).findByRole('button', { name: 'Print label' }));
    expect(within(drawer).getByText('Choose who is printing this label.')).toBeTruthy();
    expect(api.calls.some((call) => call.url.endsWith('/labels'))).toBe(false);

    await user.type(within(drawer).getByRole('combobox', { name: /Printed by/ }), 'JS');
    await user.click(await within(drawer).findByRole('option', { name: /Jordan Smith/ }));
    await user.click(within(drawer).getByRole('button', { name: 'Print label' }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.endsWith('/labels'))!.body).toEqual({
        receiverUserId: '00000000-0000-4000-8000-000000000301',
      }),
    );
  });
});
