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
  extra: Partial<ConcreteWorklist> & { canHoldUntil?: boolean } = {},
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
            canHoldUntil: extra.canHoldUntil ?? canReschedule,
            rows,
          },
        ],
  exceptions: [],
  testingMachineRegistered: true,
  projects: [{ id: PROJECT, projectNumber: 'DEMO-2601', name: 'Example tower' }],
  ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'canHoldUntil')),
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
  path = '/lab-testing/concrete',
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
  const router = createMemoryRouter(routes, { initialEntries: [path] });
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
  return { fetchMock, router };
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

/** Three specimens of set 26-01 due today (B, C, D) and one of 26-02 (A). */
const SPEC = (n: number) => `00000000-0000-4000-8000-00000000060${n}`;
const fourDue = () => [
  row({ specimenId: SPEC(1), letter: 'B', identity: { temporaryId: null, permanentId: '26-01B' } }),
  row({ specimenId: SPEC(2), letter: 'C', identity: { temporaryId: null, permanentId: '26-01C' } }),
  row({ specimenId: SPEC(3), letter: 'D', identity: { temporaryId: null, permanentId: '26-01D' } }),
  row({
    specimenId: SPEC(4),
    setId: '00000000-0000-4000-8000-000000000502',
    letter: 'A',
    identity: { temporaryId: null, permanentId: '26-02A' },
    assignedAge: 7,
    castingDate: '2026-11-28',
  }),
];

const selectionBar = () => screen.getByRole('region', { name: 'Selection' });

describe('Concrete → Breaks (MM-V2-C22, STRATA-95 variant A)', () => {
  it('opens on Today, one row per set with its specimens, and flags a weekend target', async () => {
    renderPage((view) => list(view as ConcreteWorklist['view'], view === 'today' ? [row()] : []));
    expect(await screen.findByRole('heading', { name: 'Concrete breaks', level: 1 })).toBeVisible();
    const tabs = await screen.findByRole('tablist', { name: 'Concrete worklist views' });
    expect(within(tabs).getByRole('tab', { name: /Today/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(within(tabs).getByRole('tab', { name: 'Next 7 days 3' })).toBeInTheDocument();
    expect(
      within(tabs)
        .getAllByRole('tab')
        .map((tab) => tab.textContent?.replace(/\s*\d+$/, '')),
    ).toEqual(['Overdue', 'Today', 'Next 7 days', 'On HOLD', 'Exceptions']);
    const group = await screen.findByRole('region', { name: /DEMO-2601 · Example tower/ });
    expect(within(group).getByText('1 specimen')).toBeInTheDocument();
    const table = within(group).getByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).getByText(specimen('26-01B'))).toBeInTheDocument();
    expect(within(table).getByText('2026-12-05')).toBeInTheDocument();
    expect(within(table).getByText('28-day', { selector: 'td' })).toBeInTheDocument();
    expect(within(table).getByText('Weekend target')).toBeInTheDocument();
    expect(
      screen.getByText(/Weekend and holiday test dates are\s+flagged, never moved/),
    ).toBeInTheDocument();
    // Nothing ticked: no selection bar.
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('says so when nothing is due today and offers the next seven days', async () => {
    const user = userEvent.setup();
    renderPage((view) =>
      list(view as ConcreteWorklist['view'], view === 'upcoming' ? [row()] : []),
    );
    expect(await screen.findByText('No concrete specimens are due today.')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Show next 7 days' }));
    await vi.waitFor(() =>
      expect(screen.getByRole('tab', { name: /Next 7 days/ })).toHaveAttribute(
        'aria-selected',
        'true',
      ),
    );
    expect(await screen.findByRole('table', { name: 'DEMO-2601 specimens' })).toBeVisible();
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
    const hold = screen.getByRole('tab', { name: /On HOLD/ });
    expect(hold).toHaveFocus();
    // Manual activation: Enter opens the focused view (arrows alone load nothing).
    await user.keyboard('{Enter}');
    // The view is kept in the URL, which the router updates a moment later.
    await vi.waitFor(() => expect(hold).toHaveAttribute('aria-selected', 'true'));
    const table = await screen.findByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).getByRole('columnheader', { name: 'Hold until' })).toBeInTheDocument();
    expect(within(table).getByText('2027-01-02')).toBeInTheDocument();
    // The Kind cell, and its copy folded under the set for narrow tables (CSS shows one).
    expect(within(table).getAllByText('Ordinary HOLD')).toHaveLength(2);
    expect(within(table).getByText('HOLD review due')).toBeInTheDocument();
    // HOLD specimens aren't broken, rescheduled or ticked here: Holds owns them.
    expect(within(table).queryByRole('checkbox')).toBeNull();
    expect(within(table).getByRole('link', { name: 'Open 26-01 in Holds' })).toHaveAttribute(
      'href',
      '/lab-testing/concrete/holds',
    );
  });

  it('the set checkbox reads all, some or none of its specimens and ticks them all', async () => {
    const user = userEvent.setup();
    renderPage((view) => list(view as ConcreteWorklist['view'], view === 'today' ? fourDue() : []));
    const setBox = await screen.findByRole('checkbox', { name: 'Select set 26-01 (28-day)' });
    expect(setBox).toHaveAttribute('aria-checked', 'false');
    await user.click(screen.getByRole('checkbox', { name: 'Select 26-01C' }));
    expect(setBox).toHaveAttribute('aria-checked', 'mixed');
    expect(within(selectionBar()).getByRole('status')).toHaveTextContent('1 specimen · 1 set');
    await user.click(setBox);
    expect(setBox).toHaveAttribute('aria-checked', 'true');
    for (const id of ['26-01B', '26-01C', '26-01D']) {
      expect(screen.getByRole('checkbox', { name: `Select ${id}` })).toBeChecked();
    }
    expect(screen.getByRole('checkbox', { name: 'Select 26-02A' })).not.toBeChecked();
    expect(within(selectionBar()).getByRole('status')).toHaveTextContent('3 specimens · 1 set');
    await user.click(setBox);
    expect(setBox).toHaveAttribute('aria-checked', 'false');
    expect(screen.queryByRole('region', { name: 'Selection' })).toBeNull();
  });

  it('Record breaks opens the Testing table with only the ticked specimens', async () => {
    const user = userEvent.setup();
    const { router } = renderPage((view) =>
      list(view as ConcreteWorklist['view'], view === 'today' ? fourDue() : []),
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select 26-01B' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select 26-02A' }));
    expect(within(selectionBar()).getByRole('status')).toHaveTextContent('2 specimens · 2 sets');
    expect(
      within(selectionBar()).getByText(
        'Record breaks opens the testing table with just these 2 specimens.',
      ),
    ).toBeVisible();
    await user.click(within(selectionBar()).getByRole('button', { name: 'Record breaks' }));
    await vi.waitFor(() => expect(router.state.location.pathname).toBe('/concrete/testing'));
    expect(new URLSearchParams(router.state.location.search).get('specimenIds')).toBe(
      `${SPEC(1)},${SPEC(4)}`,
    );
  });

  it('no testing machine: a banner with the Equipment link; Record breaks disabled with the reason', async () => {
    const user = userEvent.setup();
    renderPage((view) =>
      list(view as ConcreteWorklist['view'], view === 'today' ? fourDue() : [], true, {
        testingMachineRegistered: false,
      }),
    );
    expect(
      await screen.findByText('No testing machine is registered (Settings → Equipment).'),
    ).toBeVisible();
    expect(screen.getByRole('link', { name: 'Open Settings → Equipment' })).toHaveAttribute(
      'href',
      '/settings/equipment',
    );
    // The listing stays usable.
    await user.click(screen.getByRole('checkbox', { name: 'Select 26-01B' }));
    const record = within(selectionBar()).getByRole('button', { name: 'Record breaks' });
    expect(record).toBeDisabled();
    expect(record).toHaveAccessibleDescription('Record breaks needs a registered testing machine.');
    expect(within(selectionBar()).getByRole('button', { name: 'Reschedule' })).toBeEnabled();
  });

  it('without the authority, Reschedule and Hold until are disabled with the reason', async () => {
    const user = userEvent.setup();
    renderPage((view) => list(view as ConcreteWorklist['view'], [row()], false));
    await user.click(await screen.findByRole('checkbox', { name: 'Select 26-01B' }));
    const reschedule = within(selectionBar()).getByRole('button', { name: 'Reschedule' });
    expect(reschedule).toBeDisabled();
    expect(reschedule).toHaveAccessibleDescription(/Reschedule needs the project lead/);
    const hold = within(selectionBar()).getByRole('button', { name: 'Hold until' });
    expect(hold).toBeDisabled();
    expect(hold).toHaveAccessibleDescription('Hold until needs the project lead or a Lab Manager.');
  });

  it('Reschedule names the specimens it leaves out: draft and unnumbered sets (C38)', async () => {
    const user = userEvent.setup();
    renderPage((view) =>
      list(view as ConcreteWorklist['view'], [
        row({ specimenId: SPEC(1) }),
        row({
          specimenId: SPEC(2),
          setId: '00000000-0000-4000-8000-000000000502',
          letter: 'A',
          identity: { temporaryId: 'T-0007A', permanentId: null },
          reportState: 'submitted',
          reschedulable: false,
        }),
        row({
          specimenId: SPEC(3),
          setId: '00000000-0000-4000-8000-000000000503',
          letter: 'A',
          identity: { temporaryId: 'T-0008A', permanentId: null },
          reportState: 'draft',
          flags: ['report_draft'],
          reschedulable: false,
        }),
      ]),
    );
    for (const name of ['Select 26-01B', 'Select T-0007A', 'Select T-0008A']) {
      await user.click(await screen.findByRole('checkbox', { name }));
    }
    await user.click(within(selectionBar()).getByRole('button', { name: 'Reschedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reschedule 1 specimen' });
    const left = within(dialog).getByRole('list', { name: 'Not included' });
    expect(left).toHaveTextContent(
      'T-0007A isn’t included: its set isn’t numbered yet; number the set first.',
    );
    expect(left).toHaveTextContent(
      'T-0008A isn’t included: its field report is still a draft, so its technician changes the age there.',
    );
  });

  it('reschedules each eligible specimen with its own key, before → after, and a reason', async () => {
    const user = userEvent.setup();
    const posts: { url: string; body: Record<string, unknown> }[] = [];
    const second = row({
      specimenId: SPEC(2),
      letter: 'C',
      identity: { temporaryId: null, permanentId: '26-01C' },
    });
    renderPage(
      (view) =>
        list(
          view as ConcreteWorklist['view'],
          view === 'today' ? [row({ specimenId: SPEC(1) }), second] : [],
        ),
      (url, body) => {
        posts.push({ url, body });
        if (url.includes(SPEC(2))) return json(409, { code: 'tested_specimen' });
        const result: ConcreteRescheduleResult = {
          specimenId: SPEC(1),
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
    await user.click(await screen.findByRole('checkbox', { name: 'Select set 26-01 (28-day)' }));
    await user.click(within(selectionBar()).getByRole('button', { name: 'Reschedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Reschedule 2 specimens' });
    const submit = within(dialog).getByRole('button', { name: 'Reschedule 2 specimens' });
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Enter the new test age');
    await user.type(within(dialog).getByLabelText('New test age (days)'), '56');
    const planned = within(dialog).getByRole('list', { name: 'Specimens to reschedule' });
    expect(planned).toHaveTextContent(/26-01B\s*28-day 2026-12-05 → 56-day 2027-01-02/);
    expect(planned).toHaveTextContent('(weekend: kept and flagged)');
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A reason is required');
    expect(posts).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason'), 'Engineer asked for 56 days');
    await user.click(submit);
    // Each specimen is reported on its own; the refused one stays for a retry.
    expect(
      await within(dialog).findByText('Rescheduled to 56 days (test date 2027-01-02).'),
    ).toBeVisible();
    expect(
      within(dialog).getByText(
        'This specimen already has a complete test entry, so its age stays.',
      ),
    ).toBeVisible();
    expect(posts.map((p) => p.url)).toEqual([
      `/api/concrete/specimens/${SPEC(1)}/reschedule`,
      `/api/concrete/specimens/${SPEC(2)}/reschedule`,
    ]);
    expect(posts[0]!.body).toEqual({
      idempotencyKey: expect.any(String),
      version: 1,
      newAge: 56,
      reason: 'Engineer asked for 56 days',
    });
    expect(posts[0]!.body.idempotencyKey).not.toBe(posts[1]!.body.idempotencyKey);
    // A retry resends only the failed one, with the same key.
    const firstKey = posts[1]!.body.idempotencyKey;
    await user.click(within(dialog).getByRole('button', { name: 'Reschedule 2 specimens' }));
    await vi.waitFor(() => expect(posts).toHaveLength(3));
    expect(posts[2]!.url).toBe(`/api/concrete/specimens/${SPEC(2)}/reschedule`);
    expect(posts[2]!.body.idempotencyKey).toBe(firstKey);
  });

  it('Hold until needs a later date and a reason, and names specimens the server refuses', async () => {
    const user = userEvent.setup();
    const posts: Record<string, unknown>[] = [];
    renderPage(
      (view) => list(view as ConcreteWorklist['view'], view === 'today' ? fourDue() : []),
      (url, body) => {
        posts.push({ url, ...body });
        return json(409, {
          code: 'not_eligible',
          problems: [{ specimenId: SPEC(2), code: 'already_on_hold' }],
        });
      },
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select 26-01B' }));
    await user.click(screen.getByRole('checkbox', { name: 'Select 26-01C' }));
    await user.click(within(selectionBar()).getByRole('button', { name: 'Hold until' }));
    const dialog = await screen.findByRole('dialog', { name: 'Hold 2 specimens until a date' });
    const submit = within(dialog).getByRole('button', { name: 'Hold 2 specimens until a date' });
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Choose the date to hold until.');
    await user.type(within(dialog).getByLabelText('Hold until'), '2026-12-05');
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent(
      'Choose a date after today (2026-12-05).',
    );
    await user.clear(within(dialog).getByLabelText('Hold until'));
    await user.type(within(dialog).getByLabelText('Hold until'), '2027-01-15');
    await user.click(submit);
    expect(within(dialog).getByRole('alert')).toHaveTextContent('A reason is required.');
    expect(posts).toHaveLength(0);
    await user.type(within(dialog).getByLabelText('Reason'), 'Engineer wants to hold these');
    await user.click(submit);
    const alert = await within(dialog).findByRole('alert');
    expect(alert).toHaveTextContent('Nothing was changed: some specimens aren’t eligible.');
    expect(within(alert).getByRole('list', { name: 'Not eligible' })).toHaveTextContent(
      '26-01C: Already on hold',
    );
    expect(posts).toEqual([
      {
        url: '/api/concrete/holds/hold-until',
        idempotencyKey: expect.any(String),
        items: [
          { specimenId: SPEC(1), version: 1 },
          { specimenId: SPEC(2), version: 1 },
        ],
        holdUntil: '2027-01-15',
        reason: 'Engineer wants to hold these',
      },
    ]);
  });

  it('Hold until is disabled with the reason when the project does not allow it', async () => {
    const user = userEvent.setup();
    renderPage((view) =>
      list(view as ConcreteWorklist['view'], [row()], true, { canHoldUntil: false }),
    );
    await user.click(await screen.findByRole('checkbox', { name: 'Select 26-01B' }));
    expect(within(selectionBar()).getByRole('button', { name: 'Reschedule' })).toBeEnabled();
    const hold = within(selectionBar()).getByRole('button', { name: 'Hold until' });
    expect(hold).toBeDisabled();
    expect(hold).toHaveAccessibleDescription('Hold until needs the project lead or a Lab Manager.');
  });

  it('opens the view the overview links to (Overdue), with days late', async () => {
    renderPage(
      (view) =>
        list(
          view as ConcreteWorklist['view'],
          view === 'overdue'
            ? [row({ targetDate: '2026-12-01', daysOverdue: 4, flags: ['overdue'] })]
            : [],
        ),
      undefined,
      '/lab-testing/concrete?view=overdue',
    );
    expect(await screen.findByRole('tab', { name: /Overdue/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    const table = await screen.findByRole('table', { name: 'DEMO-2601 specimens' });
    expect(within(table).getByRole('columnheader', { name: 'Due · late' })).toBeInTheDocument();
    expect(within(table).getByText('4 days late')).toBeVisible();
  });
});
