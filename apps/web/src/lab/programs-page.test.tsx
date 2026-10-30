import type { LabProgramList, LabProgramSummary } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ProgramsPage } from './ProgramsPage';

// BUG-002 (paging), BUG-003 (closed status) and BUG-010 (stale answers) on Lab Testing →
// Programs. Fictional data only: DEMO-2601, TH26-01, user PE.

const PE = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };

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
  };
}

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

function renderPage() {
  const router = createMemoryRouter([{ path: '/', element: <ProgramsPage /> }]);
  render(<RouterProvider router={router} />);
}

const programLinks = () =>
  within(screen.getByRole('table', { name: 'Testing programs' }))
    .getAllByRole('link')
    .map((link) => link.textContent);

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Lab Testing → Programs list', () => {
  it('BUG-002: pages through 51 programs and reaches the 51st', async () => {
    const all = Array.from({ length: 51 }, (_, i) => program(i + 1));
    const queries = stubPrograms((params) => {
      const page = Number(params.get('page') ?? '1');
      const list: LabProgramList = { total: 51, items: all.slice((page - 1) * 50, page * 50) };
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
    expect(queries).toEqual(['', 'page=2']);
  });

  it('BUG-003: a closed program reads Closed, and the Closed filter starts again at page 1', async () => {
    const queries = stubPrograms((params) => {
      if (params.get('status') === 'closed') {
        return json({ total: 1, items: [program(7, 'closed')] });
      }
      const page = Number(params.get('page') ?? '1');
      const items = Array.from({ length: page === 1 ? 50 : 10 }, (_, i) =>
        program((page - 1) * 50 + i + 1, i === 0 ? 'closed' : 'submitted'),
      );
      return json({ total: 60, items });
    });
    const user = userEvent.setup();
    renderPage();

    const table = await screen.findByRole('table', { name: 'Testing programs' });
    const firstRow = within(table).getAllByRole('row')[1]!;
    expect(within(firstRow).getByText('Closed')).toBeInTheDocument();
    expect(within(table).getAllByText('Open')).toHaveLength(49);

    await user.click(screen.getByRole('button', { name: 'Next' }));
    await screen.findByText('Page 2 of 2');
    await user.selectOptions(screen.getByLabelText(/Show/), 'Closed');
    expect(await screen.findByText('1 program')).toBeInTheDocument();
    expect(programLinks()).toEqual(['LP-2026-0007']);
    expect(queries.at(-1)).toBe('status=closed');
  });

  it('BUG-010: an earlier filter’s late answer or failure never replaces the current one', async () => {
    const pending = { all: deferred(), drafts: deferred() };
    stubPrograms((params) =>
      params.get('status') === 'draft' ? pending.drafts.promise : pending.all.promise,
    );
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(screen.getByLabelText(/Show/), 'Drafts');
    pending.drafts.resolve(json({ total: 1, items: [program(3, 'draft')] }));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
    // The All request answers last, with more programs.
    pending.all.resolve(json({ total: 2, items: [program(3, 'draft'), program(4)] }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(programLinks()).toEqual(['Draft program']);
    expect(screen.getByLabelText(/Show/)).toHaveValue('draft');
  });

  it('BUG-010: a late failure for an earlier filter shows no error', async () => {
    const pending = { all: deferred(), drafts: deferred() };
    stubPrograms((params) =>
      params.get('status') === 'draft' ? pending.drafts.promise : pending.all.promise,
    );
    const user = userEvent.setup();
    renderPage();

    await user.selectOptions(screen.getByLabelText(/Show/), 'Drafts');
    pending.drafts.resolve(json({ total: 1, items: [program(3, 'draft')] }));
    expect(await screen.findByText('1 program')).toBeInTheDocument();
    pending.all.reject(new Error('network'));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(screen.queryByText('Programs couldn’t be loaded.')).not.toBeInTheDocument();
    expect(programLinks()).toEqual(['Draft program']);
  });

  it('steps back when the page asked for is past the end', async () => {
    const queries = stubPrograms((params) => {
      const page = Number(params.get('page') ?? '1');
      // 60 programs on the first answer, then drafts were deleted elsewhere: only 40 remain.
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
    expect(queries).toEqual(['', 'page=2', '']);
    expect(screen.queryByRole('navigation', { name: 'Pages' })).not.toBeInTheDocument();
  });
});
