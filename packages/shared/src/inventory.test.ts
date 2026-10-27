import { describe, expect, it } from 'vitest';
import {
  formatStorageUnitHoleSummary,
  inventoryQuerySchema,
  inventorySortDirection,
  normalizeStorageUnitCode,
  splitInventorySearch,
} from './inventory';

const PROJECT = '00000000-0000-4000-8000-000000000201';

describe('inventory query (MM-T12)', () => {
  it('defaults to Current stock, newest received first, 25 per page', () => {
    const query = inventoryQuerySchema.parse({});
    expect(query).toMatchObject({ status: 'current', sort: 'received', page: 1, pageSize: 25 });
    expect(inventorySortDirection(query)).toBe('desc');
    expect(inventorySortDirection({ sort: 'id', dir: undefined })).toBe('asc');
  });

  it('treats blank parameters as not set and coerces numbers from the query string', () => {
    const query = inventoryQuerySchema.parse({
      search: '  ',
      projectId: '',
      status: '',
      page: '3',
      pageSize: '100',
    });
    expect(query.search).toBeUndefined();
    expect(query.projectId).toBeUndefined();
    expect(query).toMatchObject({ status: 'current', page: 3, pageSize: 100 });
  });

  it('rejects bad values instead of guessing', () => {
    for (const bad of [
      { pageSize: '101' },
      { page: '0' },
      { projectId: 'DEMO-2601' },
      { status: 'lost' },
      { type: 'core_box' },
      { receivedFrom: '2026-13-01' },
      { sort: 'project' },
    ]) {
      expect(inventoryQuerySchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(inventoryQuerySchema.parse({ projectId: PROJECT }).projectId).toBe(PROJECT);
  });

  it('splits search into lower-case words, dropping duplicates', () => {
    expect(splitInventorySearch('  TH26-01   Warehouse th26-01 ')).toEqual([
      'th26-01',
      'warehouse',
    ]);
    expect(splitInventorySearch(undefined)).toEqual([]);
    expect(splitInventorySearch('a b c d e f g h i j k l')).toHaveLength(10);
  });

  it('folds en dashes, em dashes and minus signs to a hyphen, as the search document does (MM-T59)', () => {
    const displayed = formatStorageUnitHoleSummary({
      type: 'sample_range',
      sampleFrom: 'G1',
      sampleTo: 'S10',
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      customText: null,
    });
    expect(splitInventorySearch(displayed)).toEqual(['g1-s10']);
    for (const search of ['G1-S10', 'G1–S10', 'G1—S10', 'G1−S10', 'G1‐S10']) {
      expect(splitInventorySearch(search), search).toEqual(['g1-s10']);
    }
    expect(splitInventorySearch('TH26-01: 3–5 ft')).toEqual(['th26-01:', '3-5', 'ft']);
    // A dash standing alone between spaced words is not a word.
    expect(splitInventorySearch('G1 – S10')).toEqual(['g1', 's10']);
    expect(splitInventorySearch('3 - 5 ft')).toEqual(['3', '5', 'ft']);
    expect(splitInventorySearch(' – ')).toEqual([]);
    expect(splitInventorySearch('G1–S10 g1-s10')).toEqual(['g1-s10']);
  });

  it('normalises a typed storage unit ID by trimming and upper-casing', () => {
    expect(normalizeStorageUnitCode(' bkt-2026-000014 ')).toBe('BKT-2026-000014');
  });

  it('formats summaries the way people read them', () => {
    const empty = {
      sampleFrom: null,
      sampleTo: null,
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      customText: null,
    } as const;
    expect(formatStorageUnitHoleSummary({ ...empty, type: 'all' })).toBe('ALL');
    expect(
      formatStorageUnitHoleSummary({
        ...empty,
        type: 'sample_range',
        sampleFrom: 'G1',
        sampleTo: 'S12',
      }),
    ).toBe('G1–S12');
    expect(
      formatStorageUnitHoleSummary({
        ...empty,
        type: 'depth_range',
        depthFrom: 0,
        depthTo: 1.5,
        depthUnit: 'm',
      }),
    ).toBe('0–1.5 m');
    expect(formatStorageUnitHoleSummary({ ...empty, type: 'custom', customText: 'Bag 3' })).toBe(
      'Bag 3',
    );
  });
});
