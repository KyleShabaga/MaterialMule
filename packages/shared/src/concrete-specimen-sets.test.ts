import { describe, expect, it } from 'vitest';
import {
  concreteAddDays,
  concreteCastingCorrectionRequestSchema,
  concreteCastingDate,
  concreteSetShapeDefault,
  concreteSpecimenDates,
  createConcreteSpecimenSetRequestSchema,
  normalizeConcreteSpecimenRows,
  resolveConcreteSchedule,
  type ConcreteSpecimenRow,
} from './concrete-specimen-sets';
import { concreteFieldReportMissing, concreteFieldReportWarnings } from './concrete-field-reports';
import {
  CONCRETE_FIELD_REPORT_DEFERRED_CHECKS,
  CONCRETE_REPORT_SPEC_EMPTY,
} from './concrete-field-reports';

// MM-V2-C05 test plan T1: count, default resolution, HOLD dates and midnight / year boundaries.
// Fictional ids only.

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const rows = (...ages: (number | 'HOLD' | null)[]): ConcreteSpecimenRow[] =>
  ages.map((age, i) => ({ id: id(i + 1), age }));

describe('specimen rows (AC1, AC2, AC3)', () => {
  it('AC1: 7/28/28/HOLD makes four distinct specimens A–D', () => {
    const specimens = normalizeConcreteSpecimenRows(rows(7, 28, 28, 'HOLD'));
    expect(specimens.map((s) => [s.letter, s.age])).toEqual([
      ['A', 7],
      ['B', 28],
      ['C', 28],
      ['D', 'HOLD'],
    ]);
    expect(new Set(specimens.map((s) => s.id)).size).toBe(4);
  });

  it('AC2: blank rows do not count; an added row does', () => {
    expect(normalizeConcreteSpecimenRows(rows(7, null, 28, null))).toHaveLength(2);
    expect(normalizeConcreteSpecimenRows(rows(7, 28, 28, 'HOLD', 56))).toHaveLength(5);
    expect(normalizeConcreteSpecimenRows(rows(null, 28)).map((s) => s.letter)).toEqual(['A']);
  });

  it('AC3: no populated rows → no specimens', () => {
    expect(normalizeConcreteSpecimenRows([])).toEqual([]);
    expect(normalizeConcreteSpecimenRows(rows(null, null))).toEqual([]);
  });

  it('never passes Z: 26 is the most, 27 is refused (never trimmed)', () => {
    const z = normalizeConcreteSpecimenRows(rows(...Array<number>(26).fill(28)));
    expect(z.at(-1)!.letter).toBe('Z');
    expect(() => normalizeConcreteSpecimenRows(rows(...Array<number>(27).fill(28)))).toThrow(
      RangeError,
    );
    const request = createConcreteSpecimenSetRequestSchema.safeParse({
      idempotencyKey: id(99),
      specimens: rows(...Array<number>(27).fill(28)),
    });
    expect(request.success).toBe(false);
    // Blanks beyond 26 rows are fine.
    expect(
      createConcreteSpecimenSetRequestSchema.safeParse({
        idempotencyKey: id(99),
        specimens: rows(...Array<number>(26).fill(28), null, null),
      }).success,
    ).toBe(true);
  });

  it('there is no count input', () => {
    expect(
      createConcreteSpecimenSetRequestSchema.safeParse({ idempotencyKey: id(99), count: 4 })
        .success,
    ).toBe(false);
  });

  it('row ids are unique', () => {
    const parsed = createConcreteSpecimenSetRequestSchema.safeParse({
      idempotencyKey: id(99),
      specimens: [
        { id: id(1), age: 7 },
        { id: id(1), age: 28 },
      ],
    });
    expect(parsed.success).toBe(false);
  });
});

describe('default resolution', () => {
  const mix = { revisionId: id(50), spec: { testAges: [3, 7, 28, 28, 'HOLD'] } } as never;

  it('lab default 7/28/28/HOLD and 56 days when nothing is saved', () => {
    expect(resolveConcreteSchedule({ projectSettings: null, mixSnapshot: null })).toEqual({
      ages: [7, 28, 28, 'HOLD'],
      source: 'lab_default',
      mixRevisionId: null,
      holdDurationDays: 56,
      holdDurationSource: 'lab_default',
    });
  });

  it('project settings override the lab default; the mix overrides the project ages', () => {
    const projectSettings = { defaultSpecimenAges: [7, 28, 'HOLD' as const], holdDurationDays: 90 };
    expect(resolveConcreteSchedule({ projectSettings, mixSnapshot: null })).toMatchObject({
      ages: [7, 28, 'HOLD'],
      source: 'project',
      holdDurationDays: 90,
      holdDurationSource: 'project',
    });
    expect(resolveConcreteSchedule({ projectSettings, mixSnapshot: mix })).toEqual({
      ages: [3, 7, 28, 28, 'HOLD'],
      source: 'mix',
      mixRevisionId: id(50),
      holdDurationDays: 90,
      holdDurationSource: 'project',
    });
  });

  it('the resolved ages are a copy: changing the source later never changes them (AC4)', () => {
    const settings = { defaultSpecimenAges: [7, 28], holdDurationDays: 56 };
    const resolved = resolveConcreteSchedule({ projectSettings: settings, mixSnapshot: null });
    settings.defaultSpecimenAges.push(56);
    expect(resolved.ages).toEqual([7, 28]);
  });

  it('shape defaults by material: concrete 150x300 cylinders, grout cubes, else blank', () => {
    expect(concreteSetShapeDefault('concrete')).toEqual({
      specimenType: 'cylinder',
      mouldSize: '150x300',
    });
    expect(concreteSetShapeDefault('cementitious_grout')).toEqual({
      specimenType: 'cube',
      mouldSize: null,
    });
    expect(concreteSetShapeDefault(null)).toEqual({ specimenType: 'cylinder', mouldSize: null });
  });
});

describe('dates (America/Edmonton calendar day)', () => {
  it('casting day is the local day, across local midnight and New Year', () => {
    // Late on 31 December locally is already 1 January in UTC under any Alberta offset.
    expect(concreteCastingDate('2027-01-01T05:30:00Z')).toBe('2026-12-31');
    expect(concreteCastingDate('2027-01-01T07:30:00Z')).toBe('2027-01-01');
    expect(concreteAddDays('2026-12-31', 28)).toBe('2027-01-28');
    expect(concreteAddDays('2028-02-01', 28)).toBe('2028-02-29');
  });

  it('target date = casting + age; HOLD expiry = casting + saved duration', () => {
    const castAt = '2026-11-02T16:15:00Z';
    expect(concreteSpecimenDates({ castAt, age: 28, holdDurationDays: 56 })).toEqual({
      targetDate: '2026-11-30',
      holdExpiresOn: null,
      flags: [],
    });
    expect(concreteSpecimenDates({ castAt, age: 'HOLD', holdDurationDays: 56 })).toEqual({
      targetDate: null,
      holdExpiresOn: '2026-12-28',
      flags: [],
    });
    expect(concreteSpecimenDates({ castAt: null, age: 7, holdDurationDays: 56 })).toEqual({
      targetDate: null,
      holdExpiresOn: null,
      flags: [],
    });
  });

  it('a weekend target stays on the weekend and is flagged', () => {
    // Saturday 7 November 2026 + 7 = Saturday 14 November.
    expect(
      concreteSpecimenDates({ castAt: '2026-11-07T17:00:00Z', age: 7, holdDurationDays: 56 }),
    ).toEqual({ targetDate: '2026-11-14', holdExpiresOn: null, flags: ['weekend_target'] });
  });
});

describe('casting correction request (AC5)', () => {
  it('needs a reason and an explicit confirm answer', () => {
    const base = { idempotencyKey: id(1), version: 3, castAt: '2026-11-02T09:00:00-06:00' };
    expect(
      concreteCastingCorrectionRequestSchema.safeParse({ ...base, reason: ' ', confirm: true })
        .success,
    ).toBe(false);
    expect(concreteCastingCorrectionRequestSchema.safeParse({ ...base, reason: 'x' }).success).toBe(
      false,
    );
    expect(
      concreteCastingCorrectionRequestSchema.safeParse({ ...base, reason: 'x', confirm: false })
        .success,
    ).toBe(true);
  });
});

describe('report review with set detail (C04 handoff)', () => {
  const fields = { specimensCast: true, castAt: '2026-11-02T09:00:00-06:00' } as never;
  const missing = (sets?: { id: string; specimenCount: number; mouldSize: string | null }[]) =>
    concreteFieldReportMissing({
      technicianUserId: id(1),
      fields: { ...emptyFields(), ...(fields as object) },
      mixSnapshot: null,
      specimenSets: sets,
    }).filter((path) => path.startsWith('specimenSets'));

  it('cast → at least one set with specimens, each with its mould size', () => {
    expect(missing([])).toEqual(['specimenSets']);
    expect(missing([{ id: 's1', specimenCount: 0, mouldSize: null }])).toEqual(['specimenSets']);
    expect(missing([{ id: 's1', specimenCount: 4, mouldSize: null }])).toEqual([
      'specimenSets.s1.mouldSize',
    ]);
    expect(missing([{ id: 's1', specimenCount: 4, mouldSize: '150x300' }])).toEqual([]);
    expect(CONCRETE_FIELD_REPORT_DEFERRED_CHECKS.map((c) => c.owner)).not.toContain('C05');
  });

  it('No with specimens still recorded warns (nothing is deleted)', () => {
    const warnings = concreteFieldReportWarnings({
      technicianUserId: id(1),
      fields: { ...emptyFields(), specimensCast: false },
      mixSnapshot: null,
      specimenSets: [{ id: 's1', specimenCount: 4, mouldSize: '150x300' }],
    });
    expect(warnings.map((w) => w.code)).toContain('specimens_recorded_but_not_cast');
  });
});

function emptyFields() {
  return {
    reportDate: null,
    contractorName: null,
    paperFieldId: null,
    locationElements: [],
    locationElementOther: null,
    locationDescription: null,
    supplierName: null,
    mixNumber: null,
    ticketNumber: null,
    truckNumber: null,
    plantName: null,
    batchedAt: null,
    loadVolumeM3: null,
    cumulativeVolumeM3: null,
    mixId: null,
    projectSpec: CONCRETE_REPORT_SPEC_EMPTY,
    ticketSpec: CONCRETE_REPORT_SPEC_EMPTY,
    arrivedAt: null,
    sampledAt: null,
    testedAt: null,
    castAt: null,
    timeLimitExceeded: null,
    timeLimitInformed: null,
    loadRejected: null,
    loadDecisionByName: null,
    loadDecisionByCompany: null,
    samplingLocation: null,
    samplingLocationOther: null,
    placementMethods: [],
    placementMethodOther: null,
    material: null,
    superplasticizerAdded: null,
    readings: [],
    unitWeightKgM3: null,
    concreteTempC: null,
    ambientTempC: null,
    waterAdded: null,
    waterAddedAuthorizedBy: null,
    specimensCast: null,
    airMeterEquipmentId: null,
    comments: null,
    resultsReportedToName: null,
    resultsReportedToCompany: null,
    attachmentRefs: [],
  } as never as Parameters<typeof concreteFieldReportMissing>[0]['fields'];
}
