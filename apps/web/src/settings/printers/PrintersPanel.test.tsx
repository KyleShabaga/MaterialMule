import type { MeResponse, Printer } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';
import { PrintersPanel } from './PrintersPanel';

// Settings › Printers (MM-T15, STRATA-118, STRATA-102). Fictional printers and people only.

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: '00000000-0000-4000-8000-000000000301',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'printer.manage'],
  sessionExpiresAt: '2026-11-13T06:00:00.000Z',
  ...overrides,
});

const RECEIVING: Printer = {
  id: 'receiving',
  name: 'Receiving ZD621',
  host: '10.0.0.50',
  port: 9100,
  enabled: true,
  isDefault: true,
  checkStatus: true,
};
const SOILS: Printer = {
  ...RECEIVING,
  id: 'soils',
  name: 'Soils lab',
  host: '10.0.0.51',
  enabled: false,
  isDefault: false,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderPanel(
  user: MeResponse,
  handler: (method: string, body: unknown) => Response = () => json(200, [RECEIVING, SOILS]),
) {
  const calls: { method: string; url: string; body: unknown }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      calls.push({ method, url, body });
      return url === '/api/admin/printers' ? handler(method, body) : json(404, {});
    }),
  );
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: user },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <PrintersPanel />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Settings › Printers panel (STRATA-102)', () => {
  it('lists the printers with address and whether they are in use', async () => {
    renderPanel(me());
    const panel = screen.getByRole('region', { name: 'Printers' });
    const table = await within(panel).findByRole('table', { name: 'Printers' });
    expect(within(table).getByText('Receiving ZD621')).toBeInTheDocument();
    expect(within(table).getByText('10.0.0.50:9100')).toBeInTheDocument();
    expect(within(table).getByText('Default')).toBeInTheDocument();
    expect(within(table).getByText('In use')).toBeInTheDocument();
    expect(within(table).getByText('Not in use')).toBeInTheDocument();
    expect(screen.getByText('2 printers')).toBeInTheDocument();
  });

  it('opens a printer in the drawer and saves only that printer', async () => {
    const calls = renderPanel(me(), (method) =>
      method === 'PUT'
        ? json(200, [{ ...RECEIVING, host: '10.0.0.60' }, SOILS])
        : json(200, [RECEIVING, SOILS]),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText('Receiving ZD621'));
    const form = screen.getByRole('form', { name: 'Receiving ZD621' });
    const host = within(form).getByLabelText(/IP address or host name/);
    expect(host).toHaveValue('10.0.0.50');
    await user.clear(host);
    await user.type(host, '10.0.0.60');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Printer settings saved.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toEqual({
      printers: [{ ...RECEIVING, host: '10.0.0.60' }],
    });
  });

  it('adds a printer with its permanent ID', async () => {
    const added: Printer = { ...SOILS, id: 'concrete-room', name: 'Concrete room', enabled: true };
    const calls = renderPanel(me(), (method) =>
      method === 'PUT' ? json(200, [RECEIVING, SOILS, added]) : json(200, [RECEIVING, SOILS]),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByRole('button', { name: 'Add a printer' }));
    const form = screen.getByRole('form', { name: 'Add a printer' });
    await user.type(within(form).getByLabelText(/Printer ID/), 'concrete-room');
    await user.type(within(form).getByLabelText(/^Name/), 'Concrete room');
    await user.type(within(form).getByLabelText(/IP address or host name/), '10.0.0.51');
    await user.click(within(form).getByRole('button', { name: 'Add printer' }));
    expect(await screen.findByText('Concrete room added.')).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PUT')?.body).toMatchObject({
      printers: [{ id: 'concrete-room', name: 'Concrete room', host: '10.0.0.51', port: 9100 }],
    });
  });

  it('shows the server’s refusal in the form', async () => {
    renderPanel(me(), (method) =>
      method === 'PUT'
        ? json(400, { message: 'Only one printer can be the default' })
        : json(200, [RECEIVING, SOILS]),
    );
    const user = userEvent.setup();
    await user.click(await screen.findByText('Soils lab'));
    const form = screen.getByRole('form', { name: 'Soils lab' });
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await within(form).findByRole('alert')).toHaveTextContent(
      'Only one printer can be the default',
    );
  });

  it('without printer.manage says who can and never calls the API', async () => {
    const calls = renderPanel(me({ roles: [], permissions: ['inventory.read'] }));
    expect(
      screen.getByText('Only Lab Managers and administrators can change printers.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Add a printer' })).toBeNull();
    expect(calls).toHaveLength(0);
  });
});
