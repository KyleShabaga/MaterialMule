import type { ConcreteSearch, ConcreteSearchResult, MeResponse } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter } from 'react-router';
import { RouterProvider } from 'react-router/dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { destinationsFor, isConcreteLabStaff } from '../../layout/nav';
import { routes } from '../../routes';
import { SessionContext } from '../../session/context';

// MM-V2-C31: Concrete Lab navigation and the Ctrl K lab search (the dashboard has its own test). Fictional
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
