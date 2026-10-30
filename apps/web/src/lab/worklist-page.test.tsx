import type { Worklist, WorklistItem } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WorklistPage } from './WorklistPage';

// BUG-006: the worklist pages through every matching program and offers every project, not
// only those on the loaded page. Fictional data only: DEMO-2601 / DEMO-2602.

const A = { id: 'proj-a', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' };
const B = { id: 'proj-b', projectNumber: 'DEMO-2602', name: 'Hillside bridge' };

function item(n: number, project = A): WorklistItem {
  return {
    programId: `p-${n}`,
    programNumber: `LP-2026-${String(n).padStart(4, '0')}`,
    priority: 'normal',
    project,
    submittedAt: '2026-10-21T16:00:00.000Z',
    requestedBy: 'Pat Example',
    counts: {
      requested: 1,
      in_progress: 0,
      completed: 0,
      review: 0,
      accepted: 0,
      cancelled: 0,
    },
    openCount: 1,
    oldestOpenSeconds: 3600,
  };
}

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lab Testing → Worklist paging (BUG-006)', () => {
  it('offers projects beyond the first page, pages to the rest, and restarts on a filter change', async () => {
    const queries: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/test-catalogue') return json({ groups: [], tests: [] });
        if (url.pathname !== '/api/worklist') return new Response('{}', { status: 404 });
        queries.push(url.searchParams.toString());
        const page = Number(url.searchParams.get('page') ?? '1');
        const projectId = url.searchParams.get('projectId');
        const all = [...Array.from({ length: 150 }, (_, i) => item(i + 1)), item(151, B)].filter(
          (row) => !projectId || row.project.id === projectId,
        );
        const list: Worklist = {
          items: all.slice((page - 1) * 100, page * 100),
          total: all.length,
          page,
          pageSize: 100,
          projects: [A, B],
        };
        return json(list);
      }),
    );
    const user = userEvent.setup();
    render(
      <RouterProvider router={createMemoryRouter([{ path: '/', element: <WorklistPage /> }])} />,
    );

    expect(await screen.findByText('Showing 1–100 of 151 programs')).toBeInTheDocument();
    const project = screen.getByLabelText(/Project/);
    expect(
      within(project)
        .getAllByRole('option')
        .map((o) => o.textContent),
    ).toEqual(['All', 'DEMO-2601', 'DEMO-2602']);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 101–151 of 151 programs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LP-2026-0151' })).toBeInTheDocument();

    await user.selectOptions(project, 'DEMO-2602');
    expect(await screen.findByRole('link', { name: 'LP-2026-0151' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    expect(queries).toEqual(['open=true', 'open=true&page=2', 'projectId=proj-b&open=true']);
  });
});

// PR #104 review finding 2: while a page is loading the table, label and buttons belong to the
// page being fetched, and nothing from an obsolete request is ever shown. Answers are released
// by the test (deferred), never by time.
describe('Lab Testing → Worklist while a page is loading', () => {
  interface Held {
    query: string;
    resolve: (response: Response) => void;
    reject: (error: Error) => void;
  }

  /**
   * GET /api/worklist answers at once when `auto` returns a list and is held otherwise, until the
   * test resolves or rejects it. Every query string is recorded.
   */
  function stub(auto: (params: URLSearchParams) => Worklist | null) {
    const queries: string[] = [];
    const held: Held[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'http://localhost');
        if (url.pathname === '/api/test-catalogue') return json({ groups: [], tests: [] });
        if (url.pathname !== '/api/worklist') return new Response('{}', { status: 404 });
        const query = url.searchParams.toString();
        queries.push(query);
        const list = auto(url.searchParams);
        if (list) return json(list);
        return new Promise<Response>((resolve, reject) => held.push({ query, resolve, reject }));
      }),
    );
    async function take(query: string): Promise<Held> {
      await vi.waitFor(() => expect(held.map((h) => h.query)).toContain(query));
      return held.splice(
        held.findIndex((h) => h.query === query),
        1,
      )[0]!;
    }
    return { queries, take };
  }

  /** Page `page` (100 per page) of `total` DEMO-2601 programs. */
  function pageOf(total: number, page: number): Worklist {
    const start = (page - 1) * 100;
    return {
      items: Array.from({ length: Math.max(0, Math.min(100, total - start)) }, (_, i) =>
        item(start + i + 1),
      ),
      total,
      page,
      pageSize: 100,
      projects: [A, B],
    };
  }

  function renderPage() {
    render(
      <RouterProvider router={createMemoryRouter([{ path: '/', element: <WorklistPage /> }])} />,
    );
  }

  const pager = () => screen.getByRole('navigation', { name: 'Pages' });
  const programLinks = () => screen.queryAllByRole('link').map((link) => link.textContent);

  it('shows the page being fetched, and a second Next while it loads skips nothing', async () => {
    const { queries, take } = stub((p) => (p.get('page') ? null : pageOf(251, 1)));
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('Showing 1–100 of 251 programs')).toBeInTheDocument();

    await user.click(within(pager()).getByRole('button', { name: 'Next' }));
    // Loading page 2: no stale rows, the label says page 2, both buttons are off.
    expect(screen.getByText('Loading the worklist…')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: 'Lab worklist' })).not.toBeInTheDocument();
    expect(within(pager()).getByText('Page 2 of 3')).toBeInTheDocument();
    expect(within(pager()).getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(within(pager()).getByRole('button', { name: 'Previous' })).toBeDisabled();
    // Project options stay while loading.
    expect(within(screen.getByLabelText(/Project/)).getAllByRole('option')).toHaveLength(3);
    await user.click(within(pager()).getByRole('button', { name: 'Next' }));

    (await take('open=true&page=2')).resolve(json(pageOf(251, 2)));
    expect(await screen.findByText('Showing 101–200 of 251 programs')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'LP-2026-0101' })).toBeInTheDocument();
    expect(within(pager()).getByText('Page 2 of 3')).toBeInTheDocument();
    expect(within(pager()).getByRole('button', { name: 'Next' })).toBeEnabled();
    expect(within(pager()).getByRole('button', { name: 'Previous' })).toBeEnabled();
    expect(queries).toEqual(['open=true', 'open=true&page=2']);
  });

  it('a filter change while a page loads starts at page 1, and the late page answer is ignored', async () => {
    const { queries, take } = stub((p) =>
      p.get('page') || p.get('priority') ? null : pageOf(251, 1),
    );
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Showing 1–100 of 251 programs');

    await user.click(within(pager()).getByRole('button', { name: 'Next' }));
    const stalePage = await take('open=true&page=2');
    await user.selectOptions(screen.getByLabelText(/Priority/), 'Urgent');
    // Other filters: no pager from the old ones while the new answer loads.
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    const urgent = await take('priority=urgent&open=true');

    urgent.resolve(json({ ...pageOf(1, 1), items: [item(900)] }));
    expect(await screen.findByRole('link', { name: 'LP-2026-0900' })).toBeInTheDocument();
    stalePage.resolve(json(pageOf(251, 2)));
    // The stale answer is read and dropped: the table never changes.
    await vi.waitFor(() => expect(programLinks()).toEqual(['LP-2026-0900']));
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    expect(queries).toEqual(['open=true', 'open=true&page=2', 'priority=urgent&open=true']);
  });

  it('a late failure for an obsolete page shows no error', async () => {
    const { take } = stub((p) => (p.get('page') || p.get('priority') ? null : pageOf(251, 1)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Showing 1–100 of 251 programs');

    await user.click(within(pager()).getByRole('button', { name: 'Next' }));
    const stalePage = await take('open=true&page=2');
    await user.selectOptions(screen.getByLabelText(/Priority/), 'Urgent');
    (await take('priority=urgent&open=true')).resolve(
      json({ ...pageOf(1, 1), items: [item(900)] }),
    );
    expect(await screen.findByRole('link', { name: 'LP-2026-0900' })).toBeInTheDocument();
    stalePage.reject(new Error('network'));
    await vi.waitFor(() => expect(programLinks()).toEqual(['LP-2026-0900']));
    expect(screen.queryByText('The worklist couldn’t be loaded.')).not.toBeInTheDocument();
  });

  it('a failed page offers a retry, and the retry loads that page', async () => {
    const { queries, take } = stub((p) => (p.get('page') ? null : pageOf(251, 1)));
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Showing 1–100 of 251 programs');

    await user.click(within(pager()).getByRole('button', { name: 'Next' }));
    (await take('open=true&page=2')).reject(new Error('network'));
    expect(await screen.findByText('The worklist couldn’t be loaded.')).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /retry|try again/i }));
    (await take('open=true&page=2')).resolve(json(pageOf(251, 2)));
    expect(await screen.findByText('Showing 101–200 of 251 programs')).toBeInTheDocument();
    expect(queries).toEqual(['open=true', 'open=true&page=2', 'open=true&page=2']);
  });

  it('steps back to the last page when the asked page no longer exists', async () => {
    let answers = 0;
    const { queries, take } = stub((p) => {
      if (p.get('page')) return null;
      // 150 programs at first; by the time page 2 is asked for, only 80 remain.
      answers += 1;
      return answers === 1 ? pageOf(150, 1) : pageOf(80, 1);
    });
    const user = userEvent.setup();
    renderPage();
    await screen.findByText('Showing 1–100 of 150 programs');

    await user.click(within(pager()).getByRole('button', { name: 'Next' }));
    (await take('open=true&page=2')).resolve(json(pageOf(80, 2)));
    expect(await screen.findByRole('link', { name: 'LP-2026-0080' })).toBeInTheDocument();
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
    expect(queries).toEqual(['open=true', 'open=true&page=2', 'open=true']);
  });
});
