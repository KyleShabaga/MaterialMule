import { describe, expect, it } from 'vitest';
import {
  createLocationRequestSchema,
  locationListQuerySchema,
  locationPayload,
  normalizeLocationCode,
  parseScanPayload,
  updateLocationRequestSchema,
} from './locations';

describe('location codes and scan payloads (MM-T37)', () => {
  it('T2: trims and upper-cases codes', () => {
    expect(normalizeLocationCode(' wh-c1 ')).toBe('WH-C1');
    expect(locationPayload(' wh-c1 ')).toBe('LOC-WH-C1');
  });

  it('T1: tells LOC- labels from CT/BKT/ST/CRE stickers and rejects anything else', () => {
    expect(parseScanPayload('LOC-WH-C1')).toEqual({ type: 'location', code: 'WH-C1' });
    expect(parseScanPayload(' loc-lab-b1\r\n')).toEqual({ type: 'location', code: 'LAB-B1' });
    for (const id of ['CT-2026-000001', 'BKT-2026-000014', 'ST-2026-000003', 'CRE-2026-000002']) {
      expect(parseScanPayload(id)).toEqual({ type: 'storage_unit', readableId: id });
    }
    expect(parseScanPayload('bkt-2026-000014\t')).toEqual({
      type: 'storage_unit',
      readableId: 'BKT-2026-000014',
    });
    // A location whose code looks like a unit ID is still a location when scanned from its label.
    expect(parseScanPayload('LOC-BKT-2026-000014')).toEqual({
      type: 'location',
      code: 'BKT-2026-000014',
    });
    for (const garbage of [
      '',
      'WH-C1',
      'LOC-',
      'LOC-A',
      `LOC-${'X'.repeat(21)}`,
      'LOC-WH C1',
      'https://example.test/LOC-WH-C1',
      'SU-2026-000001',
      'BKT-26-000014',
      'BKT-2026-14',
    ]) {
      expect(parseScanPayload(garbage), garbage).toEqual({ type: 'unknown' });
    }
  });

  it('validates create and update requests', () => {
    expect(
      createLocationRequestSchema.parse({
        code: ' wh-c1',
        name: ' Warehouse C1 ',
        kind: 'warehouse',
      }),
    ).toEqual({
      code: 'WH-C1',
      name: 'Warehouse C1',
      kind: 'warehouse',
      area: null,
      // STRATA-106: top level, own term not set, capacity unknown.
      parentId: null,
      storageTerm: null,
      capacity: null,
    });
    expect(
      createLocationRequestSchema.parse({ code: 'WH-C1', name: 'W', kind: 'lab', area: '  ' }).area,
    ).toBeNull();
    expect(
      createLocationRequestSchema.safeParse({ code: 'W', name: 'W', kind: 'lab' }).success,
    ).toBe(false);
    expect(
      createLocationRequestSchema.safeParse({ code: 'WH-C1', name: 'W', kind: 'receiving_lab' })
        .success,
    ).toBe(false);
    expect(updateLocationRequestSchema.safeParse({ name: 'W' }).success).toBe(false);
    expect(updateLocationRequestSchema.parse({ area: null, version: 3 })).toEqual({
      area: null,
      version: 3,
    });
  });

  it('validates the storage term, parent and capacity (STRATA-106)', () => {
    const base = { code: 'WH-A-B1-S1', name: 'Shelf 1', kind: 'warehouse' } as const;
    expect(
      createLocationRequestSchema.parse({
        ...base,
        parentId: '00000000-0000-4000-8000-000000000403',
        storageTerm: 'short_term',
        capacity: 16,
      }),
    ).toMatchObject({ storageTerm: 'short_term', capacity: 16 });
    expect(createLocationRequestSchema.safeParse({ ...base, storageTerm: 'forever' }).success).toBe(
      false,
    );
    expect(createLocationRequestSchema.safeParse({ ...base, capacity: 0 }).success).toBe(false);
    expect(createLocationRequestSchema.safeParse({ ...base, capacity: 1.5 }).success).toBe(false);
    expect(createLocationRequestSchema.safeParse({ ...base, parentId: 'WH-A' }).success).toBe(
      false,
    );
    // Null clears an override (inherit) or the capacity.
    expect(
      updateLocationRequestSchema.parse({ storageTerm: null, capacity: null, version: 2 }),
    ).toEqual({ storageTerm: null, capacity: null, version: 2 });
  });

  it('includes retired locations only when asked', () => {
    expect(locationListQuerySchema.parse({})).toEqual({ includeRetired: false, all: false });
    expect(locationListQuerySchema.parse({ includeRetired: 'true', search: ' wh ' })).toEqual({
      includeRetired: true,
      all: false,
      search: 'wh',
    });
    // BUG-007: screens that need every location ask for all=true.
    expect(locationListQuerySchema.parse({ all: 'true' })).toMatchObject({ all: true });
    expect(locationListQuerySchema.safeParse({ all: 'yes' }).success).toBe(false);
    expect(locationListQuerySchema.safeParse({ includeRetired: 'yes' }).success).toBe(false);
  });
});
