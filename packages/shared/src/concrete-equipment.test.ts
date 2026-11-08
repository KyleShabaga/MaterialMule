import { describe, expect, it } from 'vitest';
import {
  calibrationInEffect,
  concreteEquipmentFlags,
  createConcreteEquipmentRequestSchema,
  recordConcreteCalibrationRequestSchema,
  updateConcreteEquipmentRequestSchema,
  type CalibrationForRule,
} from './index';

// MM-V2-C27 T1: the equipment flag rule (CD-45) and the request contracts. Fictional IDs only.
const KEY = '00000000-0000-4000-8000-000000000201';

const entry = (
  entryNumber: number,
  calibratedOn: string,
  nextDueOn: string,
  voided = false,
): CalibrationForRule => ({ id: `c${entryNumber}`, entryNumber, calibratedOn, nextDueOn, voided });

const inService = { status: 'in_service' as const };

describe('concrete equipment flag rule (MM-V2-C27 T1)', () => {
  const history = [entry(1, '2025-03-01', '2026-03-01'), entry(2, '2026-02-20', '2027-02-20')];

  it('AC1: a next-due date in the past flags the use; it never blocks (only warnings come back)', () => {
    const result = concreteEquipmentFlags(
      inService,
      [entry(1, '2025-01-10', '2026-01-10')],
      '2026-11-07',
    );
    expect(result.flags).toEqual(['calibration_overdue']);
    expect(result.calibration?.id).toBe('c1');
  });

  it('within the recorded next-due date: no flag; on the due date: its own warning', () => {
    expect(concreteEquipmentFlags(inService, history, '2026-11-07').flags).toEqual([]);
    expect(concreteEquipmentFlags(inService, history, '2027-02-20').flags).toEqual([
      'calibration_due_on_use_date',
    ]);
    expect(concreteEquipmentFlags(inService, history, '2027-02-21').flags).toEqual([
      'calibration_overdue',
    ]);
  });

  it('judges the use against the calibration in effect on that date, not today', () => {
    // Used before the 2026-02-20 calibration: the 2025 entry applied, due 2026-03-01.
    expect(concreteEquipmentFlags(inService, history, '2026-01-05')).toMatchObject({
      calibration: { id: 'c1' },
      flags: [],
    });
    // Late entry for a date when the first calibration had lapsed and none newer existed.
    const lapsed = [entry(1, '2025-01-01', '2025-06-01'), entry(2, '2025-09-01', '2026-09-01')];
    expect(concreteEquipmentFlags(inService, lapsed, '2025-07-15').flags).toEqual([
      'calibration_overdue',
    ]);
    // Before any calibration: none recorded for that date.
    expect(concreteEquipmentFlags(inService, history, '2025-02-01')).toEqual({
      calibration: null,
      flags: ['no_calibration_recorded'],
    });
  });

  it('uses the recorded next-due date only, never an interval', () => {
    // A two-week certificate is overdue after two weeks, whatever is typical.
    const short = [entry(1, '2026-10-01', '2026-10-15')];
    expect(concreteEquipmentFlags(inService, short, '2026-10-16').flags).toEqual([
      'calibration_overdue',
    ]);
    // A ten-year one is not.
    const long = [entry(1, '2020-01-01', '2030-01-01')];
    expect(concreteEquipmentFlags(inService, long, '2029-12-31').flags).toEqual([]);
  });

  it('ignores voided entries; ties on date go to the later entry', () => {
    const corrected = [
      entry(1, '2026-02-20', '2026-03-20'),
      entry(2, '2026-02-20', '2027-02-20'),
      entry(3, '2026-06-01', '2026-06-02', true),
    ];
    expect(calibrationInEffect(corrected, '2026-11-07')?.id).toBe('c2');
    expect(
      concreteEquipmentFlags(inService, [entry(1, '2026-01-01', '2027-01-01', true)], '2026-05-01')
        .flags,
    ).toEqual(['no_calibration_recorded']);
  });

  it('an unresolved equipment issue or retirement flags too, alongside calibration', () => {
    expect(
      concreteEquipmentFlags({ status: 'out_of_service' }, history, '2026-11-07').flags,
    ).toEqual(['equipment_out_of_service']);
    expect(concreteEquipmentFlags({ status: 'retired' }, [], '2026-11-07').flags).toEqual([
      'equipment_retired',
      'no_calibration_recorded',
    ]);
  });
});

describe('concrete equipment contracts (MM-V2-C27)', () => {
  it('an air meter needs its ID; only an air meter is assigned', () => {
    expect(
      createConcreteEquipmentRequestSchema.safeParse({ kind: 'air_meter', idempotencyKey: KEY })
        .success,
    ).toBe(false);
    expect(
      createConcreteEquipmentRequestSchema.safeParse({
        kind: 'testing_machine',
        assignedUserId: KEY,
        idempotencyKey: KEY,
      }).success,
    ).toBe(false);
    expect(
      createConcreteEquipmentRequestSchema.parse({
        kind: 'testing_machine',
        make: '  Example Make ',
        model: '',
        idempotencyKey: KEY,
      }),
    ).toMatchObject({ make: 'Example Make', model: null });
  });

  it('a calibration needs a next-due date after its date; no procedure readings are accepted', () => {
    const base = {
      calibratedOn: '2026-11-01',
      nextDueOn: '2027-11-01',
      performedBy: 'Example Calibration Co.',
      idempotencyKey: KEY,
    };
    expect(recordConcreteCalibrationRequestSchema.safeParse(base).success).toBe(true);
    expect(
      recordConcreteCalibrationRequestSchema.safeParse({ ...base, nextDueOn: '2026-11-01' })
        .success,
    ).toBe(false);
    const { nextDueOn: _omit, ...withoutNextDue } = base;
    void _omit;
    expect(recordConcreteCalibrationRequestSchema.safeParse(withoutNextDue).success).toBe(false);
    // Gated on the air-meter calibration form (owner input): unknown fields are refused.
    expect(
      recordConcreteCalibrationRequestSchema.safeParse({ ...base, readings: [1, 2] }).success,
    ).toBe(false);
  });

  it('an edit carries the version last read', () => {
    expect(updateConcreteEquipmentRequestSchema.safeParse({ make: 'x' }).success).toBe(false);
    expect(updateConcreteEquipmentRequestSchema.safeParse({ version: 1, make: 'x' }).success).toBe(
      true,
    );
  });
});
