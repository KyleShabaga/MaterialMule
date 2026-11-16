import type { ConcreteProjectSetList, ProjectDetail } from '@materialmule/shared';
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter, Outlet, Route, Routes, useLocation } from 'react-router';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProjectLayoutContext } from '../../projects/project-layout-context';
import { concreteTabPath } from './paths';
import { ProjectConcreteTab } from './ProjectConcretePage';

// STRATA-98: the Concrete tab inside the project page (lane D's ProjectLayout outlet): five
// sub-tabs with their own addresses, the former Specimens address opening Sets, and the Sets list
// with working labels and "n of m tested". Fictional data only (DEMO-2616).

const PROJECT = {
  id: '00000000-0000-4000-8000-000000000216',
  projectNumber: 'DEMO-2616',
  name: 'Riverside apartments',
  leadProjectEngineer: { id: 'u-at', displayName: 'Alex Tester', initials: 'AT' },
} as ProjectDetail;

const fetchProjectSets = vi.fn<() => Promise<ConcreteProjectSetList>>();
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  fetchProjectSets: () => fetchProjectSets(),
}));
vi.mock('../../concrete-review/StrengthReportList', () => ({
  StrengthReportList: () => <p>Strength reports list</p>,
}));

function Where() {
  const location = useLocation();
  return <p data-testid="where">{location.pathname}</p>;
}

function renderAt(path: string) {
  const context: ProjectLayoutContext = {
    project: PROJECT,
    reloadProject: () => undefined,
    setFormOpen: () => undefined,
  };
  render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/projects/:projectId" element={<Outlet context={context} />}>
          <Route path="concrete/:tab" element={<ProjectConcreteTab />} />
        </Route>
      </Routes>
      <Where />
    </MemoryRouter>,
  );
}

const SETS: ConcreteProjectSetList = {
  projectId: PROJECT.id,
  today: '2026-11-11',
  total: 2,
  page: 1,
  pageSize: 25,
  items: [
    {
      setId: 'set-2',
      workingNumber: 2,
      workingLabel: 'Set 2',
      specimenRange: '2A–2D',
      identity: { temporaryId: null, permanentId: null },
      fieldReportId: 'r2',
      reportState: 'submitted',
      castingDate: '2026-11-02',
      structure: ['Level 1 slab'],
      location: null,
      testAges: [7, 28, 28, 'HOLD'],
      testedCount: 1,
      scheduledCount: 3,
      nextTestDate: '2026-11-30',
      voided: false,
      status: 'curing',
    },
    {
      setId: 'set-1',
      workingNumber: 1,
      workingLabel: 'Set 1',
      specimenRange: '1A–1D',
      identity: { temporaryId: null, permanentId: null },
      fieldReportId: 'r1',
      reportState: 'issued',
      castingDate: '2026-10-14',
      structure: ['Footings F7–F9'],
      location: null,
      testAges: [7, 28, 28, 'HOLD'],
      testedCount: 1,
      scheduledCount: 3,
      nextTestDate: '2026-11-11',
      voided: false,
      status: 'due_today',
    },
  ],
};

describe('the project Concrete tab', () => {
  beforeEach(() => {
    fetchProjectSets.mockReset();
    fetchProjectSets.mockResolvedValue(SETS);
  });

  it('has five sub-tabs, each its own address', async () => {
    renderAt(concreteTabPath(PROJECT.id, 'sets'));
    const nav = screen.getByRole('navigation', { name: 'Concrete sections' });
    const tabs = within(nav).getAllByRole('tab');
    expect(tabs.map((t) => t.textContent)).toEqual([
      'Field reports',
      'Sets',
      'Mixes',
      'Summary',
      'Settings',
    ]);
    expect(within(nav).getByRole('tab', { name: 'Sets' })).toHaveAttribute('aria-selected', 'true');
    expect(within(nav).getByRole('tab', { name: 'Mixes' })).toHaveAttribute(
      'href',
      concreteTabPath(PROJECT.id, 'mixes'),
    );
    await screen.findByText('Set 2');
  });

  it('opens Sets from the former Specimens address', async () => {
    renderAt(`/projects/${PROJECT.id}/concrete/specimens`);
    expect(await screen.findByTestId('where')).toHaveTextContent(
      concreteTabPath(PROJECT.id, 'sets'),
    );
  });

  it('lists each set with its working label, test ages and n of m tested', async () => {
    renderAt(concreteTabPath(PROJECT.id, 'sets'));
    expect(await screen.findByRole('link', { name: 'Open Set 2' })).toHaveAttribute(
      'href',
      '/concrete/specimens/set-2',
    );
    expect(screen.getByText('2A–2D')).toBeInTheDocument();
    expect(screen.getAllByRole('progressbar', { name: '1 of 3 tested' })).toHaveLength(2);
    expect(screen.getAllByText('7, 28, 28, HOLD')).toHaveLength(2);
    expect(screen.getByText('Break today')).toBeInTheDocument();
    expect(screen.getByText('Today')).toBeInTheDocument();
    expect(
      screen.getByText(/permanent set numbering is an open item \(package 3\)/),
    ).toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Strength reports' })).toBeInTheDocument();
  });

  it('says when the project has no sets yet', async () => {
    fetchProjectSets.mockResolvedValue({ ...SETS, items: [], total: 0 });
    renderAt(concreteTabPath(PROJECT.id, 'sets'));
    expect(await screen.findByText('No specimen sets for this project yet.')).toBeInTheDocument();
  });
});
