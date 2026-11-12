import type {
  ConcreteReceivingQueue,
  ConcreteReceivingQueueRow,
  ConcreteSearch,
  ConcreteSearchResult,
  MeResponse,
} from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destinationsFor, isConcreteLabStaff } from '../../layout/nav';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// MM-V2-C31: Concrete dashboard, Concrete Lab workspace, search and specimen lookup. Fictional
// projects and people only (DEMO-2601 / DEMO-2602, Alex Tester, Jordan Smith).

const ME: MeResponse = {
  id: '00000000-0000-4000-8000-000000000101',
  displayName: 'Alex Tester',
  initials: 'AT',
  accountType: 'test',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-12-05T06:00:00.000Z',
  profileRefreshFailed: false,
};
const A = '00000000-0000-4000-8000-000000000201';
const B = '00000000-0000-4000-8000-000000000202';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

const queueRow = (overrides: Partial<ConcreteReceivingQueueRow>): ConcreteReceivingQueueRow => ({
  setId: '00000000-0000-4000-8000-000000000301',
  fieldReportId: '00000000-0000-4000-8000-000000000401',
  projectId: A,
  projectNumber: 'DEMO-2601',
  projectName: 'Example tower',
  identity: { temporaryId: 'TMP-D07-001', permanentId: '26-05' },
  castAt: '2026-11-02T15:00:00.000Z',
  technician: { userId: ME.id, initials: 'AT', name: 'Alex Tester' },
  mine: true,
  letters: ['A', 'B', 'C', 'D'],
  specimenCount: 4,
  reportState: 'submitted',
  ...overrides,
});

const result = (overrides: Partial<ConcreteSearchResult>): ConcreteSearchResult => ({
  fieldReportId: '00000000-0000-4000-8000-000000000401',
  projectId: A,
  projectNumber: 'DEMO-2601',
  projectName: 'Example tower',
  reportDate: '2026-11-02',
  castingDate: '2026-11-02',
  paperFieldId: null,
  ticketNumber: 'T-77821',
  supplierName: 'Demo Ready Mix',
  mixNumber: '35MPA-A',
  technician: { userId: ME.id, initials: 'AT', name: 'Alex Tester' },
  workflowState: 'submitted',
  matches: ['set_id'],
  sets: [
    {
      setId: '00000000-0000-4000-8000-000000000301',
      identity: { temporaryId: 'TMP-D07-001', permanentId: '26-05' },
      specimenCount: 4,
      voided: false,
      matched: true,
    },
  ],
  ...overrides,
});

const twoProjects: ConcreteSearch = {
  q: '26-05B',
  letter: 'B',
  total: 2,
  page: 1,
  pageSize: 25,
  projectCount: 2,
  items: [
    result({
      fieldReportId: '00000000-0000-4000-8000-000000000402',
      projectId: B,
      projectNumber: 'DEMO-2602',
      projectName: 'Example bridge',
      sets: [
        {
          setId: '00000000-0000-4000-8000-000000000302',
          identity: { temporaryId: null, permanentId: '26-05' },
          specimenCount: 4,
          voided: false,
          matched: true,
        },
      ],
    }),
    result({}),
  ],
};

function renderAt(path: string, answer: (url: URL) => Response | undefined, me: MeResponse = ME) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input), 'http://x');
    // MM-V2-C39: the dashboard's strength-report panel reads an empty list unless a test says.
    const fallback =
      url.pathname === '/api/concrete/strength-reports'
        ? json(200, { items: [], truncated: false })
        : json(404, {});
    return answer(url) ?? fallback;
  });
  vi.stubGlobal('fetch', fetchMock);
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
  return { fetchMock, router };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Concrete Lab navigation (role-based, grants nothing)', () => {
  it('lab staff are the Lab Technician role, Lab Managers and the shared LAB account', () => {
    expect(isConcreteLabStaff({ accountType: 'shared_lab', roles: [] })).toBe(true);
    expect(isConcreteLabStaff({ accountType: 'personal', roles: ['lab_technician'] })).toBe(true);
    expect(isConcreteLabStaff({ accountType: 'personal', roles: ['lab_manager'] })).toBe(true);
    expect(isConcreteLabStaff({ accountType: 'personal', roles: ['admin'] })).toBe(false);
    expect(isConcreteLabStaff({ accountType: 'personal', roles: [] })).toBe(false);
  });

  it('lab staff get Receiving and Specimens in the Concrete group; everyone else does not', () => {
    const concrete = (me: Pick<MeResponse, 'accountType' | 'roles'>) =>
      destinationsFor(me)
        .find((d) => d.key === 'concrete')!
        .children.map((i) => i.label);
    expect(concrete({ accountType: 'shared_lab', roles: [] })).toEqual([
      'Breaks',
      'Receiving',
      'Specimens',
      'Holds',
      'Review',
    ]);
    expect(concrete({ accountType: 'personal', roles: [] })).toEqual(['Breaks', 'Holds', 'Review']);
  });

  it('shows the sidebar Concrete section to a Lab Technician, Specimens marked', async () => {
    renderAt('/concrete/specimens', () => undefined, { ...ME, roles: ['lab_technician'] });
    const nav = await screen.findByRole('navigation', { name: 'Main' });
    const group = nav.querySelector<HTMLElement>('[data-section="concrete"]')!;
    expect(
      within(group)
        .getAllByRole('link')
        .map((a) => a.getAttribute('href')),
    ).toEqual([
      '/concrete',
      '/lab-testing/concrete',
      '/concrete/receiving',
      '/concrete/specimens',
      '/lab-testing/concrete/holds',
      '/concrete/review',
    ]);
    expect(within(group).getByRole('link', { name: 'Specimens' })).toHaveAttribute(
      'aria-current',
      'page',
    );
  });
});

describe('Concrete dashboard', () => {
  it('AC3: shows each count from its own list and links to that list', async () => {
    renderAt('/concrete', (url) => {
      if (url.pathname === '/api/concrete/receiving-queue') {
        return json(200, {
          stage: 'awaiting_pickup',
          counts: { awaiting_pickup: 3, awaiting_receiving: 1 },
          mineTotal: 1,
          total: 3,
          page: 1,
          pageSize: 1,
          items: [queueRow({})],
        } satisfies ConcreteReceivingQueue);
      }
      if (url.pathname === '/api/concrete/lab-worklist') {
        return json(200, {
          view: 'exceptions',
          today: '2026-12-05',
          upcomingThrough: '2026-12-12',
          counts: { today: 4, overdue: 2, upcoming: 9, hold: 5, exceptions: 0 },
          holdReviewDue: 1,
          holdDue: false,
          total: 0,
          page: 1,
          pageSize: 200,
          groups: [],
          exceptions: [],
          testingMachineRegistered: false,
          projects: [],
        });
      }
      if (url.pathname === '/api/concrete/review-queue') {
        return json(200, {
          items: [],
          total: 6,
          page: 1,
          pageSize: 1,
          counts: { awaiting_review: 6, returned: 0, reviewed_awaiting_issue: 2, issued: 8 },
        });
      }
      return undefined;
    });
    const expectations: [string, string, string][] = [
      ['3', 'Awaiting pickup', '/concrete/receiving'],
      ['1', 'Awaiting receiving', '/concrete/receiving?stage=awaiting_receiving'],
      ['4', 'Tests due today', '/lab-testing/concrete'],
      ['2', 'Tests overdue', '/lab-testing/concrete?view=overdue'],
      ['1', 'HOLDs due for review', '/lab-testing/concrete?view=hold&holdDue=true'],
      ['6', 'Awaiting review', '/concrete/review'],
      ['2', 'Awaiting issuance', '/concrete/review?status=reviewed_awaiting_issue'],
    ];
    for (const [count, label, href] of expectations) {
      const link = await screen.findByRole('link', { name: new RegExp(`^${count} ${label}`) });
      expect(link).toHaveAttribute('href', href);
    }
    // Overdue tests above zero say so in words, not just colour.
    expect(screen.getByRole('link', { name: /Tests overdue \(needs attention\)/ })).toBeVisible();
    expect(screen.getByRole('button', { name: 'New field report' })).toBeDisabled();
    expect(screen.getByRole('link', { name: 'Open testing table' })).toHaveAttribute(
      'href',
      '/concrete/testing',
    );
  });

  it('says when the counts could not load and retries', async () => {
    const user = userEvent.setup();
    let calls = 0;
    renderAt('/concrete', (url) => {
      if (url.pathname === '/api/concrete/receiving-queue') {
        calls += 1;
        return json(500, {});
      }
      return undefined;
    });
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't load");
    await user.click(screen.getByRole('button', { name: 'Retry' }));
    await vi.waitFor(() => expect(calls).toBe(2));
  });
});

describe('Specimen receiving', () => {
  it('lists My reports first, separated from everyone else’s, and switches stage by keyboard', async () => {
    const user = userEvent.setup();
    const { fetchMock } = renderAt('/concrete/receiving', (url) => {
      if (url.pathname !== '/api/concrete/receiving-queue') return undefined;
      const stage = url.searchParams.get('stage');
      return json(200, {
        stage,
        counts: { awaiting_pickup: 2, awaiting_receiving: 0 },
        mineTotal: stage === 'awaiting_pickup' ? 1 : 0,
        total: stage === 'awaiting_pickup' ? 2 : 0,
        page: 1,
        pageSize: 50,
        items:
          stage === 'awaiting_pickup'
            ? [
                queueRow({}),
                queueRow({
                  setId: '00000000-0000-4000-8000-000000000302',
                  projectId: B,
                  projectNumber: 'DEMO-2602',
                  identity: { temporaryId: null, permanentId: '26-05' },
                  technician: { userId: 'x', initials: 'JS', name: 'Jordan Smith' },
                  mine: false,
                }),
              ]
            : [],
      });
    });
    const mine = await screen.findByRole('region', { name: /My reports/ });
    expect(within(mine).getByRole('link', { name: '26-05' })).toHaveAttribute(
      'href',
      '/concrete/specimens/00000000-0000-4000-8000-000000000301',
    );
    expect(within(mine).getByText('DEMO-2601')).toBeVisible();
    const others = screen.getByRole('region', { name: /Other reports/ });
    expect(within(others).getByText('DEMO-2602')).toBeVisible();
    expect(within(others).getByText('Jordan Smith')).toBeVisible();

    const tab = screen.getByRole('tab', { name: /Awaiting pickup/ });
    tab.focus();
    await user.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Awaiting receiving/ })).toHaveFocus();
    expect(await screen.findByText('Nothing is awaiting receiving.')).toBeVisible();
    expect(fetchMock.mock.calls.map(([u]) => String(u))).toContain(
      '/api/concrete/receiving-queue?stage=awaiting_receiving',
    );
  });
});

describe('Concrete search and specimen lookup', () => {
  it('AC1: a set number in two projects lists both with their project; nothing is chosen', async () => {
    const { router } = renderAt('/concrete/specimens?q=26-05B', (url) =>
      url.pathname === '/api/concrete/search' ? json(200, twoProjects) : undefined,
    );
    expect(await screen.findByText(/Set numbers repeat between projects/)).toBeVisible();
    const sets = screen.getAllByRole('list', { name: /Specimen sets/ });
    expect(sets.map((l) => l.getAttribute('aria-label'))).toEqual([
      'Specimen sets, DEMO-2602',
      'Specimen sets, DEMO-2601',
    ]);
    // Each match opens its own set with the searched letter; the page stays on the list.
    expect(within(sets[0]!).getByRole('link', { name: '26-05B' })).toHaveAttribute(
      'href',
      '/concrete/specimens/00000000-0000-4000-8000-000000000302?letter=B',
    );
    expect(router.state.location.pathname).toBe('/concrete/specimens');
  });

  it('AC2: a TMP ID with one match opens its set straight away', async () => {
    const { router } = renderAt('/concrete/specimens?q=TMP-D07-001', (url) =>
      url.pathname === '/api/concrete/search'
        ? json(200, {
            ...twoProjects,
            q: 'TMP-D07-001',
            letter: null,
            total: 1,
            projectCount: 1,
            items: [result({})],
          })
        : undefined,
    );
    await vi.waitFor(() =>
      expect(router.state.location.pathname).toBe(
        '/concrete/specimens/00000000-0000-4000-8000-000000000301',
      ),
    );
  });

  it('Concrete search shows what matched, the aliases and the report facts', async () => {
    renderAt('/concrete/search?q=T-778', (url) =>
      url.pathname === '/api/concrete/search'
        ? json(200, {
            ...twoProjects,
            q: 'T-778',
            letter: null,
            total: 1,
            projectCount: 1,
            items: [
              result({
                matches: ['ticket'],
                sets: result({}).sets.map((s) => ({ ...s, matched: false })),
              }),
            ],
          })
        : undefined,
    );
    expect(await screen.findByText('Matched on')).toHaveTextContent('Matched on Ticket');
    expect(screen.getByText('T-77821 (Demo Ready Mix)')).toBeVisible();
    expect(screen.getByText('also TMP-D07-001', { exact: false })).toBeVisible();
    expect(screen.getByRole('textbox', { name: 'Search concrete' })).toHaveValue('T-778');
  });

  it('groups results into field reports and sets, and tags a ticket listed twice on both', async () => {
    renderAt('/concrete/search?q=T-77821', (url) =>
      url.pathname === '/api/concrete/search'
        ? json(200, {
            ...twoProjects,
            q: 'T-77821',
            letter: null,
            items: [
              ...twoProjects.items.map((item) => ({ ...item, matches: ['ticket'] as const })),
              result({
                fieldReportId: '00000000-0000-4000-8000-000000000403',
                workflowState: 'void',
                matches: ['ticket'],
                sets: [],
              }),
            ],
            total: 3,
          })
        : undefined,
    );
    expect(await screen.findByRole('heading', { name: 'Field reports', level: 2 })).toBeVisible();
    expect(screen.getByRole('heading', { name: 'Specimen sets', level: 2 })).toBeVisible();
    // The two live reports share supplier and ticket; the Void one is not counted.
    expect(screen.getAllByText('Duplicate ticket')).toHaveLength(2);
    expect(screen.getAllByRole('heading', { level: 3 })).toHaveLength(3);
  });
});

describe('Lab search (Ctrl K menu)', () => {
  it('searches every lab area from the sidebar’s Search or scan and shows each area’s results', async () => {
    const user = userEvent.setup();
    const { router } = renderAt('/concrete', (url) => {
      if (url.pathname === '/api/inventory') {
        return json(200, { items: [], total: 0, page: 1, pageSize: 5 });
      }
      if (url.pathname === '/api/projects/search') {
        return json(200, [
          {
            id: A,
            projectNumber: 'DEMO-2601',
            name: 'Example tower',
            client: 'Example Client Ltd.',
            leadProjectEngineer: null,
          },
        ]);
      }
      if (url.pathname === '/api/concrete/search') {
        return json(200, {
          ...twoProjects,
          q: 'DEMO-2601',
          letter: null,
          total: 1,
          projectCount: 1,
          items: [result({ matches: ['project'] })],
        });
      }
      if (url.pathname === '/api/scan/resolve') {
        return json(200, { type: 'unknown', reason: 'not_recognised' });
      }
      return undefined;
    });
    // Strata: the top-bar search box is gone; the sidebar's Search or scan opens the Ctrl K menu.
    await user.click(await screen.findByRole('button', { name: 'Search or scan' }));
    await screen.findByRole('dialog', { name: 'Search or scan' });
    await user.keyboard('DEMO-2601{Enter}');
    // Not an exact unit ID, so Enter lands on the results page.
    await vi.waitFor(() =>
      expect(router.state.location.pathname + router.state.location.search).toBe(
        '/search?q=DEMO-2601',
      ),
    );
    const projects = await screen.findByRole('region', { name: 'Projects' });
    expect(await within(projects).findByRole('link', { name: /DEMO-2601/ })).toBeVisible();
    expect(screen.queryByRole('region', { name: 'Storage units' })).toBeNull();
    const concrete = screen.getByRole('region', { name: 'Concrete' });
    await vi.waitFor(() => expect(concrete).toHaveTextContent('Matched on Project'), {
      timeout: 3000,
    });
    expect(within(concrete).getByRole('link', { name: 'Show all in Concrete' })).toHaveAttribute(
      'href',
      '/concrete/search?q=DEMO-2601',
    );
  });
});
