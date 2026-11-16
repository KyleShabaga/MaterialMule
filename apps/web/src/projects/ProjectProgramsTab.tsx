import type { LabProgramList, LabProgramSummary } from '@materialmule/shared';
import { Flag, FlaskConical } from 'lucide-react';
import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
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
import { fetchProjectPrograms, type LoadResult } from './api';
import { programName, programStage, programStatusLabel, useDebounced } from './project-format';
import { useProjectLayout } from './project-layout-context';
import { LoadErrorAlert, ProgramProgress, TablePager } from './project-ui';

const PAGE_SIZE = 25;

/** Program state tabs over the API's `status`. */
const PROGRAM_STATES = [
  { id: 'open', label: 'Open', status: 'submitted' },
  { id: 'drafts', label: 'Drafts (mine)', status: 'draft' },
  { id: 'closed', label: 'Closed', status: 'closed' },
] as const;
type ProgramState = (typeof PROGRAM_STATES)[number]['id'];

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Most recent first', sort: null },
  { label: 'Submitted, newest first', sort: { key: 'submitted', dir: 'desc' } },
  { label: 'Program number', sort: { key: 'number', dir: 'asc' } },
];
const SORT_LABELS = {
  submitted: { asc: 'Submitted, oldest first', desc: 'Submitted, newest first' },
  number: { asc: 'Program number A–Z', desc: 'Program number Z–A' },
};
const SORT_KEYS = new Set(['submitted', 'number']);

function readState(params: URLSearchParams): ProgramState {
  const value = params.get('state');
  return PROGRAM_STATES.some((s) => s.id === value) ? (value as ProgramState) : 'open';
}

const programPath = (program: LabProgramSummary) =>
  `/lab-testing/programs/${encodeURIComponent(program.id)}`;

/**
 * The project's Lab programs tab (STRATA-84, canvas R4Programs*; round 5 list pattern). Progress
 * only: results are recorded outside Material Mule. Rows open the program page.
 */
export function ProjectProgramsTab() {
  const { project } = useProjectLayout();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('project-programs');
  const state = readState(params);
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const sort = query.sort && SORT_KEYS.has(query.sort.key) ? query.sort : null;
  const search = useDebounced(query.search);

  const requestKey = useMemo(() => {
    const request = new URLSearchParams({
      projectId: project.id,
      status: PROGRAM_STATES.find((s) => s.id === state)!.status,
      pageSize: String(PAGE_SIZE),
    });
    if (search.trim()) request.set('search', search.trim());
    if (sort) {
      request.set('sort', sort.key);
      request.set('dir', sort.dir);
    }
    if (page > 1) request.set('page', String(page));
    return request.toString();
  }, [project.id, state, search, sort, page]);

  const [result, setResult] = useState<(LoadResult<LabProgramList> & { key: string }) | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchProjectPrograms(new URLSearchParams(requestKey)).then((response) => {
      if (!cancelled) setResult({ ...response, key: requestKey });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);
  const loading = !result || result.key !== requestKey;
  const data = result?.ok ? result.data : null;
  const counts = project.labProgramCounts;

  const setParam = (key: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page') next.delete('page');
      return next;
    });

  const columns = useMemo<DataTableColumn<LabProgramSummary>[]>(
    () => [
      {
        id: 'program',
        header: 'Program',
        priority: 'identity',
        mono: true,
        width: '17ch',
        sortKey: 'number',
        cell: (program) => (
          <Button
            variant="link"
            asChild
            className="h-auto p-0 font-mono focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
          >
            <Link to={programPath(program)}>{programName(program)}</Link>
          </Button>
        ),
      },
      {
        id: 'requestedBy',
        header: 'Requested by',
        priority: 'attribute',
        hideOrder: 2,
        cell: (program) => (
          <PersonCell name={program.requestedBy.name} userId={program.requestedBy.userId} />
        ),
      },
      {
        id: 'submitted',
        header: 'Submitted',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        sortKey: 'submitted',
        hideOrder: 1,
        cell: (program) => program.submittedAt?.slice(0, 10) ?? '—',
      },
      {
        id: 'priority',
        header: 'Priority',
        priority: 'attribute',
        width: '9rem',
        hideOrder: 3,
        cell: (program) =>
          program.priority === 'urgent' ? (
            <StageTag variant="outline" icon={Flag} label="Urgent · Priority" />
          ) : (
            'Normal'
          ),
      },
      {
        id: 'progress',
        header: 'Progress',
        priority: 'state',
        width: '8rem',
        control: true,
        cell: (program) => <ProgramProgress program={program} />,
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '12rem',
        wrap: true,
        cell: (program) => (
          <StageTag stage={programStage(program)} label={programStatusLabel(program)} />
        ),
      },
    ],
    [],
  );

  const toolbarQuery: TableQuery = { ...query, sort, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };

  let body: ReactNode;
  if (result && !result.ok && !loading) {
    body = (
      <LoadErrorAlert
        title="Lab programs couldn't load"
        message={result.message}
        onRetry={() => setReloads((n) => n + 1)}
      />
    );
  } else if (data && data.total === 0 && !loading) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FlaskConical aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {query.search.trim()
              ? 'No lab programs match this search.'
              : state === 'drafts'
                ? 'You have no draft lab programs for this project.'
                : state === 'closed'
                  ? 'No closed lab programs yet.'
                  : 'No open lab programs.'}
          </EmptyTitle>
          {state === 'drafts' ? (
            <EmptyDescription>
              Drafts have no LP number; the number is issued on submit.
            </EmptyDescription>
          ) : null}
        </EmptyHeader>
      </Empty>
    );
  } else {
    body = (
      <>
        <DataTable
          columns={columns}
          data={data?.items ?? []}
          getRowId={(program) => program.id}
          rowLabel={programName}
          density={density}
          sort={sort}
          onSortChange={(next) => setQuery({ sort: next })}
          stage={programStage}
          onOpenRow={(program) => navigate(programPath(program))}
          caption={`Lab programs on ${project.projectNumber}`}
          loading={!data && loading}
        />
        {data ? (
          <TablePager
            page={page}
            pageSize={PAGE_SIZE}
            total={data.total}
            noun={data.total === 1 ? 'lab program' : 'lab programs'}
            onPage={(next) => setParam('page', next > 1 ? String(next) : null)}
          />
        ) : null}
      </>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Tabs
          value={state}
          onValueChange={(next) => setParam('state', next === 'open' ? null : next)}
        >
          <TabsList
            aria-label="Program state"
            className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
          >
            {PROGRAM_STATES.map((s) => (
              <TabsTrigger key={s.id} value={s.id}>
                {s.label}
                {counts && s.id !== 'drafts' ? ' ' : null}
                {counts && s.id !== 'drafts' ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {s.id === 'open' ? counts.open : counts.closed}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
        <TableToolbar
          label="Lab programs tools"
          query={toolbarQuery}
          onQueryChange={onQueryChange}
          sortOptions={SORT_OPTIONS}
          sortLabels={SORT_LABELS}
          views={DENSITY_VIEW_OPTIONS}
          searchPlaceholder="Search this project's programs…"
        />
      </div>
      <p className="text-sm text-muted-foreground">
        Progress only. Results are recorded outside Material Mule.
      </p>
      <div aria-busy={loading} className="min-w-0">
        {body}
      </div>
    </div>
  );
}
