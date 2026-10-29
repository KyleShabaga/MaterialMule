import type { InventoryItem } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { describe, expect, it } from 'vitest';
import { StorageUnitTable } from './StorageUnitTable';

// MM-T71 T3/AC3: in Sample Storage a tested unit shows only its exception (Retain until: Not
// applicable), never the "On hold" tag, even when a project hold covers it. Fictional data only.

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
};

function item(readableId: string, overrides: Partial<InventoryItem>): InventoryItem {
  return {
    id: `id-${readableId}`,
    readableId,
    unitType: 'shelby_tube',
    status: 'in_stock',
    project: PROJECT,
    holes: [],
    sample: null,
    bulkGroup: null,
    location: { id: 'loc-s', code: 'A-01', name: 'Rack A shelf 1' },
    receivedDate: '2026-10-23',
    ...overrides,
  };
}

describe('Sample Storage retention cells (MM-T71)', () => {
  it('a tested tube under a hold shows Not applicable and no On hold; an untested one shows the hold', () => {
    render(
      <MemoryRouter>
        <StorageUnitTable
          items={[
            item('ST-2026-000004', {
              retention: {
                effectiveRetainUntil: '2031-01-01',
                onHold: true,
                eligibleByDate: false,
                retentionExempt: true,
              },
            }),
            item('ST-2026-000005', {
              retention: {
                effectiveRetainUntil: '2031-01-01',
                onHold: true,
                eligibleByDate: false,
                retentionExempt: false,
              },
            }),
          ]}
        />
      </MemoryRouter>,
    );
    const row = (id: string) => screen.getByRole('link', { name: id }).closest('tr')!;
    const tested = within(row('ST-2026-000004'));
    expect(tested.getByText('Not applicable')).toBeVisible();
    expect(tested.queryByText('On hold')).toBeNull();
    expect(tested.queryByText(/2031-01-01/)).toBeNull();
    const untested = within(row('ST-2026-000005'));
    expect(untested.getByText('On hold')).toBeVisible();
    expect(untested.getByText(/2031-01-01/)).toBeVisible();
  });
});
