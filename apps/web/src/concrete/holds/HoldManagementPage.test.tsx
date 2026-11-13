import type { ConcreteHoldList, ConcreteHoldRow, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { StrataToaster } from '../../components/strata/toast';
import { SessionContext } from '../../session/context';
import { blockedReason, statusFilterOf } from './hold-actions';

// Concrete → Holds (MM-V2-C26 rules; STRATA-95 part B screen). Fictional projects and people.

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-000000000102',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'test',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['inventory.read', 'concrete_specimen.dispose_record'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000201',
  projectNumber: 'DEMO-2601',
  name: 'Example tower',
};

const row = (n: number, overrides: Partial<ConcreteHoldRow> = {}): ConcreteHoldRow => ({
  specimenId: `00000000-0000-4000-8000-00000000060${n}`,
  setId: `00000000-0000-4000-8000-00000000050${n}`,
  fieldReportId: '00000000-0000-4000-8000-000000000401',
  project: PROJECT,
  letter: 'D',
  identity: { temporaryId: null, permanentId: `26-0${n}D` },
  holdKind: 'ordinary',
  assignedAge: 'HOLD',
  castingDate: '2026-11-07',
  holdExpiresOn: '2027-01-02',
  status: 'held',
  failureReason: null,
  disposal: null,
  actions: { scheduleTest: true, authorizeDisposal: true, recordDisposal: false },
  version: 1,
  ...overrides,
});

const FAILED = row(3, {
  holdKind: 'failed',
  assignedAge: 28,
  holdExpiresOn: null,
  failureReason: 'Low 28-day result',
  actions: { scheduleTest: false, authorizeDisposal: false, recordDisposal: false },
});
const OPEN_ROWS = [row(1), row(2, { status: 'review_due', holdExpiresOn: '2026-12-01' }), FAILED];
const AUTHORIZED = row(4, {
  status: 'disposal_authorized',
  actions: { scheduleTest: false, authorizeDisposal: false, recordDisposal: true },
  disposal: {
    reason: 'Spare cylinders not needed',
    authorizedAt: '2026-12-01T16:00:00.000Z',
    authorizedBy: { userId: 'x', initials: 'PE', name: 'Pat Example' },
    disposedAt: null,
    disposedBy: null,
    recordedAt: null,
  },
});

const list = (
  rows: ConcreteHoldRow[],
  status: ConcreteHoldList['status'] = 'open',
): ConcreteHoldList => ({
  today: '2026-12-05',
  kind: 'all',
  status,
  counts: { open: 3, disposal_authorized: 1, disposed: 0, all: 4 },
  total: rows.length,
  page: 1,
  pageSize: 100,
  rows,
  projects: [PROJECT],
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function renderPage(
  onPost: (url: string, body: Record<string, unknown>) => Response,
  path = '/lab-testing/concrete/holds',
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.startsWith('/api/concrete/holds')) {
      const params = new URL(url, 'http://x').searchParams;
      const status = params.get('status');
      const kind = params.get('kind');
      if (status === 'disposal_authorized')
        return json(200, list([AUTHORIZED], 'disposal_authorized'));
      const rows =
        kind === 'failed'
          ? [FAILED]
          : kind === 'ordinary'
            ? OPEN_ROWS.filter((r) => r.holdKind === 'ordinary')
            : OPEN_ROWS;
      return json(200, list(rows));
    }
    if (method === 'POST') return onPost(url, JSON.parse(String(init?.body)));
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
      <StrataToaster />
    </SessionContext.Provider>,
  );
  return fetchMock;
}

const holdsTable = async () =>
  within(await screen.findByRole('region', { name: 'HOLD specimens' }));
const rowOf = (label: string) =>
  screen.getByRole('checkbox', { name: `Select ${label}` }).closest('tr')! as HTMLElement;

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('hold actions (pure)', () => {
  it('reads the status filter from one chip, open by default', () => {
    expect(statusFilterOf([])).toBe('open');
    expect(statusFilterOf(['project:x', 'status:disposed'])).toBe('disposed');
    expect(statusFilterOf(['status:disposal_authorized'])).toBe('disposal_authorized');
  });

  it('names why an action is not offered from what the server said about each row', () => {
    expect(blockedReason('schedule_test', [row(1)])).toBeNull();
    expect(blockedReason('schedule_test', [row(1), FAILED])).toBe(
      '26-03D is a failed-specimen hold: no test can be scheduled.',
    );
    expect(blockedReason('record_disposal', [row(1), FAILED])).toBe(
      'None is authorized for disposal yet.',
    );
    expect(blockedReason('record_disposal', [row(1), AUTHORIZED])).toBe(
      '26-01D is not authorized for disposal yet.',
    );
    expect(blockedReason('authorize_disposal', [AUTHORIZED])).toBe(
      '26-04D is already authorized for disposal.',
    );
    // A technician: the server offers nothing on open holds.
    const tech = row(1, {
      actions: { scheduleTest: false, authorizeDisposal: false, recordDisposal: false },
    });
    expect(blockedReason('authorize_disposal', [tech])).toBe(
      'Authorizing disposal needs the project lead or a Lab Manager.',
    );
  });
});

describe('Concrete holds page', () => {
  it('opens on open holds only, in the four states, with the kind tabs counted', async () => {
    const fetchMock = renderPage(() => json(500, {}));
    expect(
      await screen.findByRole('heading', { name: 'Concrete holds', level: 1 }),
    ).toBeInTheDocument();
    const table = await holdsTable();
    expect(await table.findByRole('link', { name: '26-01D' })).toHaveAttribute(
      'href',
      '/concrete/specimens/00000000-0000-4000-8000-000000000501?letter=D',
    );
    expect(within(rowOf('26-01D')).getByText('Inside the hold period')).toBeInTheDocument();
    expect(within(rowOf('26-02D')).getByText('Hold period has ended')).toBeInTheDocument();
    expect(within(rowOf('26-03D')).getByText('No expiry')).toBeInTheDocument();
    expect(within(rowOf('26-03D')).getByText('Failed-specimen hold')).toBeInTheDocument();
    const urls = fetchMock.mock.calls.map(([u]) => String(u)).filter((u) => u.includes('/holds?'));
    expect(urls.length).toBeGreaterThan(0);
    for (const url of urls) expect(url).toContain('status=open');
    expect(screen.getByRole('tab', { name: /All holds 3/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByRole('tab', { name: /Failed-specimen holds/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /Ordinary HOLD/ })).toBeInTheDocument();
    expect(screen.getByText(/Open holds only\./)).toBeInTheDocument();
    // No chip while on the default open view.
    expect(screen.queryByRole('group', { name: 'Active sort and filters' })).toBeNull();
  });

  it('shows Disposal authorized as a filter chip and asks the server for it', async () => {
    const fetchMock = renderPage(
      () => json(500, {}),
      '/lab-testing/concrete/holds?filter=status:disposal_authorized',
    );
    const table = await holdsTable();
    expect(await table.findByRole('link', { name: '26-04D' })).toBeInTheDocument();
    expect(within(rowOf('26-04D')).getByText('Disposal authorized')).toBeInTheDocument();
    const chips = screen.getByRole('group', { name: 'Active sort and filters' });
    expect(
      within(chips).getByRole('button', { name: 'Clear Disposal authorized' }),
    ).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([u]) => String(u).includes('status=disposal_authorized')),
    ).toBe(true);
    expect(screen.getByText(/Filtered to disposal authorized/)).toBeInTheDocument();
  });

  it('keeps all three actions visible and disables those not allowed, with the reason', async () => {
    renderPage(() => json(500, {}));
    await (await holdsTable()).findByRole('link', { name: '26-01D' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-03D' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(within(bar).getByText('2 specimens selected')).toBeInTheDocument();
    const schedule = within(bar).getByRole('button', { name: 'Schedule test' });
    const authorize = within(bar).getByRole('button', { name: 'Authorize disposal' });
    const record = within(bar).getByRole('button', { name: 'Record disposal' });
    expect(schedule).toBeDisabled();
    expect(authorize).toBeDisabled();
    expect(record).toBeDisabled();
    expect(schedule).toHaveAccessibleDescription(
      /Each action is offered when every selected specimen allows it\..*26-03D is a failed-specimen hold: no test can be scheduled\./,
    );
    expect(record).toHaveAccessibleDescription(/None is authorized for disposal yet\./);
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-03D' }));
    expect(schedule).toBeEnabled();
    expect(authorize).toBeEnabled();
    expect(record).toBeDisabled();
  });

  it('bulk Schedule test asks for the age and a reason and lists each new target first', async () => {
    const posts: [string, Record<string, unknown>][] = [];
    renderPage((url, body) => {
      posts.push([url, body]);
      return json(200, {
        commandId: 'c1',
        rows: [row(1, { assignedAge: 56 }), row(2, { assignedAge: 56 })],
      });
    });
    await (await holdsTable()).findByRole('link', { name: '26-01D' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-02D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Schedule test' }));
    const dialog = screen.getByRole('dialog', { name: 'Schedule test: 2 specimens' });
    await userEvent.type(within(dialog).getByLabelText('Test age (days)'), '56');
    const changes = within(dialog).getByRole('list', { name: 'Specimens and changes' });
    // 7 Nov 2026 + 56 days = 2 Jan 2027.
    expect(within(changes).getAllByText('HOLD → 56 d, target 2027-01-02')).toHaveLength(2);
    // A reason is required: nothing is sent without one.
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Schedule test for 2 specimens' }),
    );
    expect(within(dialog).getByText('A reason is required')).toBeInTheDocument();
    expect(posts).toEqual([]);
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Engineer wants a 56-day break');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Schedule test for 2 specimens' }),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/concrete/holds/schedule-test');
    expect(posts[0]![1]).toMatchObject({
      newAge: 56,
      reason: 'Engineer wants a 56-day break',
      items: [
        { specimenId: OPEN_ROWS[0]!.specimenId, version: 1 },
        { specimenId: OPEN_ROWS[1]!.specimenId, version: 1 },
      ],
    });
    expect(await screen.findByText('2 specimens scheduled for testing.')).toBeInTheDocument();
  });

  it('shows the server’s per-specimen problems when nothing was changed', async () => {
    renderPage(() =>
      json(409, {
        code: 'not_eligible',
        problems: [{ specimenId: OPEN_ROWS[0]!.specimenId, code: 'disposal_authorized' }],
      }),
    );
    await (await holdsTable()).findByRole('link', { name: '26-01D' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Authorize disposal' }));
    const dialog = screen.getByRole('dialog', { name: 'Authorize disposal: 1 specimen' });
    expect(within(dialog).getByText('HOLD → Disposal authorized')).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText('Reason'), 'Spare cylinders not needed');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Authorize disposal of 1 specimen' }),
    );
    expect(await within(dialog).findByText('Already authorized for disposal')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Nothing was changed');
  });

  it('Record disposal asks when, then confirms with every ID listed', async () => {
    const posts: [string, Record<string, unknown>][] = [];
    renderPage((url, body) => {
      posts.push([url, body]);
      return json(200, { commandId: 'c2', rows: [{ ...AUTHORIZED, status: 'disposed' }] });
    }, '/lab-testing/concrete/holds?filter=status:disposal_authorized');
    await (await holdsTable()).findByRole('link', { name: '26-04D' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-04D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Record disposal' }));
    const details = screen.getByRole('dialog', { name: 'Record disposal: 1 specimen' });
    expect(within(details).getByText('Recorded as removed by you.')).toBeInTheDocument();
    await userEvent.click(within(details).getByRole('button', { name: 'Continue' }));
    const confirm = await screen.findByRole('alertdialog', {
      name: 'Record disposal of 1 specimen?',
    });
    const ids = within(confirm).getByRole('region', { name: '1 specimen' });
    expect(within(ids).getByText('26-04D')).toBeInTheDocument();
    expect(within(ids).getByText(/authorized 2026-12-01 by Pat Example/)).toBeInTheDocument();
    expect(posts).toEqual([]);
    await userEvent.click(
      within(confirm).getByRole('button', { name: 'Record disposal of 1 specimen' }),
    );
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/concrete/disposal/record');
    expect(posts[0]![1]).toMatchObject({ specimenIds: [AUTHORIZED.specimenId] });
    expect(posts[0]![1]).not.toHaveProperty('performedByUserId');
    expect(await screen.findByText('1 specimen recorded as disposed.')).toBeInTheDocument();
  });
});
