import type { MeResponse, StationConfig, StationToday as Counts } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { newDraft } from '../../receiving/draft';
import { newRecord } from '../../receiving/drafts/record';
import { indexedDbDraftStore } from '../../receiving/drafts/store';
import { SessionContext } from '../../session/context';
import {
  PERSONAL_CONTROLLER,
  RecordingPersonContext,
  type RecordingPersonController,
} from '../../session/recording-person-store';
import { COULD_NOT_LOAD, StationToday } from './StationToday';
import { STATION_ID_KEY, stationId } from './station-id';
import { hiddenRowsNote, stationDraftCount } from './rows';

// STRATA-20, 21, 63: Today on a LAB station. Fictional people only (Pat Example, Sam Sample).

const LAB: MeResponse = {
  id: 'u-lab',
  displayName: 'LAB',
  initials: 'LAB',
  accountType: 'shared_lab',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-13T23:00:00.000Z',
  profileRefreshFailed: false,
};

const STATION: RecordingPersonController = {
  ...PERSONAL_CONTROLLER,
  isStation: true,
  person: { id: 'u-pe', displayName: 'Pat Example', initials: 'PE', roleLine: 'Technician' },
};

const ID = 'station-test-0001';

const config = (overrides: Partial<StationConfig> = {}): StationConfig => ({
  stationId: ID,
  rows: [
    { row: 'drafts', visible: true },
    { row: 'breaks_due', visible: true },
    { row: 'labels_to_print', visible: true },
  ],
  version: 0,
  updatedBy: null,
  updatedAt: null,
  ...overrides,
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(today: () => Response, station: () => Response = () => json(200, config())) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url === '/api/station/today') return today();
    if (url === `/api/station/config/${ID}`) return station();
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function wrap(children: ReactNode) {
  return (
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: LAB },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RecordingPersonContext.Provider value={STATION}>
        <MemoryRouter>{children}</MemoryRouter>
      </RecordingPersonContext.Provider>
    </SessionContext.Provider>
  );
}

const counts = (overrides: Partial<Counts> = {}): Counts => ({
  draftReceipts: 3,
  breaksDueToday: 5,
  labelsToPrint: 4,
  ...overrides,
});

async function rows() {
  const list = await screen.findByRole('list');
  return within(list).getAllByRole('link');
}

beforeEach(() => window.localStorage.setItem(STATION_ID_KEY, ID));
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('StationToday (STRATA-20)', () => {
  it('shows the recording person, three equal tiles and this station’s busy rows', async () => {
    stub(() => json(200, counts()));
    render(wrap(<StationToday />));

    expect(screen.getByText(/Work started here is recorded as/)).toHaveTextContent(
      'Work started here is recorded as Pat Example.',
    );
    const tiles = within(screen.getByRole('navigation', { name: 'Start work' })).getAllByRole(
      'link',
    );
    expect(tiles.map((tile) => tile.getAttribute('href'))).toEqual([
      '/receiving-log/new',
      '/concrete/receiving',
      '/lab-testing/concrete',
    ]);
    expect(tiles[0]).toHaveTextContent('Receive samples');
    expect(tiles[1]).toHaveTextContent('Receive concrete');
    expect(tiles[2]).toHaveTextContent('Record breaks');

    const [drafts, breaks, labels] = await rows();
    expect(drafts).toHaveTextContent(
      '3Draft receipts to finishStarted here, not confirmed yet. IDs are issued on confirm.',
    );
    expect(breaks).toHaveTextContent('5Breaks due today');
    expect(breaks).toHaveAttribute('href', '/lab-testing/concrete?view=today');
    expect(labels).toHaveTextContent('4Labels to print');
    expect(screen.queryByText(/hidden on this station/)).toBeNull();
  });

  it('adds this browser’s unregistered LAB drafts to the server count, once', async () => {
    const registered = { ...newRecord(newDraft(null), LAB), registeredAt: '2026-11-13T15:00:00Z' };
    const unregistered = newRecord(newDraft(null), LAB);
    await indexedDbDraftStore.put(registered);
    await indexedDbDraftStore.put(unregistered);
    // The server's registry already holds the registered one (and one from another computer).
    stub(() => json(200, counts({ draftReceipts: 2 })));
    render(wrap(<StationToday />));
    const [drafts] = await rows();
    expect(drafts).toHaveTextContent(/^3Draft receipts to finish/);
  });

  it('keeps zero rows with a muted 0 and “Nothing waiting.”', async () => {
    stub(() => json(200, counts({ draftReceipts: 0, breaksDueToday: 0, labelsToPrint: 0 })));
    render(wrap(<StationToday />));
    const all = await rows();
    expect(all).toHaveLength(3);
    for (const row of all) expect(row).toHaveTextContent(/^0.*Nothing waiting\.$/);
  });

  it('shows 99+ over ninety-nine', async () => {
    stub(() => json(200, counts({ breaksDueToday: 140 })));
    render(wrap(<StationToday />));
    const [, breaks] = await rows();
    expect(breaks).toHaveTextContent('99+Breaks due today');
  });

  it('says “Couldn’t load.” on the one row whose count failed', async () => {
    stub(() => json(200, counts({ breaksDueToday: null })));
    render(wrap(<StationToday />));
    const [drafts, breaks, labels] = await rows();
    expect(breaks).toHaveTextContent(COULD_NOT_LOAD);
    expect(drafts).not.toHaveTextContent(COULD_NOT_LOAD);
    expect(labels).toHaveTextContent('4Labels to print');
  });

  it('shows a red alert when the whole list failed, and Try again loads it', async () => {
    let fail = true;
    stub(() => (fail ? json(500, {}) : json(200, counts())));
    render(wrap(<StationToday />));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('This station’s work couldn’t load.');
    expect(alert).toHaveTextContent('The receiving buttons above still work.');
    // The tiles still work.
    expect(screen.getByRole('link', { name: /Receive samples/ })).toBeVisible();

    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await rows()).toHaveLength(3);
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says nothing is set to show when every row is switched off', async () => {
    stub(
      () => json(200, counts()),
      () =>
        json(
          200,
          config({ rows: config().rows.map((r) => ({ ...r, visible: false })), version: 2 }),
        ),
    );
    render(wrap(<StationToday />));
    expect(await screen.findByText('Nothing is set to show at this station.')).toBeVisible();
    expect(screen.getAllByRole('button', { name: 'Customize this station' })).toHaveLength(2);
    expect(screen.queryByRole('list')).toBeNull();
  });

  it('follows the saved order and notes hidden rows', async () => {
    stub(
      () => json(200, counts()),
      () =>
        json(
          200,
          config({
            rows: [
              { row: 'breaks_due', visible: true },
              { row: 'drafts', visible: false },
              { row: 'labels_to_print', visible: false },
            ],
            version: 3,
          }),
        ),
    );
    render(wrap(<StationToday />));
    const all = await rows();
    expect(all).toHaveLength(1);
    expect(all[0]).toHaveTextContent('Breaks due today');
    expect(screen.getByText('2 rows are hidden on this station.')).toBeVisible();
  });

  it('opens Customize read-only on the LAB session, with who set it up', async () => {
    stub(
      () => json(200, counts()),
      () =>
        json(
          200,
          config({
            version: 4,
            updatedBy: { userId: 'u-ss', name: 'Sam Sample' },
            updatedAt: '2026-11-12T16:00:00.000Z',
          }),
        ),
    );
    render(wrap(<StationToday />));
    await rows();
    await userEvent.click(screen.getByRole('button', { name: 'Customize this station' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize this station' });
    expect(within(dialog).getByText('Shown on this station')).toBeVisible();
    const switches = within(dialog).getAllByRole('switch');
    expect(switches).toHaveLength(3);
    for (const control of switches) expect(control).toBeDisabled();
    expect(within(dialog).queryByRole('button', { name: /^Move / })).toBeNull();
    expect(dialog).toHaveTextContent('Saved on this computer only.');
    expect(dialog).toHaveTextContent(
      'Set up by Sam Sample. Only a Lab Manager can change this station.',
    );
  });

  it('says only a Lab Manager can change the defaults', async () => {
    stub(() => json(200, counts()));
    render(wrap(<StationToday />));
    await rows();
    await userEvent.click(screen.getByRole('button', { name: 'Customize this station' }));
    const dialog = await screen.findByRole('dialog', { name: 'Customize this station' });
    expect(dialog).toHaveTextContent('Only a Lab Manager can change this station.');
    expect(dialog).not.toHaveTextContent('Set up by');
  });

  it('shows the defaults when the station’s settings can’t be read', async () => {
    stub(
      () => json(200, counts()),
      () => json(500, {}),
    );
    render(wrap(<StationToday />));
    expect(await rows()).toHaveLength(3);
  });
});

describe('station draft count', () => {
  it('adds only this browser’s drafts the server registry doesn’t know yet', () => {
    const local = [
      { registeredAt: '2026-11-13T15:00:00.000Z' },
      { registeredAt: null },
      { registeredAt: null },
    ];
    expect(stationDraftCount(2, local)).toBe(4);
    expect(stationDraftCount(0, [])).toBe(0);
    expect(stationDraftCount(null, local)).toBeNull();
  });

  it('words the hidden rows note', () => {
    expect(hiddenRowsNote(0)).toBeNull();
    expect(hiddenRowsNote(1)).toBe('1 row is hidden on this station.');
    expect(hiddenRowsNote(2)).toBe('2 rows are hidden on this station.');
  });
});

describe('station ID', () => {
  it('is made once and kept in this browser', () => {
    window.localStorage.clear();
    const first = stationId();
    expect(first).toMatch(/^[a-f0-9]{32}$/);
    expect(window.localStorage.getItem(STATION_ID_KEY)).toBe(first);
    expect(stationId()).toBe(first);
  });
});
