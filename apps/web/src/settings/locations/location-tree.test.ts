import type { StorageLocation } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { buildTree, clampPage, pageCount, pagePlaces, visibleLocations } from './location-tree';

// STRATA-102: the Locations tree and its paging by top-level place. Fictional locations only.

function location(id: string, area: string | null, extra: Partial<StorageLocation> = {}) {
  return {
    id,
    code: id.toUpperCase(),
    name: id,
    kind: 'warehouse',
    area,
    active: true,
    isSystem: false,
    retiredAt: null,
    retiredReason: null,
    codeLocked: false,
    labelPrintedAt: null,
    inStockCount: 1,
    createdAt: '2026-10-27T15:00:00.000Z',
    updatedAt: '2026-10-27T15:00:00.000Z',
    version: 1,
    ...extra,
  } satisfies StorageLocation;
}

describe('buildTree', () => {
  it('groups by area in server order, totals stock, and puts the system location first', () => {
    const tree = buildTree([
      location('a1', 'Warehouse A'),
      location('solo', null),
      location('a2', 'Warehouse A', { inStockCount: 4 }),
      location('recv', null, { isSystem: true, kind: 'receiving_lab' }),
    ]);
    expect(tree.map((place) => place.key)).toEqual([
      'location:recv',
      'area:Warehouse A',
      'location:solo',
    ]);
    const area = tree[1]!;
    expect(area.kind === 'area' && area.locations.map((l) => l.id)).toEqual(['a1', 'a2']);
    expect(area.kind === 'area' && area.inStock).toBe(5);
  });
});

describe('paging', () => {
  const tree = buildTree(Array.from({ length: 21 }, (_, index) => location(`p${index}`, null)));

  it('has 10 top-level places per page', () => {
    expect(pageCount(tree)).toBe(3);
    expect(pagePlaces(tree, 3)).toHaveLength(1);
    expect(pageCount([])).toBe(1);
  });

  it('clamps the page from the URL', () => {
    expect(clampPage(null, tree)).toBe(1);
    expect(clampPage('0', tree)).toBe(1);
    expect(clampPage('abc', tree)).toBe(1);
    expect(clampPage('2', tree)).toBe(2);
    expect(clampPage('9', tree)).toBe(3);
  });

  it('hides a collapsed area’s locations from the visible order', () => {
    const grouped = buildTree([location('a1', 'A'), location('a2', 'A'), location('b', null)]);
    expect(visibleLocations(grouped, new Set()).map((l) => l.id)).toEqual(['a1', 'a2', 'b']);
    expect(visibleLocations(grouped, new Set(['area:A'])).map((l) => l.id)).toEqual(['b']);
  });
});
