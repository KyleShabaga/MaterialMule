import {
  LAB_PROGRAM_PAGE_SIZE,
  LAB_PROGRAM_PHASE_TAG,
  type LabProgramList,
  type LabProgramSummary,
} from '@materialmule/shared';
import { FlaskConical, SearchX, TriangleAlert } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type MouseEvent } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
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
import { PeekSplit, usePeekAvailable, usePeekParam } from '../components/strata/peek';
import { PersonCell } from '../components/strata/person-avatar';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortOption } from '../components/strata/table-query';
import { useMe } from '../session/context';
import { fetchPrograms } from './api';
import { activityTime, recordDate } from './format';
import { ProgramPeek } from './ProgramPeek';
import { PriorityTag, ProgramStatusTag, programPhase } from './program-tags';
import { ProgressMeter } from './ProgressCells';

// Lab programs › Programs (STRATA-87, DESIGN.md › Soils lab, boards R5List*): tabs Open, Drafts
// (mine) and Closed with counts; table tools (search, sort, view) sent to the server, which pages
// and sorts; rows open the program in the drawer (≥ 1024 px) or on its own page. Progress only.

export type ProgramsTab = 'open' | 'drafts' | 'closed';

const TABS: { id: ProgramsTab; label: string; status: LabProgramSummary['status'] }[] = [
  { id: 'open', label: 'Open', status: 'submitted' },
  { id: 'drafts', label: 'Drafts (mine)', status: 'draft' },
  { id: 'closed', label: 'Closed', status: 'closed' },
];

const SORT_OPTIONS: SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Program number', sort: { key: 'number', dir: 'asc' } },
  { label: 'Project', sort: { key: 'project', dir: 'asc' } },
  { label: 'Submitted, oldest first', sort: { key: 'submitted', dir: 'asc' } },
];

const SORT_LABELS = {
  number: { asc: 'Program number A–Z', desc: 'Program number Z–A' },
  project: { asc: 'Project A–Z', desc: 'Project Z–A' },
  submitted: { asc: 'Submitted, oldest first', desc: 'Submitted, newest first' },
};

const NO_ROWS: LabProgramSummary[] = [];

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: LabProgramList };

function linesText(row: LabProgramSummary): string {
  const lines = `${row.lineCount} ${row.lineCount === 1 ? 'line' : 'lines'}`;
  if (row.testCount === 0) return `${lines} · no tests yet`;
  return `${lines} · ${row.testCount} ${row.testCount === 1 ? 'test' : 'tests'}`;
}

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), ms);
    return () => clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

export function ProgramsPage() {
  const me = useMe();
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const [density, setDensity] = useTableDensity('lab-programs');
  const tab: ProgramsTab =
    TABS.find((t) => t.id === params.get('tab'))?.id ?? ('open' as ProgramsTab);
  const status = TABS.find((t) => t.id === tab)!.status;
  const page = Math.max(1, Number(params.get('page')) || 1);
  const search = useDebounced(query.search, 250);
  const [attempt, setAttempt] = useState(0);

  // Each answer is kept with the request it answers; one for an earlier tab, page, search or
  // retry never fills the table (it reads as loading until the current answer arrives).
  const requestKey = JSON.stringify([status, page, search, query.sort, attempt]);
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // Tab counts stay from the last answer while the next one loads.
  const [counts, setCounts] = useState<LabProgramList['counts']>();

  const setPage = (next: number) =>
    setParams((current) => {
      const copy = new URLSearchParams(current);
      if (next > 1) copy.set('page', String(next));
      else copy.delete('page');
      return copy;
    });

  useEffect(() => {
    let current = true;
    fetchPrograms({
      status,
      page,
      search,
      sort: query.sort?.key,
      dir: query.sort?.dir,
    }).then(
      (list) => {
        if (!current) return;
        if (list.counts) setCounts(list.counts);
        const lastPage = Math.max(1, Math.ceil(list.total / LAB_PROGRAM_PAGE_SIZE));
        // Programs can disappear between pages (a draft deleted elsewhere): step back.
        if (list.items.length === 0 && page > lastPage) setPage(lastPage);
        else setAnswer({ key: requestKey, load: { state: 'ready', list } });
      },
      () => current && setAnswer({ key: requestKey, load: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
    // setPage is stable enough: it only writes the URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [requestKey]);

  const rows = load.state === 'ready' ? load.list.items : NO_ROWS;
  const total = load.state === 'ready' ? load.list.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / LAB_PROGRAM_PAGE_SIZE));
  const first = (page - 1) * LAB_PROGRAM_PAGE_SIZE + 1;

  const openPeek = peek.open;
  const openRow = useCallback(
    (row: LabProgramSummary) => {
      // Drafts open in the editor; elsewhere the drawer, or the page on narrow screens.
      if (row.status === 'draft' || !peekAvailable) navigate(`/lab-testing/programs/${row.id}`);
      else openPeek(row.id);
    },
    [navigate, openPeek, peekAvailable],
  );

  const changeTab = (next: string) =>
    setParams((current) => {
      const copy = new URLSearchParams(current);
      if (next === 'open') copy.delete('tab');
      else copy.set('tab', next);
      copy.delete('page');
      copy.delete('open');
      return copy;
    });

  const columns = useProgramColumns(tab, openRow);
  const ids = rows.map((row) => row.id);
  const drawerOpen = peekAvailable && peek.openId !== null && tab !== 'drafts';

  const list = (
    <section aria-labelledby="programs-heading" className="flex min-w-0 flex-col gap-3">
      <h2 id="programs-heading" className="sr-only">
        Programs
      </h2>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <TabsList
          aria-label="Show"
          className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
        >
          {TABS.map((t) => (
            <TabsTrigger key={t.id} value={t.id}>
              {t.label}
              {counts ? (
                <span className="text-muted-foreground tabular-nums">
                  {t.id === 'open'
                    ? counts.open
                    : t.id === 'drafts'
                      ? counts.drafts
                      : counts.closed}
                </span>
              ) : null}
            </TabsTrigger>
          ))}
        </TabsList>
        <TableToolbar
          label="Program tools"
          query={{ ...query, view: density === 'comfortable' ? null : density }}
          onQueryChange={(patch) => {
            if (patch.view !== undefined) {
              // The View menu is the row density, kept per browser (not in the URL).
              setDensity(
                DENSITY_VIEW_OPTIONS.find((v) => v.id === patch.view)?.id ?? 'comfortable',
              );
              return;
            }
            setQuery(patch);
          }}
          sortOptions={tab === 'drafts' ? undefined : SORT_OPTIONS}
          sortLabels={SORT_LABELS}
          views={DENSITY_VIEW_OPTIONS}
          searchPlaceholder="Search programs and projects…"
        />
      </div>
      <TabsContent value={tab} className="flex min-w-0 flex-col gap-3">
        {tab === 'drafts' ? (
          <p className="text-sm text-muted-foreground">
            Only your own drafts are listed. A draft gets its LP number when it is submitted.
          </p>
        ) : null}
        {load.state === 'error' ? (
          <Empty className="border">
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <TriangleAlert aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>The programs couldn’t be loaded.</EmptyTitle>
              <EmptyDescription>Check the connection and try again.</EmptyDescription>
            </EmptyHeader>
            <EmptyContent>
              <Button variant="outline" onClick={() => setAttempt((n) => n + 1)}>
                Try again
              </Button>
            </EmptyContent>
          </Empty>
        ) : load.state === 'ready' && rows.length === 0 ? (
          <ProgramsEmpty
            tab={tab}
            search={search}
            canEnter={me.permissions.includes('lab_program.manage')}
            onClearSearch={() => setQuery({ search: '' })}
          />
        ) : (
          <>
            {load.state === 'ready' ? (
              <p className="text-sm text-muted-foreground" role="status">
                {total > LAB_PROGRAM_PAGE_SIZE
                  ? `Showing ${first}–${first + rows.length - 1} of ${total} programs`
                  : `${total} ${total === 1 ? 'program' : 'programs'}`}
              </p>
            ) : null}
            <DataTable
              caption="Testing programs"
              columns={columns}
              data={rows}
              getRowId={(row) => row.id}
              rowLabel={(row) => row.programNumber ?? 'Draft lab program'}
              density={density}
              loading={load.state === 'loading'}
              sort={query.sort}
              onSortChange={(sort) => setQuery({ sort })}
              stage={(row) => LAB_PROGRAM_PHASE_TAG[programPhase(row)].stage}
              onOpenRow={openRow}
              openRowId={drawerOpen ? peek.openId : null}
            />
          </>
        )}
        {tab === 'closed' && load.state === 'ready' && rows.length > 0 ? (
          <p className="text-sm text-muted-foreground">
            Closed programs keep their lines, comments and history.
          </p>
        ) : null}
        {total > LAB_PROGRAM_PAGE_SIZE ? (
          <nav className="flex items-center justify-end gap-2" aria-label="Pages">
            <Button
              variant="outline"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage(page - 1)}
            >
              Previous
            </Button>
            <span className="text-sm tabular-nums">
              Page {page} of {totalPages}
            </span>
            <Button
              variant="outline"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage(page + 1)}
            >
              Next
            </Button>
          </nav>
        ) : null}
      </TabsContent>
    </section>
  );

  return (
    <Tabs value={tab} onValueChange={changeTab} className="min-w-0">
      <PeekSplit
        open={drawerOpen}
        openId={peek.openId}
        listLabel="Testing programs"
        drawerLabel="Lab program"
        list={list}
        drawer={
          drawerOpen && peek.openId ? (
            <ProgramPeek
              key={peek.openId}
              programId={peek.openId}
              summary={rows.find((row) => row.id === peek.openId) ?? null}
              ids={ids}
              onOpen={(id) => peek.open(id)}
              onClose={peek.close}
            />
          ) : null
        }
      />
    </Tabs>
  );
}

function ProgramsEmpty({
  tab,
  search,
  canEnter,
  onClearSearch,
}: {
  tab: ProgramsTab;
  search: string;
  canEnter: boolean;
  onClearSearch: () => void;
}) {
  if (search.trim()) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <SearchX aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>No programs match “{search.trim()}”.</EmptyTitle>
          <EmptyDescription>Search looks at program numbers and projects.</EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button variant="outline" onClick={onClearSearch}>
            Clear search
          </Button>
        </EmptyContent>
      </Empty>
    );
  }
  const words: Record<ProgramsTab, { title: string; description: string }> = {
    open: {
      title: 'No lab programs are open.',
      description: `A program appears here once it is submitted to the lab.${
        canEnter ? ' Start one with New lab program.' : ''
      }`,
    },
    drafts: {
      title: 'You have no drafts.',
      description: 'A program you start stays here as a draft until you submit it.',
    },
    closed: {
      title: 'No closed programs yet.',
      description: 'A program closes once every test is accepted or cancelled with a reason.',
    },
  };
  return (
    <Empty className="border">
      <EmptyHeader>
        <EmptyMedia variant="icon">
          <FlaskConical aria-hidden="true" />
        </EmptyMedia>
        <EmptyTitle>{words[tab].title}</EmptyTitle>
        <EmptyDescription>{words[tab].description}</EmptyDescription>
      </EmptyHeader>
    </Empty>
  );
}

/** A modified click (new tab) follows the link; a plain one opens the program like the row. */
function rowLinkClick(event: MouseEvent<HTMLAnchorElement>, open: () => void) {
  event.stopPropagation();
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.button !== 0) return;
  event.preventDefault();
  open();
}

function useProgramColumns(
  tab: ProgramsTab,
  openRow: (row: LabProgramSummary) => void,
): DataTableColumn<LabProgramSummary>[] {
  return useMemo(() => {
    const program: DataTableColumn<LabProgramSummary> = {
      id: 'program',
      header: tab === 'drafts' ? 'Draft' : 'Program',
      priority: 'identity',
      mono: tab !== 'drafts',
      width: tab === 'drafts' ? '10rem' : '13ch',
      sortKey: tab === 'drafts' ? undefined : 'number',
      control: true,
      cell: (row) => (
        <Button variant="link" asChild className="h-auto p-0 font-[inherit]">
          <Link
            to={`/lab-testing/programs/${row.id}`}
            onClick={(event) => rowLinkClick(event, () => openRow(row))}
          >
            {row.programNumber ?? 'Draft lab program'}
          </Link>
        </Button>
      ),
    };
    const project: DataTableColumn<LabProgramSummary> = {
      id: 'project',
      header: 'Project',
      priority: 'identity',
      sortKey: tab === 'drafts' ? undefined : 'project',
      cell: (row) => (
        <span className="flex min-w-0 gap-2" title={row.project.name}>
          <span className="font-mono">{row.project.projectNumber}</span>
          <span className="min-w-0 truncate">{row.project.name}</span>
        </span>
      ),
    };
    const status: DataTableColumn<LabProgramSummary> = {
      id: 'status',
      header: 'Status',
      priority: 'state',
      wrap: true,
      width: '11rem',
      cell: (row) => <ProgramStatusTag phase={programPhase(row)} />,
    };
    if (tab === 'drafts') {
      return [
        program,
        project,
        {
          id: 'lines',
          header: 'Lines',
          priority: 'attribute',
          width: '9rem',
          hideOrder: 1,
          cell: (row) => linesText(row),
        },
        {
          id: 'saved',
          header: 'Last saved',
          priority: 'attribute',
          width: '11rem',
          hideOrder: 2,
          cell: (row) => activityTime(row.updatedAt),
        },
        status,
      ];
    }
    return [
      program,
      project,
      {
        id: 'requestedBy',
        header: 'Requested by',
        priority: 'attribute',
        width: '10rem',
        hideOrder: 2,
        cell: (row) => <PersonCell name={row.requestedBy.name} userId={row.requestedBy.userId} />,
      },
      tab === 'closed'
        ? {
            id: 'closed',
            header: 'Closed',
            priority: 'attribute',
            mono: true,
            width: '10ch',
            hideOrder: 1,
            cell: (row) => (row.closedAt ? recordDate(row.closedAt) : '—'),
          }
        : {
            id: 'submitted',
            header: 'Submitted',
            priority: 'attribute',
            mono: true,
            width: '10ch',
            hideOrder: 1,
            sortKey: 'submitted',
            cell: (row) => (row.submittedAt ? recordDate(row.submittedAt) : '—'),
          },
      {
        id: 'priority',
        header: 'Priority',
        priority: 'attribute',
        width: '10rem',
        hideOrder: 3,
        control: true,
        cell: (row) => <PriorityTag priority={row.priority} />,
      },
      {
        id: 'progress',
        header: 'Progress',
        priority: 'attribute',
        width: '7rem',
        hideOrder: 4,
        cell: (row) => <ProgressMeter progress={row.progress} />,
      },
      status,
    ];
  }, [tab, openRow]);
}
