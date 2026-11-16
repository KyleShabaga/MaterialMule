import type {
  LabLine,
  LabProgram,
  MeResponse,
  TestCatalogue,
  TestTemplate,
} from '@materialmule/shared';
import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, type RouteObject } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../../session/context';
import { RecordingPersonLayout } from '../../session/recording-person';
import { pickStationPerson } from '../../session/station-test-person';
import { ProgramEditor } from '../ProgramEditor';

// STRATA-86: the lab program editor's Lines and Grid views of one edit state, saves as you go,
// the sticky bar, long programs, conflicts and the LAB station's Requested by. Fictional data
// only (DEMO-2601, TH26-01, Alex Tester).

// Popovers, selects and menus make these interaction tests slower than the default allows.
vi.setConfig({ testTimeout: 15000 });

beforeAll(() => {
  const proto = window.HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  proto.setPointerCapture ??= () => {};
  proto.scrollIntoView ??= () => {};
});

const PROJECT = '00000000-0000-4000-8000-000000000201';
const HOLE_1 = '00000000-0000-4000-8000-000000000301';
const HOLE_2 = '00000000-0000-4000-8000-000000000302';
const TUBE = '00000000-0000-4000-8000-000000000303';
const PROGRAM_ID = '00000000-0000-4000-8000-0000000000e1';
const MC = '00000000-0000-4000-8000-0000000000a1';
const ATT = '00000000-0000-4000-8000-0000000000a3';
const OLD = '00000000-0000-4000-8000-0000000000a2';
const SOILS = '00000000-0000-4000-8000-00000000c101';
const ALEX = '00000000-0000-4000-8000-000000000102';

const me = (overrides: Partial<MeResponse> = {}): MeResponse => ({
  id: ALEX,
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read', 'lab_program.read', 'lab_program.manage'],
  sessionExpiresAt: '2026-10-28T06:00:00.000Z',
  profileRefreshFailed: false,
  ...overrides,
});
const LAB = me({
  id: '00000000-0000-4000-8000-000000000001',
  displayName: 'LAB',
  initials: null,
  accountType: 'shared_lab',
});

const test = (id: string, code: string, name: string | null, active = true) => ({
  id,
  groupId: SOILS,
  groupName: 'Soils',
  subgroupId: null,
  subgroupName: null,
  code,
  name,
  description: `${name ?? code} (fictional)`,
  sortOrder: 0,
  active,
  retiredAt: active ? null : '2026-10-27T00:00:00.000Z',
  version: 1,
  sampleTagMode: 'none' as const,
  sampleTagGroup: null,
});
const catalogue: TestCatalogue = {
  groups: [{ id: SOILS, name: 'Soils', sortOrder: 1, version: 1, subgroups: [] }],
  tests: [
    test(MC, 'DEMO-MC', 'Moisture Content'),
    test(ATT, 'DEMO-ATT', 'Atterberg Limits'),
    test(OLD, 'DEMO-OLD', null, false),
  ],
};
const templates: TestTemplate[] = [
  {
    id: '00000000-0000-4000-8000-0000000000b1',
    name: 'Demo pair',
    active: true,
    retiredAt: null,
    version: 1,
    items: [
      { testTypeId: MC, code: 'DEMO-MC', displayName: 'Moisture Content', active: true },
      { testTypeId: OLD, code: 'DEMO-OLD', displayName: 'Old fictional test', active: false },
    ],
  },
];
const sources = [
  { kind: 'test_hole', id: HOLE_1, label: 'TH26-01', unitCount: 2 },
  { kind: 'test_hole', id: HOLE_2, label: 'TH26-02', unitCount: 1 },
  { kind: 'standalone_unit', id: TUBE, label: 'Embankment 03 · ST-2026-000004', unitCount: 1 },
];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

const testOf = (id: string) => {
  const found = catalogue.tests.find((t) => t.id === id)!;
  return {
    testTypeId: id,
    code: found.code,
    displayName: found.name ?? found.description,
    description: found.description,
    groupName: 'Soils',
    subgroupName: null,
    active: found.active,
  };
};

function line(
  n: number,
  over: Partial<Omit<LabLine, 'tests'>> & { tests?: string[] } = {},
): LabLine {
  const { tests = [], ...rest } = over;
  return {
    id: `line-${n}`,
    lineNumber: n,
    source: { kind: 'test_hole', id: HOLE_1, label: 'TH26-01' },
    scope: 'all',
    sampleLabel: null,
    depthMode: null,
    depthFrom: null,
    depthTo: null,
    depthUnit: null,
    acknowledgedDepths: [],
    tests: tests.map(testOf),
    unitIds: [],
    requests: [],
    coverage: [],
    coverageCapturedAt: null,
    amendmentId: null,
    ...rest,
  };
}

function program(lines: LabLine[], version = 3): LabProgram {
  return {
    id: PROGRAM_ID,
    programNumber: null,
    status: 'draft',
    priority: 'normal',
    notes: null,
    project: { id: PROJECT, projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
    createdBy: { userId: ALEX, initials: 'AT', name: 'Alex Tester', accountType: 'personal' },
    requestedBy: { userId: ALEX, initials: 'AT', name: 'Alex Tester' },
    createdAt: '2026-11-12T16:00:00.000Z',
    updatedAt: '2026-11-12T17:02:00.000Z',
    version,
    submittedAt: null,
    submittedBy: null,
    submittedFor: null,
    lines,
  };
}

type Body = Record<string, unknown> & { lines?: Record<string, unknown>[]; version?: number };

/**
 * A small fake of the program API: PATCH saves (or answers `patch` instead), the review covers
 * one bucket per ALL line, and submit numbers the program.
 */
function fakeServer(
  start: LabProgram,
  options: { patch?: (body: Body) => Response | null; create?: (body: Body) => Response } = {},
) {
  let current = start;
  const toLines = (lines: Record<string, unknown>[]) =>
    lines.map((input, i) =>
      line(i + 1, {
        id: (input.id as string | undefined) ?? `saved-${i + 1}`,
        source: input.source
          ? {
              ...(input.source as { kind: 'test_hole'; id: string }),
              label: sources.find((s) => s.id === (input.source as { id: string }).id)!.label,
            }
          : null,
        scope: input.scope as LabLine['scope'],
        sampleLabel: (input.sampleLabel as string | null) ?? null,
        tests: input.testTypeIds as string[],
        unitIds: (input.unitIds as string[]) ?? [],
      }),
    );
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    const body = init?.body ? (JSON.parse(String(init.body)) as Body) : {};
    if (url.startsWith('/api/test-catalogue')) return json(200, catalogue);
    if (url.startsWith('/api/test-templates')) return json(200, templates);
    if (url.endsWith('/units')) {
      return json(200, [
        {
          storageUnitId: '00000000-0000-4000-8000-000000000401',
          readableId: 'BKT-2026-000019',
          unitType: 'bucket',
          contents: 'G1–G3',
          receivedDate: '2026-11-02',
        },
      ]);
    }
    if (url.includes('/lab-sources')) return json(200, sources);
    if (url.startsWith('/api/projects/search')) {
      return json(200, [
        {
          id: PROJECT,
          projectNumber: 'DEMO-2601',
          name: 'Riverbank investigation',
          client: 'Example Client',
          leadProjectEngineer: null,
        },
      ]);
    }
    if (url === '/api/lab-programs' && method === 'POST') {
      if (options.create) return options.create(body);
      current = { ...start, lines: toLines(body.lines ?? []), version: 1 };
      return json(201, current);
    }
    if (url.endsWith(`/${PROGRAM_ID}`) && method === 'PATCH') {
      const answer = options.patch?.(body);
      if (answer) return answer;
      current = {
        ...current,
        version: current.version + 1,
        notes: (body.notes as string | null) ?? null,
        lines: toLines(body.lines ?? []),
      };
      return json(200, current);
    }
    if (url.endsWith('/review')) {
      return json(200, {
        programId: PROGRAM_ID,
        version: current.version,
        ready: true,
        lines: current.lines.map((l) => ({
          lineId: l.id,
          lineNumber: l.lineNumber,
          coverage:
            l.scope === 'all'
              ? [
                  {
                    storageUnitId: `unit-${l.lineNumber}`,
                    readableId: `BKT-2026-00002${l.lineNumber}`,
                    unitType: 'bucket',
                    contents: null,
                    receivedDate: '2026-11-02',
                    receiptId: 'r1',
                    included: true,
                    matchingBasis: 'hole_summary',
                    amendmentId: null,
                  },
                ]
              : [],
          unknownClassificationCount: 0,
          discrepancy: null,
          retiredTests: [],
          problems: [],
        })),
      });
    }
    if (url.endsWith('/submit') && method === 'POST') {
      return json(200, { ...current, status: 'submitted', programNumber: 'LP-2026-0007' });
    }
    if (url.endsWith('/discard') && method === 'POST') return json(200, null);
    if (url.startsWith('/api/staff')) return json(200, { options: [], receivers: [] });
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const calls = (method: string, ending: string) =>
    fetchMock.mock.calls
      .filter(([url, init]) => (init?.method ?? 'GET') === method && String(url).endsWith(ending))
      .map(([, init]) => (init?.body ? (JSON.parse(String(init.body)) as Body) : {}));
  return { fetchMock, calls };
}

function renderEditor(
  session: MeResponse,
  draft: LabProgram | null,
  entry: string | { pathname: string; state: unknown } = draft
    ? `/lab-testing/programs/${draft.id}`
    : '/lab-testing/programs/new',
) {
  pickStationPerson(session);
  const routes: RouteObject[] = [
    {
      element: <RecordingPersonLayout />,
      children: [
        { path: '/lab-testing/programs/new', element: <ProgramEditor draft={null} /> },
        {
          path: '/lab-testing/programs/:programId',
          element: draft ? <ProgramEditor draft={draft} /> : <p>Draft page</p>,
        },
        { path: '/lab-testing/programs', element: <p>Programs list</p> },
      ],
    },
  ];
  const router = createMemoryRouter(routes, { initialEntries: [entry] });
  render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me: session },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router} />
    </SessionContext.Provider>,
  );
  return router;
}

const bar = () => screen.getByRole('region', { name: 'Submit' });

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('Program editor: header and creating the draft', () => {
  it('a new program starts its draft once a project is chosen; no LP number until submitted', async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(program([]));
    const router = renderEditor(me(), null);
    expect(await screen.findByRole('heading', { level: 1, name: 'New lab program' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Choose a project first.' })).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Submit to the lab' })).toBeDisabled();
    await user.type(screen.getByLabelText('Project'), 'DEMO');
    await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }));
    await waitFor(() =>
      expect(router.state.location.pathname).toBe(`/lab-testing/programs/${PROGRAM_ID}`),
    );
    const [created] = calls('POST', '/api/lab-programs');
    expect(created).toMatchObject({ projectId: PROJECT, lines: [{ scope: 'all', source: null }] });
    expect(created).not.toHaveProperty('requestedByUserId');
    expect(screen.queryByText(/LP-\d{4}/)).toBeNull();
  });

  it('STRATA-125: on the LAB station Requested by starts as the recording person and goes with the draft', async () => {
    const user = userEvent.setup();
    const { calls } = fakeServer(program([]));
    renderEditor(LAB, null);
    const person = await screen.findByRole('combobox', { name: /Requested by/ });
    await waitFor(() => expect(person).toHaveValue('AT · Alex Tester'));
    expect(screen.getByText('Recorded as LAB for AT · Alex Tester')).toBeVisible();
    await user.type(screen.getByLabelText('Project'), 'DEMO');
    await user.click(await screen.findByRole('option', { name: /DEMO-2601/ }));
    await waitFor(() => expect(calls('POST', '/api/lab-programs')).toHaveLength(1));
    expect(calls('POST', '/api/lab-programs')[0]).toMatchObject({ requestedByUserId: ALEX });
  });

  it('a draft shows Draft · Lab program, when it was saved, and priority as Normal', async () => {
    fakeServer(program([line(1, { tests: [MC] })]));
    renderEditor(me(), program([line(1, { tests: [MC] })]));
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Draft lab program' }),
    ).toBeVisible();
    expect(screen.getByText('Draft · Lab program')).toBeVisible();
    expect(screen.getByText(/^Draft · saved \d{1,2}:\d{2}/)).toBeVisible();
    expect(screen.getByText('Normal')).toBeVisible();
    expect(screen.getByText('DEMO-2601')).toBeVisible();
    // Progress only: nothing asks for a result value.
    expect(screen.queryByLabelText(/result/i)).toBeNull();
  });

  it('without the lab program permission the editor says so', async () => {
    fakeServer(program([]));
    renderEditor(me({ permissions: ['lab_program.read'] }), null);
    expect(await screen.findByText('You can’t request lab tests')).toBeVisible();
    expect(screen.queryByLabelText('Project')).toBeNull();
  });

  it('units chosen on Inventory start a draft with a Specific line holding them', async () => {
    const UNIT = '00000000-0000-4000-8000-000000000401';
    const { calls } = fakeServer(program([]));
    const router = renderEditor(me(), null, {
      pathname: '/lab-testing/programs/new',
      state: {
        projectId: PROJECT,
        projectLabel: 'DEMO-2601 · Riverbank investigation',
        storageUnitIds: [UNIT],
      },
    });
    await waitFor(() => expect(calls('POST', '/api/lab-programs')).toHaveLength(1));
    expect(calls('POST', '/api/lab-programs')[0]).toMatchObject({
      projectId: PROJECT,
      lines: [{ scope: 'specific', unitIds: [UNIT], source: { kind: 'test_hole', id: HOLE_1 } }],
    });
    await waitFor(() =>
      expect(router.state.location.state).toMatchObject({
        notice: '1 unit from Inventory is ticked on 1 line. Name each sample and choose its tests.',
      }),
    );
  });
});

describe('Program editor: Lines and Grid share one edit state', () => {
  it('ticking a Grid column heading adds the test to every line; Lines shows the same chips and it saves', async () => {
    const user = userEvent.setup();
    const draft = program([line(1, { tests: [MC] }), line(2)]);
    const { calls } = fakeServer(draft);
    renderEditor(me(), draft);
    await screen.findByRole('heading', { level: 1, name: 'Draft lab program' });
    expect(within(bar()).getByText('2 lines · 1 test')).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Add a test to line 2.' })).toBeVisible();
    expect(
      within(screen.getByRole('region', { name: 'Line 2' })).getByText('Add a test to this line.'),
    ).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Submit to the lab' })).toBeDisabled();

    await user.click(screen.getByRole('tab', { name: 'Grid' }));
    const column = screen.getByRole('checkbox', { name: 'Moisture Content on every line' });
    expect(column).toHaveAttribute('data-state', 'indeterminate');
    expect(screen.getByRole('checkbox', { name: 'Moisture Content on line 2' })).not.toBeChecked();
    await user.click(column);
    expect(screen.getByRole('checkbox', { name: 'Moisture Content on line 2' })).toBeChecked();
    expect(within(bar()).getByText('2 lines · 2 tests')).toBeVisible();

    await user.click(screen.getByRole('tab', { name: 'Lines' }));
    const line2 = screen.getByRole('region', { name: 'Line 2' });
    expect(within(line2).getByRole('list', { name: 'Requested tests' })).toHaveTextContent(
      'DEMO-MC · Moisture Content',
    );
    // Saves as you go, with the draft's version.
    await waitFor(() => expect(calls('PATCH', `/${PROGRAM_ID}`)).toHaveLength(1), {
      timeout: 3000,
    });
    expect(calls('PATCH', `/${PROGRAM_ID}`)[0]).toMatchObject({
      version: 3,
      lines: [
        { id: 'line-1', testTypeIds: [MC] },
        { id: 'line-2', testTypeIds: [MC] },
      ],
    });
    // The review after the save shows the units each line covers.
    expect(
      await within(screen.getByRole('region', { name: 'Line 1' })).findByText('BKT-2026-000021'),
    ).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Submit to the lab' })).toBeEnabled();
  });

  it('+ Add test searches the catalogue by group; a template adds active tests and lists retired ones', async () => {
    const user = userEvent.setup();
    const draft = program([line(1)]);
    fakeServer(draft);
    renderEditor(me(), draft);
    const line1 = await screen.findByRole('region', { name: 'Line 1' });
    await user.click(within(line1).getByRole('button', { name: 'Add test to line 1' }));
    const search = await screen.findByLabelText('Find a test');
    expect(screen.getByText('Soils')).toBeVisible();
    // Retired tests are never offered.
    expect(screen.queryByRole('option', { name: /DEMO-OLD/ })).toBeNull();
    await user.type(search, 'atterberg');
    await user.click(screen.getByRole('option', { name: /DEMO-ATT/ }));
    expect(within(line1).getByRole('list', { name: 'Requested tests' })).toHaveTextContent(
      'DEMO-ATT · Atterberg Limits',
    );
    await user.clear(search);
    await user.click(screen.getByRole('option', { name: /Demo pair/ }));
    const chips = within(line1).getByRole('list', { name: 'Requested tests' });
    expect(chips).toHaveTextContent('DEMO-MC · Moisture Content');
    expect(chips).not.toHaveTextContent('DEMO-OLD');
    expect(within(line1).getByRole('status')).toHaveTextContent(
      'Not added because they are retired: DEMO-OLD',
    );
    await user.click(within(line1).getByRole('button', { name: 'Remove DEMO-ATT' }));
    expect(chips).not.toHaveTextContent('DEMO-ATT');
  });

  it('keeps each source exact: a standalone Shelby tube line and a Specific sample with its interval', async () => {
    const draft = program([
      line(1, {
        source: { kind: 'standalone_unit', id: TUBE, label: 'Embankment 03 · ST-2026-000004' },
        tests: [MC],
      }),
      line(2, {
        scope: 'specific',
        sampleLabel: 'G3',
        depthMode: 'interval',
        depthFrom: 1.5,
        depthTo: 3,
        depthUnit: 'm',
        tests: [ATT],
      }),
    ]);
    fakeServer(draft);
    renderEditor(me(), draft);
    const line1 = await screen.findByRole('region', { name: 'Line 1' });
    expect(within(line1).getByLabelText('Sampling source')).toHaveTextContent(
      'Embankment 03 · ST-2026-000004',
    );
    const line2 = screen.getByRole('region', { name: 'Line 2' });
    expect(within(line2).getByRole('radio', { name: 'Specific sample' })).toBeChecked();
    expect(within(line2).getByLabelText('Sample label')).toHaveValue('G3');
    expect(within(line2).getByLabelText('From')).toHaveValue('1.5');
    expect(within(line2).getByLabelText('To')).toHaveValue('3');
    await userEvent.setup().click(screen.getByRole('tab', { name: 'Grid' }));
    const rows = screen.getAllByRole('rowheader');
    expect(rows[0]).toHaveTextContent('Embankment 03 · ST-2026-000004');
    expect(rows[1]).toHaveTextContent('G3 at 1.5–3 m');
  });
});

describe('Program editor: long programs, conflicts and submitting', () => {
  it('over 12 lines a filter bar shows each test hole; problems on hidden lines stay in the bar', async () => {
    const user = userEvent.setup();
    const lines = Array.from({ length: 14 }, (_, i) =>
      line(i + 1, {
        source:
          i < 9
            ? { kind: 'test_hole', id: HOLE_1, label: 'TH26-01' }
            : { kind: 'test_hole', id: HOLE_2, label: 'TH26-02' },
        tests: i === 2 ? [] : [MC],
      }),
    );
    fakeServer(program(lines));
    renderEditor(me(), program(lines));
    const find = await screen.findByRole('group', { name: 'Find a line' });
    expect(within(find).getByRole('radio', { name: /^All\s*14$/ })).toBeChecked();
    await user.click(within(find).getByRole('radio', { name: /^TH26-02\s*5$/ }));
    expect(screen.getAllByRole('region', { name: /^Line \d+$/ })).toHaveLength(5);
    expect(screen.getByText(/Showing 5 of 14 lines: TH26-02 only/)).toBeVisible();
    // Line 3 is hidden, but its problem still shows in the bar.
    expect(within(bar()).getByRole('button', { name: 'Add a test to line 3.' })).toBeVisible();
    await user.click(within(bar()).getByRole('button', { name: 'Add a test to line 3.' }));
    expect(screen.getAllByRole('region', { name: /^Line \d+$/ })).toHaveLength(14);
    await user.type(within(find).getByLabelText('Go to line'), '12{Enter}');
    expect(screen.getByRole('region', { name: 'Line 12' })).toHaveFocus();
  });

  it('a version conflict stops saving: "This program changed. Reload it to continue."', async () => {
    const user = userEvent.setup();
    const draft = program([line(1)]);
    const newer = program([line(1, { tests: [ATT] })], 7);
    fakeServer(draft, {
      patch: () => json(409, { code: 'version_conflict', current: newer }),
    });
    renderEditor(me(), draft);
    await user.click(await screen.findByRole('tab', { name: 'Grid' }));
    await user.click(screen.getByRole('tab', { name: 'Lines' }));
    const line1 = screen.getByRole('region', { name: 'Line 1' });
    await user.click(within(line1).getByRole('button', { name: 'Add test to line 1' }));
    await user.click(await screen.findByRole('option', { name: /DEMO-MC/ }));
    await user.keyboard('{Escape}');
    expect(
      await screen.findByText(
        'This program changed. Reload it to continue.',
        {},
        { timeout: 3000 },
      ),
    ).toBeVisible();
    expect(within(bar()).getByText('Reload first.')).toBeVisible();
    expect(within(bar()).getByRole('button', { name: 'Submit to the lab' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Reload' }));
    expect(
      within(screen.getByRole('region', { name: 'Line 1' })).getByRole('list', {
        name: 'Requested tests',
      }),
    ).toHaveTextContent('DEMO-ATT');
    expect(screen.queryByText('This program changed. Reload it to continue.')).toBeNull();
  });

  it('Submit to the lab sends the reviewed coverage and opens the submitted program', async () => {
    const user = userEvent.setup();
    const draft = program([line(1, { tests: [MC] })]);
    const { calls } = fakeServer(draft);
    const router = renderEditor(me(), draft);
    const submit = await within(bar()).findByRole('button', { name: 'Submit to the lab' });
    expect(within(bar()).getByText('1 line · 1 test')).toBeVisible();
    await user.click(submit);
    await waitFor(() => expect(calls('POST', '/submit')).toHaveLength(1));
    expect(calls('POST', '/submit')[0]).toMatchObject({
      version: 3,
      coverage: [{ lineId: 'line-1', unitIds: ['unit-1'] }],
    });
    expect(router.state.location.state).toMatchObject({ submitted: true });
  });

  it('Delete draft asks first and then discards it', async () => {
    const user = userEvent.setup();
    const draft = program([line(1, { tests: [MC] })]);
    const { calls } = fakeServer(draft);
    const router = renderEditor(me(), draft);
    await user.click(await screen.findByRole('button', { name: 'More actions' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Delete draft' }));
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete this draft?' });
    expect(calls('POST', '/discard')).toHaveLength(0);
    await act(async () => {
      await user.click(within(dialog).getByRole('button', { name: 'Delete draft' }));
    });
    await waitFor(() => expect(router.state.location.pathname).toBe('/lab-testing/programs'));
    expect(calls('POST', '/discard')[0]).toMatchObject({ version: 3 });
  });
});
