import { describe, expect, it } from 'vitest';
import { moveRequestSchema, resolveLocationConflictRequestSchema } from './moves';
import { toFieldErrors } from './receipts';

const MOVE = {
  clientMoveId: '6f1c1c1e-6b0e-4d3c-9f43-0c6c7f0e0a01',
  storageUnitId: '00000000-0000-4000-8000-000000000501',
  toLocationId: '00000000-0000-4000-8000-000000000601',
  baseVersion: 3,
  scannedAt: '2026-10-27T09:15:00.000-06:00',
  capturedOffline: true,
  captureContext: {
    stationId: '3b4b0c5e-2d0a-4f7e-9a51-6f0c7c0b9e02',
    accountId: '00000000-0000-4000-8000-0000000e1801',
    moverUserId: '00000000-0000-4000-8000-000000000102',
  },
};

const errorsOf = (value: unknown) => {
  const result = moveRequestSchema.safeParse(value);
  return result.success ? [] : toFieldErrors(result.error).map((e) => e.field);
};

describe('move intent (MM-T28)', () => {
  it('accepts a frozen scan intent with or without a predecessor', () => {
    expect(errorsOf(MOVE)).toEqual([]);
    expect(
      errorsOf({ ...MOVE, previousClientMoveId: '9d0b3f5a-1c2e-4a7b-8e6f-5d4c3b2a1f00' }),
    ).toEqual([]);
  });

  it('refuses a self-linked predecessor, a scan time without offset and extra fields', () => {
    expect(errorsOf({ ...MOVE, previousClientMoveId: MOVE.clientMoveId })).toEqual([
      'previousClientMoveId',
    ]);
    expect(errorsOf({ ...MOVE, scannedAt: '2026-10-27T09:15:00' })).toEqual(['scannedAt']);
    expect(errorsOf({ ...MOVE, baseVersion: 0 })).toEqual(['baseVersion']);
    // Nothing that looks like authority or a session is accepted.
    expect(errorsOf({ ...MOVE, sessionId: 'abc' })).not.toEqual([]);
    expect(
      errorsOf({ ...MOVE, captureContext: { ...MOVE.captureContext, roles: ['admin'] } }),
    ).not.toEqual([]);
  });

  it('resolution: blank note becomes null; versions are required', () => {
    const parsed = resolveLocationConflictRequestSchema.parse({
      clientResolutionId: MOVE.clientMoveId,
      locationId: MOVE.toLocationId,
      note: '  ',
      expectedUnitVersion: 2,
      expectedConflictVersion: 1,
    });
    expect(parsed.note).toBeNull();
    expect(
      resolveLocationConflictRequestSchema.safeParse({
        clientResolutionId: MOVE.clientMoveId,
        locationId: MOVE.toLocationId,
      }).success,
    ).toBe(false);
  });
});
