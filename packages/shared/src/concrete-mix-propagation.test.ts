import { describe, expect, it } from 'vitest';
import { concreteReportSpecFromMix } from './concrete-field-reports';
import {
  concreteMixPropagationDecisionSchema,
  concreteMixPropagationReportBlock,
  concreteMixPropagationReportChanges,
  concreteMixPropagationSpecimenChange,
} from './concrete-mix-propagation';
import { concreteMixSpecSchema, type ConcreteMixSnapshot } from './concrete-mixes';
import { concreteProjectSpecimenStatus } from './concrete-project-specimens';

// MM-V2-C30: mix propagation rules (which values a newer approved revision would change, what is
// kept, what is blocked) and the Specimens tab status. Fictional values only.

const key = '6f1d1c1e-2b9a-4c8e-9d61-3c7f0b2a4e11';
const spec = concreteMixSpecSchema.parse({
  supplierName: 'Example Ready-Mix',
  mixNumber: '0042',
  plantNames: [],
  specifiedStrengthMpa: 32,
  specifiedStrengthAgeDays: null,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
  specAdmixtures: { declaration: 'none', items: [] },
  ticketDefaults: {},
  testAges: [7, 28, 28, 'HOLD'],
});
const snapshot: ConcreteMixSnapshot = {
  mixId: 'mix-1',
  revisionId: 'rev-1',
  revisionNumber: 1,
  revisionState: 'approved',
  spec,
  capturedAt: '2026-11-01T16:00:00.000Z',
};

describe('concreteMixPropagationReportChanges', () => {
  it('proposes the changed spec members and the new revision', () => {
    const column = concreteReportSpecFromMix(snapshot).projectSpec;
    const target = {
      revisionId: 'rev-2',
      revisionNumber: 2,
      spec: { ...spec, slumpTargetMm: 100 },
    };
    const result = concreteMixPropagationReportChanges(column, snapshot, target);
    expect(result.affected).toBe(true);
    expect(result.kept).toEqual([]);
    expect(result.changes).toEqual([
      { field: 'projectSpec.slumpTargetMm', before: 80, proposed: 100 },
      { field: 'mixRevision', before: 1, proposed: 2 },
    ]);
  });

  it('keeps a member the technician changed by hand', () => {
    const column = { ...concreteReportSpecFromMix(snapshot).projectSpec, slumpTargetMm: 90 };
    const target = {
      revisionId: 'rev-2',
      revisionNumber: 2,
      spec: { ...spec, slumpTargetMm: 100, cementType: 'HE' },
    };
    const result = concreteMixPropagationReportChanges(column, snapshot, target);
    expect(result.kept).toEqual([
      { field: 'projectSpec.slumpTargetMm', before: 90, proposed: 100 },
    ]);
    expect(result.changes.map((c) => c.field)).toEqual(['projectSpec.cementType', 'mixRevision']);
  });

  it('is not affected when it already uses the approved revision', () => {
    const column = concreteReportSpecFromMix(snapshot).projectSpec;
    const result = concreteMixPropagationReportChanges(column, snapshot, {
      revisionId: 'rev-1',
      revisionNumber: 1,
      spec,
    });
    expect(result.affected).toBe(false);
  });

  it('a snapshot taken while the revision was a draft only moves the revision on', () => {
    const column = concreteReportSpecFromMix(snapshot).projectSpec;
    const result = concreteMixPropagationReportChanges(
      column,
      { ...snapshot, revisionState: 'draft' },
      { revisionId: 'rev-1', revisionNumber: 1, spec },
    );
    expect(result.affected).toBe(true);
    expect(result.changes).toEqual([{ field: 'mixRevision', before: 1, proposed: 1 }]);
  });
});

describe('concreteMixPropagationReportBlock', () => {
  it('allows drafts only (submitted, returned, reviewed and issued reports are blocked)', () => {
    const block = (workflowState: string, issueCount = 0) =>
      concreteMixPropagationReportBlock({ workflowState, issueCount });
    expect(block('draft')).toBeNull();
    expect(block('ready_to_submit')).toBe('report_ready_to_submit');
    expect(block('submitted')).toBe('report_submitted');
    expect(block('returned')).toBe('report_returned');
    expect(block('reviewed')).toBe('report_reviewed');
    expect(block('reviewed', 1)).toBe('report_issued');
    expect(block('draft', 1)).toBe('report_issued');
  });
});

describe('concreteMixPropagationSpecimenChange', () => {
  const change = (
    savedAge: never | 7 | 28 | 'HOLD' | null,
    currentAge: unknown,
    proposedAge: unknown,
  ) =>
    concreteMixPropagationSpecimenChange({
      savedAge,
      currentAge: currentAge as 7,
      proposedAge: proposedAge as 7,
    });

  it('proposes the newer age at the same position', () => {
    expect(change(7, 7, 3)).toEqual({
      change: { field: 'assignedAge', before: 7, proposed: 3 },
      block: null,
    });
  });

  it('nothing to do when the age is unchanged, already current, or has no newer entry', () => {
    expect(change(28, 28, 28)).toBeNull();
    expect(change(7, 3, 3)).toBeNull();
    expect(change(7, 7, null)).toBeNull();
  });

  it('a rescheduled or hand-changed age is kept; HOLD changes are blocked', () => {
    expect(change(7, 14, 3)?.block).toBe('manually_edited');
    expect(change('HOLD', 'HOLD', 56)?.block).toBe('hold_specimen');
    expect(change(28, 28, 'HOLD')?.block).toBe('hold_specimen');
  });
});

describe('concreteMixPropagationDecisionSchema', () => {
  it('is per item or Approve all of the displayed list', () => {
    const base = { idempotencyKey: key, previewId: 'abc123' };
    expect(
      concreteMixPropagationDecisionSchema.safeParse({
        ...base,
        selection: { kind: 'approve_all', displayedItemIds: ['i1', 'i2'] },
      }).success,
    ).toBe(true);
    expect(
      concreteMixPropagationDecisionSchema.safeParse({
        ...base,
        selection: { kind: 'items', itemIds: [] },
      }).success,
    ).toBe(false);
    expect(
      concreteMixPropagationDecisionSchema.safeParse({ ...base, selection: { kind: 'some' } })
        .success,
    ).toBe(false);
  });
});

describe('concreteProjectSpecimenStatus', () => {
  const today = '2026-11-08';
  const status = (row: Partial<Parameters<typeof concreteProjectSpecimenStatus>[0]>) =>
    concreteProjectSpecimenStatus({
      voided: false,
      assignedAge: 7,
      targetDate: null,
      holdExpiresOn: null,
      today,
      ...row,
    });

  it('derives the status from the stored dates', () => {
    expect(status({ voided: true, targetDate: today })).toBe('void');
    expect(status({})).toBe('awaiting_casting');
    expect(status({ targetDate: today })).toBe('due_today');
    expect(status({ targetDate: '2026-11-07' })).toBe('overdue');
    expect(status({ targetDate: '2026-11-09' })).toBe('scheduled');
    expect(status({ assignedAge: 'HOLD', holdExpiresOn: '2027-01-01' })).toBe('hold');
    expect(status({ assignedAge: 'HOLD' })).toBe('awaiting_casting');
  });
});
