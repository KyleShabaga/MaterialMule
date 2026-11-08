import { describe, expect, it } from 'vitest';
import {
  CONCRETE_REPORT_ACTIONS,
  CONCRETE_REPORT_LIFECYCLE_STATES,
  concreteReportCommentRequiredSchema,
  concreteReportLifecycleState,
  concreteReportMayReviewRouted,
  concreteReportNextState,
  concreteReportRoute,
  concreteReportStoredState,
  type ConcreteReportAction,
  type ConcreteReportLifecycleState,
} from './concrete-report-lifecycle';

// MM-V2-C09 test plan T1: the transition table, including every illegal transition, and the
// routing rules (D11). Fictional ids only.

const LEAD = '11111111-1111-4111-8111-111111111111';
const REVIEWER = '22222222-2222-4222-8222-222222222222';
const OTHER = '33333333-3333-4333-8333-333333333333';

const ALLOWED: [
  ConcreteReportLifecycleState,
  ConcreteReportAction,
  ConcreteReportLifecycleState,
][] = [
  ['draft', 'submit', 'submitted'],
  ['ready_to_submit', 'submit', 'submitted'],
  ['submitted', 'recall', 'draft'],
  ['submitted', 'return', 'returned'],
  ['submitted', 'review', 'reviewed'],
  ['returned', 'resubmit', 'submitted'],
  ['reviewed', 'return', 'returned'],
  ['reviewed', 'issue', 'issued'],
  ['issued', 'revise', 'draft'],
];

describe('report lifecycle transitions (T1)', () => {
  it('allows exactly the confirmed transitions and refuses every other pair', () => {
    for (const state of CONCRETE_REPORT_LIFECYCLE_STATES) {
      for (const action of CONCRETE_REPORT_ACTIONS) {
        const expected = ALLOWED.find(([s, a]) => s === state && a === action)?.[2] ?? null;
        expect(concreteReportNextState(state, action), `${state} + ${action}`).toBe(expected);
      }
    }
  });

  it('recall only before review; issued reports are corrected by revision, never returned', () => {
    expect(concreteReportNextState('reviewed', 'recall')).toBeNull();
    expect(concreteReportNextState('issued', 'return')).toBeNull();
    expect(concreteReportNextState('issued', 'issue')).toBeNull();
    expect(concreteReportNextState('returned', 'submit')).toBeNull();
    expect(concreteReportNextState('void', 'submit')).toBeNull();
  });

  it('issued is reviewed plus an issued latest version; it is stored as reviewed', () => {
    expect(concreteReportLifecycleState('reviewed', 'issued')).toBe('issued');
    expect(concreteReportLifecycleState('reviewed', 'reviewed')).toBe('reviewed');
    expect(concreteReportLifecycleState('draft', 'issued')).toBe('draft');
    expect(concreteReportStoredState('issued')).toBe('reviewed');
    expect(concreteReportStoredState('returned')).toBe('returned');
  });

  it('return and revise need a comment', () => {
    const base = { idempotencyKey: LEAD, version: 1 };
    expect(concreteReportCommentRequiredSchema.safeParse(base).success).toBe(false);
    expect(concreteReportCommentRequiredSchema.safeParse({ ...base, comment: '  ' }).success).toBe(
      false,
    );
    expect(
      concreteReportCommentRequiredSchema.safeParse({ ...base, comment: 'Fix the slump time' })
        .success,
    ).toBe(true);
  });
});

describe('review routing (D11)', () => {
  const resubmit = {
    action: 'resubmit' as const,
    labManagerCorrection: false,
    originalReviewerUserId: REVIEWER,
    originalReviewerCanReview: true,
    leadProjectEngineerUserId: LEAD,
  };

  it('a first submission goes to every designated reviewer and the lead', () => {
    expect(concreteReportRoute({ ...resubmit, action: 'submit' })).toEqual({
      kind: 'designated_reviewers',
      routedToUserId: null,
      reason: null,
    });
  });

  it('a resubmission goes back to the reviewer who returned it', () => {
    expect(concreteReportRoute(resubmit)).toEqual({
      kind: 'original_reviewer',
      routedToUserId: REVIEWER,
      reason: 'resubmission',
    });
  });

  it("a Lab Manager's correction goes to the Lead Project Engineer (AC2)", () => {
    expect(concreteReportRoute({ ...resubmit, labManagerCorrection: true })).toEqual({
      kind: 'lead_project_engineer',
      routedToUserId: LEAD,
      reason: 'lab_manager_correction',
    });
    expect(
      concreteReportRoute({
        ...resubmit,
        labManagerCorrection: true,
        leadProjectEngineerUserId: null,
      }),
    ).toEqual({ error: 'no_lead_project_engineer' });
  });

  it('an original reviewer who can no longer review hands it to the lead (proposal)', () => {
    expect(concreteReportRoute({ ...resubmit, originalReviewerCanReview: false })).toEqual({
      kind: 'lead_project_engineer',
      routedToUserId: LEAD,
      reason: 'original_reviewer_unavailable',
    });
  });

  it('a routed version is reviewed only by its reviewer or the lead', () => {
    const routed = { kind: 'original_reviewer' as const, routedToUserId: REVIEWER };
    expect(concreteReportMayReviewRouted(routed, REVIEWER, LEAD)).toBe(true);
    expect(concreteReportMayReviewRouted(routed, LEAD, LEAD)).toBe(true);
    expect(concreteReportMayReviewRouted(routed, OTHER, LEAD)).toBe(false);
    const open = { kind: 'designated_reviewers' as const, routedToUserId: null };
    expect(concreteReportMayReviewRouted(open, OTHER, LEAD)).toBe(true);
  });
});
