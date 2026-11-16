import type { MeResponse, StationConfig } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { setLabStationComputer } from '../../session/station';
import { CustomizeStation, StationRowsEditor } from './CustomizeStation';
import { CONFLICT_MESSAGE, lockLine, SAVE_FAILED_MESSAGE } from './rows';
import { STATION_ID_KEY } from './station-id';
import { STATION_CONFIGURE_PERMISSION, StationSetupCard } from './StationSetupCard';

// STRATA-21 and STRATA-36 (d): the editable "Customize this station" for a Lab Manager's own
// account on the station computer (PUT with the version, 409 reloads), and the setup card that
// leads to it. Fictional people only.

const ID = 'station-test-0001';

const config = (overrides: Partial<StationConfig> = {}): StationConfig => ({
  stationId: ID,
  rows: [
    { row: 'drafts', visible: true },
    { row: 'breaks_due', visible: true },
    { row: 'labels_to_print', visible: true },
  ],
  version: 2,
  updatedBy: { userId: 'u-ss', name: 'Sam Sample' },
  updatedAt: '2026-11-12T16:00:00.000Z',
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

type Api = (url: string, init?: RequestInit) => Response;

function stub(api: Api) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    api(String(input), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function puts(fetchMock: ReturnType<typeof stub>) {
  return fetchMock.mock.calls
    .filter(([, init]) => init?.method === 'PUT')
    .map(([url, init]) => ({ url: String(url), body: JSON.parse(String(init?.body)) as unknown }));
}

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('StationRowsEditor, editable (Lab Manager’s own account)', () => {
  it('saves a switch with the full row list and the version it was based on', async () => {
    const saved = config({
      rows: [
        { row: 'drafts', visible: true },
        { row: 'breaks_due', visible: false },
        { row: 'labels_to_print', visible: true },
      ],
      version: 3,
      updatedBy: { userId: 'u-pe', name: 'Pat Example' },
    });
    const fetchMock = stub(() => json(200, saved));
    const onChange = vi.fn();
    render(<StationRowsEditor config={config()} editable onChange={onChange} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Breaks due today' }));
    await waitFor(() => expect(onChange).toHaveBeenCalledWith(saved));
    expect(puts(fetchMock)).toEqual([
      {
        url: `/api/station/config/${ID}`,
        body: { rows: saved.rows, version: 2 },
      },
    ]);
    expect(screen.getByRole('status')).toHaveTextContent('Saved.');
    expect(screen.queryByText(/Only a Lab Manager/)).toBeNull();
    expect(screen.getByText('Saved on this computer only.')).toBeVisible();
  });

  it('moves a row with the buttons and with Alt and an arrow key', async () => {
    const fetchMock = stub((_url, init) => {
      const body = JSON.parse(String(init?.body)) as { rows: StationConfig['rows'] };
      return json(200, config({ rows: body.rows, version: 3 }));
    });
    const onChange = vi.fn();
    const { rerender } = render(
      <StationRowsEditor config={config()} editable onChange={onChange} />,
    );
    expect(screen.getByRole('button', { name: 'Move Draft receipts to finish up' })).toBeDisabled();
    await userEvent.click(
      screen.getByRole('button', { name: 'Move Draft receipts to finish down' }),
    );
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(1));
    expect(puts(fetchMock)[0]?.body).toEqual({
      rows: [
        { row: 'breaks_due', visible: true },
        { row: 'drafts', visible: true },
        { row: 'labels_to_print', visible: true },
      ],
      version: 2,
    });

    rerender(
      <StationRowsEditor
        config={onChange.mock.calls[0]![0] as StationConfig}
        editable
        onChange={onChange}
      />,
    );
    const labels = screen.getByRole('switch', { name: 'Labels to print' });
    labels.focus();
    await userEvent.keyboard('{Alt>}{ArrowUp}{/Alt}');
    await waitFor(() => expect(onChange).toHaveBeenCalledTimes(2));
    expect(puts(fetchMock)[1]?.body).toEqual({
      rows: [
        { row: 'breaks_due', visible: true },
        { row: 'labels_to_print', visible: true },
        { row: 'drafts', visible: true },
      ],
      version: 3,
    });
  });

  it('reloads and says so when someone else saved first (409)', async () => {
    const theirs = config({
      rows: [
        { row: 'labels_to_print', visible: true },
        { row: 'drafts', visible: false },
        { row: 'breaks_due', visible: true },
      ],
      version: 5,
      updatedBy: { userId: 'u-at', name: 'Alex Tester' },
    });
    const fetchMock = stub((_url, init) =>
      init?.method === 'PUT' ? json(409, { code: 'stale_version' }) : json(200, theirs),
    );
    const onChange = vi.fn();
    const reload = vi.fn(async () => theirs);
    render(<StationRowsEditor config={config()} editable onChange={onChange} reload={reload} />);

    await userEvent.click(screen.getByRole('switch', { name: 'Labels to print' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(CONFLICT_MESSAGE);
    expect(reload).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(theirs);
    expect(puts(fetchMock)).toHaveLength(1);
  });

  it('says it couldn’t save and keeps the saved state', async () => {
    stub(() => json(500, {}));
    const onChange = vi.fn();
    render(<StationRowsEditor config={config()} editable onChange={onChange} />);
    const drafts = screen.getByRole('switch', { name: 'Draft receipts to finish' });
    await userEvent.click(drafts);
    expect(await screen.findByRole('alert')).toHaveTextContent(SAVE_FAILED_MESSAGE);
    expect(onChange).not.toHaveBeenCalled();
    expect(drafts).toBeChecked();
  });
});

describe('StationRowsEditor, read-only (the LAB session)', () => {
  it('disables every switch, offers no order buttons and never saves', async () => {
    const fetchMock = stub(() => json(200, config()));
    render(<StationRowsEditor config={config()} editable={false} />);
    for (const control of screen.getAllByRole('switch')) expect(control).toBeDisabled();
    expect(screen.queryByRole('button')).toBeNull();
    expect(
      screen.getByText('Set up by Sam Sample. Only a Lab Manager can change this station.'),
    ).toBeVisible();
    await userEvent.click(screen.getByRole('switch', { name: 'Labels to print' }));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('words the lock line for the defaults', () => {
    expect(lockLine(config({ updatedBy: null }))).toBe(
      'Only a Lab Manager can change this station.',
    );
  });

  it('opens from the outline button as a popover', async () => {
    render(<CustomizeStation config={config()} editable={false} />);
    await userEvent.click(screen.getByRole('button', { name: 'Customize this station' }));
    expect(await screen.findByRole('dialog', { name: 'Customize this station' })).toBeVisible();
  });
});

const manager = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u-ss',
  displayName: 'Sam Sample',
  initials: 'SS',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', STATION_CONFIGURE_PERMISSION],
  sessionExpiresAt: '2026-11-13T23:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

function renderCard(me: MeResponse) {
  return render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <StationSetupCard />
    </SessionContext.Provider>,
  );
}

describe('StationSetupCard (STRATA-36 d)', () => {
  it('shows on the LAB station computer for a Lab Manager’s own account and opens the editor', async () => {
    setLabStationComputer(true);
    window.localStorage.setItem(STATION_ID_KEY, ID);
    stub((url) => (url === `/api/station/config/${ID}` ? json(200, config()) : json(404, {})));
    renderCard(manager());
    expect(await screen.findByText('This computer is a LAB station')).toBeVisible();
    expect(await screen.findByText('Last set up by Sam Sample.')).toBeVisible();
    const rows = within(screen.getByRole('list', { name: 'This station’s rows' })).getAllByRole(
      'listitem',
    );
    expect(rows[0]).toHaveTextContent('Draft receipts to finish· Shown');

    await userEvent.click(screen.getByRole('button', { name: 'Customize this station' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize this station' });
    for (const control of within(dialog).getAllByRole('switch')) expect(control).toBeEnabled();
    expect(dialog).not.toHaveTextContent('Only a Lab Manager can change this station.');
  });

  it('stays hidden on a computer that isn’t the LAB station', () => {
    const fetchMock = stub(() => json(200, config()));
    const { container } = renderCard(manager());
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('stays hidden for the LAB session and for anyone without the permission', () => {
    setLabStationComputer(true);
    const fetchMock = stub(() => json(200, config()));
    const lab = renderCard(
      manager({ accountType: 'shared_lab', permissions: [STATION_CONFIGURE_PERMISSION] }),
    );
    expect(lab.container).toBeEmptyDOMElement();
    lab.unmount();
    const tech = renderCard(
      manager({ roles: ['lab_technician'], permissions: ['inventory.read'] }),
    );
    expect(tech.container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
