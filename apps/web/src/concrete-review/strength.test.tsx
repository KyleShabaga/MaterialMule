import {
  concreteStrengthReportSnapshotSchema,
  type ConcreteStrengthReportDetail,
  type ConcreteStrengthReportSnapshot,
  type MeResponse,
} from '@materialmule/shared';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../routes';
import { SessionContext } from '../session/context';

// MM-V2-C39: the strength report page. Fictional project and people only (DEMO-2601, Lee
// Manager, Riley Reviewer).

const SET = '00000000-0000-4000-8000-000000000501';
const LEE = { userId: '00000000-0000-4000-8000-000000000101', initials: 'LM', name: 'Lee Manager' };

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: LEE.userId,
  displayName: LEE.name,
  initials: LEE.initials,
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'concrete_test.enter'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});

const snapshot = (): ConcreteStrengthReportSnapshot =>
  concreteStrengthReportSnapshotSchema.parse({
    kind: 'strength',
    versionNo: 1,
    revNo: 0,
    revision: null,
    reportId: '',
    projectId: '00000000-0000-4000-8000-000000000201',
    projectNumber: 'DEMO-2601',
    projectName: 'Fictional parkade',
    client: 'Example Client',
    leadProjectEngineer: { userId: 'pe', initials: 'PE', name: 'Pat Example' },
    set: {
      setId: SET,
      identity: { permanentId: '26-07', temporaryId: null },
      fieldReportId: 'fr',
      fieldReportNumber: null,
      paperFieldId: null,
      castAt: '2026-11-02T15:15:00.000Z',
      castingDate: '2026-11-02',
      structureElements: ['Slab'],
      structureElementOther: null,
      location: 'Level 2',
      supplierName: 'Example Ready-Mix',
      mixNumber: 'M-32',
      specifiedStrengthMpa: 32,
      specifiedStrengthAgeDays: 28,
      specimenType: 'cylinder',
      specimenSize: '100x200',
      receivedOn: '2026-11-03',
      initialFieldCuring: null,
      labCuring: null,
    },
    units: { load: 'kN', dimension: 'mm', provisional: true },
    results: [
      {
        specimenId: 'a',
        letter: 'A',
        specimenLabel: '26-07A',
        identity: { permanentId: '26-07A', temporaryId: null },
        assignedAge: 7,
        targetDate: '2026-11-09',
        status: 'tested',
        reported: true,
        resultId: 'r',
        attemptNo: 1,
        testedOn: '2026-11-09',
        actualAgeDays: 7,
        heightReadings: [200.1],
        diameterReadings: [100.2],
        averageDiameter: null,
        averageHeight: null,
        area: null,
        maxLoad: 410.2,
        strength: null,
        fractureType: null,
        testedBy: LEE,
        enteredBy: [LEE],
        remarks: null,
      },
      {
        specimenId: 'b',
        letter: 'B',
        specimenLabel: '26-07B',
        identity: { permanentId: '26-07B', temporaryId: null },
        assignedAge: 28,
        targetDate: '2026-11-30',
        status: 'not_yet_tested',
        reported: false,
        resultId: null,
        attemptNo: null,
        testedOn: null,
        actualAgeDays: null,
        heightReadings: [],
        diameterReadings: [],
        averageDiameter: null,
        averageHeight: null,
        area: null,
        maxLoad: null,
        strength: null,
        fractureType: null,
        testedBy: null,
        enteredBy: [],
        remarks: null,
      },
      {
        specimenId: 'd',
        letter: 'D',
        specimenLabel: '26-07D',
        identity: { permanentId: '26-07D', temporaryId: null },
        assignedAge: 'HOLD',
        targetDate: null,
        status: 'hold',
        reported: false,
        resultId: null,
        attemptNo: null,
        testedOn: null,
        actualAgeDays: null,
        heightReadings: [],
        diameterReadings: [],
        averageDiameter: null,
        averageHeight: null,
        area: null,
        maxLoad: null,
        strength: null,
        fractureType: null,
        testedBy: null,
        enteredBy: [],
        remarks: null,
      },
    ],
    ages: [
      {
        ageDays: 7,
        specimenCount: 1,
        testedCount: 1,
        complete: true,
        averageStrength: null,
        assessment: null,
      },
      {
        ageDays: 28,
        specimenCount: 1,
        testedCount: 0,
        complete: false,
        averageStrength: null,
        assessment: null,
      },
    ],
    agesReported: [7],
    warnings: [],
    standardsLine: 'Test methods: [to be confirmed by owner]',
    calculation: {
      method: null,
      note: 'Strength, area, averages and assessment await the approved method.',
    },
  });

const detail = (
  overrides: Partial<ConcreteStrengthReportDetail> = {},
): ConcreteStrengthReportDetail => ({
  setId: SET,
  projectId: '00000000-0000-4000-8000-000000000201',
  reportId: null,
  reportNumber: null,
  state: 'not_started',
  version: 0,
  issueCount: 0,
  revised: false,
  preview: snapshot(),
  submitBlocker: null,
  newResults: true,
  latestVersion: null,
  latestIssuedVersionNo: null,
  selfReviewUserIds: [],
  allowedActions: ['submit'],
  canExclude: false,
  excludableSpecimenIds: [],
  ...overrides,
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

function renderAt(answer: (url: URL, init?: RequestInit) => Response, who = me()) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
    answer(new URL(String(input), 'http://x'), init),
  );
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: [`/concrete/strength/${SET}`] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: who },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return { fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Strength report page', () => {
  it('prints the set block and results, with "—" for strength on a pre-C24 version, HOLD and targets', async () => {
    renderAt(() => json(200, detail()));
    expect(await screen.findByRole('heading', { name: 'Strength report 26-07' })).toBeVisible();
    // Field Ledger: one framed table per test age, then the held specimens.
    const row = (table: string, index: number) =>
      within(screen.getByRole('table', { name: `Strength results, ${table}` })).getAllByRole('row')[
        index
      ]!;
    expect(within(row('7 days', 1)).getByRole('rowheader')).toHaveAccessibleName('26-07A');
    expect(row('7 days', 1)).toHaveTextContent('410.2');
    expect(row('28 days', 1)).toHaveTextContent('Not yet tested (target 2026-11-30)');
    expect(row('On hold', 1)).toHaveTextContent('HOLD');
    // Strength and area columns print a dash, never 0.
    const cells = within(row('7 days', 1)).getAllByRole('cell');
    expect(cells[4]).toHaveTextContent(/^—$/);
    expect(cells[6]).toHaveTextContent(/^—$/);
    // The four facts in the panel: version, workflow, specified strength and method.
    const facts = screen
      .getByRole('complementary', { name: 'Review panel' })
      .querySelector('dl[aria-label="Strength report"]')!;
    expect(Array.from(facts.querySelectorAll('dt')).map((dt) => dt.textContent)).toEqual([
      'Version',
      'Workflow',
      'Specified',
      'Method',
    ]);
    // The status word is the header's tag; the paper is marked provisional (G2).
    expect(screen.getByText('Not submitted')).toBeVisible();
    expect(screen.getByText('Provisional · G2 open')).toBeVisible();
    expect(screen.getByText('Provisional design · G2 open · not for issue as drawn')).toBeVisible();
    expect(screen.getByText(/32 MPa at 28 d/)).toBeVisible();
    expect(screen.getByText(/to be confirmed by owner/)).toBeVisible();
  });

  it('submits as lab staff with the report version and a fresh key', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt((url, init) => {
      if (init?.method === 'POST') return json(201, detail({ state: 'submitted' }));
      return json(200, detail());
    });
    await user.click(await screen.findByRole('button', { name: 'Submit for review' }));
    const post = fetchMock.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(String(post[0])).toBe(`/api/concrete/specimen-sets/${SET}/strength-report/submit`);
    expect(JSON.parse(String(post[1]!.body))).toMatchObject({ version: 0 });
  });

  it('MM-V2-C24: shows the P1 values, the advisory assessment and the method line', async () => {
    const base = snapshot();
    const p1 = concreteStrengthReportSnapshotSchema.parse({
      ...base,
      results: base.results.map((row) =>
        row.letter === 'A'
          ? { ...row, area: 7901, strength: 51.9, calculationMethodVersion: 'P1' }
          : row,
      ),
      ages: base.ages.map((age) =>
        age.ageDays === 7
          ? { ...age, averageStrength: 51.9, assessment: 'information_only', single: true }
          : age,
      ),
      calculation: {
        method: {
          method: 'compressive_strength',
          version: 'P1',
          provisional: true,
          line: 'Calculation method P1 (provisional)',
        },
        note: 'Provisional calculation pending the office worksheet.',
      },
    });
    const user = userEvent.setup();
    const { fetchMock } = renderAt((url, init) => {
      if (init?.method === 'PUT') {
        return json(200, { specimenId: 'a', excluded: null, history: [] });
      }
      return json(
        200,
        detail({ preview: p1, canExclude: true, excludableSpecimenIds: ['a', 'b', 'd'] }),
      );
    });
    expect(await screen.findByText('Calculation method P1 (provisional)')).toBeVisible();
    const table = screen.getByRole('table', { name: 'Strength results, 7 days' });
    const rows = within(table).getAllByRole('row');
    expect(rows[1]).toHaveTextContent('51.9 MPa');
    expect(rows[1]).toHaveTextContent('7901 mm²');
    expect(screen.getByText(/single specimen/)).toBeVisible();
    expect(screen.getByText('Information only')).toBeVisible();

    // A strength reviewer excludes a specimen, with a reason.
    await user.click(screen.getByRole('button', { name: 'Exclude 26-07A' }));
    // jsdom has no modal dialogs: the closed-dialog controls are inert there, so the reason
    // is set and the form sent directly.
    fireEvent.change(screen.getByLabelText(/^Reason/), { target: { value: 'Defective specimen' } });
    fireEvent.click(screen.getByRole('button', { name: 'Exclude', hidden: true }));
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(true),
    );
    const put = fetchMock.mock.calls.find(([, init]) => init?.method === 'PUT')!;
    expect(String(put[0])).toBe('/api/concrete/specimens/a/strength-exclusion');
    expect(JSON.parse(String(put[1]!.body))).toMatchObject({
      excluded: true,
      reason: 'Defective specimen',
    });
  });

  it('review fix: after an issue, the new later-age results can be shown and excluded', async () => {
    const base = snapshot();
    // Issued Rev 0 reports A (7 d); B's 28-day result came in afterwards.
    const issued = base;
    const live = concreteStrengthReportSnapshotSchema.parse({
      ...base,
      versionNo: 2,
      results: base.results.map((row) =>
        row.letter === 'B'
          ? {
              ...row,
              status: 'tested',
              reported: true,
              resultId: 'rb',
              attemptNo: 1,
              testedOn: '2026-11-30',
              actualAgeDays: 28,
              maxLoad: 300,
            }
          : row,
      ),
    });
    const version = {
      id: 'v1',
      versionNo: 1,
      state: 'issued',
      revisionOfVersionNo: null,
      snapshotSha256: 'x'.repeat(64),
      submittedAt: '2026-11-10T16:00:00.000Z',
      submittedBy: LEE,
      submittedStaff: LEE,
      route: { kind: 'designated_reviewers', routedTo: null, reason: null },
      review: null,
      closed: null,
      issued: null,
    };
    const user = userEvent.setup();
    renderAt((url) => {
      if (url.pathname.endsWith('/exception-notes')) {
        return json(200, { reportId: 'sr', versionNo: 1, notes: [] });
      }
      if (url.pathname.endsWith('/versions/1')) {
        return json(200, { ...version, reportId: 'sr', snapshot: issued });
      }
      if (url.pathname.endsWith('/versions')) {
        return json(200, { reportId: 'sr', versions: [version], transitions: [] });
      }
      return json(
        200,
        detail({
          reportId: 'sr',
          state: 'issued',
          version: 3,
          issueCount: 1,
          preview: live,
          latestVersion: version as ConcreteStrengthReportDetail['latestVersion'],
          latestIssuedVersionNo: 1,
          allowedActions: [],
          canExclude: true,
          // A is on the issued version (locked); B is new.
          excludableSpecimenIds: ['b', 'd'],
        }),
      );
    });
    const toggle = await screen.findByRole('button', { name: 'Show the new results' });
    // The issued version is shown first, without exclusion controls, its results locked.
    expect(screen.queryByRole('button', { name: /^Exclude / })).toBeNull();
    expect(screen.getByText(/These results are on an issued version/)).toBeVisible();
    await user.click(toggle);
    expect(screen.queryByText(/These results are on an issued version/)).toBeNull();
    expect(screen.getByRole('button', { name: 'Exclude 26-07B' })).toBeVisible();
    // The issued specimen stays protected.
    expect(screen.queryByRole('button', { name: 'Exclude 26-07A' })).toBeNull();
    await user.click(screen.getByRole('button', { name: 'Show the issued version' }));
    expect(screen.queryByRole('button', { name: /^Exclude / })).toBeNull();
  });

  it('explains why the sole tester can’t review', async () => {
    renderAt(() =>
      json(
        200,
        detail({ state: 'submitted', allowedActions: [], selfReviewUserIds: [LEE.userId] }),
      ),
    );
    const button = await screen.findByRole('button', { name: 'Mark reviewed' });
    expect(button).toBeDisabled();
    expect(screen.getByText(/entered or tested these results alone/)).toBeVisible();
  });
});
