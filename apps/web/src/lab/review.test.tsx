import type { ProgramWork, ReviewActions } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ReviewControls } from './ReviewControls';

// MM-T25 review controls on a worked program. Fictional data only.

const REQUEST = '00000000-0000-4000-8000-0000000000f1';

function work(
  reviewState: ProgramWork['requests'][number]['reviewState'],
  actions: Partial<ReviewActions>,
  extra: Partial<ProgramWork> = {},
): ProgramWork {
  return {
    programId: '00000000-0000-4000-8000-0000000000e1',
    canChangePriority: false,
    requests: [
      {
        testRequestId: REQUEST,
        status: 'review',
        version: 4,
        needsTestedUnits: false,
        reviewState,
        acceptedAt: null,
        acceptedBy: null,
        acceptedViaDelegation: false,
        reviewActions: {
          canReview: false,
          canCorrectionDone: false,
          canAccept: false,
          acceptBlockedReason: null,
          ...actions,
        },
        lifecycle: {
          cancelReason: null,
          cancelledAt: null,
          cancelledBy: null,
          repeatOfId: null,
          repeatIds: [],
          canCancel: false,
          canRequestCancel: false,
          canRepeat: false,
        },
      },
    ],
    statusHistory: [],
    testedUnits: [],
    priorityHistory: [],
    comments: [],
    reviewEvents: [],
    actionItems: [],
    lifecycle: {
      status: 'submitted',
      version: 2,
      closedAt: null,
      closedBy: null,
      events: [],
      closure: { eligible: false, emptyProgram: false, blockers: [], counts: {}, summary: '' },
      canClose: false,
      closeBlockedReason: 'not_pm_pe',
      canRequestClose: false,
      canReopen: false,
    },
    ...extra,
  };
}

describe('ReviewControls (MM-T25)', () => {
  it('shows the sub-state as text and why Accept is disabled', () => {
    render(
      <ReviewControls
        testRequestId={REQUEST}
        work={work('awaiting_review', {
          canReview: true,
          acceptBlockedReason: 'review_not_complete',
        })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Awaiting review')).toBeInTheDocument();
    const accept = screen.getByRole('button', { name: 'Accept' });
    expect(accept).toBeDisabled();
    expect(accept).toHaveAccessibleDescription('Review not complete');
    expect(screen.getByRole('button', { name: 'Mark review complete' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Return for correction' })).toBeEnabled();
  });

  it('explains a missing acceptance authority', () => {
    render(
      <ReviewControls
        testRequestId={REQUEST}
        work={work('review_complete', { acceptBlockedReason: 'no_authority' })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Review complete')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Accept' })).toHaveAccessibleDescription(
      'You don’t have acceptance authority for this project',
    );
  });

  it('shows the return comment for the Lab Manager and offers Mark correction done', () => {
    render(
      <ReviewControls
        testRequestId={REQUEST}
        work={work(
          'returned',
          { canCorrectionDone: true, acceptBlockedReason: 'no_authority' },
          {
            actionItems: [
              {
                id: '00000000-0000-4000-8000-0000000000d1',
                kind: 'correction',
                targetRole: 'lab_manager',
                testRequestId: REQUEST,
                comment: 'Sieve stack missing',
                status: 'open',
                resolution: null,
                createdAt: '2026-10-27T15:00:00.000Z',
                createdBy: { userId: 'x', initials: 'AT', name: 'Alex Tester' },
                resolvedAt: null,
              },
            ],
          },
        )}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Returned to Lab Manager')).toBeInTheDocument();
    expect(screen.getByText('Sieve stack missing')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Mark correction done' })).toBeEnabled();
  });

  it('tells a LAB station that review and acceptance need a personal sign-in', () => {
    render(
      <ReviewControls
        testRequestId={REQUEST}
        work={work('review_complete', { acceptBlockedReason: 'personal_sign_in' })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText(/need a personal sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});
