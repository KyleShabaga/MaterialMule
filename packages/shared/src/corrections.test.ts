import { describe, expect, it } from 'vitest';
import {
  describeStorageUnitCorrection,
  minimumRetainUntil,
  storageUnitCorrectionRequestSchema,
} from './corrections';
import { toFieldErrors } from './receipts';

const HOLE = '00000000-0000-4000-8000-000000000301';
const PROJECT = '00000000-0000-4000-8000-000000000201';

describe('minimumRetainUntil (TRP-T13)', () => {
  it('adds one year, turning 29 February into 28 February', () => {
    expect(minimumRetainUntil('2026-10-21')).toBe('2027-10-21');
    expect(minimumRetainUntil('2028-02-29')).toBe('2029-02-28');
    expect(minimumRetainUntil('2027-02-28')).toBe('2028-02-28');
  });
});

describe('storageUnitCorrectionRequestSchema', () => {
  const parse = (body: unknown) => storageUnitCorrectionRequestSchema.safeParse(body);
  const fields = (body: unknown) => {
    const result = parse(body);
    return result.success ? [] : toFieldErrors(result.error).map((e) => `${e.field}:${e.code}`);
  };

  it('keeps an absent note unchanged and turns a blank one into null', () => {
    const absent = parse({
      version: 1,
      reason: 'wrong date',
      changes: { receivedDate: '2026-10-21' },
    });
    expect(absent.success && absent.data.changes.note).toBeUndefined();
    const blank = parse({ version: 1, reason: 'clear note', changes: { note: '   ' } });
    expect(blank.success && blank.data.changes.note).toBeNull();
  });

  it('needs a reason of at least 5 characters and at least one change', () => {
    expect(fields({ version: 1, changes: { note: 'x' } })).toEqual(['reason:invalid_type']);
    expect(fields({ version: 1, reason: ' abc ', changes: { note: 'x' } })).toEqual([
      'reason:too_small',
    ]);
    expect(fields({ version: 1, reason: 'nothing', changes: {} })).toEqual(['changes:no_changes']);
  });

  it('refuses the ID or location and needs holes with a new project', () => {
    expect(
      fields({ version: 1, reason: 'rename', changes: { readableId: 'BKT-2026-000001' } }),
    ).toEqual(['changes:unrecognized_keys', 'changes:no_changes']);
    expect(fields({ version: 1, reason: 'move it', changes: { projectId: PROJECT } })).toEqual([
      'changes.holeSummaries:required',
    ]);
    expect(
      fields({
        version: 1,
        reason: 'duplicate',
        changes: {
          holeSummaries: [
            { testHoleId: HOLE, type: 'all' },
            { testHoleId: HOLE, type: 'all' },
          ],
        },
      }),
    ).toEqual(['changes.holeSummaries.1.testHoleId:duplicate_test_hole']);
  });
});

describe('describeStorageUnitCorrection', () => {
  it('describes each changed field in words', () => {
    expect(
      describeStorageUnitCorrection(
        {
          receivedDate: '2026-10-23',
          project: { id: 'a', projectNumber: 'DEMO-2601' },
          holeSummaries: [{ testHoleName: 'TH26-01', type: 'all' }],
          note: null,
          unitType: 'shelby_tube',
        },
        {
          receivedDate: '2026-10-21',
          project: { id: 'b', projectNumber: 'DEMO-2602' },
          holeSummaries: [
            {
              testHoleName: 'TH26-01',
              type: 'depth_range',
              depthFrom: 0,
              depthTo: 1.5,
              depthUnit: 'm',
            },
          ],
          note: 'Lid taped',
          unitType: 'bucket',
        },
      ),
    ).toEqual([
      'type Shelby tube → Bucket',
      'received date 2026-10-23 → 2026-10-21',
      'project DEMO-2601 → DEMO-2602',
      'test holes TH26-01: ALL → TH26-01: 0–1.5 m',
      'note none → Lid taped',
    ]);
  });
});
