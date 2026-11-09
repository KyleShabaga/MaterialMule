import { describe, expect, it } from 'vitest';
import {
  CONCRETE_MIX_SPEC_DEFAULTS,
  approveConcreteMixRequestSchema,
  concreteAdmixturesSchema,
  concreteMixListQuerySchema,
  concreteMixMissingForApproval,
  concreteMixSpecSchema,
  copyConcreteMixRequestSchema,
  createConcreteMixRequestSchema,
  updateConcreteMixRequestSchema,
} from './concrete-mixes';

// MM-V2-C03 test plan T1: mix validators (target/tolerance, air bounds, optional strength age,
// repeated test ages and HOLD). Fictional values only.

const key = '6f1d1c1e-2b9a-4c8e-9d61-3c7f0b2a4e11';
const fullSpec = {
  supplierName: 'Example Ready-Mix',
  mixNumber: '0042',
  plantNames: ['North Plant'],
  specifiedStrengthMpa: 32,
  specifiedStrengthAgeDays: null,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
  specAdmixtures: { declaration: 'none' as const, items: [] },
  ticketDefaults: {},
  testAges: [7, 28, 28, 'HOLD' as const],
};

describe('concrete mix contracts (MM-V2-C03)', () => {
  it('new mixes default to 7/28/28/HOLD with HOLD and the repeated 28 kept as distinct entries', () => {
    expect(CONCRETE_MIX_SPEC_DEFAULTS.testAges).toEqual([7, 28, 28, 'HOLD']);
    const spec = concreteMixSpecSchema.parse({
      ...fullSpec,
      testAges: [7, 28, 28, 28, 'HOLD', 'HOLD'],
    });
    expect(spec.testAges).toEqual([7, 28, 28, 28, 'HOLD', 'HOLD']);
  });

  it('a create needs only supplier and mix number; the rest may wait as null, never 0', () => {
    const parsed = createConcreteMixRequestSchema.parse({
      idempotencyKey: key,
      spec: { supplierName: '  Example Ready-Mix ', mixNumber: '007' },
    });
    expect(parsed.spec).toEqual({ supplierName: 'Example Ready-Mix', mixNumber: '007' });
    expect(
      createConcreteMixRequestSchema.safeParse({ idempotencyKey: key, spec: { mixNumber: '1' } })
        .success,
    ).toBe(false);
    expect(
      createConcreteMixRequestSchema.safeParse({
        idempotencyKey: key,
        spec: { supplierName: 'S', mixNumber: '1', bogus: 1 },
      }).success,
    ).toBe(false);
  });

  it('specified strength age is optional and separate from test ages (AC1)', () => {
    const spec = concreteMixSpecSchema.parse(fullSpec);
    expect(spec.specifiedStrengthAgeDays).toBeNull();
    expect(concreteMixMissingForApproval(spec)).toEqual([]);
    expect(
      concreteMixSpecSchema.parse({ ...fullSpec, specifiedStrengthAgeDays: 56 })
        .specifiedStrengthAgeDays,
    ).toBe(56);
    for (const bad of [0, 1000, 2.5]) {
      expect(
        concreteMixSpecSchema.safeParse({ ...fullSpec, specifiedStrengthAgeDays: bad }).success,
      ).toBe(false);
    }
  });

  it('slump is target ± tolerance; negative values are refused but no limit is hardcoded', () => {
    expect(
      concreteMixSpecSchema.safeParse({ ...fullSpec, slumpTargetMm: 250, slumpToleranceMm: 0 })
        .success,
    ).toBe(true);
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, slumpToleranceMm: -1 }).success).toBe(
      false,
    );
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, slumpTargetMm: -5 }).success).toBe(false);
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, slumpTargetMm: 80.25 }).success).toBe(
      false,
    );
  });

  it('air is min–max within 0–100 with min ≤ max, in the spec and the ticket column', () => {
    expect(
      concreteMixSpecSchema.safeParse({ ...fullSpec, airMinPercent: 6, airMaxPercent: 6 }).success,
    ).toBe(true);
    const inverted = concreteMixSpecSchema.safeParse({
      ...fullSpec,
      airMinPercent: 8,
      airMaxPercent: 5,
    });
    expect(inverted.success).toBe(false);
    expect(inverted.error!.issues[0]!.path).toEqual(['airMaxPercent']);
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, airMaxPercent: 101 }).success).toBe(
      false,
    );
    const ticket = concreteMixSpecSchema.safeParse({
      ...fullSpec,
      ticketDefaults: { airMinPercent: 9, airMaxPercent: 4 },
    });
    expect(ticket.error!.issues[0]!.path).toEqual(['ticketDefaults', 'airMaxPercent']);
    const patch = updateConcreteMixRequestSchema.safeParse({
      idempotencyKey: key,
      version: 1,
      spec: { airMinPercent: 9, airMaxPercent: 4 },
    });
    expect(patch.success).toBe(false);
  });

  it('approval needs the required set; missing values are reported, strength age is not required', () => {
    const draft = concreteMixSpecSchema.parse({
      ...fullSpec,
      specifiedStrengthMpa: null,
      cementType: null,
    });
    expect(concreteMixMissingForApproval(draft)).toEqual(['specifiedStrengthMpa', 'cementType']);
  });

  it('admixtures: None and Unknown are answers distinct from blank; dosage only where printed', () => {
    expect(concreteAdmixturesSchema.parse({})).toEqual({ declaration: null, items: [] });
    expect(concreteAdmixturesSchema.parse({ declaration: 'unknown' }).declaration).toBe('unknown');
    expect(
      concreteAdmixturesSchema.parse({
        declaration: 'listed',
        items: [
          { kind: 'superplasticizer', dosage: 1.25 },
          { kind: 'other', description: 'Shrinkage reducer' },
        ],
      }).items,
    ).toEqual([
      { kind: 'superplasticizer', dosage: 1.25, description: null },
      { kind: 'other', dosage: null, description: 'Shrinkage reducer' },
    ]);
    for (const bad of [
      { declaration: 'listed', items: [] },
      { declaration: 'none', items: [{ kind: 'ice' }] },
      { declaration: 'listed', items: [{ kind: 'ice', dosage: 2 }] },
      { declaration: 'listed', items: [{ kind: 'ice', description: 'x' }] },
      { declaration: 'listed', items: [{ kind: 'ice' }, { kind: 'ice' }] },
    ]) {
      expect(concreteAdmixturesSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });

  it('identifiers keep leading zeros and refuse control characters', () => {
    expect(concreteMixSpecSchema.parse({ ...fullSpec, mixNumber: '00012' }).mixNumber).toBe(
      '00012',
    );
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, mixNumber: 'a\u0007' }).success).toBe(
      false,
    );
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, plantNames: ['A', 'a'] }).success).toBe(
      false,
    );
  });

  it('test ages: 1–26 entries of 1–999 days or HOLD', () => {
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, testAges: [] }).success).toBe(false);
    expect(
      concreteMixSpecSchema.safeParse({ ...fullSpec, testAges: Array(27).fill(28) }).success,
    ).toBe(false);
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, testAges: [0] }).success).toBe(false);
    expect(concreteMixSpecSchema.safeParse({ ...fullSpec, testAges: ['hold'] }).success).toBe(
      false,
    );
  });

  it('approve names the revision; copy names the source; list paging is bounded', () => {
    expect(
      approveConcreteMixRequestSchema.safeParse({ idempotencyKey: key, version: 1 }).success,
    ).toBe(false);
    expect(
      copyConcreteMixRequestSchema.safeParse({ idempotencyKey: key, sourceMixId: key }).success,
    ).toBe(true);
    expect(concreteMixListQuerySchema.parse({})).toMatchObject({ page: 1, pageSize: 50 });
    expect(concreteMixListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(concreteMixListQuerySchema.parse({ supplier: ' ' }).supplier).toBeUndefined();
  });
});
