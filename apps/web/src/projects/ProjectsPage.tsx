import type { ProjectListItem, ProjectListPage } from '@materialmule/shared';
import { ArrowDownToLine, Folder, SearchX } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '../components/strata/data-table';
import { PersonCell } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortOption, type TableQuery } from '../components/strata/table-query';
import { START_DELIVERY_PATH } from '../receiving-log/paths';
import { useMe } from '../session/context';
import { fetchProjects, type LoadResult } from './api';
import { nominationLine, useDebounced } from './project-format';
import { LoadErrorAlert, TablePager } from './project-ui';
import {
  projectListRequest,
  projectListSort,
  projectsTabParams,
  readPage,
  readPageSize,
  readProjectsTab,
  type ProjectsTab,
} from './url-state';

/** Where the project page's "Projects" breadcrumb returns to (the list's own query). */
export interface ProjectLinkState {
  from?: string;
}

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Number A–Z', sort: null },
  { label: 'Number Z–A', sort: { key: 'number', dir: 'desc' } },
  { label: 'Name A–Z', sort: { key: 'name', dir: 'asc' } },
  { label: 'Last receipt, newest first', sort: { key: 'last_receipt', dir: 'desc' } },
];

const SORT_LABELS = {
  number: { asc: 'Number A–Z', desc: 'Number Z–A' },
  name: { asc: 'Name A–Z', desc: 'Name Z–A' },
  last_receipt: { asc: 'Last receipt, oldest first', desc: 'Last receipt, newest first' },
};

const TAB_LABEL: Record<ProjectsTab, string> = {
  mine: 'My projects',
  all: 'All projects',
  waiting: 'Waiting for a lead',
};

const TABLE_LABEL: Record<ProjectsTab, string> = {
  mine: 'My projects',
  all: 'All projects',
  waiting: 'Projects waiting for a lead',
};

function LeadCell({ project }: { project: ProjectListItem }) {
  const lead = project.leadProjectEngineer;
  if (lead) return <PersonCell name={lead.displayName} userId={lead.id} />;
  // D02 (MM-AO04): a project can wait for a lead; receiving carries on meanwhile.
  return (
    <span className="flex min-w-0 flex-col items-start gap-0.5">
      <StageTag stage="due" label="Waiting for a lead" />
      <span className="max-w-full truncate text-xs text-muted-foreground">
        {nominationLine(project)}
      </span>
    </span>
  );
}

/**
 * Projects list (STRATA-83, canvas R4List*): segmented tabs My projects (default), All projects
 * and Waiting for a lead, each with its server count; table tools; a server-searched, sorted and
 * paged table. Projects are created while receiving, so there is no page action here.
 */
export function ProjectsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const canMine = me.accountType !== 'shared_lab';
  const tab = readProjectsTab(params, canMine);
  const page = readPage(params);
  const pageSize = readPageSize(params);
  const [density, setDensity] = useTableDensity('projects');

  const search = useDebounced(query.search);
  const requestKey = projectListRequest(
    tab,
    { search, sort: query.sort },
    page,
    pageSize,
  ).toString();
  const [result, setResult] = useState<(LoadResult<ProjectListPage> & { key: string }) | null>(
    null,
  );
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchProjects(new URLSearchParams(requestKey)).then((response) => {
      if (!cancelled) setResult({ ...response, key: requestKey });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const loading = !result || result.key !== requestKey;
  // Keep the last page on screen while the next one loads, so the table doesn't flash.
  const data = result?.ok ? result.data : null;
  const counts = data?.tabCounts;
  const linkState: ProjectLinkState = { from: location.search };

  const toolbarQuery: TableQuery = { ...query, sort: projectListSort(query.sort), view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };

  const columns = useMemo<DataTableColumn<ProjectListItem>[]>(
    () => [
      {
        id: 'number',
        header: 'Number',
        priority: 'identity',
        mono: true,
        width: '12ch',
        sortKey: 'number',
        cell: (project) => (
          <Button variant="link" asChild className="h-auto p-0 font-mono">
            <Link
              to={`/projects/${project.id}`}
              state={linkState}
              aria-label={`Open project ${project.projectNumber}`}
            >
              {project.projectNumber}
            </Link>
          </Button>
        ),
      },
      {
        id: 'name',
        header: 'Name',
        priority: 'identity',
        sortKey: 'name',
        cell: (project) => (
          <span className="truncate" title={`${project.name} · ${project.client}`}>
            {project.name}
          </span>
        ),
      },
      {
        id: 'lead',
        header: 'Lead',
        priority: 'state',
        width: '16rem',
        wrap: true,
        cell: (project) => <LeadCell project={project} />,
      },
      {
        id: 'testHoles',
        header: 'Test holes',
        priority: 'attribute',
        numeric: true,
        width: '6rem',
        // DESIGN.md › Projects: at 1024 px (table narrower than 50rem) Test holes hides.
        hideBelow: '50rem',
        cell: (project) => project.testHoleCount.toLocaleString('en-CA'),
      },
      {
        id: 'inStock',
        header: 'Units in stock',
        priority: 'attribute',
        numeric: true,
        width: '7.5rem',
        cell: (project) => project.inStockUnitCount.toLocaleString('en-CA'),
      },
      {
        id: 'lastReceipt',
        header: 'Last receipt',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        sortKey: 'last_receipt',
        cell: (project) => project.lastReceiptDate ?? '—',
      },
    ],
    // linkState follows the URL; the columns only need it for the links.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [location.search],
  );

  function chooseTab(next: string) {
    setParams(projectsTabParams(params, next as ProjectsTab));
  }

  function goToPage(next: number) {
    setParams((current) => {
      const updated = new URLSearchParams(current);
      if (next > 1) updated.set('page', String(next));
      else updated.delete('page');
      return updated;
    });
  }

  const tabs: ProjectsTab[] = canMine ? ['mine', 'all', 'waiting'] : ['all', 'waiting'];
  const searching = query.search.trim() !== '';

  let body: ReactNode;
  if (result && !result.ok && !loading) {
    body = (
      <LoadErrorAlert
        title="Projects couldn't load"
        message={result.message}
        onRetry={() => setReloads((n) => n + 1)}
      />
    );
  } else if (data && data.total === 0 && !loading) {
    body = (
      <EmptyProjects
        tab={tab}
        searching={searching}
        anyProjects={(counts?.all ?? 0) > 0}
        canReceive={me.permissions.includes('receipt.confirm')}
        onClear={() => setQuery({ search: '' })}
        onAll={() => chooseTab('all')}
      />
    );
  } else {
    body = (
      <>
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          getRowId={(project) => project.id}
          rowLabel={(project) => project.projectNumber}
          density={density}
          sort={projectListSort(query.sort)}
          onSortChange={(sort) => setQuery({ sort })}
          onOpenRow={(project) => navigate(`/projects/${project.id}`, { state: linkState })}
          caption={TABLE_LABEL[tab]}
          loading={!data && loading}
        />
        {data ? (
          <TablePager
            page={page}
            pageSize={data.pageSize}
            total={data.total}
            noun={data.total === 1 ? 'project' : 'projects'}
            onPage={goToPage}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-4">
      <h1 className="sr-only">Projects</h1>
      <Tabs value={tab} onValueChange={chooseTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList
            aria-label="Projects"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {tabs.map((id) => (
              <TabsTrigger key={id} value={id}>
                {TAB_LABEL[id]}
                {counts ? ' ' : null}
                {counts ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {(id === 'mine'
                      ? counts.mine
                      : id === 'all'
                        ? counts.all
                        : counts.waitingForLead
                    ).toLocaleString('en-CA')}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TableToolbar
            label="Projects tools"
            query={toolbarQuery}
            onQueryChange={onQueryChange}
            sortOptions={SORT_OPTIONS}
            sortLabels={SORT_LABELS}
            views={DENSITY_VIEW_OPTIONS}
            searchPlaceholder="Search projects…"
          />
        </div>
        <TabsContent value={tab} className="flex flex-col gap-3 pt-2">
          {tab === 'mine' ? (
            <p className="text-sm text-muted-foreground">
              Projects you lead or are on the team of.
            </p>
          ) : tab === 'waiting' ? (
            <p className="text-sm text-muted-foreground">
              Receiving works on these projects. Decisions only a lead can make wait until an admin
              appoints one.
            </p>
          ) : null}
          <div aria-busy={loading} className="min-w-0">
            {body}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  );
}

function EmptyProjects({
  tab,
  searching,
  anyProjects,
  canReceive,
  onClear,
  onAll,
}: {
  tab: ProjectsTab;
  searching: boolean;
  anyProjects: boolean;
  canReceive: boolean;
  onClear: () => void;
  onAll: () => void;
}) {
  if (searching) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No projects match this search.</EmptyTitle>
          <EmptyDescription>Check the number or the name, or clear the search.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onClear}>
            Clear the search
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  if (!anyProjects) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Folder aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No projects yet.</EmptyTitle>
          <EmptyDescription>Projects are added while receiving samples.</EmptyDescription>
        </EmptyHeader>
        {canReceive ? (
          <EmptyContent>
            <Button asChild>
              <Link to={START_DELIVERY_PATH}>
                <ArrowDownToLine aria-hidden="true" />
                Receive samples
              </Link>
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  }
  return (
    <Empty>
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <Folder aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>
          {tab === 'waiting' ? 'Every project has a lead.' : 'No projects of yours yet.'}
        </EmptyTitle>
        <EmptyDescription>
          {tab === 'waiting'
            ? 'Projects saved without a Lead Project Engineer show here until an admin appoints one.'
            : 'Projects you lead or are on the team of show here.'}
        </EmptyDescription>
      </EmptyHeader>
      {tab === 'mine' ? (
        <EmptyContent>
          <Button variant="outline" onClick={onAll}>
            Show all projects
          </Button>
        </EmptyContent>
      ) : null}
    </Empty>
  );
}
