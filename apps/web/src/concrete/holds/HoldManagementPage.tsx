import {
  CONCRETE_HOLD_KIND_LABEL,
  type ConcreteHoldHistory,
  type ConcreteHoldList,
  type ConcreteHoldRow,
} from '@materialmule/shared';
import { CalendarPlus, History, Hourglass, RotateCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { useEffect, useId, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Separator } from '@/components/ui/separator';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { StageTag } from '../../components/strata/stage-tag';
import { useTableQuery, type TableQuery } from '../../components/strata/table-query';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { notifySuccess } from '../../components/strata/toast';
import { useMe } from '../../session/context';
import { setLookupPath } from '../lab/format';
import { fetchHoldHistory, fetchHolds, type LoadResult } from './api';
import { HoldActionDialogs } from './HoldDialogs';
import {
  blockedReason,
  HOLD_ACTION_LABEL,
  HOLD_ACTIONS,
  HOLD_STATE,
  HOLD_TABS,
  holdName,
  readHoldTab,
  STATUS_FILTERS,
  statusFilterOf,
  type HoldAction,
  type HoldTab,
} from './hold-actions';

// Concrete → Holds (STRATA-95 part B, canvas R7Holds*; MM-V2-C26 rules). Tabs All holds,
// Failed-specimen holds and Ordinary HOLD; the page opens on open holds only (inside the hold
// period or past it), with Disposal authorized and Disposed under Filter as a chip. The selection
// bar keeps Schedule test, Authorize disposal and Record disposal visible; each is offered when
// every selected specimen allows it (the server's per-row actions), else disabled with the
// reason. Reaching a hold date only flags it: nothing is tested, released or disposed of on its
// own.

const ACTION_ICON = {
  schedule_test: CalendarPlus,
  authorize_disposal: ShieldCheck,
  record_disposal: Trash2,
} as const;

const projectFilterId = (id: string) => `project:${id}`;

function historyLine(e: ConcreteHoldHistory['events'][number]): string {
  switch (e.kind) {
    case 'test_scheduled':
      return `Test scheduled at ${e.newAge} d (target ${e.newTargetDate})`;
    case 'disposal_authorized':
      return 'Disposal authorized';
    case 'disposed':
      return `Disposed (removed ${new Date(e.disposedAt!).toLocaleString()})`;
    case 'hold_assigned':
      return `Held until ${e.holdUntil} (was ${e.previousAge} d, target ${e.previousTargetDate})`;
    default:
      return 'Failed-specimen hold';
  }
}

export function HoldManagementPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const tab = readHoldTab(params.get('tab'));
  const status = statusFilterOf(query.filters);
  const projectFilter = query.filters.find((f) => f.startsWith('project:')) ?? null;
  const projectId = projectFilter ? projectFilter.slice('project:'.length) : '';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [reload, setReload] = useState(0);
  const requestKey = `${tab}|${status}|${projectId}|${page}|${reload}`;
  const [answer, setAnswer] = useState<{
    key: string;
    lists: Record<HoldTab, LoadResult<ConcreteHoldList>>;
  } | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<HoldAction | null>(null);
  const [historyOf, setHistoryOf] = useState<ConcreteHoldRow | null>(null);
  const [history, setHistory] = useState<{ id: string; data: ConcreteHoldHistory | null } | null>(
    null,
  );
  const whyId = useId();

  useEffect(() => {
    let current = true;
    // The selected tab's rows, and the other two kinds for their tab counts.
    void Promise.all(
      HOLD_TABS.map((t) =>
        fetchHolds({ kind: t.id, status, projectId, page: t.id === tab ? page : 1 }),
      ),
    ).then(([all, failed, ordinary]) => {
      if (current)
        setAnswer({ key: requestKey, lists: { all: all!, failed: failed!, ordinary: ordinary! } });
    });
    return () => {
      current = false;
    };
  }, [tab, status, projectId, page, requestKey]);

  useEffect(() => {
    if (!historyOf) return;
    let current = true;
    void fetchHoldHistory(historyOf.specimenId).then((result) => {
      if (current) setHistory({ id: historyOf.specimenId, data: result.ok ? result.data : null });
    });
    return () => {
      current = false;
    };
  }, [historyOf]);

  const ready = answer?.key === requestKey ? answer : null;
  const load = ready?.lists[tab] ?? null;
  const list = load?.ok ? load.data : null;
  const rows = useMemo(() => {
    const q = query.search.trim().toLowerCase();
    const all = list?.rows ?? [];
    return q
      ? all.filter((r) =>
          [holdName(r), r.project.projectNumber, r.project.name].some((v) =>
            v.toLowerCase().includes(q),
          ),
        )
      : all;
  }, [list, query.search]);
  const chosen = rows.filter((r) => selected.has(r.specimenId));
  const reasons = HOLD_ACTIONS.map((a) => blockedReason(a, chosen)).filter(
    (r, i, all): r is string => r !== null && all.indexOf(r) === i,
  );

  const resetSelection = () => setSelected(new Set());
  const chooseTab = (next: string) => {
    const nextParams = new URLSearchParams(params);
    if (next === 'all') nextParams.delete('tab');
    else nextParams.set('tab', next);
    nextParams.delete('page');
    setParams(nextParams, { replace: true });
    resetSelection();
  };
  const goToPage = (next: number) => {
    const nextParams = new URLSearchParams(params);
    if (next > 1) nextParams.set('page', String(next));
    else nextParams.delete('page');
    setParams(nextParams, { replace: true });
    resetSelection();
  };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    if (patch.filters) {
      // One status and one project at a time: the server reads one of each.
      const added = patch.filters.filter((f) => !query.filters.includes(f));
      let next = patch.filters;
      for (const f of added) {
        const prefix = f.startsWith('status:') ? 'status:' : 'project:';
        next = next.filter((x) => x === f || !x.startsWith(prefix));
      }
      patch = { ...patch, filters: next };
      resetSelection();
    }
    setQuery(patch);
  };

  // Projects with any held specimen (the server's list), for the Filter menu.
  const projects = ready
    ? ((
        Object.values(ready.lists).find((l) => l.ok) as
          { ok: true; data: ConcreteHoldList } | undefined
      )?.data.projects ?? [])
    : [];
  const filterOptions = [
    ...STATUS_FILTERS.map((f) => ({
      ...f,
      count: list?.counts[f.id === 'status:disposed' ? 'disposed' : 'disposal_authorized'],
    })),
    ...projects.map((p) => ({ id: projectFilterId(p.id), label: p.projectNumber })),
  ];

  const columns: DataTableColumn<ConcreteHoldRow>[] = [
    {
      id: 'specimen',
      header: 'Specimen',
      priority: 'identity',
      width: '9rem',
      cell: (r) => (
        <Button variant="link" asChild className="h-auto p-0 font-mono font-semibold">
          <Link to={setLookupPath(r.setId, r.letter)}>{holdName(r)}</Link>
        </Button>
      ),
    },
    {
      id: 'kind',
      header: 'Kind',
      priority: 'attribute',
      width: '11rem',
      cell: (r) => (
        <span className="flex min-w-0 flex-col">
          <span>{r.holdKind === 'failed' ? 'Failed-specimen hold' : 'Ordinary HOLD'}</span>
          {r.failureReason ? (
            <span className="truncate text-[12px] text-muted-foreground" title={r.failureReason}>
              {r.failureReason}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: 'project',
      header: 'Project',
      priority: 'identity',
      cell: (r) => (
        <span className="flex min-w-0 gap-2" title={r.project.name}>
          <span className="font-mono">{r.project.projectNumber}</span>
          <span className="min-w-0 truncate text-muted-foreground">{r.project.name}</span>
        </span>
      ),
    },
    {
      id: 'cast',
      header: 'Casting date',
      priority: 'attribute',
      hideOrder: 1,
      mono: true,
      width: '10ch',
      cell: (r) =>
        r.castingDate ?? <span className="font-sans text-muted-foreground">Unknown</span>,
    },
    {
      id: 'until',
      header: 'Hold until',
      priority: 'attribute',
      width: '10ch',
      cell: (r) =>
        r.holdKind === 'failed' ? (
          'No expiry'
        ) : r.holdExpiresOn ? (
          <span className="font-mono">{r.holdExpiresOn}</span>
        ) : (
          <span className="text-muted-foreground">Unknown</span>
        ),
    },
    {
      id: 'state',
      header: 'State',
      priority: 'state',
      wrap: true,
      width: '12rem',
      cell: (r) =>
        r.status === 'held' ? (
          <StageTag variant="neutral" icon={Hourglass} label={HOLD_STATE.held.label} />
        ) : (
          <StageTag stage={HOLD_STATE[r.status].stage} label={HOLD_STATE[r.status].label} />
        ),
    },
    {
      id: 'history',
      header: <span className="sr-only">History</span>,
      priority: 'state',
      control: true,
      width: '2.25rem',
      cell: (r) => (
        <Button
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={`History of ${holdName(r)}`}
          onClick={() => {
            setHistory(null);
            setHistoryOf(r);
          }}
        >
          <History aria-hidden="true" />
        </Button>
      ),
    },
  ];

  const intro =
    status === 'disposal_authorized'
      ? 'Filtered to disposal authorized: these have left the open list and wait for someone to record their removal.'
      : status === 'disposed'
        ? 'Filtered to disposed: removed specimens keep their IDs and history.'
        : tab === 'failed'
          ? 'Placed when a tested specimen fails. Only the project lead or a Lab Manager with concrete authority can release one.'
          : 'Open holds only. Specimens authorized for disposal (waiting for removal) and disposed ones are under Filter. Reaching an ordinary HOLD date only flags it; nothing is tested, released or disposed of on its own.';

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const authorizedWaiting = list?.counts.disposal_authorized ?? 0;

  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-4">
      <h1 className="sr-only">Concrete holds</h1>
      <Tabs value={tab} onValueChange={chooseTab}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label="Hold kind" className="max-w-full justify-start overflow-x-auto">
            {HOLD_TABS.map((t) => {
              const count = ready?.lists[t.id];
              return (
                <TabsTrigger key={t.id} value={t.id}>
                  {t.label}
                  {count?.ok ? ' ' : null}
                  {count?.ok ? (
                    <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                      {count.data.counts[status]}
                    </span>
                  ) : null}
                </TabsTrigger>
              );
            })}
          </TabsList>
          <TableToolbar
            label="Holds tools"
            query={query}
            onQueryChange={onQueryChange}
            filters={filterOptions}
            searchPlaceholder="Search specimens or projects…"
          />
        </div>
      </Tabs>
      <p className="text-[13px] text-muted-foreground">{intro}</p>

      {chosen.length > 0 ? (
        <div
          role="region"
          aria-label="Selection"
          className="flex flex-col gap-1 rounded-xl border bg-card p-2 shadow-sm"
        >
          <div className="flex flex-wrap items-center gap-2">
            <span className="px-2 text-sm font-semibold" aria-live="polite">
              {chosen.length} {chosen.length === 1 ? 'specimen' : 'specimens'} selected
            </span>
            <Separator orientation="vertical" className="h-6" />
            {HOLD_ACTIONS.map((a) => {
              const Icon = ACTION_ICON[a];
              const blocked = blockedReason(a, chosen);
              return (
                <Button
                  key={a}
                  type="button"
                  size="sm"
                  variant={a === 'record_disposal' ? 'destructive' : 'outline'}
                  disabled={blocked !== null}
                  aria-describedby={blocked ? whyId : undefined}
                  onClick={() => setAction(a)}
                >
                  <Icon aria-hidden="true" />
                  {HOLD_ACTION_LABEL[a]}
                </Button>
              );
            })}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="Clear selection"
                  onClick={resetSelection}
                >
                  <X aria-hidden="true" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top">Clear selection</TooltipContent>
            </Tooltip>
          </div>
          <p id={whyId} className="px-2 pb-0.5 text-[12px] text-muted-foreground">
            Each action is offered when every selected specimen allows it.
            {reasons.length > 0 ? ` ${reasons.join(' ')}` : ''}
          </p>
        </div>
      ) : null}

      {load && !load.ok ? (
        <Alert variant="destructive">
          <AlertTitle>{load.message}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={() => setReload((n) => n + 1)}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : list && list.total === 0 && query.search === '' ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Hourglass aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {status === 'open'
                ? tab === 'failed'
                  ? 'No failed-specimen holds are open.'
                  : 'No specimens are on HOLD.'
                : status === 'disposal_authorized'
                  ? 'No specimens are waiting for removal.'
                  : 'No specimens have been disposed of.'}
            </EmptyTitle>
            <EmptyDescription>
              {status === 'open'
                ? `Spare specimens assigned HOLD show here with their hold-until date.${
                    authorizedWaiting > 0
                      ? ` ${authorizedWaiting} authorized for disposal ${authorizedWaiting === 1 ? 'is' : 'are'} under Filter.`
                      : ''
                  }`
                : 'Clear the filter to see open holds.'}
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <section aria-label="HOLD specimens" aria-busy={!ready} className="flex flex-col gap-3">
          {!ready ? (
            <p className="sr-only" role="status">
              Loading holds
            </p>
          ) : null}
          <DataTable
            columns={columns}
            data={ready ? rows : []}
            loading={!ready}
            getRowId={(r) => r.specimenId}
            rowLabel={holdName}
            stage={(r) => HOLD_STATE[r.status].stage}
            selectedIds={selected}
            onSelectedIdsChange={setSelected}
            caption="Specimens on hold"
            empty="No specimens match this search."
          />
          {list && list.total > list.pageSize ? (
            <nav className="flex items-center justify-end gap-2" aria-label="HOLD pages">
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </Button>
              <span className="font-mono text-sm tabular-nums">
                Page {page} of {totalPages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= totalPages}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </section>
      )}

      <HoldActionDialogs
        key={action ?? 'none'}
        action={action}
        rows={chosen}
        sharedStation={me.accountType === 'shared_lab'}
        onClose={() => setAction(null)}
        onDone={(message) => {
          setAction(null);
          notifySuccess(message);
          resetSelection();
          setReload((n) => n + 1);
        }}
      />

      <Sheet
        open={historyOf !== null}
        onOpenChange={(open) => (open ? undefined : setHistoryOf(null))}
      >
        <SheetContent className="w-full sm:max-w-[28rem]">
          <SheetHeader>
            <SheetTitle>
              History of <span className="font-mono">{historyOf ? holdName(historyOf) : ''}</span>
            </SheetTitle>
            <SheetDescription>
              {historyOf ? CONCRETE_HOLD_KIND_LABEL[historyOf.holdKind] : ''} · newest last
            </SheetDescription>
          </SheetHeader>
          <div className="px-4">
            {history && history.id === historyOf?.specimenId ? (
              history.data === null ? (
                <p className="text-sm text-destructive-text">The HOLD history couldn’t load.</p>
              ) : history.data.events.length === 0 ? (
                <p className="text-sm text-muted-foreground">No HOLD actions yet.</p>
              ) : (
                <ol className="flex flex-col gap-3 text-sm" aria-label="HOLD history">
                  {history.data.events.map((e, i) => (
                    <li key={i} className="flex flex-col gap-0.5">
                      <span>
                        {historyLine(e)} by {e.by.name}
                        {e.recordedBy ? `, recorded by ${e.recordedBy.name}` : ''}
                        {e.reason ? `: ${e.reason}` : ''}
                      </span>
                      <time dateTime={e.at} className="font-mono text-[13px] text-muted-foreground">
                        {new Date(e.at).toLocaleString()}
                      </time>
                    </li>
                  ))}
                </ol>
              )
            ) : (
              <p className="text-sm text-muted-foreground">Loading…</p>
            )}
          </div>
        </SheetContent>
      </Sheet>
    </div>
  );
}
