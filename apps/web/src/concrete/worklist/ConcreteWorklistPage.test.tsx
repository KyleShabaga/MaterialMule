import type {
  ConcreteRescheduleResult,
  ConcreteWorklist,
  ConcreteWorklistRow,
  MeResponse,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// Concrete → Breaks (MM-V2-C22). Fictional projects and people only.

/** A specimen ID drawn as set ID + lettered square (SpecimenId): matched on its whole text. */
const specimen = (id: string) => (_: string, element: Element | null) =>
  element?.classList.contains('specimen-id') === true && element.textContent === id;

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};

const PROJECT = '00000000-0000-4000-8000-000000000201';

const row = (overrides: Partial<ConcreteWorklistRow> = {}): ConcreteWorklistRow => ({
  specimenId: '00000000-0000-4000-8000-000000000601',
  setId: '00000000-0000-4000-8000-000000000501',
  fieldReportId: '00000000-0000-4000-8000-000000000401',
  projectId: PROJECT,
  letter: 'B',
  identity: { temporaryId: null, permanentId: '26-01B' },
  assignedAge: 28,
  castingDate: '2026-11-07',
  targetDate: '2026-12-05',
  holdExpiresOn: null,
  daysOverdue: null,
  holdKind: null,
  reportState: 'submitted',
  flags: ['weekend_target'],
  rescheduleCount: 0,
  reschedulable: true,
  version: 1,
  ...overrides,
});

const list = (
  view: ConcreteWorklist['view'],
  rows: ConcreteWorklistRow[],
  canReschedule = true,
): ConcreteWorklist => ({
  view,
  today: '2026-12-05',
  upcomingThrough: '2026-12-12',
  counts: { today: 1, overdue: 0, upcoming: 3, hold: 1, exceptions: 0 },
  holdReviewDue: 0,
  holdDue: false,
  total: rows.length,
  page: 1,
  pageSize: 200,
  groups:
    rows.length === 0
      ? []
      : [
          {
            projectId: PROJECT,
            projectNumber: 'DEMO-2601',
            projectName: 'Example tower',
            count: rows.length,
            canReschedule,
            rows,
          },
        ],
  exceptions: [],
  testingMachineRegistered: false,
  projects: [{ id: PROJECT, projectNumber: 'DEMO-2601', name: 'Example tower' }],
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(
  answer: (view: string) => ConcreteWorklist,
  onPost?: (url: string, body: Record<string, unknown>) => Response,
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.startsWith('/api/concrete/lab-worklist')) {
      const view = new URL(url, 'http://x').searchParams.get('view') ?? 'today';
      return json(200, answer(view));
    }
    if (method === 'GET' && url.includes('/schedule-history')) {
      return json(200, {
        specimenId: row().specimenId,
        identity: row().identity,
        assignedAge: 28,
        castingDate: '2026-11-07',
        targetDate: '2026-12-05',
        holdExpiresOn: null,
        version: 1,
        history: [],
      });
    }
    if (method === 'POST' && onPost) return onPost(url, JSON.parse(String(init?.body)));
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/lab-testing/concrete'] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: ME },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

beforeEach(() => {
  // jsdom has no <dialog> methods.
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Concrete → Breaks (MM-V2-C22)', () => {
  it('opens on Today, grouped by project with counts, and flags a weekend target', async () => {
    renderPage((view) => list(view as ConcreteWorklist['view'], view === 'today' ? [row()] : []));
    expect(await screen.findByRole('heading', { name: 'Concrete breaks', level: 1 })).toBeVisible();
    const tabs = await screen.findByRole('tablist', { name: 'Concrete worklist views' });
    expect(within(tabs).getByRole('tab', { name: /Today/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Next 7 days 3' })).toBeInTheDocument();
    const group = await screen.findByRole('region', { name: /DEMO-2601 · Example tower/ });
    expect(within(group).getByText('1 specimen')).toBeInTheDocument();
    const table = within(group).getByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).getByText(specimen('26-01B'))).toBeInTheDocument();
    expect(within(table).getByText('2026-12-05')).toBeInTheDocument();
    expect(within(table).getByText('Weekend target')).toBeInTheDocument();
    expect(screen.getByText(/the holiday list\s+comes later/)).toBeInTheDocument();
  });

  it('moves between views with the arrow keys and shows HOLD with its hold-until date', async () => {
    const user = userEvent.setup();
    renderPage((view) =>
      view === 'hold'
        ? list('hold', [
            row({
              letter: 'D',
              identity: { temporaryId: null, permanentId: '26-01D' },
              assignedAge: 'HOLD',
              targetDate: null,
              holdExpiresOn: '2027-01-02',
              holdKind: 'ordinary',
              flags: ['hold_review_due'],
              reschedulable: false,
            }),
          ])
        : list(view as ConcreteWorklist['view'], []),
    );
    const today = await screen.findByRole('tab', { name: /Today/ });
    today.focus();
    await user.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Exceptions/ })).toHaveFocus();
    await user.keyboard('{ArrowLeft}');
    const hold = screen.getByRole('tab', { name: /HOLD/ });
    expect(hold).toHaveFocus();
    expect(hold).toHaveAttribute('aria-selected', 'true');
    const table = await screen.findByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).getByRole('columnheader', { name: 'Hold until' })).toBeInTheDocument();
    expect(within(table).getByText('2027-01-02')).toBeInTheDocument();
    expect(within(table).getByText('Ordinary HOLD')).toBeInTheDocument();
    expect(within(table).getByText('HOLD review due')).toBeInTheDocument();
    // HOLD actions are C26's: no reschedule button.
    expect(within(table).queryByRole('button', { name: /Reschedule/ })).toBeNull();
  });

  it('hides Reschedule without the authority', async () => {
    renderPage((view) => list(view as ConcreteWorklist['view'], [row()], false));
    const table = await screen.findByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).queryByRole('button', { name: /Reschedule/ })).toBeNull();
  });

  it('disables Reschedule for an unnumbered set past draft: number it first (C38)', async () => {
    renderPage((view) =>
      list(view as ConcreteWorklist['view'], [
        row({
          identity: { temporaryId: 'T-0007', permanentId: null },
          reportState: 'submitted',
          reschedulable: false,
        }),
        row({
          specimenId: '00000000-0000-4000-8000-000000000602',
          letter: 'C',
          identity: { temporaryId: 'T-0008', permanentId: null },
          reportState: 'draft',
          flags: ['report_draft'],
          reschedulable: false,
        }),
      ]),
    );
    const table = await screen.findByRole('table', { name: 'DEMO-2601 specimens' });
    const blocked = within(table).getByRole('button', { name: /Reschedule/ });
    expect(blocked).toBeDisabled();
    expect(blocked).toHaveAccessibleDescription('Number this set first');
    // On a draft the technician edits the ages on the draft itself: no action here, as before.
    expect(within(table).getAllByRole('button', { name: /Reschedule/ })).toHaveLength(1);
  });

  it('reschedules with a reason, previewing the target from the casting date', async () => {
    const user = userEvent.setup();
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    renderPage(
      (view) => list(view as ConcreteWorklist['view'], view === 'today' ? [row()] : []),
      (url, body) => {
        posts.push({ url, body });
        const result: ConcreteRescheduleResult = {
          specimenId: row().specimenId,
          identity: row().identity,
          assignedAge: 56,
          castingDate: '2026-11-07',
          targetDate: '2027-01-02',
          holdExpiresOn: null,
          version: 2,
          history: [],
          flags: ['weekend_target', 'rescheduled'],
        };
        return json(201, result);
      },
    );
    await user.click(await screen.findByRole('button', { name: 'Reschedule 26-01B' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reschedule 26-01B' });
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the new test age');
    await user.type(within(dialog).getByLabelText('New test age (days)'), '56');
    expect(within(dialog).getByText(/New target 2027-01-02 \(weekend target/)).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A reason is required');
    expect(posts).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason'), 'Engineer asked for 56 days');
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule' }));
    expect(
      await screen.findByText('Rescheduled 26-01B to 56 days (target 2027-01-02).'),
    ).toBeInTheDocument();
    expect(posts).toEqual([
      {
        url: `/api/concrete/specimens/${row().specimenId}/reschedule`,
        body: {
          idempotencyKey: expect.any(String),
          version: 1,
          newAge: 56,
          reason: 'Engineer asked for 56 days',
        },
      },
    ]);
  });
});
