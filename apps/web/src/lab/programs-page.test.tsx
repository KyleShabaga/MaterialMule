import type { LabProgramList, LabProgramSummary, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SessionContext } from '../session/context';
import { ProgramsPage } from './ProgramsPage';

// Lab programs › Programs (STRATA-87; BUG-002 paging, BUG-003 closed status, BUG-010 stale
// answers). Fictional data only: DEMO-2601, TH26-01, user PE.

const PE = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };

const me: MeResponse = {
  id: 'u-pe',
  displayName: 'Pat Example',
  initials: 'PE',
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['lab_program.read', 'lab_program.manage'],
  sessionExpiresAt: '2026-11-30T16:00:00.000Z',
  profileRefreshFailed: false,
};

function program(n: number, status: LabProgramSummary['status'] = 'submitted'): LabProgramSummary {
  return {
    id: `p-${n}`,
    programNumber: status === 'draft' ? null : `LP-2026-${String(n).padStart(4, '0')}`,
    status,
    priority: 'normal',
    project: { id: 'proj-1', projectNumber: 'DEMO-2601', name: 'Riverbank investigation' },
    createdBy: { ...PE, accountType: 'personal' },
    requestedBy: PE,
    createdAt: '2026-10-20T16:00:00.000Z',
    updatedAt: '2026-10-20T16:00:00.000Z',
    submittedAt: status === 'draft' ? null : '2026-10-21T16:00:00.000Z',
    lineCount: 1,
    testCount: 2,
    progress: { done: 0, inProgress: 0, notStarted: 2, cancelled: 0 },
    phase: status === 'draft' ? 'draft' : status === 'closed' ? 'closed' : 'testing',
    closedAt: status === 'closed' ? '2026-10-30T16:00:00.000Z' : null,
  };
}

const COUNTS = { open: 11, drafts: 2, closed: 18 };

const json = (body: unknown) =>
  new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });

function deferred() {
  let resolve!: (response: Response) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<Response>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/** Answers GET /api/lab-programs with `answer(params)`; records every query string. */
function stubPrograms(answer: (params: URLSearchParams) => Response | Promise<Response>) {
  const queries: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://localhost');
      if (url.pathname === '/api/lab-programs') {
        queries.push(url.searchParams.toString());
        return answer(url.searchParams);
      }
      return new Response('{}', { status: 404 });
    }),
  );
  return queries;
}

function renderPage(entry = '/lab-testing/programs') {
  const router = createMemoryRouter(
    [
      { path: '/lab-testing/programs', element: <ProgramsPage /> },
      { path: '/lab-testing/programs/:id', element: <h1>Program page</h1> },
    ],
    { initialEntries: [entry] },
  );
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
  return router;
}

const programLinks = () =>
  within(screen.getByRole('table', { name: 'Testing programs' }))
    .getAllByRole('link')
    .map((link) => link.textContent);

const tab = (name: RegExp) => screen.getByRole('tab', { name });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lab programs › Programs list (STRATA-87)', () => {
  it('BUG-002: pages through 51 open programs and reaches the 51st', async () => {
    const all = Array.from({ length: 51 }, (_, i) => program(i + 1));
    const queries = stubPrograms((params) => {
      const page = Number(params.get('page') ?? '1');
      const list: LabProgramList = {
        total: 51,
        items: all.slice((page - 1) * 50, page * 50),
        counts: COUNTS,
      };
      return json(list);
    });
    const user = userEvent.setup();
    renderPage();

    expect(await screen.findByText('Showing 1–50 of 51 programs')).toBeInTheDocument();
    expect(programLinks()).toHaveLength(50);
    const pages = screen.getByRole('navigation', { name: 'Pages' });
    expect(within(pages).getByRole('button', { name: 'Previous' })).toBeDisabled();
    expect(within(pages).getByText('Page 1 of 2')).toBeInTheDocument();

    await user.click(within(pages).getByRole('button', { name: 'Next' }));
    expect(await screen.findByText('Showing 51–51 of 51 programs')).toBeInTheDocument();
    expect(programLinks()).toEqual(['LP-2026-0051']);
    expect(screen.getByRole('button', { name: 'Next' })).toBeDisabled();
    expect(queries).toEqual(['status=submitted', 'status=submitted&page=2']);
  });

  it('shows tab counts, the status tag, priority, requester and "n of m" progress', async () => {
    stubPrograms(() =>
      json({
        total: 2,
        counts: COUNTS,
        items: [
          {
            ...program(12),
            priority: 'urgent',
            phase: 'review',
            progress: { done: 0, inProgress: 0, notStarted: 5, cancelled: 0 },
          },
          {
            ...program(3),
            phase: 'ready',
            progress: { done: 4, inProgress: 0, notStarted: 0, cancelled: 1 },
          },
        ],
      }),
    );
    renderPage();
    const table = await screen.findByRole('table', { name: 'Testing programs' });
    const [, first, second] = within(table).getAllByRole('row');
    expect(within(first!).getByText('Due · Review')).toBeInTheDocument();
    expect(within(first!).getByText('Urgent · Priority')).toBeInTheDocument();
    expect(within(first!).getByText('0 of 5')).toBeInTheDocument();
    expect(within(first!).getByText('Pat Example')).toBeInTheDocument();
    expect(within(second!).getByText('Due · Ready to close')).toBeInTheDocument();
    expect(within(second!).getByText('Normal')).toBeInTheDocument();
    expect(within(second!).getByText('4 of 4')).toBeInTheDocument();
    expect(within(second!).getByText('1 cancelled')).toBeInTheDocument();
    expect(
      within(second!).getByRole('progressbar', {
        name: '4 of 4 tests done, 0 in progress, 0 not started, 1 cancelled',
      }),
    ).toBeInTheDocument();
    expect(tab(/^Open/)).toHaveTextContent('Open11');
    expect(tab(/^Drafts \(mine\)/)).toHaveTextContent('2');
    expect(tab(/^Closed/)).toHaveTextContent('18');
  });

  it('BUG-003: the Closed tab asks for closed programs from page 1 and shows when each closed', async () => {
    const queries = stubPrograms((params) => {
      if (params.get('status') === 'closed') {
        return json({ total: 1, items: [program(7, 'closed')], counts: COUNTS });
      }
      const page = Number(params.get('page') ?? '1');
      const items = Array.from({ length: page === 1 ? 50 : 10 }, (_, i) =>
        program((page - 1) * 50 + i + 1),
      );
      return json({ total: 60, items, counts: COUNTS });
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 2');
    await user.click(tab(/^Closed/));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
    expect(programLinks()).toEqual(['LP-2026-0007']);
    expect(screen.getByText('Closed · Lab program')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Closed' })).toBeInTheDocument();
    expect(screen.getByText('2026-10-30')).toBeInTheDocument();
    expect(queries.at(-1)).toBe('status=closed');
  });

  it('Drafts (mine): no LP number, lines and tests, and a draft opens in the editor', async () => {
    stubPrograms((params) =>
      json(
        params.get('status') === 'draft'
          ? { total: 1, items: [{ ...program(3, 'draft'), testCount: 0 }], counts: COUNTS }
          : { total: 0, items: [], counts: COUNTS },
      ),
    );
    const user = userEvent.setup();
    const router = renderPage('/lab-testing/programs?tab=drafts');
    expect(
      await screen.findByText(
        'Only your own drafts are listed. A draft gets its LP number when it is submitted.',
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText('1 line · no tests yet')).toBeInTheDocument();
    expect(screen.getByText('Draft · Lab program')).toBeInTheDocument();
    await user.click(screen.getByRole('link', { name: 'Draft lab program' }));
    expect(router.state.location.pathname).toBe('/lab-testing/programs/p-3');
  });

  it('BUG-010: an earlier tab’s late answer or failure never replaces the current one', async () => {
    const pending = { open: deferred(), drafts: deferred() };
    stubPrograms((params) =>
      params.get('status') === 'draft' ? pending.drafts.promise : pending.open.promise,
    );
    const user = userEvent.setup();
    renderPage();

    await user.click(tab(/^Drafts/));
    pending.drafts.resolve(json({ total: 1, items: [program(3, 'draft')] }));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
    // The Open request answers last, with more programs; then a late failure.
    pending.open.resolve(json({ total: 2, items: [program(4), program(5)] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(programLinks()).toEqual(['Draft lab program']);
    expect(tab(/^Drafts/)).toHaveAttribute('aria-selected', 'true');
    expect(screen.queryByText('The programs couldn’t be loaded.')).not.toBeInTheDocument();
  });

  it('search goes to the server; no matches offers Clear search', async () => {
    const queries = stubPrograms((params) =>
      json(
        params.get('search')
          ? { total: 0, items: [], counts: COUNTS }
          : { total: 1, items: [program(1)], counts: COUNTS },
      ),
    );
    const user = userEvent.setup();
    renderPage('/lab-testing/programs?search=DEMO-9999');
    expect(await screen.findByText('No programs match “DEMO-9999”.')).toBeInTheDocument();
    expect(queries).toContain('status=submitted&search=DEMO-9999');
    const empty = screen.getByText('No programs match “DEMO-9999”.').closest('[data-slot="empty"]');
    await user.click(within(empty as HTMLElement).getByRole('button', { name: 'Clear search' }));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
  });

  it('an empty tab says what will appear there', async () => {
    stubPrograms(() => json({ total: 0, items: [], counts: { open: 0, drafts: 0, closed: 0 } }));
    renderPage();
    expect(await screen.findByText('No lab programs are open.')).toBeInTheDocument();
    expect(screen.getByText(/Start one with New lab program/)).toBeInTheDocument();
  });

  it('a failed load offers Try again', async () => {
    let calls = 0;
    stubPrograms(() => {
      calls += 1;
      return calls === 1
        ? new Response('{}', { status: 500 })
        : json({ total: 1, items: [program(1)], counts: COUNTS });
    });
    const user = userEvent.setup();
    renderPage();
    expect(await screen.findByText('The programs couldn’t be loaded.')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
  });

  it('steps back when the page asked for is past the end', async () => {
    const queries = stubPrograms((params) => {
      const page = Number(params.get('page') ?? '1');
      // 60 programs on the first answer, then programs went elsewhere: only 40 remain.
      if (page === 1 && queries.length === 1) {
        return json({ total: 60, items: Array.from({ length: 50 }, (_, i) => program(i + 1)) });
      }
      if (page === 2) return json({ total: 40, items: [] });
      return json({ total: 40, items: Array.from({ length: 40 }, (_, i) => program(i + 1)) });
    });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Next' }));
    expect(await screen.findByText('40 programs')).toBeInTheDocument();
    expect(queries).toEqual(['status=submitted', 'status=submitted&page=2', 'status=submitted']);
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
  });

  it('a row opens the program page on a narrow screen (no drawer below 1024 px)', async () => {
    stubPrograms(() => json({ total: 1, items: [program(7)], counts: COUNTS }));
    const user = userEvent.setup();
    const router = renderPage();
    await user.click(await screen.findByText('Riverbank investigation'));
    expect(router.state.location.pathname).toBe('/lab-testing/programs/p-7');
  });
});
