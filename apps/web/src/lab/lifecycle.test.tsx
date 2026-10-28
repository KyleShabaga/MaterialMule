import type { LabProgram, ProgramLifecycle as Lifecycle, ProgramWork } from '@materialmule/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProgramLifecycle, RequestLifecycle } from './LifecycleControls';

// MM-T26 lifecycle controls on a worked program. Fictional data only.

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';

const program = {
  id: '00000000-0000-4000-8000-0000000000e1',
  lines: [
    {
      id: 'line',
      lineNumber: 1,
      requests: [
        { id: A, code: 'DEMO-MC', name: 'Moisture', description: 'Moisture content' },
        { id: B, code: 'DEMO-MC', name: 'Moisture', description: 'Moisture content' },
      ],
    },
  ],
} as unknown as LabProgram;

function work(
  lifecycle: Partial<Lifecycle>,
  requestLife: Record<string, unknown> = {},
): ProgramWork {
  const life = {
    cancelReason: null,
    cancelledAt: null,
    cancelledBy: null,
    repeatOfId: null,
    repeatIds: [],
    canCancel: false,
    canRequestCancel: false,
    canRepeat: false,
  };
  return {
    programId: program.id,
    canChangePriority: false,
    requests: [A, B].map((id) => ({
      testRequestId: id,
      status: 'accepted' as const,
      version: 6,
      needsTestedUnits: false,
      reviewState: null,
      acceptedAt: null,
      acceptedBy: null,
      acceptedViaDelegation: false,
      reviewActions: {
        canReview: false,
        canCorrectionDone: false,
        canAccept: false,
        acceptBlockedReason: null,
      },
      lifecycle: { ...life, ...(id === A ? requestLife : {}) },
    })),
    statusHistory: [],
    testedUnits: [],
    priorityHistory: [],
    comments: [],
    reviewEvents: [],
    actionItems: [],
    lifecycle: {
      status: 'submitted',
      version: 3,
      closedAt: null,
      closedBy: null,
      events: [],
      closure: { eligible: true, emptyProgram: false, blockers: [], counts: {}, summary: '' },
      canClose: true,
      closeBlockedReason: null,
      canRequestClose: true,
      canReopen: false,
      ...lifecycle,
    },
  };
}

describe('ProgramLifecycle (MM-T26)', () => {
  it('shows Open and disables Close with the unresolved tests listed', () => {
    render(
      <ProgramLifecycle
        program={program}
        work={work({
          canClose: false,
          closeBlockedReason: 'unresolved',
          closure: {
            eligible: false,
            emptyProgram: false,
            blockers: [
              { testRequestId: A, status: 'review', reviewState: 'returned', reason: 'review' },
            ],
            counts: { review: 1 },
            summary: '1 test still in Review',
          },
        })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Open')).toBeInTheDocument();
    const close = screen.getByRole('button', { name: 'Close program' });
    expect(close).toBeDisabled();
    expect(close).toHaveAccessibleDescription('1 test still in Review');
    expect(screen.getByText(/In review — Returned to Lab Manager/)).toBeInTheDocument();
    // Asking is separate from deciding.
    expect(screen.getByRole('button', { name: 'Request closure' })).toBeEnabled();
  });

  it('refuses an empty program with an explicit blocker', () => {
    render(
      <ProgramLifecycle
        program={program}
        work={work({
          canClose: false,
          closeBlockedReason: 'empty_program',
          closure: {
            eligible: false,
            emptyProgram: true,
            blockers: [],
            counts: {},
            summary:
              'This program has no test requests. At least one test is needed before it can close.',
          },
        })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByRole('button', { name: 'Close program' })).toBeDisabled();
    expect(screen.getByText(/At least one test request is needed/)).toBeInTheDocument();
  });

  it('shows Closed read-only with Reopen and the history', () => {
    render(
      <ProgramLifecycle
        program={program}
        work={work({
          status: 'closed',
          canClose: false,
          closeBlockedReason: 'not_open',
          canRequestClose: false,
          canReopen: true,
          closedAt: '2026-10-27T15:00:00.000Z',
          closedBy: { userId: 'p', initials: 'PE', name: 'Pat Example' },
          events: [
            {
              id: 'e1',
              kind: 'closed',
              reason: null,
              person: { userId: 'p', initials: 'PE', name: 'Pat Example' },
              occurredAt: '2026-10-27T15:00:00.000Z',
            },
          ],
        })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText('Closed')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close program' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Reopen program' })).toBeEnabled();
    expect(screen.getByText(/Program history \(1\)/)).toBeInTheDocument();
  });

  it('tells a LAB station lifecycle actions need a personal sign-in', () => {
    render(
      <ProgramLifecycle
        program={program}
        work={work({
          canClose: false,
          closeBlockedReason: 'personal_sign_in',
          canRequestClose: false,
        })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByText(/need a personal sign-in/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close program' })).not.toBeInTheDocument();
  });
});

describe('RequestLifecycle (MM-T26)', () => {
  it('links a repeat both ways and shows a cancellation with its reason', () => {
    const request = program.lines[0]!.requests[0]!;
    render(
      <RequestLifecycle
        request={request}
        program={program}
        work={work({}, { repeatIds: [B], canRepeat: true, canCancel: true })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.getByRole('link', { name: 'repeat 1' })).toHaveAttribute('href', `#request-${B}`);
    expect(screen.getByRole('button', { name: 'Repeat test' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Cancel test' })).toBeEnabled();
  });

  it('offers only a cancellation request to someone who can’t cancel', () => {
    const request = program.lines[0]!.requests[0]!;
    render(
      <RequestLifecycle
        request={request}
        program={program}
        work={work({}, { canRequestCancel: true, repeatOfId: B })}
        onDone={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: 'Cancel test' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Request cancellation' })).toBeEnabled();
    expect(screen.getByText(/Repeat of/)).toBeInTheDocument();
  });
});
