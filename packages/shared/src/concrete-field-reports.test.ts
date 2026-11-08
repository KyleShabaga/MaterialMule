import { describe, expect, it } from 'vitest';
import {
  CONCRETE_REPORT_SPEC_EMPTY,
  concreteFieldReportCompleteness,
  concreteFieldReportMissing,
  concreteFieldReportWarnings,
  concreteReportManualSpecChanges,
  concreteReportSpecFromMix,
  createConcreteFieldReportRequestSchema,
  saveConcreteFieldReportRequestSchema,
  type ConcreteFieldReportFields,
} from './concrete-field-reports';
import { CONCRETE_MIX_SPEC_DEFAULTS, type ConcreteMixSnapshot } from './concrete-mixes';

// MM-V2-C04 test plan T1: the draft and final-review contracts against the field map (spec
// page 2). Fictional values only.

const KEY = '7b1f0c1e-4a52-4b8e-9d33-0f6d2c1a9e01';
const R1 = '11111111-1111-4111-8111-111111111111';
const R2 = '22222222-2222-4222-8222-222222222222';
const R3 = '33333333-3333-4333-8333-333333333333';

function blank(): ConcreteFieldReportFields {
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
    mixId: null,
    projectSpec: CONCRETE_REPORT_SPEC_EMPTY,
    ticketSpec: CONCRETE_REPORT_SPEC_EMPTY,
    readings: [],
    attachmentRefs: [],
  };
}

const SPEC = {
  ...CONCRETE_REPORT_SPEC_EMPTY,
  specifiedStrengthMpa: 32,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
};

function complete(): ConcreteFieldReportFields {
  return {
    ...blank(),
    reportDate: '2026-11-08',
    contractorName: 'Example Builders',
    locationElements: ['Footing'],
    locationDescription: 'Grid A-3',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: '000123',
    truckNumber: 'T-7',
    plantName: 'North',
    batchedAt: '2026-11-08T15:00:00.000Z',
    loadVolumeM3: 8,
    cumulativeVolumeM3: 24,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: '2026-11-08T15:20:00.000Z',
    sampledAt: '2026-11-08T15:30:00.000Z',
    testedAt: '2026-11-08T15:35:00.000Z',
    timeLimitExceeded: false,
    loadRejected: false,
    loadDecisionByName: 'Sam Example',
    loadDecisionByCompany: 'Example Builders',
    samplingLocation: 'chute',
    placementMethods: ['chute'],
    material: 'concrete',
    superplasticizerAdded: 'none',
    concreteTempC: 18,
    ambientTempC: -4,
    waterAdded: false,
    specimensCast: false,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders',
    readings: [
      {
        id: R1,
        test: 'slump',
        context: 'initial',
        position: 1,
        value: 90,
        measuredAt: null,
        note: null,
      },
      {
        id: R2,
        test: 'air',
        context: 'initial',
        position: 1,
        value: 6,
        measuredAt: null,
        note: null,
      },
    ],
    attachmentRefs: [{ id: R3, kind: 'ticket_photo', fileName: 'ticket.jpg', capturedAt: null }],
  };
}

const TECH = '44444444-4444-4444-8444-444444444444';

describe('concrete field-report contracts (MM-V2-C04 T1)', () => {
  it('AC1: an empty draft parses, blank text becomes null, and nothing defaults to No or 0', () => {
    const parsed = createConcreteFieldReportRequestSchema.parse({
      idempotencyKey: KEY,
      ticketNumber: '   ',
      supplierName: ' Example Ready-Mix ',
    });
    expect(parsed.ticketNumber).toBeNull();
    expect(parsed.supplierName).toBe('Example Ready-Mix');
    expect(parsed.material).toBeUndefined();
    expect(parsed.specimensCast).toBeUndefined();
    expect(parsed.timeLimitExceeded).toBeUndefined();
  });

  it('refuses unknown fields and malformed values, and keeps leading zeros', () => {
    expect(
      createConcreteFieldReportRequestSchema.safeParse({ idempotencyKey: KEY, specimenCount: 4 })
        .success,
    ).toBe(false);
    expect(
      createConcreteFieldReportRequestSchema.safeParse({ idempotencyKey: KEY, loadVolumeM3: -1 })
        .success,
    ).toBe(false);
    expect(
      createConcreteFieldReportRequestSchema.parse({ idempotencyKey: KEY, ticketNumber: '000123' })
        .ticketNumber,
    ).toBe('000123');
    expect(
      saveConcreteFieldReportRequestSchema.safeParse({
        idempotencyKey: KEY,
        version: 1,
        ambientTempC: -30,
      }).success,
    ).toBe(true);
  });

  it('AC3: readings keep one initial per test; retests are separate entries', () => {
    const ok = saveConcreteFieldReportRequestSchema.safeParse({
      idempotencyKey: KEY,
      version: 1,
      readings: [
        { id: R1, test: 'slump', context: 'initial', value: 80 },
        {
          id: R2,
          test: 'slump',
          context: 'retest',
          value: 110,
          measuredAt: '2026-11-08T15:40:00Z',
        },
        { id: R3, test: 'slump', context: 'retest', value: 95, measuredAt: '2026-11-08T15:50:00Z' },
      ],
    });
    expect(ok.success).toBe(true);
    const twoInitials = saveConcreteFieldReportRequestSchema.safeParse({
      idempotencyKey: KEY,
      version: 1,
      readings: [
        { id: R1, test: 'slump', context: 'initial', value: 80 },
        { id: R2, test: 'slump', context: 'initial', value: 90 },
      ],
    });
    expect(twoInitials.success).toBe(false);
    const air = saveConcreteFieldReportRequestSchema.safeParse({
      idempotencyKey: KEY,
      version: 1,
      readings: [{ id: R1, test: 'air', context: 'initial', value: 101 }],
    });
    expect(air.success).toBe(false);
  });

  it('final review: a blank draft lists every required field; a complete one lists none', () => {
    const missing = concreteFieldReportMissing({
      technicianUserId: null,
      fields: blank(),
      mixSnapshot: null,
    });
    for (const path of [
      'reportDate',
      'technicianUserId',
      'locationElements',
      'ticketNumber',
      'cumulativeVolumeM3',
      'projectSpec.slumpTargetMm',
      'ticketSpec.cementType',
      'timeLimitExceeded',
      'readings.slump.initial',
      'specimensCast',
      'attachmentRefs',
      'resultsReportedToName',
    ]) {
      expect(missing).toContain(path);
    }
    expect(
      concreteFieldReportCompleteness({
        technicianUserId: TECH,
        fields: complete(),
        mixSnapshot: null,
      }),
    ).toEqual({ complete: true, missingRequired: [] });
  });

  it('final review: conditional rows apply only when their condition holds', () => {
    const fields = {
      ...complete(),
      timeLimitExceeded: true,
      waterAdded: true,
      specimensCast: true,
      samplingLocation: 'other' as const,
      placementMethods: ['pump' as const, 'other' as const],
      locationElements: ['Other'],
      readings: [
        ...complete().readings,
        {
          id: R3,
          test: 'slump' as const,
          context: 'retest' as const,
          position: 2,
          value: null,
          measuredAt: null,
          note: null,
        },
      ],
    };
    expect(
      concreteFieldReportMissing({ technicianUserId: TECH, fields, mixSnapshot: null }),
    ).toEqual([
      'locationElementOther',
      'timeLimitInformed',
      'samplingLocationOther',
      'placementMethodOther',
      `readings.${R3}.value`,
      `readings.${R3}.measuredAt`,
      'waterAddedAuthorizedBy',
      'castAt',
    ]);
    // Air is required for routine concrete only (other materials' rules are open).
    const grout = {
      ...complete(),
      material: 'epoxy_grout' as const,
      readings: complete().readings.slice(0, 1),
    };
    expect(
      concreteFieldReportMissing({ technicianUserId: TECH, fields: grout, mixSnapshot: null }),
    ).toEqual([]);
  });

  it('AC5: unknown or unapproved mixes, out-of-range readings and ticket differences warn', () => {
    const fields = {
      ...complete(),
      ticketSpec: { ...SPEC, slumpTargetMm: 100 },
      readings: [
        {
          id: R1,
          test: 'slump' as const,
          context: 'initial' as const,
          position: 1,
          value: 115,
          measuredAt: null,
          note: null,
        },
        {
          id: R2,
          test: 'air' as const,
          context: 'initial' as const,
          position: 1,
          value: 4.5,
          measuredAt: null,
          note: null,
        },
      ],
    };
    const codes = concreteFieldReportWarnings({
      technicianUserId: TECH,
      fields,
      mixSnapshot: null,
    }).map((w) => [w.code, w.field]);
    expect(codes).toEqual([
      ['unknown_mix', 'mixNumber'],
      ['slump_out_of_range', `readings.${R1}.value`],
      ['air_out_of_range', `readings.${R2}.value`],
      ['ticket_differs_from_spec', 'ticketSpec.slumpTargetMm'],
    ]);
    const snapshot: ConcreteMixSnapshot = {
      mixId: R3,
      revisionId: R3,
      revisionNumber: 1,
      revisionState: 'draft',
      spec: {
        ...CONCRETE_MIX_SPEC_DEFAULTS,
        supplierName: 'Example Ready-Mix',
        mixNumber: '0042',
        testAges: [7, 28, 28, 'HOLD'],
      },
      capturedAt: '2026-11-08T15:00:00.000Z',
    };
    const withMix = { ...complete(), mixId: R3 };
    expect(
      concreteFieldReportWarnings({
        technicianUserId: TECH,
        fields: withMix,
        mixSnapshot: snapshot,
      }).map((w) => w.code),
    ).toEqual(['unapproved_mix']);
  });

  it('manual spec changes are the members that differ from the snapshot', () => {
    const snapshot: ConcreteMixSnapshot = {
      mixId: R3,
      revisionId: R3,
      revisionNumber: 2,
      revisionState: 'approved',
      spec: {
        ...CONCRETE_MIX_SPEC_DEFAULTS,
        supplierName: 'Example Ready-Mix',
        mixNumber: '0042',
        specifiedStrengthMpa: 32,
        slumpTargetMm: 80,
        testAges: [7, 28, 28, 'HOLD'],
      },
      capturedAt: '2026-11-08T15:00:00.000Z',
    };
    const fromMix = concreteReportSpecFromMix(snapshot);
    expect(fromMix.projectSpec.slumpTargetMm).toBe(80);
    expect(
      concreteReportManualSpecChanges(
        {
          projectSpec: { ...fromMix.projectSpec, slumpTargetMm: 100 },
          ticketSpec: fromMix.ticketSpec,
        },
        snapshot,
      ),
    ).toEqual({ projectSpec: ['slumpTargetMm'], ticketSpec: [] });
  });
});
