import { describe, expect, it } from 'vitest';
import {
  CONCRETE_DEVICE_SYNC_STATUSES,
  CONCRETE_WORKFLOW_STATES,
  concreteDraftCompletenessSchema,
  concreteFieldReportSchema,
  concreteIssuanceSchema,
  concretePermanentNumber,
  concreteReportAcknowledgmentSchema,
  concreteSetIdentitySchema,
  concreteSpecimenAlias,
  concreteSpecimenSetSchema,
  concreteWorkflowSchema,
  type ConcreteFieldReport,
} from './concrete';
import { CONCRETE_FIXTURES } from './concrete-fixtures';

const clone = <T>(value: T): T => structuredClone(value);

describe('concrete fixtures (MM-V2-C01 T2)', () => {
  it.each(Object.entries(CONCRETE_FIXTURES))('%s parses', (_name, fixture) => {
    expect(concreteFieldReportSchema.parse(fixture)).toEqual(fixture);
  });

  it('an empty draft has no sets, no numbers and is incomplete, not zero', () => {
    const draft = CONCRETE_FIXTURES.emptyDraft;
    expect(draft.sets).toEqual([]);
    expect(draft.technicianUserId).toBeNull();
    expect(draft.completeness.complete).toBe(false);
    expect(draft.workflow.state).toBe('draft');
    expect(draft.issuance.status).toBe('not_issued');
  });

  it('attaching a permanent alias keeps every internal UUID', () => {
    const ids = (r: ConcreteFieldReport) => ({
      report: r.id,
      sets: r.sets.map((s) => ({ id: s.id, specimens: s.specimens.map((sp) => sp.id) })),
    });
    const before = CONCRETE_FIXTURES.draftWithTemporarySet;
    const after = CONCRETE_FIXTURES.withPermanentAlias;
    expect(ids(after)).toEqual(ids(before));
    expect(after.sets[0]!.identity.temporaryId).toBe(before.sets[0]!.identity.temporaryId);
    expect(after.sets[0]!.specimens.map((s) => s.identity)).toEqual([
      { temporaryId: 'TMP-D07-001A', permanentId: '26-01A' },
      { temporaryId: 'TMP-D07-001B', permanentId: '26-01B' },
    ]);
  });
});

describe('separate status dimensions', () => {
  it('no value appears in more than one dimension', () => {
    const all = [
      ...CONCRETE_WORKFLOW_STATES,
      ...CONCRETE_DEVICE_SYNC_STATUSES,
      'not_issued',
      'issued',
    ];
    expect(new Set(all).size).toBe(all.length);
  });

  it('workflow refuses issuance and sync values', () => {
    for (const state of ['issued', 'revised', 'accepted', 'pending_upload', 'complete']) {
      expect(
        concreteWorkflowSchema.safeParse({ state, readyToSubmitAt: null, submittedAt: null })
          .success,
      ).toBe(false);
    }
  });

  it('workflow times follow the state', () => {
    const t = '2026-11-07T16:00:00.000Z';
    const ok = (state: string, readyToSubmitAt: string | null, submittedAt: string | null) =>
      concreteWorkflowSchema.safeParse({ state, readyToSubmitAt, submittedAt }).success;
    expect(ok('ready_to_submit', null, null)).toBe(false);
    expect(ok('ready_to_submit', t, null)).toBe(true);
    expect(ok('submitted', t, null)).toBe(false);
    expect(ok('submitted', t, t)).toBe(true);
    expect(ok('draft', null, t)).toBe(false);
    expect(ok('void', null, null)).toBe(true);
  });

  it('completeness agrees with the missing list', () => {
    expect(
      concreteDraftCompletenessSchema.safeParse({ complete: true, missingRequired: ['slump'] })
        .success,
    ).toBe(false);
    expect(
      concreteDraftCompletenessSchema.safeParse({ complete: false, missingRequired: [] }).success,
    ).toBe(false);
  });

  it('issuance fields agree with the issue count', () => {
    const issued = CONCRETE_FIXTURES.issued.issuance;
    expect(concreteIssuanceSchema.safeParse({ ...issued, status: 'not_issued' }).success).toBe(
      false,
    );
    expect(concreteIssuanceSchema.safeParse({ ...issued, lastIssuedAt: null }).success).toBe(false);
    expect(
      concreteIssuanceSchema.safeParse({ ...CONCRETE_FIXTURES.emptyDraft.issuance, issueCount: 1 })
        .success,
    ).toBe(false);
    const report = clone(CONCRETE_FIXTURES.issued);
    report.issuance.lastIssuedVersion = report.version + 1;
    expect(concreteFieldReportSchema.safeParse(report).success).toBe(false);
  });

  it('a sync acknowledgment carries the accepted version', () => {
    expect(
      concreteReportAcknowledgmentSchema.safeParse({
        reportId: CONCRETE_FIXTURES.emptyDraft.id,
        acceptedVersion: 0,
        acceptedAt: '2026-11-07T16:00:00.000Z',
      }).success,
    ).toBe(false);
  });
});

describe('identity contracts', () => {
  it('derives the counter and specimen aliases', () => {
    expect(concretePermanentNumber('27-03')).toBe(3);
    expect(concretePermanentNumber('G27-123')).toBe(123);
    expect(concreteSpecimenAlias('TMP-D07-001', 'A')).toBe('TMP-D07-001A');
    expect(concreteSpecimenAlias(null, 'A')).toBeNull();
  });

  it('refuses mismatched or malformed set identities', () => {
    const ok = (temporaryId: string | null, permanentId: string | null, n: number | null) =>
      concreteSetIdentitySchema.safeParse({ temporaryId, permanentId, permanentNumber: n }).success;
    expect(ok(null, null, null)).toBe(true);
    expect(ok('TMP-D07-001', '27-03', 3)).toBe(true);
    expect(ok(null, 'G27-03', 3)).toBe(true);
    expect(ok(null, '27-03', 4)).toBe(false);
    expect(ok(null, '27-03', null)).toBe(false);
    expect(ok(null, null, 3)).toBe(false);
    expect(ok(null, '27-3', 3)).toBe(false);
    expect(ok('D07-001', null, null)).toBe(false);
  });

  it('refuses duplicate letters, more than 26 specimens, foreign children and drifting aliases', () => {
    const base = CONCRETE_FIXTURES.withPermanentAlias.sets[0]!;
    const dupe = clone(base);
    dupe.specimens[1]!.letter = 'A';
    dupe.specimens[1]!.identity = { temporaryId: 'TMP-D07-001A', permanentId: '26-01A' };
    expect(concreteSpecimenSetSchema.safeParse(dupe).success).toBe(false);

    const many = clone(base);
    many.specimens = Array.from({ length: 27 }, () => clone(base.specimens[0]!));
    expect(concreteSpecimenSetSchema.safeParse(many).success).toBe(false);

    const drift = clone(base);
    drift.specimens[0]!.identity.permanentId = '26-02A';
    expect(concreteSpecimenSetSchema.safeParse(drift).success).toBe(false);

    const foreign = clone(base);
    foreign.specimens[0]!.projectId = '00000000-0000-4000-8000-000000000202';
    expect(concreteSpecimenSetSchema.safeParse(foreign).success).toBe(false);

    const report = clone(CONCRETE_FIXTURES.withPermanentAlias);
    report.sets[0]!.projectId = '00000000-0000-4000-8000-000000000202';
    expect(concreteFieldReportSchema.safeParse(report).success).toBe(false);
  });
});
