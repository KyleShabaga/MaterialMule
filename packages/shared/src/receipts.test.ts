import { describe, expect, it } from 'vitest';
import {
  confirmReceiptRequestSchema,
  holeSummaryInputSchema,
  toFieldErrors,
  type ConfirmReceiptRequestInput,
} from './receipts';

const HOLE_1 = '00000000-0000-4000-8000-000000000301';
const HOLE_2 = '00000000-0000-4000-8000-000000000302';

function request(overrides: Partial<ConfirmReceiptRequestInput> = {}): ConfirmReceiptRequestInput {
  return {
    idempotencyKey: '7d3c0f8e-2b7a-4c1e-9a55-0d6f1f2a9b10',
    projectId: '00000000-0000-4000-8000-000000000201',
    receivedDate: '2026-10-23',
    receiverUserId: '00000000-0000-4000-8000-000000000102',
    units: [
      {
        clientRowId: 'row-1',
        unitType: 'bucket',
        holeSummaries: [
          { testHoleId: HOLE_1, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
        ],
      },
    ],
    ...overrides,
  };
}

function errorsFor(input: unknown) {
  const result = confirmReceiptRequestSchema.safeParse(input);
  expect(result.success).toBe(false);
  return result.success ? [] : toFieldErrors(result.error);
}

function summaryErrors(summary: Record<string, unknown>) {
  const result = holeSummaryInputSchema.safeParse({ testHoleId: HOLE_1, ...summary });
  return result.success ? [] : toFieldErrors(result.error).map((e) => `${e.field}:${e.code}`);
}

describe('confirmReceiptRequestSchema (MM-T09 T1)', () => {
  it('accepts a valid receipt and normalises optional text to null', () => {
    const parsed = confirmReceiptRequestSchema.parse(request({ description: '   ' }));
    expect(parsed.description).toBeNull();
    expect(parsed.units[0]!.note).toBeNull();
    expect(parsed.units[0]!.holeSummaries[0]).toMatchObject({
      type: 'sample_range',
      sampleFrom: 'G1',
      sampleTo: 'S12',
      depthFrom: null,
      depthUnit: null,
      customText: null,
    });
  });

  it('accepts every summary type in its valid shape', () => {
    expect(summaryErrors({ type: 'all' })).toEqual([]);
    expect(summaryErrors({ type: 'sample_range', sampleFrom: 'G1', sampleTo: 'G4' })).toEqual([]);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: 0, depthTo: 0, depthUnit: 'm' }),
    ).toEqual([]);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: 1.25, depthTo: 20.5, depthUnit: 'ft' }),
    ).toEqual([]);
    expect(summaryErrors({ type: 'custom', customText: 'Bag samples only' })).toEqual([]);
  });

  it('rejects fields that do not belong to ALL', () => {
    expect(summaryErrors({ type: 'all', sampleFrom: 'G1', depthUnit: 'ft' })).toEqual([
      'sampleFrom:not_allowed',
      'depthUnit:not_allowed',
    ]);
  });

  it('requires both ends of a sample range', () => {
    expect(summaryErrors({ type: 'sample_range', sampleFrom: 'G1' })).toEqual([
      'sampleTo:required',
    ]);
    expect(summaryErrors({ type: 'sample_range', sampleFrom: ' ', sampleTo: '' })).toEqual([
      'sampleFrom:required',
      'sampleTo:required',
    ]);
  });

  it('checks depth ranges: both ends, unit, order, sign and precision', () => {
    expect(summaryErrors({ type: 'depth_range', depthFrom: 1, depthTo: 2 })).toEqual([
      'depthUnit:required',
    ]);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: 5, depthTo: 2, depthUnit: 'ft' }),
    ).toEqual(['depthTo:depth_range_reversed']);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: -1, depthTo: 2, depthUnit: 'ft' }),
    ).toEqual(['depthFrom:too_small']);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: 1.234, depthTo: 2, depthUnit: 'ft' }),
    ).toEqual(['depthFrom:too_precise']);
    expect(
      summaryErrors({ type: 'depth_range', depthFrom: 1, depthTo: 2, depthUnit: 'in' }),
    ).toEqual(['depthUnit:invalid_value']);
  });

  it('requires non-blank custom text', () => {
    expect(summaryErrors({ type: 'custom', customText: '   ' })).toEqual(['customText:required']);
  });

  it('rejects an unknown summary type', () => {
    expect(summaryErrors({ type: 'some' })).toEqual(['type:invalid_value']);
  });

  it('needs at least one unit, each with at least one summary', () => {
    expect(errorsFor(request({ units: [] }))).toEqual([
      expect.objectContaining({ field: 'units', code: 'too_small' }),
    ]);
    const noSummary = request({
      units: [{ clientRowId: 'row-1', unitType: 'bucket', holeSummaries: [] }],
    });
    expect(errorsFor(noSummary)).toEqual([
      expect.objectContaining({ field: 'units.0.holeSummaries', code: 'too_small' }),
    ]);
  });

  it('allows a hole at most once per unit (but in several units)', () => {
    const twice = request({
      units: [
        {
          clientRowId: 'row-1',
          unitType: 'bucket',
          holeSummaries: [
            { testHoleId: HOLE_1, type: 'all' },
            { testHoleId: HOLE_1, type: 'custom', customText: 'Again' },
          ],
        },
      ],
    });
    expect(errorsFor(twice)).toEqual([
      expect.objectContaining({
        field: 'units.0.holeSummaries.1.testHoleId',
        code: 'duplicate_test_hole',
      }),
    ]);

    const acrossUnits = request({
      units: ['row-1', 'row-2'].map((clientRowId) => ({
        clientRowId,
        unitType: 'bucket' as const,
        holeSummaries: [{ testHoleId: HOLE_1, type: 'all' as const }],
      })),
    });
    expect(confirmReceiptRequestSchema.safeParse(acrossUnits).success).toBe(true);
  });

  it('accepts a mixed-hole bucket', () => {
    const mixed = request({
      units: [
        {
          clientRowId: 'row-1',
          unitType: 'bucket',
          holeSummaries: [
            { testHoleId: HOLE_1, type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' },
            { testHoleId: HOLE_2, type: 'all' },
          ],
        },
      ],
    });
    expect(confirmReceiptRequestSchema.safeParse(mixed).success).toBe(true);
  });

  it('rejects duplicate client row IDs', () => {
    const unit = request().units[0]!;
    expect(errorsFor(request({ units: [unit, unit] }))).toEqual([
      expect.objectContaining({ field: 'units.1.clientRowId', code: 'duplicate_client_row' }),
    ]);
  });

  it('caps a receipt at 50 units', () => {
    const units = Array.from({ length: 51 }, (_, i) => ({
      ...request().units[0]!,
      clientRowId: `row-${i}`,
    }));
    expect(errorsFor(request({ units }))).toEqual([
      expect.objectContaining({ field: 'units', code: 'too_big' }),
    ]);
  });

  it('accepts only buckets in this increment', () => {
    const tube = request({
      units: [{ ...request().units[0]!, unitType: 'shelby_tube' as never }],
    });
    expect(errorsFor(tube)).toEqual([
      expect.objectContaining({ field: 'units.0.unitType', code: 'invalid_value' }),
    ]);
  });

  it('validates the header fields', () => {
    const errors = errorsFor({
      ...request(),
      idempotencyKey: 'not-a-uuid',
      projectId: 42,
      receivedDate: '2026-02-30',
      receiverUserId: undefined,
    });
    expect(errors.map((e) => e.field)).toEqual([
      'idempotencyKey',
      'projectId',
      'receivedDate',
      'receiverUserId',
    ]);
  });
});
