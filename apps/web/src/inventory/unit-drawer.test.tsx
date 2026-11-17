import type { StorageUnitDetail } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { UnitDrawer } from './UnitDrawer';

// The shared unit drawer (STRATA-73): Print label for a live unit, and for a disposed one a
// disabled Print label with its reason shown. Fictional data only: DEMO-2601, TH26-01.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};
const LOC = {
  id: '00000000-0000-4000-8000-000000000701',
  code: 'WH-A-B2-S3',
  name: 'Warehouse A shelf 3',
};

function unit(overrides: Partial<StorageUnitDetail> = {}): StorageUnitDetail {
  return {
    id: '00000000-0000-4000-8000-000000000801',
    readableId: 'BKT-2026-000001',
    unitType: 'bucket',
    status: 'in_stock',
    note: null,
    receivedDate: '2026-10-14',
    minimumRetainUntil: '2027-10-14',
    version: 1,
    project: PROJECT,
    holes: [
      {
        testHoleId: '00000000-0000-4000-8000-000000000301',
        testHoleName: 'TH26-01',
        type: 'all',
        sampleFrom: null,
        sampleTo: null,
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
        customText: null,
        note: null,
      },
    ],
    sample: null,
    bulkGroup: null,
    location: LOC,
    locationConflict: null,
    receipt: {
      id: 'r1',
      receivedDate: '2026-10-14',
      project: PROJECT,
      receiver: { initials: 'PE', name: 'Pat Example' },
      account: { initials: 'PE', name: 'Pat Example' },
      description: null,
      quantity: 1,
      confirmedAt: '2026-10-14T16:00:00.000Z',
    },
    recordStatus: 'short_term',
    stage: 'storage',
    lifecycleStep: 'short_term',
    storageTerm: { term: 'short_term', source: 'own', fromLocation: LOC },
    neverTested: true,
    ...overrides,
  } satisfies StorageUnitDetail;
}

function renderDrawer(detail: StorageUnitDetail) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      const body = url.pathname.startsWith('/api/storage-units/') ? detail : { items: [] };
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
  render(
    <MemoryRouter>
      <UnitDrawer readableId={detail.readableId} toolbar={{ onClose: () => undefined }} />
    </MemoryRouter>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('UnitDrawer print label (STRATA-73)', () => {
  it('a live unit links Print label to the label print view', async () => {
    renderDrawer(unit());
    const print = await screen.findByRole('link', { name: 'Print label' });
    expect(print).toHaveAttribute('href', '/labels/print/unit/BKT-2026-000001');
    expect(screen.queryByText('Disposed units can’t be relabelled.')).toBeNull();
  });

  it('a disposed unit shows Print label disabled, with the reason beside it', async () => {
    renderDrawer(unit({ status: 'disposed', recordStatus: 'disposed', stage: 'closed' }));
    const print = await screen.findByRole('button', { name: 'Print label' });
    expect(print).toBeDisabled();
    expect(print).toHaveAccessibleDescription('Disposed units can’t be relabelled.');
    expect(screen.getByText('Disposed units can’t be relabelled.')).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Print label' })).toBeNull();
  });
});
