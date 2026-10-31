import type { StorageUnitHoleSummary } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { diffCorrection, type CorrectableValues } from './correction-diff.js';

const hole = (
  id: string,
  name: string,
  changes: Partial<StorageUnitHoleSummary> = {},
): StorageUnitHoleSummary => ({
  testHoleId: id,
  testHoleName: name,
  type: 'all',
  sampleFrom: null,
  sampleTo: null,
  depthFrom: null,
  depthTo: null,
  depthUnit: null,
  customText: null,
  note: null,
  ...changes,
});

const current: CorrectableValues = {
  unitType: 'bucket',
  receivedDate: '2026-10-23',
  project: { id: 'p1', projectNumber: 'DEMO-2601' },
  sample: null,
  bulkGroup: null,
  holeSummaries: [hole('h1', 'TH26-01'), hole('h2', 'TH26-02')],
  note: 'Lid taped',
};

describe('diffCorrection (MM-T13 T1)', () => {
  it('reports nothing when every value is the same', () => {
    const same = { ...current, holeSummaries: [...current.holeSummaries].reverse() };
    expect(diffCorrection(current, same)).toEqual({ fields: [], before: {}, after: {} });
  });

  it('includes only the changed fields, with their old and new values', () => {
    const diff = diffCorrection(current, { ...current, receivedDate: '2026-10-21' });
    expect(diff).toEqual({
      fields: ['receivedDate'],
      before: { receivedDate: '2026-10-23' },
      after: { receivedDate: '2026-10-21' },
    });
  });

  it('treats summaries as a set and notices any changed value', () => {
    const next = {
      ...current,
      holeSummaries: [hole('h2', 'TH26-02'), hole('h1', 'TH26-01', { note: 'wet' })],
    };
    const diff = diffCorrection(current, next);
    expect(diff.fields).toEqual(['holeSummaries']);
    expect(diff.before.holeSummaries).toEqual(current.holeSummaries);
    expect(diff.after.holeSummaries).toEqual(next.holeSummaries);
  });

  it('lists several changes in display order, project by ID', () => {
    const diff = diffCorrection(current, {
      ...current,
      note: null,
      project: { id: 'p2', projectNumber: 'DEMO-2602' },
      holeSummaries: [hole('h9', 'TH26-01')],
    });
    expect(diff.fields).toEqual(['project', 'holeSummaries', 'note']);
    expect(diff.before).toMatchObject({
      project: { projectNumber: 'DEMO-2601' },
      note: 'Lid taped',
    });
    expect(diff.after).toMatchObject({ project: { projectNumber: 'DEMO-2602' }, note: null });
    expect(Object.keys(diff.after)).not.toContain('receivedDate');
  });

  it('MM-T82: compares a tube source by value, not by the hole name shown', () => {
    const tube: CorrectableValues = {
      ...current,
      unitType: 'shelby_tube',
      holeSummaries: [],
      sample: {
        source: { type: 'test_hole', testHoleId: 'h1', testHoleName: 'TH26-01' },
        sampleReference: 'T5',
        depthFrom: 1.5,
        depthTo: null,
        depthUnit: 'm',
      },
    };
    const renamed = {
      ...tube,
      sample: {
        ...tube.sample!,
        source: { type: 'test_hole' as const, testHoleId: 'h1', testHoleName: 'TH26-01A' },
      },
    };
    expect(diffCorrection(tube, renamed).fields).toEqual([]);
    const moved = {
      ...tube,
      sample: {
        ...tube.sample!,
        source: { type: 'standalone_location' as const, locationReference: 'Pit 3' },
      },
    };
    const diff = diffCorrection(tube, moved);
    expect(diff.fields).toEqual(['sample']);
    expect(diff.after.sample).toEqual(moved.sample);
  });

  it('MM-T82: leaving the bulk sample is a bulkGroup change, listed before the new test holes', () => {
    const bulk: CorrectableValues = {
      ...current,
      unitType: 'bulk_container',
      holeSummaries: [],
      bulkGroup: {
        id: 'g1',
        source: { type: 'test_hole', testHoleId: 'h1', testHoleName: 'TH26-01' },
        sampleReference: 'B1',
        depthFrom: 1,
        depthTo: 2,
        depthUnit: 'm',
        description: null,
        memberNumber: 1,
        memberCount: 2,
      },
    };
    const diff = diffCorrection(bulk, {
      ...bulk,
      unitType: 'bucket',
      bulkGroup: null,
      holeSummaries: [hole('h1', 'TH26-01')],
    });
    expect(diff.fields).toEqual(['unitType', 'bulkGroup', 'holeSummaries']);
    expect(diff.after.bulkGroup).toBeNull();
  });
});
