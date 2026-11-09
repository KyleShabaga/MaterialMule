import type { ConcreteHoldList, ConcreteHoldRow, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// Lab Testing → HOLD (MM-V2-C26). Fictional projects and people only.

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

const ROWS = [
  row(1),
  row(2, { status: 'review_due' }),
  row(3, {
    holdKind: 'failed',
    assignedAge: 28,
    holdExpiresOn: null,
    failureReason: 'Low 28-day result',
    actions: { scheduleTest: false, authorizeDisposal: false, recordDisposal: false },
  }),
];

const list = (rows: ConcreteHoldRow[]): ConcreteHoldList => ({
  today: '2026-12-05',
  kind: 'all',
  status: 'open',
  counts: { open: rows.length, disposal_authorized: 0, disposed: 0, all: rows.length },
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

function renderPage(onPost: (url: string, body: Record<string, unknown>) => Response) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    if (method === 'GET' && url.startsWith('/api/concrete/holds')) return json(200, list(ROWS));
    if (method === 'POST') return onPost(url, JSON.parse(String(init?.body)));
    return json(404, {});
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/lab-testing/concrete/holds'] });
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
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('HOLD management (MM-V2-C26)', () => {
  it('tells ordinary and failed holds apart and enables only what the selection allows', async () => {
    renderPage(() => json(500, {}));
    const table = await screen.findByRole('table', { name: 'HOLD specimens' });
    expect(within(table).getByText('26-01D')).toBeInTheDocument();
    expect(within(table).getByText('Failed-specimen hold')).toBeInTheDocument();
    expect(within(table).getByText('Review due')).toBeInTheDocument();
    expect(within(table).getByText('No expiry')).toBeInTheDocument();
    const schedule = screen.getByRole('button', { name: 'Schedule test' });
    expect(schedule).toBeDisabled();
    // The failed hold isn't selectable for this Lab Manager (no project grant).
    expect(screen.getByRole('checkbox', { name: 'Select 26-03D' })).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    expect(schedule).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Record disposal' })).toBeDisabled();
  });

  it('bulk Schedule test confirms each specimen and its new target before sending', async () => {
    const posts: [string, Record<string, unknown>][] = [];
    renderPage((url, body) => {
      posts.push([url, body]);
      return json(200, {
        commandId: 'c1',
        rows: [row(1, { assignedAge: 56 }), row(2, { assignedAge: 56 })],
      });
    });
    await screen.findByRole('table', { name: 'HOLD specimens' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-02D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Schedule test' }));
    const dialog = screen.getByRole('dialog', { name: /Schedule test: 2 specimens/ });
    await userEvent.type(within(dialog).getByLabelText(/Test age/), '56');
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Engineer wants a 56-day break');
    const changes = within(dialog).getByRole('list', { name: 'Specimens and changes' });
    // 7 Nov 2026 + 56 days = 2 Jan 2027.
    expect(within(changes).getAllByText(/HOLD → 56 d, target 2027-01-02/)).toHaveLength(2);
    expect(posts).toEqual([]);
    await userEvent.click(within(dialog).getByRole('button', { name: 'Confirm schedule test' }));
    expect(posts).toHaveLength(1);
    expect(posts[0]![0]).toBe('/api/concrete/holds/schedule-test');
    expect(posts[0]![1]).toMatchObject({
      newAge: 56,
      reason: 'Engineer wants a 56-day break',
      items: [
        { specimenId: ROWS[0]!.specimenId, version: 1 },
        { specimenId: ROWS[1]!.specimenId, version: 1 },
      ],
    });
    expect(await screen.findByText('2 specimens scheduled for testing.')).toBeInTheDocument();
  });

  it('shows the server’s per-specimen problems when nothing was changed', async () => {
    renderPage(() =>
      json(409, {
        code: 'not_eligible',
        problems: [{ specimenId: ROWS[0]!.specimenId, code: 'disposal_authorized' }],
      }),
    );
    await screen.findByRole('table', { name: 'HOLD specimens' });
    await userEvent.click(screen.getByRole('checkbox', { name: 'Select 26-01D' }));
    await userEvent.click(screen.getByRole('button', { name: 'Authorize disposal' }));
    const dialog = screen.getByRole('dialog', { name: /Authorize disposal: 1 specimen/ });
    expect(within(dialog).getByText(/HOLD → Disposal authorized/)).toBeInTheDocument();
    await userEvent.type(within(dialog).getByLabelText(/Reason/), 'Spare cylinders not needed');
    await userEvent.click(
      within(dialog).getByRole('button', { name: 'Confirm authorize disposal' }),
    );
    expect(await within(dialog).findByText('Already authorized for disposal')).toBeInTheDocument();
    expect(within(dialog).getByRole('alert')).toHaveTextContent('Nothing was changed');
  });
});
