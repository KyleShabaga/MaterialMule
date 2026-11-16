import type { LabProgram, MeResponse, ProgramUnits, ProgramWork } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { WorkedProgram } from './WorkedProgram';

// STRATA-87 program page: the phase tag, test states as record words, review on this page and
// Units to pull. Fictional data only: DEMO-2601, TH26-01, LP-2026-0012.

const A = '00000000-0000-4000-8000-0000000000a1';
const B = '00000000-0000-4000-8000-0000000000b1';
const C = '00000000-0000-4000-8000-0000000000c1';
const PE = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };
const LM = { userId: 'u-lm', initials: 'LM', name: 'Lee Manager' };

const me: MeResponse = {
  id: 'u-lm',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['lab_program.read', 'test.progress', 'lab_comment.write'],
  sessionExpiresAt: '2026-11-30T16:00:00.000Z',
  profileRefreshFailed: false,
};

const request = (id: string, code: string, status: string) => ({
  id,
  testTypeId: `t-${code}`,
  code,
  name: code === 'DEMO-MC' ? 'Moisture content' : 'Atterberg limits',
  description: 'Fictional test',
  groupName: 'Soils',
  subgroupName: null,
  status,
  version: 3,
  repeatOfId: null,
  amendmentId: null,
  identityRevision: 0,
  identity: null,
});

const program = {
  id: 'p-12',
  programNumber: 'LP-2026-0012',
  status: 'submitted',
  priority: 'urgent',
  notes: null,
  project: { id: 'proj', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
  createdBy: { ...PE, accountType: 'personal' },
  requestedBy: PE,
  createdAt: '2026-11-10T21:15:00.000Z',
  updatedAt: '2026-11-11T15:04:00.000Z',
  version: 5,
  submittedAt: '2026-11-11T15:04:00.000Z',
  submittedBy: { ...PE, accountType: 'personal' },
  submittedFor: PE,
  lines: [
    {
      id: 'line-1',
      lineNumber: 1,
      source: { kind: 'test_hole', id: 'th', label: 'TH26-01' },
      scope: 'all',
      sampleLabel: null,
      depthMode: null,
      depthFrom: null,
      depthTo: null,
      depthUnit: null,
      acknowledgedDepths: [],
      tests: [],
      unitIds: [],
      requests: [
        request(A, 'DEMO-MC', 'review'),
        request(B, 'DEMO-AL', 'review'),
        request(C, 'DEMO-MC', 'cancelled'),
      ],
      coverage: [],
      coverageCapturedAt: '2026-11-11T15:04:00.000Z',
      amendmentId: null,
    },
  ],
} as unknown as LabProgram;

const life = {
  cancelReason: null,
  cancelledAt: null,
  cancelledBy: null,
  repeatOfId: null,
  repeatIds: [],
  canCancel: true,
  canRequestCancel: false,
  canRepeat: false,
  canChange: false,
};

const work = {
  programId: program.id,
  canChangePriority: true,
  requests: [A, B, C].map((id) => ({
    testRequestId: id,
    status: id === C ? 'cancelled' : 'review',
    version: 3,
    needsTestedUnits: false,
    reviewState: id === C ? null : 'awaiting_review',
    acceptedAt: null,
    acceptedBy: null,
    acceptedViaDelegation: false,
    reviewActions: {
      canReview: id !== C,
      canCorrectionDone: false,
      canAccept: false,
      acceptBlockedReason: id === C ? null : 'review_not_complete',
    },
    lifecycle:
      id === C
        ? {
            ...life,
            canCancel: false,
            cancelReason: 'Line 1 already covers moisture for this unit.',
            cancelledAt: '2026-11-12T15:00:00.000Z',
            cancelledBy: LM,
          }
        : life,
  })),
  statusHistory: [],
  testedUnits: [],
  priorityHistory: [
    {
      id: 'pr-1',
      fromPriority: 'normal',
      toPriority: 'urgent',
      person: PE,
      changedAt: '2026-11-11T15:05:00.000Z',
    },
  ],
  comments: [],
  reviewEvents: [],
  actionItems: [],
  lifecycle: {
    status: 'submitted',
    version: 5,
    closedAt: null,
    closedBy: null,
    events: [],
    closure: {
      eligible: false,
      emptyProgram: false,
      blockers: [],
      counts: { review: 2 },
      summary: '2 tests still in Review',
    },
    canClose: false,
    closeBlockedReason: 'unresolved',
    closeAs: 'lab_manager',
    canRequestClose: true,
    canReopen: false,
    canAmend: false,
    amendments: [],
    identityRevisions: [],
  },
} as unknown as ProgramWork;

const units: ProgramUnits = {
  units: [
    {
      storageUnitId: 'su-19',
      readableId: 'BKT-2026-000019',
      contents: null,
      lineNumbers: [1],
      location: { code: 'LAB-1', name: 'Soils lab', area: null },
      atLab: true,
      toPull: false,
    },
  ],
  toPull: 0,
  atLab: 1,
};

function stubApi() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const path = new URL(String(input), 'http://localhost').pathname;
      const body = path.endsWith('/work') ? work : path.endsWith('/units') ? units : {};
      return new Response(JSON.stringify(body), {
        status: path.endsWith('/work') || path.endsWith('/units') ? 200 : 404,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

function renderPage() {
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <MemoryRouter>
        <WorkedProgram program={program} reload={vi.fn()} />
      </MemoryRouter>
    </SessionContext.Provider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('Program page (STRATA-87)', () => {
  it('shows the phase, the tests as record words and a cancelled test with its reason', async () => {
    stubApi();
    renderPage();
    expect(await screen.findByText('Due · Review')).toBeInTheDocument();
    expect(screen.getByText('Urgent · Priority')).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'LP-2026-0012' })).toBeInTheDocument();
    const rows = document.querySelectorAll('.request-list li');
    expect(rows).toHaveLength(3);
    expect(within(rows[0] as HTMLElement).getByText('In review')).toBeInTheDocument();
    const cancelled = rows[2] as HTMLElement;
    expect(within(cancelled).getByText('Cancelled')).toBeInTheDocument();
    expect(
      within(cancelled)
        .getByText(/DEMO-MC · Moisture content/)
        .closest('[data-slot="item-title"]'),
    ).toHaveClass('line-through');
    expect(cancelled).toHaveTextContent('“Line 1 already covers moisture for this unit.”');
    // No results fields, ever.
    expect(screen.queryByLabelText(/result/i)).not.toBeInTheDocument();
  });

  it('Review: the Lab Manager reviews on this page, with what is decided so far', async () => {
    stubApi();
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Review' }));
    expect(
      screen.getByText('Reviewing as Lab Manager. Accept each test or cancel it with a reason.'),
    ).toBeInTheDocument();
    expect(screen.getByText(/1 of 3 decided/)).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Mark review complete' })).toHaveLength(2);
    // Cancelling asks for a reason in a dialog.
    await user.click(screen.getAllByRole('button', { name: 'Cancel test' })[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Cancel test' });
    expect(within(dialog).getByRole('button', { name: 'Cancel test' })).toBeDisabled();
    expect(within(dialog).getByText(/The requester sees the reason/)).toBeInTheDocument();
  });

  it('Units to pull says when nothing is left to pull; history lists the priority change', async () => {
    stubApi();
    renderPage();
    expect(
      await screen.findByText('Nothing to pull: every covered unit is at the lab.'),
    ).toBeInTheDocument();
    expect(screen.getByText('0 to pull · 1 at the lab')).toBeInTheDocument();
    expect(screen.getByText('At the lab')).toBeInTheDocument();
    const history = screen.getByRole('list', { name: 'Program history' });
    expect(history).toHaveTextContent('marked it urgent priority (was normal)');
    expect(history).toHaveTextContent('submitted it to the lab');
  });

  it('a Lab Manager has Close program in More only (not the main action)', async () => {
    stubApi();
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Due · Review');
    expect(screen.queryByRole('button', { name: 'Close program' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'More' }));
    expect(await screen.findByRole('menuitem', { name: 'Mark normal' })).toBeInTheDocument();
  });
});
