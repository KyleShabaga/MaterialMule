import type {
  ConcreteTestResult,
  ConcreteTestingTable,
  ConcreteTestingTableResult,
  ConcreteTestingTableRow,
  MeResponse,
} from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';
import { stationSessionKey, storeRecordingPerson } from '../../session/recording-person-store';
import { planSave } from './row-state';

// Concrete Lab → Testing table (MM-V2-C23): row states, tester attribution and corrections.
// Fictional projects and people only.

const TB = {
  id: '00000000-0000-4000-8000-000000000110',
  displayName: 'Taylor Bench',
  initials: 'TB',
};
const LM = {
  id: '00000000-0000-4000-8000-000000000103',
  displayName: 'Lee Manager',
  initials: 'LM',
};

const ME: MeResponse = {
  id: TB.id,
  displayName: TB.displayName,
  initials: TB.initials,
  accountType: 'test',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read', 'concrete_test.enter'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};

const PROJECT_ID = '00000000-0000-4000-8000-000000000201';

const row = (n: number, letter: string, extra: Partial<ConcreteTestingTableRow> = {}) =>
  ({
    specimenId: `00000000-0000-4000-8000-0000000006${String(n).padStart(2, '0')}`,
    setId: `00000000-0000-4000-8000-0000000005${String(n).padStart(2, '0')}`,
    fieldReportId: '00000000-0000-4000-8000-000000000401',
    projectId: PROJECT_ID,
    letter,
    identity: { temporaryId: null, permanentId: `26-0${Math.ceil(n / 2)}${letter}` },
    permanentNumber: Math.ceil(n / 2),
    assignedAge: 28,
    castingDate: '2026-11-02',
    targetDate: '2026-11-30',
    daysOverdue: null,
    actualAge: 28,
    reportState: 'submitted',
    specifiedStrengthMpa: 25,
    flags: [],
    result: null,
    complete: false,
    ...extra,
  }) satisfies ConcreteTestingTableRow;

const SAVED: ConcreteTestingTableResult = {
  id: '00000000-0000-4000-8000-000000000701',
  attemptNo: 1,
  version: 1,
  testedOn: '2026-11-30',
  tester: { userId: LM.id, initials: 'LM', name: LM.displayName },
  maxLoad: 400,
  heightReadings: [203.2],
  diameterReadings: [101.6],
  units: { load: 'kN', dimension: 'mm', provisional: true },
  enteredAt: '2026-11-30T15:00:00.000Z',
  calculation: null,
  strengthFlags: [],
  excluded: false,
};

const table = (rows: ConcreteTestingTableRow[], includeOverdue = false): ConcreteTestingTable => ({
  today: '2026-11-30',
  includeOverdue,
  total: rows.length,
  completed: rows.filter((r) => r.complete).length,
  truncated: false,
  projects: [{ projectId: PROJECT_ID, projectNumber: 'DEMO-2601', projectName: 'Example tower' }],
  groups: [
    { projectId: PROJECT_ID, projectNumber: 'DEMO-2601', projectName: 'Example tower', rows },
  ],
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/** The C07 answer for a save of `body` onto `specimenId`. */
function savedResult(
  specimenId: string,
  resultId: string,
  body: Record<string, unknown>,
  base: Partial<ConcreteTestResult> = {},
): ConcreteTestResult {
  return {
    id: resultId,
    specimenId,
    projectId: PROJECT_ID,
    attemptNo: 1,
    state: 'draft',
    testedOn: (body.testedOn as string | undefined) ?? base.testedOn ?? null,
    tester: base.tester ?? { userId: TB.id, initials: 'TB', name: TB.displayName },
    maxLoad: (body.maxLoad as number | undefined) ?? base.maxLoad ?? null,
    heightReadings: (body.heightReadings as number[] | undefined) ?? base.heightReadings ?? [],
    diameterReadings:
      (body.diameterReadings as number[] | undefined) ?? base.diameterReadings ?? [],
    units: { load: 'kN', dimension: 'mm', provisional: true },
    notes: null,
    testingMachineId: null,
    calculationMethod: 'compressive_strength',
    calculationMethodVersion: 'P1',
    calculation: base.calculation ?? null,
    reportVersionId: null,
    createdAt: '2026-11-30T15:00:00.000Z',
    updatedAt: '2026-11-30T15:05:00.000Z',
    version: ((body.version as number) ?? 0) + 1,
    revisions: [],
  };
}

type Put = { url: string; body: Record<string, unknown> };

function renderPage(
  data: ConcreteTestingTable | ((url: URL) => ConcreteTestingTable),
  onPut: (put: Put) => Response,
  me: MeResponse = ME,
  reads: string[] = [],
  path = '/concrete/testing',
) {
  const puts: Put[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? 'GET').toUpperCase();
      if (url.startsWith('/api/staff/active')) return json(200, [TB, LM]);
      if (url.startsWith('/api/concrete/testing-table')) {
        reads.push(url);
        return json(200, typeof data === 'function' ? data(new URL(url, 'http://test')) : data);
      }
      if (method === 'PUT') {
        const put = { url, body: JSON.parse(String(init?.body)) as Record<string, unknown> };
        puts.push(put);
        return onPut(put);
      }
      return json(404, {});
    }),
  );
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
    </SessionContext.Provider>,
  );
  return puts;
}

const specimenOf = (url: string) => url.split('/specimens/')[1]!.split('/')[0]!;
const resultOf = (url: string) => url.split('/test-results/')[1]!;
const ok = (put: Put, base?: Partial<ConcreteTestResult>) =>
  json(200, {
    created: put.body.version === 0,
    result: savedResult(specimenOf(put.url), resultOf(put.url), put.body, base),
  });

const statusOf = (label: string) =>
  screen.getByRole('rowheader', { name: label }).closest('tr')!.querySelector('.testing-status')!;

beforeEach(() => {
  // jsdom lacks pointer capture; Radix Select and menus call it.
  const proto = HTMLElement.prototype as unknown as Record<string, unknown>;
  proto.hasPointerCapture ??= () => false;
  proto.releasePointerCapture ??= () => {};
  try {
    window.localStorage.clear();
  } catch {
    // ignore
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Testing table in Strata (STRATA-95, STRATA-125)', () => {
  it('opens just the specimens picked in Breaks, with a way back to all due', async () => {
    const reads: string[] = [];
    const ids = [row(1, 'B').specimenId, row(2, 'C').specimenId];
    renderPage(
      table([row(1, 'B'), row(2, 'C')]),
      (put) => ok(put),
      ME,
      reads,
      `/concrete/testing?specimenIds=${ids.join(',')}`,
    );
    expect(await screen.findByRole('rowheader', { name: '26-01B' })).toBeInTheDocument();
    expect(new URL(reads[0]!, 'http://test').searchParams.get('specimenIds')).toBe(ids.join(','));
    expect(screen.getByText('Showing 2 selected specimens from Breaks')).toBeVisible();
    expect(screen.getByRole('link', { name: 'Show all due' })).toHaveAttribute(
      'href',
      '/concrete/testing',
    );
    // A selection isn't narrowed by project or date.
    expect(screen.queryByRole('combobox', { name: 'Project' })).toBeNull();
    expect(screen.queryByRole('checkbox', { name: 'Include overdue' })).toBeNull();
    expect(screen.getByRole('checkbox', { name: 'Hide completed' })).toBeInTheDocument();
  });

  it('arrow keys move between cells; units sit on a second header line', async () => {
    renderPage(table([row(1, 'B'), row(2, 'C')]), (put) => ok(put));
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    expect(screen.getAllByRole('columnheader', { name: 'Max load (kN)' })).toHaveLength(1);
    await userEvent.click(load);
    await userEvent.keyboard('{ArrowDown}');
    expect(screen.getByRole('textbox', { name: 'Max load 26-01C' })).toHaveFocus();
    await userEvent.keyboard('{ArrowUp}');
    expect(load).toHaveFocus();
    // Empty cell: the caret is at both ends, so ← and → leave it.
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('textbox', { name: 'Height 26-01B' })).toHaveFocus();
    await userEvent.keyboard('{ArrowLeft}');
    expect(load).toHaveFocus();
    // Inside typed text, ← moves the caret, not the focus.
    await userEvent.keyboard('412{ArrowLeft}');
    expect(load).toHaveFocus();
  });

  it('on a LAB station, Tested by is the person picked with the station chip', async () => {
    const LAB: MeResponse = {
      ...ME,
      id: '00000000-0000-4000-8000-000000000199',
      displayName: 'LAB',
      initials: null,
      accountType: 'shared_lab',
      roles: [],
    };
    storeRecordingPerson(stationSessionKey(LAB), {
      id: LM.id,
      displayName: LM.displayName,
      initials: LM.initials,
      roleLine: 'Lab Manager',
    });
    const puts = renderPage(table([row(1, 'B')]), (put) => ok(put), LAB);
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    expect(screen.getByLabelText('Tested by')).toHaveTextContent('Lee Manager (LM)');
    expect(screen.queryByRole('combobox', { name: /Tested by/ })).toBeNull();
    await userEvent.click(load);
    await userEvent.keyboard('400');
    await userEvent.tab();
    await userEvent.keyboard('203.2');
    await userEvent.tab();
    await userEvent.keyboard('101.6');
    await userEvent.tab();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ testerUserId: LM.id, maxLoad: 400 });
  });
});

describe('Testing table (MM-V2-C23)', () => {
  it('shows the progress and sorted rows, and saves a row when focus leaves it', async () => {
    const puts = renderPage(table([row(1, 'B'), row(2, 'C')]), (put) => ok(put));
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    expect(screen.getByText('0 of 2 completed')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Tested by/ })).toHaveTextContent(
        'TB · Taylor Bench',
      ),
    );
    expect(within(statusOf('26-01B') as HTMLElement).getByText('Not entered')).toBeInTheDocument();

    await userEvent.click(load);
    await userEvent.keyboard('412.5');
    expect(within(statusOf('26-01B') as HTMLElement).getByText('Not saved')).toBeInTheDocument();
    await userEvent.tab(); // height, same row: nothing sent yet
    expect(puts).toHaveLength(0);
    await userEvent.keyboard('203.2');
    await userEvent.tab();
    await userEvent.keyboard('101.6 101.8');
    // Enter moves down the column to the next row, which saves this one.
    await userEvent.keyboard('{Enter}');
    expect(screen.getByRole('textbox', { name: 'Diameter 26-01C' })).toHaveFocus();
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({
      version: 0,
      testedOn: '2026-11-30',
      testerUserId: TB.id,
      maxLoad: 412.5,
      heightReadings: [203.2],
      diameterReadings: [101.6, 101.8],
    });
    expect(puts[0]!.body).not.toHaveProperty('reason');
    await waitFor(() =>
      expect(within(statusOf('26-01B') as HTMLElement).getByText('Saved')).toBeInTheDocument(),
    );
    expect(screen.getByText('1 of 2 completed')).toBeInTheDocument();
  });

  it('saves an incomplete row without counting it as complete', async () => {
    const puts = renderPage(table([row(1, 'B')]), (put) => ok(put));
    await userEvent.click(await screen.findByRole('textbox', { name: 'Max load 26-01B' }));
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Tested by/ })).toHaveTextContent(
        'TB · Taylor Bench',
      ),
    );
    await userEvent.keyboard('300');
    await userEvent.click(document.body);
    await waitFor(() => expect(puts).toHaveLength(1));
    await waitFor(() =>
      expect(
        within(statusOf('26-01B') as HTMLElement).getByText('Saved · incomplete'),
      ).toBeInTheDocument(),
    );
    expect(screen.getByText('0 of 1 completed')).toBeInTheDocument();
  });

  it('AC2: a failed save shows Failed, keeps the typed values and retries with the same key', async () => {
    let fail = true;
    const puts = renderPage(table([row(1, 'B')]), (put) =>
      fail ? json(503, { code: 'unavailable' }) : ok(put),
    );
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Tested by/ })).toHaveTextContent(
        'TB · Taylor Bench',
      ),
    );
    await userEvent.click(load);
    await userEvent.keyboard('412.5');
    await userEvent.click(document.body);
    await waitFor(() =>
      expect(within(statusOf('26-01B') as HTMLElement).getByText('Failed')).toBeInTheDocument(),
    );
    expect(load).toHaveValue('412.5');
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry 26-01B' }));
    await waitFor(() =>
      expect(within(statusOf('26-01B') as HTMLElement).getByText(/Saved/)).toBeInTheDocument(),
    );
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body.idempotencyKey).toBe(puts[0]!.body.idempotencyKey);
    expect(resultOf(puts[1]!.url)).toBe(resultOf(puts[0]!.url));
  });

  it('AC3: changing a saved value needs a reason; without one nothing is sent and the edit stays', async () => {
    const saved = row(1, 'B', { result: SAVED, complete: true });
    const puts = renderPage(table([saved]), (put) => ok(put, { ...SAVED, tester: SAVED.tester }));
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    expect(load).toHaveValue('400');
    await userEvent.tripleClick(load);
    await userEvent.keyboard('410');
    const reason = screen.getByRole('textbox', { name: 'Correction reason 26-01B' });
    await userEvent.click(document.body);
    expect(
      within(statusOf('26-01B') as HTMLElement).getByText('Reason needed'),
    ).toBeInTheDocument();
    expect(puts).toHaveLength(0);
    expect(load).toHaveValue('410');

    await userEvent.click(reason);
    await userEvent.keyboard('Misread the gauge');
    await userEvent.click(document.body);
    await waitFor(() => expect(puts).toHaveLength(1));
    expect(puts[0]!.body).toMatchObject({ version: 1, maxLoad: 410, reason: 'Misread the gauge' });
    // AC1: an existing attempt never sends a tester, so it keeps the one it was saved with.
    expect(puts[0]!.body).not.toHaveProperty('testerUserId');
    await waitFor(() =>
      expect(within(statusOf('26-01B') as HTMLElement).getByText('Saved')).toBeInTheDocument(),
    );
  });

  it('AC1: changing the page tester leaves saved rows with their own tester', async () => {
    renderPage(table([row(1, 'B', { result: SAVED, complete: true }), row(2, 'C')]), (put) =>
      ok(put),
    );
    const tester = await screen.findByRole('combobox', { name: /Tested by/ });
    await waitFor(() => expect(tester).toHaveTextContent('TB · Taylor Bench'));
    const first = screen.getByRole('rowheader', { name: '26-01B' }).closest('tr')!;
    expect(within(first).getByText('LM')).toBeInTheDocument();
    await userEvent.click(tester);
    await userEvent.click(await screen.findByRole('option', { name: 'LM · Lee Manager' }));
    await userEvent.click(tester);
    await userEvent.click(await screen.findByRole('option', { name: 'TB · Taylor Bench' }));
    expect(within(first).getByText('LM')).toBeInTheDocument();
  });

  it('Hide completed hides complete rows; overdue rows are flagged and link to details', async () => {
    renderPage(
      table([
        row(1, 'A', {
          targetDate: '2026-11-09',
          assignedAge: 7,
          daysOverdue: 21,
          flags: ['overdue'],
        }),
        row(2, 'B', { result: SAVED, complete: true }),
      ]),
      (put) => ok(put),
    );
    await screen.findByRole('rowheader', { name: '26-01A' });
    expect(screen.getByText('Overdue 21 d')).toBeInTheDocument();
    expect(screen.getByText('target 2026-11-09')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Details for 26-01A' })).toHaveAttribute(
      'href',
      '/concrete/specimens/00000000-0000-4000-8000-000000000501',
    );
    await userEvent.click(screen.getByRole('checkbox', { name: 'Hide completed' }));
    expect(screen.queryByRole('rowheader', { name: '26-01B' })).not.toBeInTheDocument();
    expect(screen.getByRole('rowheader', { name: '26-01A' })).toBeInTheDocument();
  });

  it('hides a column; strength is blank until the entry is complete', async () => {
    renderPage(table([row(1, 'B')]), (put) => ok(put));
    await screen.findByRole('rowheader', { name: '26-01B' });
    expect(screen.getAllByRole('columnheader', { name: 'Strength (MPa)' })).toHaveLength(1);
    expect(screen.getByLabelText('Strength 26-01B: not calculated')).toHaveTextContent('—');
    await userEvent.click(screen.getByRole('button', { name: 'Columns' }));
    await userEvent.click(await screen.findByRole('menuitemcheckbox', { name: 'Strength' }));
    // The menu stays open for more changes; Escape closes it.
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('columnheader', { name: 'Strength (MPa)' })).not.toBeInTheDocument();
    expect(screen.queryByRole('columnheader', { name: 'Height (mm)' })).toBeInTheDocument();
  });

  it('MM-V2-C24: a complete entry shows its stored strength, method version and flags', async () => {
    const calculated: ConcreteTestingTableResult = {
      ...SAVED,
      calculation: {
        methodVersion: 'P1',
        provisional: true,
        meanDiameter: 101.6,
        meanHeight: 203.2,
        areaRaw: 8107.32,
        area: 8107,
        ldRatio: 2,
        correctionFactor: 1,
        strengthRaw: 49.338,
        strength: 49.3,
        flags: ['diameter_spread'],
      },
      strengthFlags: ['diameter_spread'],
    };
    renderPage(table([row(1, 'B', { result: calculated, complete: true })]), (put) => ok(put));
    const cell = await screen.findByLabelText('Strength 26-01B: 49.3 MPa');
    expect(cell).toHaveTextContent('49.3');
    expect(cell).toHaveTextContent('P1 (provisional)');
    expect(cell).toHaveAttribute(
      'title',
      expect.stringContaining('Calculation method P1 (provisional)'),
    );
    expect(screen.getByText('Diameters differ by more than 2%')).toBeVisible();
  });

  it('keeps a failed overdue edit and its retry key while Include overdue is off', async () => {
    const overdue = row(2, 'A', {
      targetDate: '2026-11-09',
      assignedAge: 7,
      daysOverdue: 21,
      flags: ['overdue'],
    });
    let fail = true;
    const puts = renderPage(
      (url) =>
        url.searchParams.get('includeOverdue') === 'true'
          ? table([row(1, 'B'), overdue], true)
          : table([row(1, 'B')]),
      (put) => (fail ? json(503, { code: 'unavailable' }) : ok(put)),
    );
    await screen.findByRole('rowheader', { name: '26-01B' });
    await waitFor(() =>
      expect(screen.getByRole('combobox', { name: /Tested by/ })).toHaveTextContent(
        'TB · Taylor Bench',
      ),
    );
    const includeOverdue = screen.getByRole('checkbox', { name: 'Include overdue' });
    await userEvent.click(includeOverdue);
    await userEvent.click(await screen.findByRole('textbox', { name: 'Max load 26-01A' }));
    await userEvent.keyboard('388.1');
    await userEvent.click(document.body);
    await waitFor(() =>
      expect(within(statusOf('26-01A') as HTMLElement).getByText('Failed')).toBeInTheDocument(),
    );

    await userEvent.click(includeOverdue);
    await waitFor(() =>
      expect(screen.queryByRole('rowheader', { name: '26-01A' })).not.toBeInTheDocument(),
    );
    await userEvent.click(includeOverdue);
    expect(await screen.findByRole('textbox', { name: 'Max load 26-01A' })).toHaveValue('388.1');
    expect(within(statusOf('26-01A') as HTMLElement).getByText('Failed')).toBeInTheDocument();
    fail = false;
    await userEvent.click(screen.getByRole('button', { name: 'Retry 26-01A' }));
    await waitFor(() =>
      expect(within(statusOf('26-01A') as HTMLElement).getByText(/Saved/)).toBeInTheDocument(),
    );
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body.idempotencyKey).toBe(puts[0]!.body.idempotencyKey);
  });

  it('lists every project with breaks and reads the chosen one from the server', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000202';
    const projects = [
      { projectId: PROJECT_ID, projectNumber: 'DEMO-2601', projectName: 'Example tower' },
      { projectId: OTHER, projectNumber: 'DEMO-2602', projectName: 'Example bridge' },
    ];
    const otherRow = row(3, 'A', {
      projectId: OTHER,
      identity: { temporaryId: null, permanentId: '26-09A' },
    });
    const reads: string[] = [];
    renderPage(
      (url) =>
        url.searchParams.get('projectId') === OTHER
          ? {
              ...table([otherRow]),
              projects,
              groups: [
                {
                  projectId: OTHER,
                  projectNumber: 'DEMO-2602',
                  projectName: 'Example bridge',
                  rows: [otherRow],
                },
              ],
            }
          : // The first project fills the row limit; the second has no rows in this window.
            { ...table([row(1, 'B')]), truncated: true, projects },
      (put) => ok(put),
      ME,
      reads,
    );
    await screen.findByRole('rowheader', { name: '26-01B' });
    await userEvent.click(screen.getByRole('combobox', { name: 'Project' }));
    await userEvent.click(await screen.findByRole('option', { name: 'DEMO-2602' }));
    expect(await screen.findByRole('rowheader', { name: '26-09A' })).toBeInTheDocument();
    expect(screen.queryByRole('rowheader', { name: '26-01B' })).not.toBeInTheDocument();
    expect(reads.at(-1)).toContain(`projectId=${OTHER}`);
  });

  it('read-only for someone without concrete_test.enter', async () => {
    renderPage(table([row(1, 'B')]), (put) => ok(put), {
      ...ME,
      roles: [],
      permissions: ['inventory.read'],
    });
    const load = await screen.findByRole('textbox', { name: 'Max load 26-01B' });
    expect(load).toHaveAttribute('readonly');
    expect(screen.getByText(/You can view this table/)).toBeInTheDocument();
  });
});

describe('planSave', () => {
  const context = { today: '2026-11-30', pageTesterId: TB.id, sharedStation: false };
  const edit = (
    values: Partial<Record<'testedOn' | 'maxLoad' | 'height' | 'diameter' | 'reason', string>>,
  ) => ({
    testedOn: '',
    maxLoad: '',
    height: '',
    diameter: '',
    reason: '',
    ...values,
  });

  it('refuses invalid cells and a new row without a tester', () => {
    expect(planSave({ row: row(1, 'B'), edit: edit({}) }, context)).toEqual({ kind: 'none' });
    expect(planSave({ row: row(1, 'B'), edit: edit({ maxLoad: 'abc' }) }, context)).toMatchObject({
      kind: 'invalid',
      field: 'maxLoad',
    });
    expect(
      planSave({ row: row(1, 'B'), edit: edit({ testedOn: '2026-02-30', maxLoad: '1' }) }, context),
    ).toMatchObject({ kind: 'invalid', field: 'testedOn' });
    expect(
      planSave(
        { row: row(1, 'B'), edit: edit({ maxLoad: '1' }) },
        { ...context, pageTesterId: null },
      ),
    ).toMatchObject({ kind: 'invalid', field: 'tester' });
  });

  it('fills an empty saved field as entry (no reason) and names the LAB station’s person', () => {
    const partial = row(1, 'B', { result: { ...SAVED, heightReadings: [] } });
    const plan = planSave(
      {
        row: partial,
        edit: edit({ testedOn: '2026-11-30', maxLoad: '400', height: '203', diameter: '101.6' }),
      },
      { ...context, sharedStation: true },
    );
    expect(plan).toEqual({
      kind: 'send',
      body: { version: 1, heightReadings: [203], enteredByUserId: TB.id },
    });
  });
});
