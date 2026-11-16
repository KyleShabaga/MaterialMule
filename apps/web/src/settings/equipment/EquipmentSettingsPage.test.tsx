import type { ConcreteEquipmentDetail, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { EquipmentPanel } from './EquipmentPanel';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';

// Settings → Equipment (MM-V2-C27). Fictional people and equipment only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000301',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: [
    'inventory.read',
    'concrete_settings.testing_machine.manage',
    'concrete_settings.air_meter.manage',
  ],
  sessionExpiresAt: '2026-11-08T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});
const TECH = me({ roles: [], permissions: ['inventory.read'], displayName: 'Alex Tester' });

const person = {
  userId: '00000000-0000-4000-8000-000000000301',
  initials: 'LM',
  name: 'Lee Manager',
};
const machine = (canManage: boolean): ConcreteEquipmentDetail => ({
  id: '00000000-0000-4000-8000-000000000401',
  kind: 'testing_machine',
  identifier: 'TM-TEST-1',
  description: null,
  make: 'Example Instruments',
  model: 'Compression 3000',
  assignedTo: null,
  status: 'in_service',
  statusNote: null,
  createdAt: '2026-11-01T16:00:00.000Z',
  updatedAt: '2026-11-01T16:00:00.000Z',
  updatedBy: person,
  version: 1,
  currentCalibration: {
    id: '00000000-0000-4000-8000-000000000501',
    entryNumber: 1,
    calibratedOn: '2025-01-10',
    nextDueOn: '2026-01-10',
    performedBy: 'Example Calibration Co.',
    result: 'Within tolerance',
    recordedAt: '2026-11-01T16:00:00.000Z',
    recordedBy: person,
    voided: false,
    voidedAt: null,
    voidedBy: null,
    voidReason: null,
  },
  flagsToday: ['calibration_overdue'],
  canManage,
  today: '2026-11-07',
  calibrations: [],
  history: [],
  historyTotal: 1,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(
  session: MeResponse,
  canManage: boolean,
  onPost?: (url: string, body: unknown) => Response,
) {
  const detail = machine(canManage);
  detail.calibrations = [detail.currentCalibration!];
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.startsWith('/api/concrete/equipment/')) return json(200, detail);
    if (method === 'GET' && url.startsWith('/api/concrete/equipment')) {
      return json(200, {
        today: '2026-11-07',
        items: [detail],
        canManage: { testing_machine: canManage, air_meter: canManage },
      });
    }
    if (method !== 'GET' && onPost) return onPost(url, JSON.parse(String(init?.body)));
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/settings/equipment'] });
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
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Settings → Equipment (MM-V2-C27)', () => {
  it('everyone sees the machine, its calibration history and its flags, read-only', async () => {
    renderPage(TECH, false);
    const nav = await screen.findByRole('navigation', { name: 'Settings' });
    expect(within(nav).getByRole('link', { name: 'Equipment' })).toHaveAttribute(
      'href',
      '/settings/equipment',
    );
    const section = await screen.findByRole('region', { name: 'Testing machine' });
    expect(await within(section).findByText('Compression 3000')).toBeInTheDocument();
    expect(within(section).getAllByText('Calibration overdue').length).toBeGreaterThan(0);
    expect(within(section).getByRole('table', { name: 'Calibration history' })).toBeInTheDocument();
    expect(within(section).queryByRole('button', { name: 'Edit details' })).toBeNull();
    expect(within(section).queryByRole('form', { name: 'Record a calibration' })).toBeNull();
    expect(within(section).queryByRole('button', { name: 'Record calibration' })).toBeNull();
    expect(
      within(section).getByText('Only Lab Managers can change equipment.'),
    ).toBeInTheDocument();
  });

  it('the Lab Manager records a calibration with a fresh idempotency key', async () => {
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    renderPage(me(), true, (url, body) => {
      posts.push({ url, body: body as Record<string, unknown> });
      return json(201, machine(true));
    });
    const user = userEvent.setup();
    const machineGroup = await screen.findByRole('region', { name: 'Testing machine' });
    await user.click(
      await within(machineGroup).findByRole('button', { name: 'Record calibration' }),
    );
    const form = screen.getByRole('form', { name: 'Record a calibration' });
    await user.type(within(form).getByLabelText(/Next calibration due/), '2027-11-01');
    await user.type(within(form).getByLabelText(/Performed by/), 'Example Calibration Co.');
    await user.click(within(form).getByRole('button', { name: 'Record calibration' }));
    expect(await screen.findByText(/Calibration recorded/)).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]!.url).toBe(
      '/api/concrete/testing-machine/00000000-0000-4000-8000-000000000401/calibrations',
    );
    expect(posts[0]!.body).toMatchObject({
      calibratedOn: '2026-11-07',
      nextDueOn: '2027-11-01',
      performedBy: 'Example Calibration Co.',
    });
    expect(posts[0]!.body.idempotencyKey).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('Equipment panel states (STRATA-102)', () => {
  function renderPanel(list: unknown) {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === '/api/concrete/equipment' ? json(200, list) : json(404, {}),
      ),
    );
    render(
      <SessionContext.Provider
        value={{
          session: { status: 'active', me: me() },
          refresh: vi.fn(async () => undefined),
          signOut: vi.fn(async () => undefined),
        }}
      >
        <EquipmentPanel />
      </SessionContext.Provider>,
    );
  }

  it('says no testing machine is registered and offers registration to the Lab Manager', async () => {
    renderPanel({
      today: '2026-11-07',
      items: [],
      canManage: { testing_machine: true, air_meter: true },
    });
    const section = await screen.findByRole('region', { name: 'Testing machine' });
    expect(within(section).getByText('No testing machine is registered.')).toBeInTheDocument();
    await userEvent
      .setup()
      .click(within(section).getByRole('button', { name: 'Register the testing machine' }));
    expect(
      within(section).getByRole('form', { name: 'Register the testing machine' }),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register an air meter' })).toBeInTheDocument();
    expect(screen.getByText('No air meters are registered.')).toBeInTheDocument();
    // G8 stays a gate: said, not filled in.
    expect(screen.getByText('Units, readings and methods (G8)')).toBeInTheDocument();
  });

  it('a Lab Technician changes air meters only (C36)', async () => {
    renderPanel({
      today: '2026-11-07',
      items: [],
      canManage: { testing_machine: false, air_meter: true },
    });
    const section = await screen.findByRole('region', { name: 'Testing machine' });
    expect(
      within(section).queryByRole('button', { name: /Register the testing machine/ }),
    ).toBeNull();
    expect(
      within(section).getByText('Only Lab Managers can change equipment.'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register an air meter' })).toBeInTheDocument();
  });
});
