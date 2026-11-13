import type { MeResponse, WorkboardColumn, Worklist, WorklistItem } from '@materialmule/shared';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, type RouterProviderProps } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { WorklistPage } from './WorklistPage';

// STRATA-88 Workboard: Board (default) and List views of GET /api/worklist, the view in the URL
// and remembered per person, server-side search, filters and paging (BUG-006), and the empty,
// failed and loading states. Fictional data only: DEMO-2601 / DEMO-2602.

const A = { id: 'proj-a', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' };
const B = { id: 'proj-b', projectNumber: 'DEMO-2602', name: 'Hillside bridge' };

const me: MeResponse = {
  id: '00000000-0000-4000-8000-000000000103',
  displayName: 'Lee Manager',
  initials: 'LM',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_manager'],
  permissions: ['lab_program.read', 'test.review'],
  sessionExpiresAt: '2026-11-13T06:00:00.000Z',
  profileRefreshFailed: false,
};

function item(n: number, column: WorkboardColumn = 'testing', extra: Partial<WorklistItem> = {}) {
  return {
    programId: `p-${n}`,
    programNumber: `LP-2026-${String(n).padStart(4, '0')}`,
    priority: 'normal',
    project: A,
    submittedAt: '2026-10-21T16:00:00.000Z',
    requestedBy: 'Pat Example',
    counts: { requested: 1, in_progress: 0, completed: 1, review: 0, accepted: 0, cancelled: 0 },
    openCount: 1,
    oldestOpenSeconds: 3 * 86_400,
    column,
    unitsToPull: column === 'pull' ? 2 : 0,
    canReview: false,
    ...extra,
  } satisfies WorklistItem;
}

const listOf = (items: WorklistItem[], total = items.length, page = 1): Worklist => ({
  items,
  total,
  urgentTotal: items.filter((i) => i.priority === 'urgent').length,
  page,
  pageSize: 100,
  projects: [A, B],
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

/** Stubs GET /api/worklist with `answer`; records every query string. */
function stub(answer: (params: URLSearchParams) => Response | Promise<Response>) {
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname !== '/api/worklist') return json({}, 404);
      queries.push(url.searchParams.toString());
      return answer(url.searchParams);
    }),
  );
  return queries;
}

/** The board's four columns: one card each, with the facts the server sends. */
const BOARD: Record<WorkboardColumn, WorklistItem[]> = {
  review: [
    item(12, 'review', { priority: 'urgent', canReview: true, oldestOpenSeconds: null }),
    item(11, 'review'),
  ],
  pull: [item(8, 'pull')],
  testing: [item(5, 'testing', { project: B })],
  ready: [
    item(3, 'ready', {
      counts: { requested: 0, in_progress: 0, completed: 0, review: 0, accepted: 4, cancelled: 0 },
      openCount: 0,
      oldestOpenSeconds: null,
    }),
  ],
};
const boardAnswer = (params: URLSearchParams) =>
  json(listOf(BOARD[(params.get('column') ?? 'testing') as WorkboardColumn]));

let router: ReturnType<typeof createMemoryRouter>;
function renderAt(path = '/lab-testing') {
  router = createMemoryRouter([{ path: '/lab-testing', element: <WorklistPage /> }], {
    initialEntries: [path],
  });
  return render(
    <SessionContext.Provider
      value={{
        session: { status: 'active', me },
        refresh: vi.fn(async () => undefined),
        signOut: vi.fn(async () => undefined),
      }}
    >
      <RouterProvider router={router as RouterProviderProps['router']} />
    </SessionContext.Provider>,
  );
}
const search = () => new URLSearchParams(router.state.location.search);

beforeEach(() => {
  localStorage.clear();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Workboard board view (STRATA-88)', () => {
  it('shows four columns by where each program is, with explicit links and no Start', async () => {
    const queries = stub(boardAnswer);
    renderAt();
    const board = await screen.findByRole('region', { name: 'Workboard by status' });
    // One request per column, Urgent first then the oldest open (sort=priority).
    expect(queries.sort()).toEqual([
      'column=pull&sort=priority',
      'column=ready&sort=priority',
      'column=review&sort=priority',
      'column=testing&sort=priority',
    ]);
    const column = (name: string) => within(board).getByRole('list', { name });
    expect(
      within(column('Waiting for review'))
        .getAllByRole('listitem')
        .map((card) => card.getAttribute('aria-label')),
    ).toEqual(['LP-2026-0012', 'LP-2026-0011']);
    expect(within(board).getByRole('heading', { name: /Waiting for review, 2 programs/ }));
    expect(screen.getByText('5 programs')).toBeInTheDocument();
    expect(screen.getByText(/· 1 urgent · priority, then oldest open/)).toBeInTheDocument();

    const urgent = within(column('Waiting for review')).getByRole('listitem', {
      name: 'LP-2026-0012',
    });
    expect(within(urgent).getByText('Urgent · Priority')).toBeInTheDocument();
    expect(within(urgent).getByText('Nothing open')).toBeInTheDocument();
    expect(within(urgent).getByRole('link', { name: 'Review LP-2026-0012' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/p-12#review',
    );
    // Review only where the server says this account may review.
    const other = within(column('Waiting for review')).getByRole('listitem', {
      name: 'LP-2026-0011',
    });
    expect(within(other).queryByRole('link', { name: /^Review/ })).toBeNull();
    expect(within(other).getByRole('link', { name: 'Open LP-2026-0011' })).toBeInTheDocument();

    const pull = within(column('Units to pull')).getByRole('listitem', { name: 'LP-2026-0008' });
    expect(within(pull).getByRole('link', { name: 'Pull list for LP-2026-0008' })).toHaveAttribute(
      'href',
      '/lab-testing/programs/p-8#units-to-pull',
    );
    expect(within(pull).getByText('1 of 2 tests')).toBeInTheDocument();
    expect(within(pull).getByText('Oldest open 3 days')).toBeInTheDocument();
    expect(within(column('Ready to close')).getByText('4 of 4 tests')).toBeInTheDocument();
    // Tests start on the program page, never from a card; nothing is draggable.
    expect(screen.queryByRole('button', { name: /start/i })).toBeNull();
    expect(document.querySelector('[draggable="true"]')).toBeNull();
    expect(board).toHaveAttribute('tabindex', '0');
  });

  it('shows the empty state when nothing is waiting, and Try again after a failure', async () => {
    let fail = true;
    const queries = stub(() => (fail ? json({}, 500) : json(listOf([]))));
    const user = userEvent.setup();
    renderAt();
    expect(await screen.findByText('The Workboard couldn’t be loaded.')).toBeInTheDocument();
    fail = false;
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('Nothing is waiting in the lab.')).toBeInTheDocument();
    expect(queries).toHaveLength(8);
  });

  it('shows a loading skeleton until every column has answered', async () => {
    let release: () => void = () => undefined;
    const held = new Promise<void>((resolve) => (release = resolve));
    stub(async (params) => {
      if (params.get('column') === 'ready') await held;
      return boardAnswer(params);
    });
    renderAt();
    expect(await screen.findByRole('group', { name: 'Loading the Workboard' })).toHaveAttribute(
      'aria-busy',
      'true',
    );
    expect(screen.getByText('Loading the Workboard…')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Workboard by status' })).toBeNull();
    release();
    expect(await screen.findByRole('region', { name: 'Workboard by status' })).toBeInTheDocument();
  });
});

describe('Workboard views and tools (STRATA-88)', () => {
  it('switches to List from the View menu, keeps it in the URL and remembers it for this person', async () => {
    stub((params) =>
      params.get('column')
        ? boardAnswer(params)
        : json(listOf([item(12, 'review', { priority: 'urgent' }), item(8, 'pull')])),
    );
    const user = userEvent.setup();
    const { unmount } = renderAt();
    await screen.findByRole('region', { name: 'Workboard by status' });
    await user.click(screen.getByRole('button', { name: 'View, Board' }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'List' }));

    const table = await screen.findByRole('table', { name: 'Workboard' });
    expect(search().get('view')).toBe('list');
    expect(localStorage.getItem(`materialmule.person.workboard-view.${me.id}`)).toBe('list');
    const rows = within(table).getAllByRole('row').slice(1);
    expect(rows.map((row) => within(row).getAllByRole('link')[0]!.textContent)).toEqual([
      'LP-2026-0012',
      'LP-2026-0008',
    ]);
    expect(within(rows[0]!).getByText('Due · Review')).toBeInTheDocument();
    expect(within(rows[1]!).getByText('In lab · Pull units')).toBeInTheDocument();
    expect(screen.getByRole('region', { name: 'Workboard table' })).toContainElement(table);

    // Next visit without view=: this person's List, written back into the URL.
    unmount();
    renderAt('/lab-testing');
    expect(await screen.findByRole('table', { name: 'Workboard' })).toBeInTheDocument();
    await waitFor(() => expect(search().get('view')).toBe('list'));
  });

  it('searches and filters on the server, and the list pages through every program (BUG-006)', async () => {
    const queries = stub((params) => {
      const page = Number(params.get('page') ?? '1');
      const projects = params.getAll('projectId');
      const all = [
        ...Array.from({ length: 150 }, (_, i) => item(i + 1)),
        item(151, 'testing', { project: B }),
      ]
        .filter((row) => projects.length === 0 || projects.includes(row.project.id))
        .filter(
          (row) => !params.get('search') || row.programNumber.includes(params.get('search')!),
        );
      return json(listOf(all.slice((page - 1) * 100, page * 100), all.length, page));
    });
    const user = userEvent.setup();
    renderAt('/lab-testing?view=list');
    expect(await screen.findByText('Showing 1–100 of 151 programs')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 101–151 of 151 programs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LP-2026-0151' })).toBeInTheDocument();
    expect(search().get('page')).toBe('2');

    // A project filter (offered for every project, not only those on this page) starts at page 1.
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'DEMO-2602' }));
    await user.keyboard('{Escape}');
    expect(await screen.findByRole('link', { name: 'LP-2026-0151' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).toBeNull();
    expect(search().get('page')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Search' }));
    await user.type(screen.getByRole('searchbox', { name: 'Search the Workboard' }), '0999');
    expect(
      await screen.findByText('No program matches this search or these filters.'),
    ).toBeInTheDocument();
    expect(queries).toContain('search=0999&projectId=proj-b&sort=priority');
    // Search is sent once typing settles, not per keystroke.
    expect(queries.filter((q) => q.startsWith('search=0'))).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Clear search and filters' }));
    expect(await screen.findByText('Showing 1–100 of 151 programs')).toBeInTheDocument();
    expect(queries).toEqual([
      'sort=priority',
      'sort=priority&page=2',
      'projectId=proj-b&sort=priority',
      'search=0999&projectId=proj-b&sort=priority',
      'sort=priority',
    ]);
  });

  it('sends the chosen order and Urgent only to the server', async () => {
    const queries = stub(() => json(listOf([item(1)])));
    const user = userEvent.setup();
    renderAt('/lab-testing?view=list');
    await screen.findByRole('table', { name: 'Workboard' });
    await user.click(screen.getByRole('button', { name: /^Sort, / }));
    await user.click(await screen.findByRole('menuitemradio', { name: 'Oldest open first' }));
    await waitFor(() => expect(queries).toContain('sort=oldest'));
    await user.click(screen.getByRole('button', { name: 'Filter' }));
    await user.click(await screen.findByRole('menuitemcheckbox', { name: 'Urgent only' }));
    await waitFor(() => expect(queries).toContain('priority=urgent&sort=oldest'));
  });
});
