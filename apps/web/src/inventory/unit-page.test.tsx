import type { MeResponse, StorageUnitDetail } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';
import { pickStationPerson } from '../session/station-test-person';
import { passedWithout, unitLifecycleStep, unitPrimaryAction, unitTag } from './unit-record';

// STRATA-72: the storage unit record pattern. Fictional data only: BKT-2026-000019, DEMO-2601.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const LOC = { id: '00000000-0000-4000-8000-000000000701', code: 'WH-A-B2-S3', name: 'Shelf 3' };

const UNIT: StorageUnitDetail = {
  id: '00000000-0000-4000-8000-000000000519',
  readableId: 'BKT-2026-000019',
  unitType: 'bucket',
  status: 'in_stock',
  note: null,
  receivedDate: '2026-10-14',
  minimumRetainUntil: '2027-10-14',
  version: 1,
  project: PROJECT,
  sample: null,
  bulkGroup: null,
  holes: [
    {
      testHoleId: '00000000-0000-4000-8000-000000000301',
      testHoleName: 'TH26-01',
      type: 'sample_range',
      sampleFrom: 'SS1',
      sampleTo: 'SS6',
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      customText: null,
      note: null,
    },
  ],
  location: LOC,
  locationConflict: null,
  receipt: {
    id: 'r1',
    receivedDate: '2026-10-14',
    project: PROJECT,
    receiver: { initials: 'JL', name: 'Jordan Lab' },
    account: { initials: 'PE', name: 'Pat Example' },
    description: null,
    quantity: 1,
    confirmedAt: '2026-10-14T16:00:00.000Z',
  },
  recordStatus: 'short_term',
  stage: 'storage',
  lifecycleStep: 'short_term',
  storageTerm: { term: 'short_term', source: 'inherited', fromLocation: LOC },
  neverTested: true,
};

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: 'u1',
  displayName: 'Kim Example',
  initials: 'KCS',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'label.print', 'storage_unit.correct'],
  sessionExpiresAt: '2026-10-26T06:00:00.000Z',
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

function renderUnit(unit: StorageUnitDetail | null, user = me()) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/health') return json(200, { status: 'ok' });
      if (unit && url.pathname === `/api/storage-units/${unit.readableId}`) return json(200, unit);
      if (url.pathname.endsWith('/history')) {
        return json(200, { items: [], total: 0, page: 1, pageSize: 20 });
      }
      return json(404, { code: 'not_found' });
    }),
  );
  const router = createMemoryRouter(routes, {
    initialEntries: [`/sample-storage/${unit?.readableId ?? 'BKT-2026-000091'}`],
  });
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

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('unit record helpers', () => {
  it('chooses one primary action by stage', () => {
    expect(unitPrimaryAction('short_term')).toEqual({ kind: 'move', label: 'Move' });
    expect(unitPrimaryAction('location_conflict')).toEqual({ kind: 'move', label: 'Move' });
    expect(unitPrimaryAction('in_lab')).toEqual({ kind: 'move', label: 'Move back to storage' });
    expect(unitPrimaryAction('retention_overdue')).toEqual({ kind: 'decide', label: 'Decide' });
    expect(unitPrimaryAction('disposed')).toEqual({ kind: 'none' });
  });

  it('keeps the storage step for a conflict and falls back from the status', () => {
    expect(unitTag('location_conflict', 'long_term', false)).toEqual({
      stage: 'storage',
      label: 'Long-term',
    });
    expect(unitLifecycleStep(undefined, 'retention_due', undefined)).toBe('short_term');
    expect(passedWithout('long_term', true)).toEqual(['in_lab']);
    expect(passedWithout('in_lab', true)).toEqual([]);
  });
});

describe('storage unit page (STRATA-72)', () => {
  it('a stored unit: tag, track, Move as the one primary, holes as a table, entered by', async () => {
    renderUnit(UNIT);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'BKT-2026-000019' }),
    ).toBeInTheDocument();
    expect(document.querySelector('.unit-status-tags')).toHaveTextContent('Short-term');
    const track = screen.getByRole('list', { name: 'Lifecycle of BKT-2026-000019' });
    expect(within(track).getByText('Short-term storage').closest('li')).toHaveAttribute(
      'aria-current',
      'step',
    );
    expect(track).toHaveTextContent('In lab, skipped');
    expect(screen.getByRole('link', { name: 'Move' })).toHaveAttribute(
      'href',
      '/sample-storage/move',
    );
    const holes = screen.getByRole('table', { name: 'Test hole summaries' });
    expect(within(holes).getByRole('row', { name: /TH26-01/ })).toHaveTextContent('SS1–SS6');
    expect(screen.getByRole('region', { name: 'Where it is' })).toHaveTextContent(
      'Short-term storage',
    );
    expect(screen.getByRole('region', { name: 'Receipt' })).toHaveTextContent(
      'Entered by Pat Example, for Jordan Lab',
    );
  });

  it('MM-T79: links on the unit page darken on hover and are never underlined', async () => {
    renderUnit(UNIT);
    await screen.findByRole('heading', { level: 1, name: 'BKT-2026-000019' });
    const page = document.querySelector('.unit-page');
    // The rule is a utility so it beats shadcn's link hover:underline (e2e/link-contrast checks
    // the computed style in a browser).
    expect(page?.className).toContain('[&_a:hover]:no-underline');
    expect(page?.className).toContain('[&_a:hover]:text-(--accent-ink)');
  });

  it('retention due offers Decide, linking to the retention route', async () => {
    renderUnit({ ...UNIT, recordStatus: 'retention_due', stage: 'due' });
    expect(await screen.findByRole('link', { name: 'Decide' })).toHaveAttribute(
      'href',
      `/disposal-retention?projectId=${PROJECT.id}`,
    );
    expect(screen.queryByRole('link', { name: 'Move' })).toBeNull();
  });

  it('a conflict keeps Move and adds the Urgent · Location tag', async () => {
    renderUnit({
      ...UNIT,
      recordStatus: 'location_conflict',
      stage: 'danger',
      locationConflict: { id: 'c1', version: 1, openedAt: '2026-11-12T20:00:00.000Z' },
    });
    expect(await screen.findByRole('link', { name: 'Move' })).toBeInTheDocument();
    const tags = document.querySelector('.unit-status-tags');
    expect(tags).toHaveTextContent('Short-term');
    expect(tags).toHaveTextContent('Urgent · Location');
    expect(screen.getByRole('region', { name: 'Where it is' })).toHaveTextContent(
      'Two places are recorded for this unit',
    );
  });

  it('a disposed unit is read-only and its menu says why Print label is off', async () => {
    renderUnit({
      ...UNIT,
      status: 'disposed',
      recordStatus: 'disposed',
      stage: 'closed',
      lifecycleStep: 'disposed',
    });
    expect(
      await screen.findByText('Read-only. Disposed units keep their ID and history.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Move' })).toBeNull();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
    const print = await screen.findByRole('menuitem', { name: 'Print label' });
    expect(print).toHaveAttribute('aria-disabled', 'true');
    expect(print).toHaveAccessibleDescription('Disposed units’ labels can’t be reprinted.');
    expect(screen.getByRole('menuitem', { name: 'Correct' })).toHaveAccessibleDescription(
      'Only the received date and note can change.',
    );
  });

  it('an unknown ID shows the ID asked for and Scan again', async () => {
    renderUnit(null);
    expect(
      await screen.findByRole('heading', { level: 1, name: 'No storage unit has this ID.' }),
    ).toBeInTheDocument();
    expect(screen.getAllByText('BKT-2026-000091').length).toBeGreaterThan(1);
    expect(screen.getByRole('link', { name: 'Scan again' })).toBeInTheDocument();
  });
});
