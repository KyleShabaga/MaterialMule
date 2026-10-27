import {
  confirmReceiptRequestSchema,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import {
  duplicateUnit,
  fieldId,
  formatUnitCount,
  newDraft,
  newSummary,
  newUnit,
  newUuid,
  toConfirmRequest,
  todayInEdmonton,
  unitHeadline,
  validateDraft,
  withHoles,
  type ReceiptDraft,
  type SummaryDraft,
  type UnitDraft,
} from './draft';

// MM-T10 T1 (summary validation through the shared T09 schema) and T2 (quantity). Fictional data.

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: { id: '00000000-0000-4000-8000-000000000101', displayName: 'Pat Example', initials: 'PE' },
};
const th1: TestHole = {
  id: '00000000-0000-4000-8000-000000000301',
  projectId: project.id,
  name: 'TH26-01',
};
const th2: TestHole = {
  id: '00000000-0000-4000-8000-000000000302',
  projectId: project.id,
  name: 'TH26-02',
};
const receiver = {
  id: '00000000-0000-4000-8000-000000000102',
  initials: 'AT',
  displayName: 'Alex Tester',
  position: null,
};

function summary(hole: TestHole, changes: Partial<SummaryDraft>): SummaryDraft {
  return { ...newSummary(hole), ...changes };
}

function unit(...summaries: SummaryDraft[]): UnitDraft {
  return { ...newUnit(), summaries };
}

function draft(...units: UnitDraft[]): ReceiptDraft {
  return { ...newDraft(receiver, '2026-10-20'), project, units };
}

const TODAY = '2026-10-26';
const problems = (d: ReceiptDraft) => validateDraft(d, TODAY);

describe('newUuid', () => {
  it('makes RFC 4122 v4 UUIDs without crypto.randomUUID', () => {
    const ids = new Set(Array.from({ length: 50 }, newUuid));
    expect(ids.size).toBe(50);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('quantity (T2)', () => {
  it('is the number of unit rows', () => {
    expect(formatUnitCount(0)).toBe('0 storage units');
    expect(formatUnitCount(1)).toBe('1 storage unit');
    expect(formatUnitCount(3)).toBe('3 storage units');
    const units = [unit(), unit(), unit()];
    expect(formatUnitCount(draft(...units).units.length)).toBe('3 storage units');
    expect(toConfirmRequest(draft(...units)).units).toHaveLength(3);
  });
});

describe('draft model', () => {
  it('starts with one bucket, today, a fresh idempotency key and the given receiver', () => {
    const a = newDraft(receiver, '2026-10-26');
    const b = newDraft(null, '2026-10-26');
    expect(a.units).toHaveLength(1);
    expect(a.units[0]!.unitType).toBe('bucket');
    expect(a.receivedDate).toBe('2026-10-26');
    expect(a.receiver).toBe(receiver);
    expect(b.receiver).toBeNull();
    expect(a.idempotencyKey).not.toBe(b.idempotencyKey);
  });

  it('duplicates a unit with its summaries under a new row ID', () => {
    const original = unit(
      summary(th1, { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }),
    );
    const copy = duplicateUnit(original);
    expect(copy.clientRowId).not.toBe(original.clientRowId);
    expect(copy.summaries).toEqual(original.summaries);
    expect(copy.summaries[0]).not.toBe(original.summaries[0]);
  });

  it('keeps entered summaries when holes are added or removed', () => {
    const start = unit(summary(th1, { type: 'all' }));
    const both = withHoles(start, [th1, th2]);
    expect(both.summaries.map((s) => [s.testHole.name, s.type])).toEqual([
      ['TH26-01', 'all'],
      ['TH26-02', ''],
    ]);
    expect(withHoles(both, [th2]).summaries.map((s) => s.testHole.name)).toEqual(['TH26-02']);
  });

  it('reads like "Bucket 1 · TH26-01: G1–S12 · TH26-02: ALL"', () => {
    const mixed = unit(
      summary(th1, { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }),
      summary(th2, { type: 'all' }),
    );
    expect(unitHeadline(0, mixed)).toBe('Bucket 1 · TH26-01: G1–S12 · TH26-02: ALL');
    expect(
      unitHeadline(
        1,
        unit(
          summary(th1, { type: 'depth_range', depthFrom: '0', depthTo: '10.5', depthUnit: 'm' }),
        ),
      ),
    ).toBe('Bucket 2 · TH26-01: 0–10.5 m');
    expect(unitHeadline(2, unit())).toBe('Bucket 3 · no test holes yet');
  });

  it('sends only the chosen type’s fields, with depths as numbers and no unit conversion', () => {
    const d = draft(
      unit(
        summary(th1, {
          type: 'depth_range',
          depthFrom: '0',
          depthTo: '10.5',
          depthUnit: 'm',
          sampleFrom: 'stale',
          customText: 'stale',
        }),
      ),
    );
    const request = toConfirmRequest(d);
    expect(request.units[0]!.holeSummaries[0]).toEqual({
      testHoleId: th1.id,
      type: 'depth_range',
      note: '',
      depthFrom: 0,
      depthTo: 10.5,
      depthUnit: 'm',
    });
    const parsed = confirmReceiptRequestSchema.parse(request);
    expect(parsed.units[0]!.holeSummaries[0]).toMatchObject({
      depthFrom: 0,
      depthTo: 10.5,
      depthUnit: 'm',
      sampleFrom: null,
      customText: null,
    });
    expect(parsed.description).toBeNull();
  });
});

describe('validation matches the T09 rules (T1)', () => {
  it('accepts every summary type in its valid shape, with a blank description (AC8)', () => {
    const d = draft(
      unit(
        summary(th1, { type: 'sample_range', sampleFrom: 'G1', sampleTo: 'S12' }),
        summary(th2, { type: 'all' }),
      ),
      unit(summary(th1, { type: 'depth_range', depthFrom: '0', depthTo: '10.5', depthUnit: 'm' })),
      unit(summary(th1, { type: 'custom', customText: 'Mixed, 0–3 m' })),
    );
    expect(problems(d)).toEqual([]);
  });

  it('AC3: a reversed depth range (30 → 0)', () => {
    const d = draft(
      unit(summary(th1, { type: 'depth_range', depthFrom: '30', depthTo: '0', depthUnit: 'ft' })),
    );
    expect(problems(d)).toEqual([
      {
        field: 'units.0.holeSummaries.0.depthTo',
        where: 'Bucket 1 · TH26-01',
        message: 'Depth to must be greater than or equal to depth from.',
      },
    ]);
  });

  it('AC3: a depth range with no ft/m unit chosen', () => {
    const d = draft(
      unit(summary(th1, { type: 'depth_range', depthFrom: '0', depthTo: '3', depthUnit: '' })),
    );
    expect(problems(d)).toEqual([
      {
        field: 'units.0.holeSummaries.0.depthUnit',
        where: 'Bucket 1 · TH26-01',
        message: 'Choose ft or m.',
      },
    ]);
  });

  it('AC3: empty Custom text, including whitespace only', () => {
    const d = draft(unit(summary(th1, { type: 'custom', customText: '   ' })));
    expect(problems(d)).toEqual([
      {
        field: 'units.0.holeSummaries.0.customText',
        where: 'Bucket 1 · TH26-01',
        message: 'Describe the samples (Custom needs text).',
      },
    ]);
  });

  it('AC3: a unit with no test hole, and a receipt with no unit', () => {
    expect(problems(draft(unit()))).toEqual([
      {
        field: 'units.0.holeSummaries',
        where: 'Bucket 1',
        message: 'Choose at least one test hole.',
      },
    ]);
    expect(problems(draft())).toEqual([
      { field: 'units', where: '', message: 'Add at least one storage unit.' },
    ]);
  });

  it('needs a summary type and both ends of a sample or depth range', () => {
    const d = draft(
      unit(
        summary(th1, { type: '' }),
        summary(th2, { type: 'sample_range', sampleFrom: 'G1', sampleTo: ' ' }),
      ),
      unit(summary(th1, { type: 'depth_range', depthFrom: '', depthTo: '', depthUnit: 'm' })),
    );
    expect(problems(d).map((p) => `${p.where}: ${p.message}`)).toEqual([
      'Bucket 1 · TH26-01: Choose a summary type: ALL, Sample range, Depth range or Custom.',
      'Bucket 1 · TH26-02: Sample to is required.',
      'Bucket 2 · TH26-01: Depth from is required.',
      'Bucket 2 · TH26-01: Depth to is required.',
    ]);
  });

  it('rejects negative depths, more than two decimals and over-long sample labels', () => {
    const d = draft(
      unit(
        summary(th1, { type: 'depth_range', depthFrom: '-1', depthTo: '1.234', depthUnit: 'm' }),
      ),
      unit(summary(th1, { type: 'sample_range', sampleFrom: 'G'.repeat(21), sampleTo: 'S1' })),
    );
    expect(problems(d).map((p) => p.message)).toEqual([
      'Depth from must be 0 or more.',
      'Depth to must have at most two decimal places.',
      'Sample from must be at most 20 characters.',
    ]);
  });

  it('needs a project, a receiver and a received date that is not in the future', () => {
    const d: ReceiptDraft = {
      ...draft(unit(summary(th1, { type: 'all' }))),
      project: null,
      receiver: null,
      receivedDate: '2026-10-27',
    };
    expect(problems(d).map((p) => [p.field, p.message])).toEqual([
      ['projectId', 'Choose a project.'],
      ['receivedDate', "Received date can't be in the future."],
      ['receiverUserId', 'Choose who received the samples.'],
    ]);
    expect(problems({ ...d, receivedDate: '' }).map((p) => p.field)).toContain('receivedDate');
  });

  it('links each problem to a field id', () => {
    expect(fieldId('units.0.holeSummaries.1.depthTo')).toBe(
      'receipt-units-0-holeSummaries-1-depthTo',
    );
  });

  it('uses the Edmonton calendar day for today', () => {
    // 05:30 UTC on 27 Oct is still 26 Oct in Edmonton (UTC-6).
    expect(todayInEdmonton(new Date('2026-10-27T05:30:00Z'))).toBe('2026-10-26');
  });
});
