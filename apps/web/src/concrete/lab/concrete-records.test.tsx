import {
  concreteSetReceivingSchema,
  concreteSpecimenSetDetailSchema,
  type ConcreteReceivingQueue,
  type ConcreteReceivingQueueRow,
  type ConcreteSearch,
  type ConcreteSetReceiving,
  type ConcreteSpecimenSetDetail,
  type ConcreteTestingTableRow,
  type MeResponse,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StrataToaster } from '../../components/strata/toast';
import { detail, PROJECT_ID, REPORT_ID } from '../../concrete-review/fixtures.test-support';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';
import { setRecordState } from './set-record';

// STRATA-95 part B: Receiving, Specimens, the set page and the old Concrete search address.
// Fictional projects and people only (DEMO-2601 / DEMO-2602, Alex Tester, Jordan Smith).

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read', 'concrete_specimen.receive'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};
const B = '00000000-0000-4000-8000-000000000202';
const SET_ID = '00000000-0000-4000-8000-000000000301';
const UNCAST_SET = '00000000-0000-4000-8000-000000000303';
const SPEC = (n: number) => `00000000-0000-4000-8000-00000000070${n}`;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const queueRow = (overrides: Partial<ConcreteReceivingQueueRow>): ConcreteReceivingQueueRow => ({
  setId: SET_ID,
  fieldReportId: REPORT_ID,
  projectId: PROJECT_ID,
  projectNumber: 'DEMO-2601',
  projectName: 'Example tower',
  identity: { temporaryId: null, permanentId: '26-05' },
  castAt: '2026-11-02T15:00:00.000Z',
  technician: { userId: ME.id, initials: 'AT', name: 'Alex Tester' },
  mine: true,
  letters: ['A', 'B'],
  specimenCount: 4,
  reportState: 'submitted',
  ...overrides,
});

function setDetail(
  overrides: Partial<ConcreteSpecimenSetDetail> = {},
  specimens: Partial<ConcreteSpecimenSetDetail['specimens'][number]>[] = [],
): ConcreteSpecimenSetDetail {
  const ages = [7, 28, 28, 'HOLD'] as const;
  return concreteSpecimenSetDetailSchema.parse({
    id: SET_ID,
    projectId: PROJECT_ID,
    fieldReportId: REPORT_ID,
    identity: { temporaryId: null, permanentId: '26-05', permanentNumber: 5 },
    specimenType: 'cylinder',
    mouldSize: '150 × 300 mm',
    castAt: '2026-11-02T15:00:00.000Z',
    castingDate: '2026-11-02',
    defaultSchedule: null,
    specimenCount: 4,
    specimens: ['A', 'B', 'C', 'D'].map((letter, i) => ({
      id: SPEC(i + 1),
      letter,
      assignedAge: ages[i],
      targetDate: ages[i] === 'HOLD' ? null : i === 0 ? '2026-11-09' : '2026-11-30',
      holdExpiresOn: ages[i] === 'HOLD' ? '2026-12-28' : null,
      flags: [],
      identity: { temporaryId: null, permanentId: `26-05${letter}` },
      ...specimens[i],
    })),
    createdBy: { userId: ME.id, initials: 'AT', name: 'Alex Tester' },
    technician: { userId: ME.id, initials: 'AT', name: 'Alex Tester' },
    void: null,
    version: 1,
    createdAt: '2026-11-02T16:00:00.000Z',
    updatedAt: '2026-11-02T16:00:00.000Z',
    canEdit: false,
    ...overrides,
  });
}

function receivingOf(
  set: ConcreteSpecimenSetDetail,
  received: readonly string[],
): ConcreteSetReceiving {
  return concreteSetReceivingSchema.parse({
    setId: set.id,
    fieldReportId: REPORT_ID,
    projectId: PROJECT_ID,
    identity: { temporaryId: set.identity.temporaryId, permanentId: set.identity.permanentId },
    castAt: set.castAt,
    technician: set.technician,
    voided: false,
    pickupWindow: {
      hours: 24,
      source: 'default',
      endsAt: null,
      verified: false,
      version: null,
    },
    currentCuringRange: null,
    specimens: set.specimens.map((s) => ({
      specimenId: s.id,
      letter: s.letter,
      identity: s.identity,
      assignedAge: s.assignedAge,
      state: received.includes(s.letter) ? 'received' : 'awaiting_pickup',
      pickup: null,
      receipt: received.includes(s.letter)
        ? {
            id: `r-${s.letter}`,
            receivedAt: '2026-11-03T15:10:00.000Z',
            receivedBy: { userId: 'j', initials: 'JS', name: 'Jordan Smith' },
            massG: '12345.6',
            recordedBy: { userId: 'j', initials: 'JS', name: 'Jordan Smith' },
            fromExceptionId: null,
            corrections: [],
            version: 1,
          }
        : null,
      markerConfirmationId: null,
      openExceptionIds: [],
    })),
    markerConfirmations: [],
    exceptions: [],
    blockers: [],
    issuanceGates: [],
  });
}

const testingRow = (specimenId: string, complete: boolean): ConcreteTestingTableRow =>
  ({
    specimenId,
    setId: SET_ID,
    fieldReportId: REPORT_ID,
    projectId: PROJECT_ID,
    letter: 'A',
    identity: { temporaryId: null, permanentId: '26-05A' },
    permanentNumber: 5,
    assignedAge: 7,
    castingDate: '2026-11-02',
    targetDate: '2026-11-09',
    daysOverdue: null,
    actualAge: 7,
    reportState: 'submitted',
    specifiedStrengthMpa: null,
    flags: [],
    result: null,
    complete,
  }) as ConcreteTestingTableRow;

type Api = (url: URL, init?: RequestInit) => Response | undefined;

/** C22's schedule history of one specimen (only the entries matter here). */
const historyOf = (specimenId: string, history: unknown[]) => ({
  specimenId,
  identity: { temporaryId: null, permanentId: null },
  assignedAge: 7,
  castingDate: '2026-11-02',
  targetDate: '2026-11-09',
  holdExpiresOn: null,
  version: 1,
  history,
});

/** The set lookup reads for one set: C05 set, C06 receiving and C04's report. */
const setApi =
  (set: ConcreteSpecimenSetDetail, receiving: ConcreteSetReceiving): Api =>
  (url) => {
    if (url.pathname === `/api/concrete/specimen-sets/${set.id}`) return json(200, set);
    if (url.pathname === `/api/concrete/specimen-sets/${set.id}/receiving`)
      return json(200, receiving);
    if (url.pathname === `/api/concrete/field-reports/${REPORT_ID}`) return json(200, detail());
    if (url.pathname.endsWith('/schedule-history')) {
      const specimenId = url.pathname.split('/')[4]!;
      return json(200, historyOf(specimenId, []));
    }
    return undefined;
  };

function renderAt(path: string, api: Api, me: MeResponse = ME) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input), 'http://x');
    return api(url, init) ?? json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return { fetchMock, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

const queue = (items: ConcreteReceivingQueueRow[]): ConcreteReceivingQueue => ({
  stage: 'awaiting_receiving',
  counts: { awaiting_pickup: 1, awaiting_receiving: items.length },
  mineTotal: items.filter((r) => r.mine).length,
  total: items.length,
  page: 1,
  pageSize: 50,
  items,
});

describe('Receiving', () => {
  const rows = [
    queueRow({}),
    queueRow({
      setId: UNCAST_SET,
      fieldReportId: '00000000-0000-4000-8000-000000000402',
      projectId: B,
      projectNumber: 'DEMO-2602',
      projectName: 'Example bridge',
      identity: { temporaryId: 'TMP-D07-004', permanentId: null },
      castAt: null,
      technician: { userId: 'x', initials: 'JS', name: 'Jordan Smith' },
      mine: false,
      letters: ['A', 'B', 'C'],
    }),
  ];

  it('opens on awaiting receiving with My reports before Other reports', async () => {
    const { fetchMock } = renderAt('/concrete/receiving', (url) =>
      url.pathname === '/api/concrete/receiving-queue' ? json(200, queue(rows)) : undefined,
    );
    const mine = await screen.findByRole('region', { name: 'My reports' });
    const others = screen.getByRole('region', { name: 'Other reports' });
    // My reports come first in the page.
    expect(mine.compareDocumentPosition(others) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(mine).getByRole('link', { name: '26-05' })).toHaveAttribute(
      'href',
      `/concrete/specimens/${SET_ID}`,
    );
    expect(within(mine).getByText('DEMO-2601')).toBeInTheDocument();
    expect(within(others).getByText('DEMO-2602')).toBeInTheDocument();
    expect(within(others).getByText('Jordan Smith')).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: 'Awaiting receiving 2' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      '/api/concrete/receiving-queue?stage=awaiting_receiving',
    );
  });

  it('lists a set without a casting time with the note, and it can be received', async () => {
    const uncast = setDetail(
      {
        id: UNCAST_SET,
        identity: { temporaryId: 'TMP-D07-004', permanentId: null, permanentNumber: null },
        castAt: null,
        castingDate: null,
      },
      [{ targetDate: null }, { targetDate: null }, { targetDate: null }, { holdExpiresOn: null }],
    );
    const posts: [string, Record<string, unknown>][] = [];
    renderAt('/concrete/receiving', (url, init) => {
      if (init?.method === 'POST') {
        posts.push([url.pathname, JSON.parse(String(init.body))]);
        return json(201, receivingOf(uncast, ['A']));
      }
      if (url.pathname === '/api/concrete/receiving-queue') return json(200, queue(rows));
      return setApi(uncast, receivingOf(uncast, []))(url, init);
    });
    const others = await screen.findByRole('region', { name: 'Other reports' });
    expect(within(others).getByText('Casting time not recorded')).toBeInTheDocument();
    expect(within(others).getByText('No test dates until it is')).toBeInTheDocument();

    await userEvent.click(within(others).getByRole('button', { name: 'Receive TMP-D07-004' }));
    const sheet = await screen.findByRole('dialog', { name: /Receive set TMP-D07-004/ });
    expect(
      await within(sheet).findByText('No test dates until it is.', { exact: false }),
    ).toBeInTheDocument();
    // Personal account: received by you unless changed.
    await userEvent.click(within(sheet).getByRole('checkbox', { name: 'Receive TMP-D07-004A' }));
    // The marker confirmation needs a numbered set.
    expect(
      within(sheet).getByRole('checkbox', { name: /Permanent IDs added to all received/ }),
    ).toBeDisabled();
    await userEvent.click(within(sheet).getByRole('button', { name: 'Receive 1 specimen' }));
    // The mass is checked with the shared rule before anything is sent.
    expect(
      within(sheet).getByText('Enter grams with at most one decimal place (0.1 g)'),
    ).toBeInTheDocument();
    expect(posts).toEqual([]);
    await userEvent.type(within(sheet).getByLabelText('Mass of TMP-D07-004A'), '12345.6');
    await userEvent.click(within(sheet).getByRole('button', { name: 'Receive 1 specimen' }));
    expect(await screen.findByText('Received 1 specimen of TMP-D07-004.')).toBeInTheDocument();
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe(`/api/concrete/specimens/${SPEC(1)}/receipt`);
    expect(posts[0]![1]).toMatchObject({ massG: '12345.6' });
    expect(posts[0]![1]).not.toHaveProperty('receivedByUserId');
  });

  it('switches to awaiting pickup and says when nothing is there', async () => {
    const { fetchMock } = renderAt('/concrete/receiving', (url) => {
      if (url.pathname !== '/api/concrete/receiving-queue') return undefined;
      return url.searchParams.get('stage') === 'awaiting_pickup'
        ? json(200, {
            ...queue([]),
            stage: 'awaiting_pickup',
            counts: { awaiting_pickup: 0, awaiting_receiving: 2 },
          })
        : json(200, queue(rows));
    });
    await screen.findByRole('region', { name: 'My reports' });
    await userEvent.click(screen.getByRole('tab', { name: /Awaiting pickup/ }));
    expect(await screen.findByText('No sets are waiting to be picked up.')).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      '/api/concrete/receiving-queue?stage=awaiting_pickup',
    );
  });
});

describe('Set page state (pure)', () => {
  const today = '2026-11-20';
  it('awaits receiving until every expected specimen is received: Receive', () => {
    const set = setDetail();
    const state = setRecordState({
      set,
      receiving: receivingOf(set, ['A']),
      testing: new Map(),
      today,
    });
    expect(state).toMatchObject({
      key: 'awaiting',
      step: 'cast',
      main: { kind: 'receive' },
      received: 1,
      expected: 4,
    });
  });

  it('a received set with a break due: Record breaks for just those specimens', () => {
    const set = setDetail();
    const state = setRecordState({
      set,
      receiving: receivingOf(set, ['A', 'B', 'C', 'D']),
      testing: new Map(),
      today,
    });
    expect(state).toMatchObject({
      key: 'due',
      tag: { stage: 'lab', label: 'In lab · Breaks' },
      step: 'testing',
      main: { kind: 'breaks', specimenIds: [SPEC(1)] },
    });
    // An entered break is no longer due.
    const entered = setRecordState({
      set,
      receiving: receivingOf(set, ['A', 'B', 'C', 'D']),
      testing: new Map([[SPEC(1), testingRow(SPEC(1), true)]]),
      today,
    });
    expect(entered.key).toBe('curing');
  });

  it('a hold past its date: Open hold, flagged in danger', () => {
    const set = setDetail({}, [{}, {}, {}, { holdExpiresOn: '2026-11-15' }]);
    const state = setRecordState({
      set,
      receiving: receivingOf(set, ['A', 'B', 'C', 'D']),
      testing: new Map([[SPEC(1), testingRow(SPEC(1), true)]]),
      today,
    });
    expect(state).toMatchObject({
      key: 'hold_ended',
      tag: { stage: 'danger', label: 'Hold period has ended' },
      main: { kind: 'hold' },
      holdEnded: [SPEC(4)],
    });
  });
});

describe('Set page', () => {
  it('shows the record header, the specimens with test dates and History', async () => {
    const set = setDetail();
    renderAt(`/concrete/specimens/${SET_ID}?letter=B`, setApi(set, receivingOf(set, ['A'])));
    expect(await screen.findByRole('heading', { name: '26-05', level: 1 })).toBeInTheDocument();
    expect(screen.getByText('Draft · Receiving')).toBeInTheDocument();
    expect(screen.getByText('1 of 4 received')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Lifecycle of set 26-05' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Receive' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /^Field report/ })).toHaveAttribute(
      'href',
      `/concrete/review/${REPORT_ID}`,
    );
    const specimens = screen.getByRole('region', { name: 'Specimens' });
    expect(within(specimens).getByText('26-05A')).toBeInTheDocument();
    expect(within(specimens).getByText('Searched')).toBeInTheDocument();
    expect(within(specimens).getAllByText('Awaiting pickup')).toHaveLength(3);
    expect(within(specimens).getByText('Hold until')).toBeInTheDocument();
    expect(within(specimens).getByText('2026-12-28')).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'History' })).toBeInTheDocument();
    expect(screen.getByText(/recorded the set/)).toBeInTheDocument();
  });

  it('marks a rescheduled specimen and offers Record breaks when a break is due', async () => {
    const set = setDetail({}, [{ targetDate: '2026-01-10' }]);
    renderAt(`/concrete/specimens/${SET_ID}`, (url, init) => {
      if (url.pathname === `/api/concrete/specimens/${SPEC(1)}/schedule-history`) {
        return json(200, {
          ...historyOf(SPEC(1), []),
          specimenId: SPEC(1),
          history: [
            {
              id: 'h1',
              previousAge: 7,
              newAge: 8,
              previousTargetDate: '2026-01-09',
              newTargetDate: '2026-01-10',
              reason: 'Press out of service',
              by: { userId: 'j', initials: 'JS', name: 'Jordan Smith' },
              at: '2026-01-09T15:00:00.000Z',
            },
          ],
        });
      }
      return setApi(set, receivingOf(set, ['A', 'B', 'C', 'D']))(url, init);
    });
    const breaks = await screen.findByRole('link', { name: 'Record breaks' });
    expect(breaks).toHaveAttribute('href', `/concrete/testing?specimenIds=${SPEC(1)}`);
    expect(await screen.findByText('Rescheduled · was 7-day')).toBeInTheDocument();
    expect(screen.getByText(/rescheduled/, { selector: 'div' })).toHaveTextContent(
      'Jordan Smith rescheduled 26-05A from 7-day to 8-day: “Press out of service”',
    );
  });

  it('says when no set has the ID', async () => {
    renderAt(`/concrete/specimens/${SET_ID}`, () => undefined);
    expect(await screen.findByText('No set or specimen has this ID.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Look up another set' })).toHaveAttribute(
      'href',
      '/concrete/specimens',
    );
  });
});

const search = (overrides: Partial<ConcreteSearch>): ConcreteSearch => ({
  q: '26-05B',
  letter: 'B',
  total: 2,
  page: 1,
  pageSize: 25,
  projectCount: 2,
  items: [B, PROJECT_ID].map((projectId, i) => ({
    fieldReportId: `00000000-0000-4000-8000-00000000040${i + 1}`,
    projectId,
    projectNumber: i === 0 ? 'DEMO-2602' : 'DEMO-2601',
    projectName: i === 0 ? 'Example bridge' : 'Example tower',
    reportDate: '2026-11-02',
    castingDate: '2026-11-02',
    paperFieldId: '118',
    ticketNumber: null,
    supplierName: null,
    mixNumber: null,
    technician: null,
    workflowState: 'submitted',
    matches: ['set_id'],
    sets: [
      {
        setId: `00000000-0000-4000-8000-00000000030${i + 1}`,
        identity: { temporaryId: null, permanentId: '26-05' },
        specimenCount: 4,
        voided: false,
        matched: true,
      },
    ],
  })),
  ...overrides,
});

describe('Specimens lookup', () => {
  it('AC1: a set number in two projects lists both with their project; nothing is chosen', async () => {
    const { router } = renderAt('/concrete/specimens?q=26-05B', (url) =>
      url.pathname === '/api/concrete/search' ? json(200, search({})) : undefined,
    );
    expect(await screen.findByText(/Set numbers repeat between projects/)).toBeInTheDocument();
    const table = screen.getByRole('table', { name: 'Specimen sets matching 26-05B' });
    const links = within(table).getAllByRole('link', { name: '26-05B' });
    expect(links.map((a) => a.getAttribute('href'))).toEqual([
      '/concrete/specimens/00000000-0000-4000-8000-000000000301?letter=B',
      '/concrete/specimens/00000000-0000-4000-8000-000000000302?letter=B',
    ]);
    expect(within(table).getByText('DEMO-2602')).toBeInTheDocument();
    expect(within(table).getByText('DEMO-2601')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/concrete/specimens');
  });

  it('AC2: one exact match opens its set straight away', async () => {
    const one = search({ q: 'TMP-D07-001', letter: null, total: 1, projectCount: 1 });
    const { router } = renderAt('/concrete/specimens?q=TMP-D07-001', (url) =>
      url.pathname === '/api/concrete/search'
        ? json(200, { ...one, items: one.items.slice(0, 1) })
        : undefined,
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/concrete/specimens/00000000-0000-4000-8000-000000000301',
      ),
    );
  });

  it('Concrete search is folded into the search results: the old address redirects', async () => {
    const { router } = renderAt('/concrete/search?q=T-778', () => undefined);
    await vi.waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe('/search?q=T-778'),
    );
  });
});
