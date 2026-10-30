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
