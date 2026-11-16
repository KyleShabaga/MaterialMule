import type {
  LabProgram,
  LabProgramPhase,
  ProgramLifecycle as Lifecycle,
  ProgramWork,
} from '@materialmule/shared';
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgramLifecycle, RequestLifecycle } from './LifecycleControls';
import { ProgramHeader } from './ProgramHeader';

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

/** The header reads the project, people and dates too. */
const full = {
  ...program,
  programNumber: 'LP-2026-0007',
  status: 'submitted',
  priority: 'normal',
  version: 3,
  project: { id: 'proj', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  requestedBy: { userId: 'u-at', initials: 'AT', name: 'Alex Tester' },
  submittedFor: null,
  submittedAt: '2026-11-04T23:12:00.000Z',
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
    canChange: false,
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
      closeAs: null,
      canRequestClose: true,
      canReopen: false,
      canAmend: false,
      amendments: [],
      identityRevisions: [],
      ...lifecycle,
    },
  };
}

const UNRESOLVED = {
  canClose: false,
  closeBlockedReason: 'unresolved' as const,
  closure: {
    eligible: false,
    emptyProgram: false,
    blockers: [
      {
        testRequestId: A,
        status: 'review' as const,
        reviewState: 'returned' as const,
        reason: 'review' as const,
      },
    ],
    counts: { review: 1 },
    summary: '1 test still in Review',
  },
};

function header(w: ProgramWork, phase: LabProgramPhase) {
  render(
    <MemoryRouter>
      <ProgramHeader
        program={full}
        work={w}
        phase={phase}
        progress={{ done: 1, inProgress: 0, notStarted: 1, cancelled: 0 }}
        reviewing={false}
        onReview={null}
        onDone={vi.fn()}
      />
    </MemoryRouter>,
  );
}

describe('ProgramLifecycle and the header (MM-T26, STRATA-87)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('lists what blocks closing; the requester sees Close program disabled with why', () => {
    render(
      <MemoryRouter>
        <ProgramLifecycle program={program} work={work({ ...UNRESOLVED, closeAs: 'requester' })} />
      </MemoryRouter>,
    );
    expect(screen.getByText('Closure checklist: 1 test still in Review')).toBeInTheDocument();
    expect(screen.getByText(/In review — Returned to Lab Manager/)).toBeInTheDocument();
    cleanup();
    header(work({ ...UNRESOLVED, closeAs: 'requester' }), 'testing');
    expect(screen.getByRole('link', { name: 'Print tags' })).toHaveAttribute(
      'href',
      `/lab-testing/programs/${program.id}/tags`,
    );
    const close = screen.getByRole('button', { name: 'Close program' });
    expect(close).toBeDisabled();
    expect(close).toHaveAccessibleDescription('1 test still in Review');
    expect(screen.getByText('In lab · Testing')).toBeInTheDocument();
    expect(screen.getByText('1 of 2 tests done')).toBeInTheDocument();
  });

  it('refuses an empty program with an explicit blocker', () => {
    render(
      <MemoryRouter>
        <ProgramLifecycle
          program={program}
          work={work({
            canClose: false,
            closeBlockedReason: 'empty_program',
            closeAs: 'lead',
            closure: {
              eligible: false,
              emptyProgram: true,
              blockers: [],
              counts: {},
              summary:
                'This program has no test requests. At least one test is needed before it can close.',
            },
          })}
        />
      </MemoryRouter>,
    );
    expect(screen.getByText(/At least one test request is needed/)).toBeInTheDocument();
  });

  it('Ready: Close program is the requester’s main action and closes the program', async () => {
    const calls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        calls.push(`${init?.method ?? 'GET'} ${String(input)}`);
        return new Response(
          JSON.stringify({ programId: program.id, status: 'closed', version: 4 }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }),
    );
    header(work({ closeAs: 'requester' }), 'ready');
    expect(screen.getByText('Due · Ready to close')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Close program' }));
    expect(calls).toEqual([`POST /api/lab-programs/${program.id}/close`]);
  });

  it('Ready: a Lab Manager closes it from More, not as the main action', async () => {
    header(work({ closeAs: 'lab_manager' }), 'ready');
    expect(screen.queryByRole('button', { name: 'Close program' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Close program' })).toBeInTheDocument();
  });

  it('Closed: who closed it, and Reopen asks for a reason in a dialog', async () => {
    const closed = work({
      status: 'closed',
      canClose: false,
      closeBlockedReason: 'not_open',
      canRequestClose: false,
      canReopen: true,
      closedAt: '2026-10-27T15:00:00.000Z',
      closedBy: { userId: 'p', initials: 'PE', name: 'Pat Example' },
    });
    render(
      <MemoryRouter>
        <ProgramLifecycle program={program} work={closed} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/Closed by PE · Pat Example/)).toBeInTheDocument();
    cleanup();
    header(closed, 'closed');
    expect(screen.getByText('Closed · Lab program')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Close program' })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Reopen program' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reopen program' });
    const submit = within(dialog).getByRole('button', { name: 'Reopen program' });
    expect(submit).toBeDisabled();
    await userEvent.type(within(dialog).getByLabelText(/Reason for reopening/), 'One more test');
    expect(submit).toBeEnabled();
  });

  it('tells a LAB station lifecycle actions need a personal sign-in', () => {
    const lab = work({
      canClose: false,
      closeBlockedReason: 'personal_sign_in',
      canRequestClose: false,
    });
    render(
      <MemoryRouter>
        <ProgramLifecycle program={program} work={lab} />
      </MemoryRouter>,
    );
    expect(screen.getByText(/need a personal sign-in/)).toBeInTheDocument();
    cleanup();
    header(lab, 'testing');
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
