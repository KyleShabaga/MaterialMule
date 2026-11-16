import {
  REQUEST_TASK_LABELS,
  UPDATE_TASK_LABELS,
  type InboxItem,
  type StationInboxPage,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PERSONAL_CONTROLLER,
  RecordingPersonContext,
  type RecordingPersonController,
} from '../../session/recording-person-store';
import { StationInbox } from './StationInbox';

// STRATA-27: the picked person's Inbox on a shared LAB computer, only with their consent, and
// read-only. Fictional people only (Pat Example, Alex Tester, Sam Sample).

const PAT = '11111111-1111-4111-8111-111111111111';
const ALEX = '22222222-2222-4222-8222-222222222222';

const station = (id: string, name: string): RecordingPersonController => ({
  ...PERSONAL_CONTROLLER,
  isStation: true,
  person: { id, displayName: name, initials: 'XX', roleLine: 'Technician' },
});

const NOW = new Date().toISOString();

const ITEMS: InboxItem[] = [
  {
    key: 'request:a-1',
    sourceId: 'a-1',
    type: 'request',
    kind: 'closure_request',
    task: REQUEST_TASK_LABELS.closure_request,
    title: 'Closure requested for LP-2026-0001',
    projectId: 'p1',
    jobNumber: 'DEMO-2601',
    record: { kind: 'lab_program', id: 'lp1', label: 'LP-2026-0001' },
    from: { userId: 'u-ss', initials: 'SS', name: 'Sam Sample' },
    receivedAt: NOW,
    unread: true,
    stage: 'due',
    domain: 'lab',
    href: '/lab-testing/programs/lp1',
    status: 'open',
    resolution: null,
    waitingOnMe: true,
    raisedByMe: false,
    reason: 'All tests reported.',
  },
  {
    key: 'update:n-2',
    sourceId: 'n-2',
    type: 'update',
    kind: 'concrete_test.failed',
    task: UPDATE_TASK_LABELS['concrete_test.failed'],
    title: 'Failed concrete test',
    projectId: 'p1',
    jobNumber: 'DEMO-2601',
    record: null,
    from: null,
    receivedAt: NOW,
    unread: false,
    stage: 'danger',
    domain: 'concrete',
    href: '/concrete',
    dismissed: false,
    aboutMyRequest: false,
    linkedRequestStatus: null,
  },
];

const shared = (name: string, userId: string, items = ITEMS): StationInboxPage => ({
  state: 'shared',
  person: { userId, name },
  page: {
    items,
    total: items.length,
    page: 1,
    pageSize: 50,
    tabCounts: { all: items.length, requests: 1, updates: 1, done: 0 },
    summary: {
      counts: { badge: 1, unread: 1, unreadRequests: 1, unreadUpdates: 0, openRequests: 1 },
      preview: [],
    },
  },
});

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function stub(api: (personId: string) => Response | Promise<Response>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
    const url = new URL(String(input), 'http://localhost');
    if (url.pathname !== '/api/station/inbox') return json(404, {});
    return api(url.searchParams.get('personId') ?? '');
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function wrap(controller: RecordingPersonController, children: ReactNode = <StationInbox />) {
  return (
    <RecordingPersonContext.Provider value={controller}>
      <MemoryRouter>{children}</MemoryRouter>
    </RecordingPersonContext.Provider>
  );
}

afterEach(() => vi.unstubAllGlobals());

describe('StationInbox (STRATA-27)', () => {
  it('keeps a private Inbox private: a lock, how to turn it on, and no items', async () => {
    const fetchMock = stub(() =>
      json(200, { state: 'private', person: { userId: PAT, name: 'Pat Example' } }),
    );
    render(wrap(station(PAT, 'Pat Example')));
    expect(
      await screen.findByRole('heading', { name: 'Pat Example’s Inbox stays private here' }),
    ).toBeVisible();
    expect(screen.getByText(/Settings › Preferences › Privacy/)).toHaveTextContent(
      '“Show my Inbox on shared LAB computers”',
    );
    expect(screen.getByText(/own account/)).toBeVisible();
    expect(
      screen.getByText('Work done at this station is still recorded under Pat Example’s name.'),
    ).toBeVisible();
    expect(screen.queryByRole('list')).toBeNull();
    const url = new URL(String(fetchMock.mock.calls[0]![0]), 'http://localhost');
    expect(url.searchParams.get('personId')).toBe(PAT);
  });

  it('shows a shared Inbox read-only, telling requests and updates apart', async () => {
    const fetchMock = stub(() => json(200, shared('Pat Example', PAT)));
    render(wrap(station(PAT, 'Pat Example')));
    expect(
      await screen.findByText(
        'You’re seeing Pat Example’s Inbox. They chose to show it on shared LAB computers.',
      ),
    ).toBeVisible();
    const list = screen.getByRole('list', { name: 'Pat Example’s Inbox, newest first' });
    const rows = within(list).getAllByRole('link');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toHaveTextContent('RequestClose a program');
    expect(rows[0]).toHaveTextContent('Unread. Closure requested for LP-2026-0001');
    expect(rows[0]).toHaveTextContent('DEMO-2601 · LP-2026-0001 · Sam Sample');
    expect(rows[0]).toHaveAttribute('href', '/lab-testing/programs/lp1');
    expect(rows[1]).toHaveTextContent('Update:Failed test');
    expect(rows[1]).not.toHaveTextContent('Unread');
    expect(rows[1]).toHaveTextContent('Material Mule');
    expect(within(list).getByText('Today')).toBeInTheDocument();
    // Read-only: nothing to mark read, dismiss or decide, and only GETs.
    expect(screen.queryByRole('button')).toBeNull();
    expect(fetchMock.mock.calls.every(([, init]) => !init?.method || init.method === 'GET')).toBe(
      true,
    );
  });

  it('drops what was shown the moment the person changes, and on sign off', async () => {
    let answerAlex: (response: Response) => void = () => undefined;
    stub((personId) =>
      personId === PAT
        ? json(200, shared('Pat Example', PAT))
        : new Promise<Response>((resolve) => {
            answerAlex = resolve;
          }),
    );
    const { rerender } = render(wrap(station(PAT, 'Pat Example')));
    expect(await screen.findByText('Closure requested for LP-2026-0001')).toBeVisible();

    rerender(wrap(station(ALEX, 'Alex Tester')));
    // Pat's items are gone before Alex's answer arrives.
    expect(screen.queryByText('Closure requested for LP-2026-0001')).toBeNull();
    expect(screen.getByText('Loading Alex Tester’s Inbox…')).toBeVisible();
    answerAlex(json(200, { state: 'private', person: { userId: ALEX, name: 'Alex Tester' } }));
    expect(await screen.findByText('Alex Tester’s Inbox stays private here')).toBeVisible();

    rerender(wrap({ ...station(ALEX, 'Alex Tester'), person: null }));
    expect(screen.queryByText(/Alex Tester/)).toBeNull();
  });

  it('shows nothing with nobody picked, and on a personal account', () => {
    const fetchMock = stub(() => json(200, shared('Pat Example', PAT)));
    const { container, rerender } = render(wrap({ ...station(PAT, 'x'), person: null }));
    expect(container).toBeEmptyDOMElement();
    rerender(wrap(PERSONAL_CONTROLLER));
    expect(container).toBeEmptyDOMElement();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('says when the Inbox couldn’t load', async () => {
    stub(() => json(500, {}));
    render(wrap(station(PAT, 'Pat Example')));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Pat Example’s Inbox couldn’t load.',
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});
