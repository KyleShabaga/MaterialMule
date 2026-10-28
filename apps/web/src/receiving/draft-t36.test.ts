import {
  confirmReceiptRequestSchema,
  type BulkGroupSummary,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import {
  bulkSamplesInDraft,
  describeErrors,
  duplicateUnit,
  emptySample,
  newDraft,
  newSummary,
  newUnit,
  toConfirmRequest,
  unitHeadline,
  validateDraft,
  withUnitKind,
  type BulkIdentityDraft,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';

// MM-T36 receiving draft: Shelby tubes with a sampling source, bulk soil buckets sharing a bulk
// sample, one contents summary per unit, and the request each produces. Fictional data only.

const project: ProjectSummary = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Riverbank investigation',
  client: 'Example Client',
  pmPe: { id: '00000000-0000-4000-8000-000000000101', displayName: 'Pat Example', initials: 'PE' },
};
const th21: TestHole = {
  id: '00000000-0000-4000-8000-000000000321',
  projectId: project.id,
  name: 'TH26-21',
};
const receiver = {
  id: '00000000-0000-4000-8000-000000000102',
  initials: 'AT',
  displayName: 'Alex Tester',
  position: null,
};
const TODAY = '2026-10-26';

function draft(...units: UnitDraft[]): ReceiptDraft {
  return { ...newDraft(receiver, '2026-10-20'), project, units };
}

const b1: BulkIdentityDraft = {
  ...emptySample(),
  sourceType: 'test_hole',
  testHole: th21,
  sampleReference: 'B1',
  depthFrom: '1.5',
  depthTo: '2.0',
  depthUnit: 'm',
  description: '',
};

function bulkRow(identity: BulkIdentityDraft = b1): UnitDraft {
  return { ...withUnitKind(newUnit(), 'bulk'), bulkChoice: { kind: 'new', identity } };
}

function tube(sample: Partial<UnitDraft['tube']>): UnitDraft {
  const row = withUnitKind(newUnit(), 'shelby_tube');
  return { ...row, tube: { ...row.tube, ...sample } };
}

const existing: BulkGroupSummary = {
  id: '00000000-0000-4000-8000-000000000501',
  projectId: project.id,
  identity: {
    source: { type: 'standalone_location', locationReference: 'Stockpile 2' },
    sampleReference: 'B1',
    depthFrom: 0.5,
    depthTo: null,
    depthUnit: 'm',
  },
  description: null,
  memberCount: 2,
  version: 3,
};

describe('MM-T36 receiving draft', () => {
  it('two buckets of one new bulk sample declare it once and share it (AC1)', () => {
    const first = bulkRow();
    const second = duplicateUnit(first);
    expect(second.bulkChoice).toEqual({ kind: 'same_as', clientRowId: first.clientRowId });
    const d = draft(first, second);
    const request = toConfirmRequest(d);
    expect(request.bulkGroups).toEqual([
      {
        key: first.clientRowId,
        sourceType: 'test_hole',
        testHoleId: th21.id,
        sampleReference: 'B1',
        depthFrom: 1.5,
        depthTo: 2,
        depthUnit: 'm',
        description: '',
      },
    ]);
    expect(request.units.map((u) => u.bulkGroup)).toEqual([
      { newGroupKey: first.clientRowId },
      { newGroupKey: first.clientRowId },
    ]);
    // Only the bulk sample is sent: no hole summaries or tube sample on a bulk bucket.
    expect(request.units[0]).not.toHaveProperty('holeSummaries');
    expect(request.units[0]).not.toHaveProperty('sample');
    expect(confirmReceiptRequestSchema.safeParse(request).success).toBe(true);
    expect(validateDraft(d, TODAY)).toEqual([]);
    expect(bulkSamplesInDraft(d)).toMatchObject([
      { text: 'TH26-21: B1 at 1.5–2.0 m', rows: [{ index: 0 }, { index: 1 }] },
    ]);
  });

  it('a later bucket joins an existing bulk sample at the version shown, typing nothing again', () => {
    const row: UnitDraft = { ...bulkRow(), bulkChoice: { kind: 'existing', group: existing } };
    const request = toConfirmRequest(draft(row));
    expect(request.units[0]!.bulkGroup).toEqual({ existingId: existing.id, version: 3 });
    expect(request).not.toHaveProperty('bulkGroups');
    expect(unitHeadline(0, row)).toBe('Bucket 1 · Bulk soil sample · Stockpile 2 · B1 · 0.5 m');
  });

  it('Shelby tubes from a test hole and a standalone location carry only their own source (AC7)', () => {
    const fromHole = tube({ sourceType: 'test_hole', testHole: th21, sampleReference: 'T5' });
    const standalone = tube({
      sourceType: 'standalone_location',
      locationReference: 'Embankment Location 03',
      depthFrom: '10',
      depthTo: '12',
      depthUnit: 'ft',
    });
    const d = draft(fromHole, standalone);
    const request = toConfirmRequest(d);
    expect(request.units.map((u) => u.sample)).toEqual([
      {
        sourceType: 'test_hole',
        testHoleId: th21.id,
        sampleReference: 'T5',
        depthFrom: null,
        depthTo: null,
        depthUnit: null,
      },
      {
        sourceType: 'standalone_location',
        sourceLocationReference: 'Embankment Location 03',
        sampleReference: '',
        depthFrom: 10,
        depthTo: 12,
        depthUnit: 'ft',
      },
    ]);
    expect(validateDraft(d, TODAY)).toEqual([]);
    expect(unitHeadline(1, standalone)).toBe('Shelby tube 2 · Embankment Location 03: 10–12 ft');
  });

  it('switching holder or contents drops what the other kind held (no hidden conflicting fields)', () => {
    const bucket: UnitDraft = { ...newUnit(), summaries: [{ ...newSummary(th21), type: 'all' }] };
    const asBulk = withUnitKind(bucket, 'bulk');
    expect(asBulk.summaries).toEqual([]);
    const asTube = withUnitKind(
      { ...asBulk, bulkChoice: { kind: 'new', identity: b1 } },
      'shelby_tube',
    );
    expect(asTube).toMatchObject({ unitType: 'shelby_tube', bulk: false, summaries: [] });
    expect(asTube.bulkChoice).toEqual({
      kind: 'new',
      identity: { ...emptySample(), description: '' },
    });
    expect(withUnitKind(asTube, 'bucket').tube).toEqual(emptySample());
  });

  it('reports missing bulk identity and tube source on the right row', () => {
    const blankBulk = bulkRow({ ...emptySample(), description: '' });
    const blankTube = tube({});
    const d = draft(blankBulk, blankTube);
    expect(validateDraft(d, TODAY).map((p) => [p.field, p.where, p.message])).toEqual([
      [
        'units.0.bulkGroup.new.sourceType',
        'Bucket 1',
        'Choose the sampling source: a test hole or a standalone sampling location.',
      ],
      [
        'units.1.sample.sourceType',
        'Shelby tube 2',
        'Choose the sampling source: a test hole or a standalone sampling location.',
      ],
    ]);
    const noRef = bulkRow({ ...b1, sampleReference: ' ', depthFrom: '', depthUnit: '' });
    expect(validateDraft(draft(noRef), TODAY).map((p) => p.message)).toEqual([
      'Enter the sample reference (for example B1).',
      'Enter the depth (or the top of the depth interval).',
      'Choose ft or m.',
    ]);
    const reversed = bulkRow({ ...b1, depthFrom: '2', depthTo: '1' });
    expect(validateDraft(draft(reversed), TODAY).map((p) => p.field)).toEqual([
      'units.0.bulkGroup.new.depthTo',
    ]);
    // A non-B reference is fine: B is a convention.
    expect(validateDraft(draft(bulkRow({ ...b1, sampleReference: 'S-7' })), TODAY)).toEqual([]);
  });

  it('a "same as" bucket whose first bucket was removed must choose again', () => {
    const first = bulkRow();
    const second = duplicateUnit(first);
    const d = draft(second);
    expect(validateDraft(d, TODAY).map((p) => [p.field, p.message])).toEqual([
      [
        'units.0.bulkGroup',
        'The bucket this one shared a bulk sample with was changed or removed. Choose the bulk sample again.',
      ],
    ]);
  });

  it('server errors about a new bulk sample point at the row that describes it', () => {
    const first = bulkRow();
    const tubeRow = tube({ sourceType: 'test_hole', testHole: th21 });
    const second = bulkRow({ ...b1, sampleReference: 'B2' });
    const d = draft(first, tubeRow, second);
    expect(
      describeErrors(d, [
        { field: 'bulkGroups.1.testHoleId', code: 'test_hole_not_in_project', message: 'x' },
        { field: 'units.0.bulkGroup.version', code: 'bulk_group_changed', message: 'x' },
      ]).map((p) => [p.field, p.where, p.message]),
    ).toEqual([
      [
        'units.2.bulkGroup.new.testHoleId',
        'Bucket 3',
        'That test hole isn’t part of this project. Choose it again.',
      ],
      [
        'units.0.bulkGroup',
        'Bucket 1',
        'This bulk sample was corrected since it was chosen. Choose it again.',
      ],
    ]);
  });
});
