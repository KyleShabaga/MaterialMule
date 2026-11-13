import type { ConcreteWorklist, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// STRATA-93: Concrete → Overview. Fictional people and data only (Alex Tester, DEMO-2601).

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'personal',
  status: 'active',
  roles: ['lab_technician'],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const receiving = (pickup: number, awaiting: number) =>
  json(200, {
    stage: 'awaiting_pickup',
    counts: { awaiting_pickup: pickup, awaiting_receiving: awaiting },
    mineTotal: 0,
    total: pickup,
    page: 1,
    pageSize: 1,
    items: [],
  });

const worklist = (counts: ConcreteWorklist['counts'], holdReviewDue = 0): Response =>
  json(200, {
    view: 'exceptions',
    today: '2026-12-05',
    upcomingThrough: '2026-12-12',
    counts,
    holdReviewDue,
    holdDue: false,
    total: 0,
    page: 1,
    pageSize: 200,
    groups: [],
    exceptions: [],
    testingMachineRegistered: true,
    projects: [],
  } satisfies ConcreteWorklist);

const review = (awaiting: number, issue: number) =>
  json(200, {
    items: [],
    total: awaiting,
    page: 1,
    pageSize: 1,
    counts: { awaiting_review: awaiting, returned: 0, reviewed_awaiting_issue: issue, issued: 8 },
  });

function renderAt(answer: (url: URL) => Response | undefined) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    const fallback =
      url.pathname === '/api/concrete/strength-reports'
        ? json(200, { items: [], truncated: false })
        : json(404, {});
    return answer(url) ?? fallback;
  });
  vi.stubGlobal('fetch', fetchMock);
  const router = createMemoryRouter(routes, { initialEntries: ['/concrete'] });
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
  return { fetchMock, router };
}

const counts = () => screen.getByRole('region', { name: 'Concrete lab counts' });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Concrete → Overview (STRATA-93)', () => {
  it('shows every counter as a link to the list that clears it', async () => {
    renderAt((url) => {
      if (url.pathname === '/api/concrete/receiving-queue') return receiving(3, 1);
      if (url.pathname === '/api/concrete/lab-worklist') {
        return worklist({ today: 4, overdue: 2, upcoming: 9, hold: 5, exceptions: 1 }, 2);
      }
      if (url.pathname === '/api/concrete/review-queue') return review(6, 2);
      return undefined;
    });
    expect(await screen.findByRole('heading', { name: 'Concrete', level: 1 })).toBeVisible();
    const expectations: [string, string][] = [
      ['3 Awaiting pickup', '/concrete/receiving'],
      ['1 Awaiting receiving', '/concrete/receiving?stage=awaiting_receiving'],
      ['4 Tests due today', '/lab-testing/concrete'],
      ['2 Tests overdue', '/lab-testing/concrete?view=overdue'],
      ['5 On HOLD, 2 past their hold date', '/lab-testing/concrete/holds'],
      ['1 Exceptions', '/lab-testing/concrete?view=exceptions'],
      ['6 Awaiting review', '/concrete/review'],
      ['2 Awaiting issuance', '/concrete/review?status=reviewed_awaiting_issue'],
    ];
    for (const [name, href] of expectations) {
      expect(await within(counts()).findByRole('link', { name })).toHaveAttribute('href', href);
    }
    expect(screen.getByText(/Lab day/)).toHaveTextContent('Lab day 2026-12-05');
    expect(screen.getByRole('button', { name: 'New field report' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'New field report' })).toHaveAccessibleDescription(
      /Not built yet/,
    );
    expect(screen.getByRole('link', { name: 'Open testing table' })).toHaveAttribute(
      'href',
      '/concrete/testing',
    );
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('says when nothing is waiting', async () => {
    renderAt((url) => {
      if (url.pathname === '/api/concrete/receiving-queue') return receiving(0, 0);
      if (url.pathname === '/api/concrete/lab-worklist') {
        return worklist({ today: 0, overdue: 0, upcoming: 3, hold: 0, exceptions: 0 });
      }
      if (url.pathname === '/api/concrete/review-queue') return review(0, 0);
      return undefined;
    });
    expect(
      await screen.findByText('Nothing is waiting in the concrete lab today.'),
    ).toBeInTheDocument();
    expect(within(counts()).getByRole('link', { name: '0 Tests overdue' })).toBeInTheDocument();
  });

  it('a count that failed or that the account cannot see is unavailable, never 0; Try again', async () => {
    const user = userEvent.setup();
    let reviewCalls = 0;
    renderAt((url) => {
      if (url.pathname === '/api/concrete/receiving-queue') return json(403, {});
      if (url.pathname === '/api/concrete/lab-worklist') {
        return worklist({ today: 4, overdue: 0, upcoming: 0, hold: 0, exceptions: 0 });
      }
      if (url.pathname === '/api/concrete/review-queue') {
        reviewCalls += 1;
        return reviewCalls === 1 ? json(500, {}) : review(6, 2);
      }
      return undefined;
    });
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('2 counts couldn’t be loaded.');
    expect(alert).toHaveTextContent(
      'Awaiting review and Awaiting issuance didn’t answer. The other counts are current.',
    );
    const region = counts();
    expect(
      within(region).getByRole('link', { name: 'Awaiting review: Couldn’t load' }),
    ).toBeInTheDocument();
    expect(
      within(region).getByRole('link', { name: 'Awaiting pickup: Not available to you' }),
    ).toBeInTheDocument();
    expect(within(region).queryByRole('link', { name: /^0 Awaiting/ })).toBeNull();
    expect(within(region).getByRole('link', { name: '4 Tests due today' })).toBeInTheDocument();
    expect(screen.queryByText('Nothing is waiting in the concrete lab today.')).toBeNull();

    await user.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await within(counts()).findByRole('link', { name: '6 Awaiting review' })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('Find concrete records opens the Ctrl K search with what was typed', async () => {
    const user = userEvent.setup();
    renderAt((url) => {
      if (url.pathname === '/api/concrete/search') {
        return json(200, {
          q: '26-18B',
          letter: 'B',
          total: 0,
          page: 1,
          pageSize: 5,
          projectCount: 0,
          items: [],
        });
      }
      if (url.pathname === '/api/inventory') {
        return json(200, { items: [], total: 0, page: 1, pageSize: 5 });
      }
      if (url.pathname === '/api/projects/search') return json(200, []);
      if (url.pathname === '/api/scan/resolve') {
        return json(200, { type: 'unknown', reason: 'not_recognised' });
      }
      return undefined;
    });
    const search = await screen.findByRole('search', { name: 'Find concrete records' });
    await user.type(
      within(search).getByRole('textbox', { name: 'Find concrete records' }),
      '26-18B',
    );
    await user.click(within(search).getByRole('button', { name: 'Search' }));
    const menu = await screen.findByRole('dialog', { name: 'Search or scan' });
    expect(within(menu).getByRole('combobox')).toHaveValue('26-18B');
  });

  it('shows the strength reports under the open G2 gate, with the lab list as built', async () => {
    renderAt(() => undefined);
    const section = await screen.findByRole('region', { name: 'Strength reports' });
    expect(within(section).getByText('Gate G2 · strength report open')).toBeVisible();
    expect(
      await within(section).findByText('No strength reports need the lab right now.'),
    ).toBeInTheDocument();
  });
});
