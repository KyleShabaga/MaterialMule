import type { MeResponse, PrintJob, StorageLocation } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '../../components/strata/toast';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';
import { TEST_STATION_PERSON, pickStationPerson } from '../../session/station-test-person';

// Lab admin › Locations (MM-T37 T7 at component level, plus permission, conflict and LAB checks;
// STRATA-102 tree, paging and drawer).
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
  pickStationPerson(session);
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return router;
}

/** Opens a location's drawer from its name in the tree (a Sheet under 1024 px, as in jsdom). */
async function openDrawer(user: ReturnType<typeof userEvent.setup>, name: string) {
  const table = await screen.findByRole('table', { name: 'Locations' });
  await user.click(within(table).getByRole('button', { name }));
  return screen.findByRole('dialog', { name });
}

/** Turns on "Include retired" in the toolbar's Filter menu. */
async function includeRetired(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: 'Filter' }));
  await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Include retired' }));
  await user.keyboard('{Escape}');
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Lab admin › Locations (MM-T37, STRATA-102)', () => {
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

  it('shows the tree: areas over their locations, code, in stock, status; the system location first', async () => {
    fakeApi([
      location({ inStockCount: 3 }),
      location({ id: 'c3', code: 'WH-C3', name: 'Warehouse C3', inStockCount: 2 }),
      RECEIVING,
    ]);
    renderPage(MANAGER);
    const table = await screen.findByRole('table', { name: 'Locations' });
    // Receiving (system, no area) comes first, then the area "Warehouse C".
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('Receiving lab');
    const area = within(table).getByRole('rowheader', { name: 'Warehouse C' });
    expect(area.closest('tr')).toHaveTextContent('5');
    const row = within(table).getByRole('row', { name: /Warehouse C1/ });
    expect(within(row).getByText('WH-C1')).toBeTruthy();
    expect(within(row).getByText('Active')).toBeTruthy();
    expect(within(row).getByRole('link', { name: '3 units at WH-C1' }).getAttribute('href')).toBe(
      '/sample-storage?locationId=00000000-0000-4000-8000-0000000000c1',
    );
    const system = within(table).getByRole('row', { name: /Receiving lab/ });
    expect(within(system).getByText('System')).toBeTruthy();
    expect(within(system).getByText('(code locked)')).toBeTruthy();
    // STRATA-128: Locations is a Lab admin page with its tabs; the layout owns the only heading.
    const tabs = screen.getByRole('navigation', { name: 'Lab administration' });
    expect(within(tabs).getByRole('link', { name: 'Locations' })).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Locations', level: 2 })).toBeNull();
    expect(screen.getByText('Places 1–2 of 2 · 3 locations')).toBeTruthy();
  });

  it('collapses and expands an area', async () => {
    const user = userEvent.setup();
    fakeApi([location()]);
    renderPage(MANAGER);
    const toggle = await screen.findByRole('button', { name: 'Warehouse C' });
    expect(toggle).toHaveAttribute('aria-expanded', 'true');
    await user.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('button', { name: 'Warehouse C1' })).toBeNull();
    await user.click(toggle);
    expect(screen.getByRole('button', { name: 'Warehouse C1' })).toBeTruthy();
  });

  it('pages by top-level place, 10 per page, never splitting an area', async () => {
    const user = userEvent.setup();
    const many = Array.from({ length: 11 }, (_, index) =>
      location({
        id: `p${index}`,
        code: `P-${index}`,
        name: `Place ${String(index).padStart(2, '0')}`,
        area: null,
      }),
    );
    // Four locations in one area count as one place, all on the page where the area starts.
    const bay = Array.from({ length: 4 }, (_, index) =>
      location({ id: `b${index}`, code: `BAY-${index}`, name: `Bay ${index}`, area: 'Yard' }),
    );
    fakeApi([...many, ...bay]);
    renderPage(MANAGER);
    expect(await screen.findByText('Places 1–10 of 12 · 15 locations')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Place 10' })).toBeNull();
    await user.click(screen.getByRole('link', { name: 'Page 2' }));
    expect(await screen.findByText('Places 11–12 of 12 · 15 locations')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Place 10' })).toBeTruthy();
    for (const name of ['Bay 0', 'Bay 1', 'Bay 2', 'Bay 3']) {
      expect(screen.getByRole('button', { name })).toBeTruthy();
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
    await includeRetired(user);
    expect(await screen.findByText('Old bay')).toBeTruthy();
    expect(screen.getByText('Retired')).toBeTruthy();
    expect(screen.getByText('2 locations · 1 retired')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Search' }));
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
    expect(within(dialog).getAllByText(/Use 2–20 letters, digits or hyphens/)).toHaveLength(1);
    expect(within(dialog).getByText('Name is required')).toBeTruthy();
    expect(calls.some((call) => call.method === 'POST')).toBe(false);

    await user.type(within(dialog).getByRole('textbox', { name: 'Code' }), 'wh-c2');
    expect(within(dialog).getByRole('textbox', { name: 'Code' })).toHaveValue('WH-C2');
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

  it('MTR-136: closing the Add location dialog returns focus to Add location', async () => {
    const user = userEvent.setup();
    fakeApi([RECEIVING]);
    renderPage(MANAGER);
    const trigger = await screen.findByRole('button', { name: 'Add location' });
    await user.click(trigger);
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());
    expect(trigger).toHaveFocus();

    await user.click(trigger);
    await screen.findByRole('dialog', { name: 'Add location' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Add location' })).toBeNull());
    expect(trigger).toHaveFocus();
  });

  it('MTR-133: Code and Name are marked required; an empty add focuses Code once', async () => {
    const user = userEvent.setup();
    fakeApi([RECEIVING]);
    renderPage(MANAGER);
    await user.click(await screen.findByRole('button', { name: 'Add location' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add location' });
    const code = within(dialog).getByRole('textbox', { name: 'Code' });
    const name = within(dialog).getByRole('textbox', { name: 'Name' });
    expect(within(dialog).getAllByText('(required)')).toHaveLength(2);
    expect(code).toBeRequired();
    expect(name).toBeRequired();

    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(code).toHaveFocus();
    expect(code).toHaveAttribute('aria-invalid', 'true');
    expect(name).toHaveAttribute('aria-invalid', 'true');
    // The rule is said once, in the error, not again in the hint.
    expect(within(dialog).getAllByText(/Use 2–20 letters, digits or hyphens/)).toHaveLength(1);

    await user.type(code, 'WH-C3');
    await user.click(within(dialog).getByRole('button', { name: 'Add location' }));
    expect(name).toHaveFocus();
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
    expect(within(dialog).getByRole('textbox', { name: 'Code' })).toHaveAttribute(
      'aria-invalid',
      'true',
    );
  });

  it('edits in the drawer: only changed fields, a locked code read-only, a conflict reloads', async () => {
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
    const drawer = await openDrawer(user, 'Warehouse C1');
    const code = await within(drawer).findByRole('textbox', { name: 'Code' });
    expect(code).toHaveAttribute('readonly');
    const name = within(drawer).getByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Warehouse C1 north');
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      name: 'Warehouse C1 north',
      version: 4,
    });
    expect(await within(drawer).findByText(/Someone else changed this location/)).toBeTruthy();
    // The list is read again.
    await waitFor(() =>
      expect(
        calls.filter((call) => call.method === 'GET' && call.url === '/api/locations').length,
      ).toBeGreaterThan(1),
    );
  });

  it('saves a change and says so', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi([location()]);
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    const name = await within(drawer).findByRole('textbox', { name: 'Name' });
    await user.clear(name);
    await user.type(name, 'Warehouse C1 north');
    await user.click(within(drawer).getByRole('button', { name: 'Save changes' }));
    expect(await screen.findByText('Warehouse C1 north was saved.')).toBeTruthy();
    expect(calls.find((call) => call.method === 'PATCH')!.body).toEqual({
      name: 'Warehouse C1 north',
      version: 1,
    });
  });

  it('the drawer reads the location again, so a code locked since the list loaded is read-only', async () => {
    const user = userEvent.setup();
    fakeApi([location()], {
      'GET /api/locations/00000000-0000-4000-8000-0000000000c1': () =>
        json(200, {
          location: location({ codeLocked: true, version: 2 }),
          events: [],
          printJobs: [],
        }),
    });
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    expect(await within(drawer).findByRole('textbox', { name: 'Code' })).toHaveAttribute(
      'readonly',
    );
  });

  it('the system location keeps its code and kind, and has no Retire', async () => {
    const user = userEvent.setup();
    fakeApi([RECEIVING]);
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Receiving lab');
    expect(await within(drawer).findByRole('textbox', { name: 'Code' })).toHaveAttribute(
      'readonly',
    );
    expect(within(drawer).getAllByText('The system location’s code can’t change.').length).toBe(2);
    expect(within(drawer).queryByRole('combobox', { name: 'Kind' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Retire/ })).toBeNull();
  });

  it('retire asks for a reason; when units arrived meanwhile it says how many and opens the shelf', async () => {
    const user = userEvent.setup();
    const { calls } = fakeApi([location()], {
      'POST /api/locations/00000000-0000-4000-8000-0000000000c1/retire': () =>
        json(409, {
          code: 'location_occupied',
          message: '3 storage units are still at this location.',
          inStockCount: 3,
        }),
    });
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    await user.click(await within(drawer).findByRole('button', { name: 'Retire location…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Retire WH-C1?' });
    await user.click(within(dialog).getByRole('button', { name: 'Retire location' }));
    expect(within(dialog).getByText('Give a reason')).toBeTruthy();
    expect(calls.some((call) => call.url.endsWith('/retire'))).toBe(false);
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Rack removed');
    await user.click(within(dialog).getByRole('button', { name: 'Retire location' }));
    const blocked = await screen.findByRole('alertdialog', { name: 'WH-C1 can’t be retired' });
    expect(within(blocked).getByText(/3 storage units are at this location/)).toBeTruthy();
    expect(within(blocked).getByRole('link', { name: 'Open shelf page' })).toHaveAttribute(
      'href',
      '/sample-storage/locations/WH-C1',
    );
    expect(calls.find((call) => call.url.endsWith('/retire'))!.body).toEqual({
      reason: 'Rack removed',
      version: 1,
    });
  });

  it('a location holding units goes straight to "can’t be retired"', async () => {
    const user = userEvent.setup();
    fakeApi([location({ inStockCount: 1 })]);
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    await user.click(await within(drawer).findByRole('button', { name: 'Retire location…' }));
    const blocked = await screen.findByRole('alertdialog', { name: 'WH-C1 can’t be retired' });
    expect(within(blocked).getByText(/1 storage unit is at this location/)).toBeTruthy();
    expect(within(blocked).queryByRole('textbox', { name: 'Reason' })).toBeNull();
  });

  it('retires with a reason', async () => {
    const user = userEvent.setup();
    fakeApi([location()], {
      'POST /api/locations/00000000-0000-4000-8000-0000000000c1/retire': () =>
        json(200, location({ active: false, retiredAt: '2026-11-01T00:00:00Z', version: 2 })),
    });
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    await user.click(await within(drawer).findByRole('button', { name: 'Retire location…' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Retire WH-C1?' });
    await user.type(within(dialog).getByRole('textbox', { name: 'Reason' }), 'Rack removed');
    await user.click(within(dialog).getByRole('button', { name: 'Retire location' }));
    expect(await screen.findByText('Warehouse C1 was retired.')).toBeTruthy();
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  });

  it('a Technician reads and prints but has no add, edit or retire actions', async () => {
    const user = userEvent.setup();
    fakeApi([location()]);
    renderPage(TECH);
    await screen.findByRole('table', { name: 'Locations' });
    expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
    expect(
      screen.getByText(/Only Lab Managers and administrators can add or change locations/),
    ).toBeTruthy();
    const drawer = await openDrawer(user, 'Warehouse C1');
    expect(await within(drawer).findByRole('button', { name: 'Print label' })).toBeTruthy();
    expect(within(drawer).queryByRole('textbox', { name: 'Name' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Retire/ })).toBeNull();
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

  it('the drawer address is ?open=<id>, so a reload restores it', async () => {
    fakeApi([location()]);
    renderPage(MANAGER, '/admin/locations?open=00000000-0000-4000-8000-0000000000c1');
    const drawer = await screen.findByRole('dialog', { name: 'Warehouse C1' });
    expect(await within(drawer).findByText('LOC-WH-C1')).toBeTruthy();
  });

  it('prints a label through the queue and shows it waiting, not printed', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location()]);
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
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

  it('from 1024 px the drawer sits beside the list; Esc closes it and focus returns to the row', async () => {
    const user = userEvent.setup();
    vi.stubGlobal(
      'matchMedia',
      (query: string) =>
        ({
          matches: query === '(min-width: 1024px)',
          media: query,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
        }) as unknown as MediaQueryList,
    );
    fakeApi([location(), location({ id: 'c3', code: 'WH-C3', name: 'Warehouse C3' })]);
    renderPage(MANAGER);
    const table = await screen.findByRole('table', { name: 'Locations' });
    const name = within(table).getByRole('button', { name: 'Warehouse C1' });
    await user.click(name);
    const drawer = await screen.findByRole('region', { name: 'Warehouse C1' });
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(within(drawer).getByText('1 of 2')).toBeTruthy();
    await user.click(within(drawer).getByRole('button', { name: 'Next' }));
    expect(await screen.findByRole('region', { name: 'Warehouse C3' })).toBeTruthy();
    await user.click(within(table).getByRole('button', { name: 'Warehouse C1' }));
    await screen.findByRole('region', { name: 'Warehouse C1' });
    await user.keyboard('{Escape}');
    await waitFor(() => expect(screen.queryByRole('region', { name: 'Warehouse C1' })).toBeNull());
    expect(within(table).getByRole('button', { name: 'Warehouse C1' })).toHaveFocus();
  });

  it('"Sent to printer" is not a physical print: a person confirms, then Reprint is offered', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location({ codeLocked: true })]);
    api.setJobs([job()]);
    renderPage(MANAGER);
    const drawer = await openDrawer(user, 'Warehouse C1');
    expect((await within(drawer).findAllByText('Sent to printer')).length).toBeGreaterThan(0);
    expect(within(drawer).getByText('Sent or queued; not yet confirmed as printed')).toBeTruthy();
    expect(within(drawer).getByRole('button', { name: 'Reprint label' })).toBeTruthy();
    await user.click(within(drawer).getAllByRole('button', { name: 'Labels came out OK' })[0]!);
    await waitFor(() =>
      expect(api.calls.some((call) => call.url.endsWith('/confirm-physical'))).toBe(true),
    );
  });

  it('AC8: a LAB station prints as the Recording as person and never sees administration', async () => {
    const user = userEvent.setup();
    const api = fakeApi([location()]);
    renderPage(LAB);
    await screen.findByRole('table', { name: 'Locations' });
    // MISC-04 (Kyle 2026-10-30): a print-only view; no add, edit or retire for LAB.
    expect(screen.queryByRole('button', { name: 'Add location' })).toBeNull();
    const drawer = await openDrawer(user, 'Warehouse C1');
    expect(within(drawer).queryByRole('button', { name: 'Save changes' })).toBeNull();
    expect(within(drawer).queryByRole('button', { name: /Retire/ })).toBeNull();
    // STRATA-125: Printed by follows the Recording as chip, read-only (attribution only).
    const printedBy = await within(drawer).findByRole('textbox', { name: /Printed by/ });
    await waitFor(() => expect(printedBy).toHaveValue('AT · Alex Tester'));
    expect(printedBy).toHaveAttribute('readonly');
    expect(within(drawer).queryByRole('combobox', { name: /Printed by/ })).toBeNull();

    await user.click(within(drawer).getByRole('button', { name: 'Print label' }));
    await waitFor(() =>
      expect(api.calls.find((call) => call.url.endsWith('/labels'))!.body).toEqual({
        receiverUserId: TEST_STATION_PERSON.id,
      }),
    );
  });
});
