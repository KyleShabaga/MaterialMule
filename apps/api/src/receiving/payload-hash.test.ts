import { confirmReceiptRequestSchema } from '@trapezoid/shared';
import { describe, expect, it } from 'vitest';
import { canonicalJson, receiptPayloadHash } from './payload-hash.js';

const base = {
  idempotencyKey: '7d3c0f8e-2b7a-4c1e-9a55-0d6f1f2a9b10',
  projectId: '00000000-0000-4000-8000-000000000201',
  receivedDate: '2026-10-23',
  receiverUserId: '00000000-0000-4000-8000-000000000102',
  units: [
    {
      clientRowId: 'row-1',
      unitType: 'bucket',
      holeSummaries: [
        {
          testHoleId: '00000000-0000-4000-8000-000000000301',
          type: 'sample_range',
          sampleFrom: 'G1',
          sampleTo: 'S12',
        },
      ],
    },
  ],
};

/** The same object with every key order reversed, recursively. */
function reversed(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(reversed);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value)
        .reverse()
        .map(([k, v]) => [k, reversed(v)]),
    );
  }
  return value;
}

const hashOf = (input: unknown) => receiptPayloadHash(confirmReceiptRequestSchema.parse(input));

describe('receipt payload hash (TRP-T09 T2)', () => {
  it('sorts keys at every level', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { f: 1, e: null }], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,{"e":null,"f":1}]},"b":1}',
    );
  });

  it('is stable regardless of key order', () => {
    expect(JSON.stringify(reversed(base))).not.toBe(JSON.stringify(base));
    expect(hashOf(reversed(base))).toBe(hashOf(base));
  });

  it('ignores the idempotency key and treats omitted, null and blank optional text alike', () => {
    expect(hashOf({ ...base, idempotencyKey: '0b9e8c1e-6f0e-4a57-9a61-3f4c3a1b2c3d' })).toBe(
      hashOf(base),
    );
    expect(hashOf({ ...base, description: null })).toBe(hashOf(base));
    expect(hashOf({ ...base, description: '  ' })).toBe(hashOf(base));
  });

  it('changes when the payload changes', () => {
    expect(hashOf({ ...base, receivedDate: '2026-10-22' })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, description: 'Two buckets' })).not.toBe(hashOf(base));
    const twoUnits = {
      ...base,
      units: [...base.units, { ...base.units[0], clientRowId: 'row-2' }],
    };
    expect(hashOf(twoUnits)).not.toBe(hashOf(base));
  });
});
