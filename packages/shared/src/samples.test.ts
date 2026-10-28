import { describe, expect, it } from 'vitest';
import {
  confirmReceiptRequestSchema,
  toFieldErrors,
  type ConfirmReceiptRequestInput,
} from './receipts';
import {
  bulkGroupOptionLabel,
  bulkSampleIdentityInputSchema,
  changeBulkGroupRequestSchema,
  formatBulkBadge,
  formatDepth,
  formatSampleIdentity,
  shelbySampleInputSchema,
  type SampleIdentity,
} from './samples';

// MM-T36 T1: bulk identity and Shelby source validation, plus the display forms search relies on.

const HOLE = '00000000-0000-4000-8000-000000000301';
const GROUP = '00000000-0000-4000-8000-000000000401';

function codes(
  schema: { safeParse(v: unknown): { success: boolean; error?: unknown } },
  v: unknown,
) {
  const result = schema.safeParse(v) as ReturnType<typeof shelbySampleInputSchema.safeParse>;
  return result.success ? [] : toFieldErrors(result.error).map((e) => `${e.field}:${e.code}`);
}

const bulkIdentity = {
  sourceType: 'test_hole' as const,
  testHoleId: HOLE,
  sampleReference: 'B1',
  depthFrom: 1.5,
  depthTo: 2,
  depthUnit: 'm' as const,
};

describe('bulk sample identity (T1)', () => {
  it('accepts a test-hole or standalone source, a single depth and a non-B reference', () => {
    expect(codes(bulkSampleIdentityInputSchema, bulkIdentity)).toEqual([]);
    expect(
      codes(bulkSampleIdentityInputSchema, {
        sourceType: 'standalone_location',
        sourceLocationReference: '  Embankment Location 03  ',
        sampleReference: 'Bag 7',
        depthFrom: 0.3,
        depthUnit: 'm',
      }),
    ).toEqual([]);
    const parsed = bulkSampleIdentityInputSchema.parse({
      ...bulkIdentity,
      sampleReference: ' S-12 ',
      description: '   ',
    });
    expect(parsed).toMatchObject({ sampleReference: 'S-12', description: null, depthTo: 2 });
  });

  it('requires the source, sample reference, depth and units', () => {
    expect(
      codes(bulkSampleIdentityInputSchema, {
        sourceType: 'test_hole',
        sampleReference: '  ',
      }),
    ).toEqual([
      'testHoleId:required',
      'sampleReference:required',
      'depthFrom:required',
      'depthUnit:required',
    ]);
    expect(
      codes(bulkSampleIdentityInputSchema, {
        ...bulkIdentity,
        sourceType: 'standalone_location',
        testHoleId: null,
        sourceLocationReference: '',
      }),
    ).toEqual(['sourceLocationReference:required']);
  });

  it('rejects an invalid interval and conflicting source fields', () => {
    expect(codes(bulkSampleIdentityInputSchema, { ...bulkIdentity, depthTo: 1 })).toEqual([
      'depthTo:depth_range_reversed',
    ]);
    expect(
      codes(bulkSampleIdentityInputSchema, {
        ...bulkIdentity,
        sourceLocationReference: 'Stockpile',
      }),
    ).toEqual(['sourceLocationReference:conflicting_source']);
    expect(
      codes(bulkSampleIdentityInputSchema, {
        ...bulkIdentity,
        sourceType: 'standalone_location',
        sourceLocationReference: 'Stockpile',
      }),
    ).toEqual(['testHoleId:conflicting_source']);
    // No hidden extra fields (a group letter, say) get through.
    expect(codes(bulkSampleIdentityInputSchema, { ...bulkIdentity, letter: 'A' })).toEqual([
      ':unrecognized_keys',
    ]);
  });
});

describe('Shelby tube sample', () => {
  it('needs only a source; reference and depth are recorded where supplied', () => {
    expect(codes(shelbySampleInputSchema, { sourceType: 'test_hole', testHoleId: HOLE })).toEqual(
      [],
    );
    expect(
      shelbySampleInputSchema.parse({
        sourceType: 'standalone_location',
        sourceLocationReference: 'Embankment Location 03',
        sampleReference: 'T5',
        depthFrom: 10,
        depthTo: 12,
        depthUnit: 'ft',
      }),
    ).toMatchObject({ testHoleId: null, sampleReference: 'T5', depthUnit: 'ft' });
  });

  it('rejects a blank standalone reference, a depth without units and stray depth fields', () => {
    expect(
      codes(shelbySampleInputSchema, {
        sourceType: 'standalone_location',
        sourceLocationReference: ' ',
      }),
    ).toEqual(['sourceLocationReference:required']);
    expect(
      codes(shelbySampleInputSchema, { sourceType: 'test_hole', testHoleId: HOLE, depthFrom: 3 }),
    ).toEqual(['depthUnit:required']);
    expect(
      codes(shelbySampleInputSchema, { sourceType: 'test_hole', testHoleId: HOLE, depthTo: 3 }),
    ).toEqual(['depthFrom:required']);
  });
});

function receipt(overrides: Partial<ConfirmReceiptRequestInput>): ConfirmReceiptRequestInput {
  return {
    idempotencyKey: '7d3c0f8e-2b7a-4c1e-9a55-0d6f1f2a9b10',
    projectId: '00000000-0000-4000-8000-000000000201',
    receivedDate: '2026-10-23',
    receiverUserId: '00000000-0000-4000-8000-000000000102',
    units: [],
    ...overrides,
  };
}

const receiptCodes = (input: ConfirmReceiptRequestInput) =>
  codes(confirmReceiptRequestSchema, input);

describe('receipt with Shelby tubes and bulk samples', () => {
  it('accepts two buckets sharing a new bulk sample, a join, a tube and an ordinary bucket', () => {
    expect(
      receiptCodes(
        receipt({
          bulkGroups: [{ key: 'b1', ...bulkIdentity }],
          units: [
            { clientRowId: 'r1', unitType: 'bucket', bulkGroup: { newGroupKey: 'b1' } },
            { clientRowId: 'r2', unitType: 'bucket', bulkGroup: { newGroupKey: 'b1' } },
            {
              clientRowId: 'r3',
              unitType: 'bucket',
              bulkGroup: { existingId: GROUP, version: 2 },
            },
            {
              clientRowId: 'r4',
              unitType: 'shelby_tube',
              sample: { sourceType: 'test_hole', testHoleId: HOLE, sampleReference: 'T5' },
            },
            {
              clientRowId: 'r5',
              unitType: 'bucket',
              holeSummaries: [{ testHoleId: HOLE, type: 'all' }],
            },
          ],
        }),
      ),
    ).toEqual([]);
  });

  it('a bulk bucket has exactly one contents summary', () => {
    expect(
      receiptCodes(
        receipt({
          bulkGroups: [{ key: 'b1', ...bulkIdentity }],
          units: [
            {
              clientRowId: 'r1',
              unitType: 'bucket',
              bulkGroup: { newGroupKey: 'b1' },
              holeSummaries: [{ testHoleId: HOLE, type: 'all' }],
              sample: { sourceType: 'test_hole', testHoleId: HOLE },
            },
          ],
        }),
      ),
    ).toEqual(['units.0.holeSummaries:not_allowed', 'units.0.sample:not_allowed']);
  });

  it('a Shelby tube never joins a bulk group', () => {
    expect(
      receiptCodes(
        receipt({
          units: [
            {
              clientRowId: 'r1',
              unitType: 'shelby_tube',
              sample: { sourceType: 'test_hole', testHoleId: HOLE },
              bulkGroup: { existingId: GROUP, version: 1 },
            },
          ],
        }),
      ),
    ).toEqual(['units.0.bulkGroup:not_allowed']);
  });

  it('rejects unknown, unused, duplicate and conflicting group references', () => {
    expect(
      receiptCodes(
        receipt({
          bulkGroups: [
            { key: 'b1', ...bulkIdentity },
            { key: 'b1', ...bulkIdentity },
          ],
          units: [
            { clientRowId: 'r1', unitType: 'bucket', bulkGroup: { newGroupKey: 'b2' } },
            {
              clientRowId: 'r2',
              unitType: 'bucket',
              bulkGroup: { newGroupKey: 'b2', existingId: GROUP },
            },
            { clientRowId: 'r3', unitType: 'bucket', bulkGroup: { existingId: GROUP } },
            {
              clientRowId: 'r4',
              unitType: 'bucket',
              bulkGroup: { existingId: GROUP, version: 1 },
            },
            {
              clientRowId: 'r5',
              unitType: 'bucket',
              bulkGroup: { existingId: GROUP, version: 2 },
            },
          ],
        }),
      ),
    ).toEqual([
      'units.1.bulkGroup.existingId:conflicting_group',
      'units.2.bulkGroup.version:required',
      'bulkGroups.1.key:duplicate_bulk_group',
      'units.0.bulkGroup.newGroupKey:unknown_bulk_group',
      'units.1.bulkGroup.newGroupKey:unknown_bulk_group',
      'units.4.bulkGroup.version:conflicting_group_version',
      'bulkGroups.0:unused_bulk_group',
      'bulkGroups.1:unused_bulk_group',
    ]);
  });
});

describe('group membership correction request', () => {
  it('takes exactly one of an existing group or a new identity, with a reason', () => {
    const base = { version: 1, reason: 'wrong pail' };
    expect(codes(changeBulkGroupRequestSchema, { ...base, groupId: GROUP })).toEqual([]);
    expect(codes(changeBulkGroupRequestSchema, { ...base, newGroup: bulkIdentity })).toEqual([]);
    // Null parses here; the API refuses it (a bulk bucket always has a group).
    expect(codes(changeBulkGroupRequestSchema, { ...base, groupId: null })).toEqual([]);
    expect(codes(changeBulkGroupRequestSchema, base)).toEqual(['groupId:required']);
    expect(
      codes(changeBulkGroupRequestSchema, { ...base, groupId: GROUP, newGroup: bulkIdentity }),
    ).toEqual(['groupId:conflicting_group']);
    expect(
      codes(changeBulkGroupRequestSchema, { version: 1, reason: 'x', groupId: GROUP }),
    ).toEqual(['reason:too_small']);
  });
});

describe('display', () => {
  const identity: SampleIdentity = {
    source: { type: 'test_hole', testHoleId: HOLE, testHoleName: 'TH26-21' },
    sampleReference: 'B1',
    depthFrom: 1.5,
    depthTo: 2,
    depthUnit: 'm',
  };

  it('formats depths, identities, badges and picker options', () => {
    expect(formatDepth(1.5, 2, 'm')).toBe('1.5–2 m');
    expect(formatDepth(3, null, 'ft')).toBe('3 ft');
    expect(formatDepth(null, null, null)).toBe('');
    expect(formatSampleIdentity(identity)).toBe('TH26-21: B1 at 1.5–2 m');
    expect(
      formatSampleIdentity({
        source: { type: 'standalone_location', locationReference: 'Embankment Location 03' },
        sampleReference: null,
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
      }),
    ).toBe('Embankment Location 03');
    expect(formatBulkBadge(identity, { memberNumber: 1, memberCount: 2 })).toBe(
      'Bulk sample · B1 · bucket 1 of 2',
    );
    expect(bulkGroupOptionLabel({ identity, memberCount: 2 })).toBe(
      'TH26-21 · B1 · 1.5–2 m — 2 buckets so far',
    );
    expect(bulkGroupOptionLabel({ identity, memberCount: 1 })).toBe(
      'TH26-21 · B1 · 1.5–2 m — 1 bucket so far',
    );
  });
});
