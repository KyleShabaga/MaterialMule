import { describe, expect, it } from 'vitest';
import {
  CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS,
  CONCRETE_PICKUP_WINDOW_VERIFIED,
  concreteCuringFlags,
  concreteFormatTenths,
  concreteMassSchema,
  concretePickupMissing,
  concretePickupWindowEndsAt,
  concreteReceivingExceptionRequestSchema,
  concreteReceivingIssues,
  concreteTemperatureSchema,
} from './concrete-receiving';

// MM-V2-C06 (test plan T1): 0.1 g / 0.1 °C validation, the curing comparison against a fixture
// range (never a CSA/ASTM value), pickup completeness and the receiving blockers.

const KEY = '00000000-0000-4000-8000-0000000000aa';
const ID = '00000000-0000-4000-8000-0000000000bb';

describe('concrete receiving values', () => {
  it('keeps a mass to the tenth of a gram exactly and refuses more precision instead of rounding', () => {
    expect(concreteMassSchema.parse('12345.6')).toBe('12345.6');
    expect(concreteMassSchema.parse(12345.6)).toBe('12345.6');
    expect(concreteMassSchema.parse('12345.60')).toBe('12345.6');
    expect(concreteMassSchema.parse('12345')).toBe('12345');
    for (const bad of ['12345.67', 12345.67, '0', 0, '-1', 'abc', '1234567.0', '']) {
      expect(concreteMassSchema.safeParse(bad).success, String(bad)).toBe(false);
    }
    expect(concreteFormatTenths('12345')).toBe('12345.0');
    expect(concreteFormatTenths('12345.6')).toBe('12345.6');
  });

  it('takes curing temperatures to 0.1 °C, negatives included', () => {
    expect(concreteTemperatureSchema.parse('-2.5')).toBe('-2.5');
    expect(concreteTemperatureSchema.parse(21)).toBe('21');
    expect(concreteTemperatureSchema.safeParse('21.55').success).toBe(false);
    expect(concreteTemperatureSchema.safeParse('100').success).toBe(false);
  });

  it('flags readings outside a supplied range only, and checks nothing without one', () => {
    const fixture = { minC: '16.0', maxC: '27.0' };
    expect(concreteCuringFlags({ minC: '18.0', maxC: '24.0' }, fixture)).toEqual([]);
    expect(concreteCuringFlags({ minC: '16.0', maxC: '27.0' }, fixture)).toEqual([]);
    expect(concreteCuringFlags({ minC: '15.9', maxC: '27.1' }, fixture)).toEqual([
      'min_below_range',
      'max_above_range',
    ]);
    expect(concreteCuringFlags({ minC: '15.0', maxC: null }, fixture)).toBeNull();
    expect(concreteCuringFlags({ minC: '1.0', maxC: '40.0' }, null)).toBeNull();
  });

  it('a pickup is complete with collector, time and both readings (AC1)', () => {
    const all = {
      collectedByUserId: ID,
      collectedAt: '2026-11-03T08:00:00-06:00',
      curingMinC: '18.0',
      curingMaxC: '24.0',
    };
    expect(concretePickupMissing(all)).toEqual([]);
    expect(concretePickupMissing({ ...all, curingMinC: null, curingMaxC: null })).toEqual([
      'curingMinC',
      'curingMaxC',
    ]);
  });

  it('the Pick up window starts at 24 h from casting and is not verified', () => {
    expect(CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS).toBe(24);
    expect(CONCRETE_PICKUP_WINDOW_VERIFIED).toBe(false);
    expect(concretePickupWindowEndsAt('2026-11-02T09:15:00-06:00', 24)).toBe(
      '2026-11-03T15:15:00.000Z',
    );
    expect(concretePickupWindowEndsAt(null, 24)).toBeNull();
  });

  it('exception requests keep each kind to its shape', () => {
    const ok = (body: object) =>
      concreteReceivingExceptionRequestSchema.safeParse({ idempotencyKey: KEY, ...body }).success;
    expect(ok({ kind: 'missing', specimenId: ID })).toBe(true);
    expect(ok({ kind: 'missing' })).toBe(false);
    expect(ok({ kind: 'missing', specimenId: ID, massG: '1.0' })).toBe(false);
    expect(ok({ kind: 'extra', setId: ID })).toBe(true);
    expect(ok({ kind: 'extra', specimenId: ID })).toBe(false);
    expect(ok({ kind: 'extra', massG: '12000.0' })).toBe(false);
    expect(ok({ kind: 'unmatched' })).toBe(false);
    expect(ok({ kind: 'unmatched', observedMarking: '26-?? A' })).toBe(true);
  });
});

describe('concreteReceivingIssues', () => {
  const specimen = (id: string, values: Partial<Record<string, boolean>> = {}) => ({
    specimenId: id,
    pickupCompleted: false,
    received: false,
    markerCovered: false,
    missingResolved: false,
    curingUnresolvedFlag: false,
    ...values,
  });

  it('lists every outstanding record by kind (AC3) and treats curing flags as an issuance gate', () => {
    const result = concreteReceivingIssues({
      setVoided: false,
      specimens: [
        specimen('A', { pickupCompleted: true, received: true, markerCovered: true }),
        specimen('B', { received: true, curingUnresolvedFlag: true }),
        specimen('C'),
        specimen('D', { missingResolved: true }),
      ],
      exceptions: [
        { id: 'x1', kind: 'missing', specimenId: 'C', resolved: false },
        { id: 'x2', kind: 'unmatched', specimenId: null, resolved: false },
        { id: 'x3', kind: 'extra', specimenId: null, resolved: true },
      ],
    });
    expect(result.blockers).toEqual([
      { code: 'pickup_incomplete', specimenIds: ['B', 'C'], exceptionIds: [] },
      { code: 'not_received', specimenIds: ['C'], exceptionIds: [] },
      { code: 'missing_unresolved', specimenIds: ['C'], exceptionIds: ['x1'] },
      { code: 'identity_unresolved', specimenIds: [], exceptionIds: ['x2'] },
      { code: 'marker_confirmation_missing', specimenIds: ['B'], exceptionIds: [] },
    ]);
    expect(result.issuanceGates).toEqual([
      { code: 'curing_out_of_range_unresolved', specimenIds: ['B'], exceptionIds: [] },
    ]);
  });

  it('a Void set blocks nothing', () => {
    expect(
      concreteReceivingIssues({ setVoided: true, specimens: [specimen('A')], exceptions: [] }),
    ).toEqual({ blockers: [], issuanceGates: [] });
  });
});
