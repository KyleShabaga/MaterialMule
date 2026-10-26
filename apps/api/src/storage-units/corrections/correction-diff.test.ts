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
});
