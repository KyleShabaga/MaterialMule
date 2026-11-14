import {
  RETENTION_TABS,
  type RetentionPipeline,
  type RetentionPipelineUnit,
  type RetentionTab,
} from '@materialmule/shared';
import { Lock, ScanLine, X } from 'lucide-react';
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import {
  PeekSplit,
  peekNeighbours,
  usePeekAvailable,
  usePeekKeys,
  usePeekParam,
} from '../components/strata/peek';
import { TableToolbar } from '../components/strata/table-toolbar';
import { useTableQuery, type SortOption, type TableQuery } from '../components/strata/table-query';
import { ConcreteReadyForDisposal } from '../concrete/holds/ConcreteReadyForDisposal';
import '../concrete/holds/holds.css';
import { UnitDrawer } from '../inventory/UnitDrawer';
import { UNIT_DRAWER_TITLE_ID } from '../inventory/unit-record';
import { TablePager } from '../projects/project-ui';
import { useDebounced } from '../projects/project-format';
import { RetentionDecisionDrawer } from '../retention/RetentionDecisionDrawer';
import { fetchPipeline, RETENTION_CHANGED_EVENT, type Loaded } from '../retention/pipeline-api';
import {
  ApprovedTab,
  ComingUp,
  DisposalListTab,
  DisposedTab,
  EligibleList,
  LoadFailed,
  type DecideTarget,
} from './RetentionPipelineParts';

const TAB_LABELS: Record<RetentionTab, string> = {
  coming: 'Coming up',
  eligible: 'Eligible',
  list: 'On disposal list',
  approved: 'Approved',
  disposed: 'Disposed',
};

const FILTERS = [
  { id: 'mine', label: 'Projects I lead' },
  { id: 'overdue', label: 'Overdue' },
  { id: 'month', label: 'Within 30 days' },
  { id: 'later', label: 'Within 90 days' },
  { id: 'hold', label: 'Has a hold' },
  { id: 'extension', label: 'Has an extension' },
] as const;
const FILTER_IDS = new Set<string>(FILTERS.map((f) => f.id));

const SORT_OPTIONS: readonly SortOption[] = [
  { label: 'Retention ends, soonest first', sort: null },
  { label: 'Project', sort: { key: 'project', dir: 'asc' } },
  { label: 'ID', sort: { key: 'id', dir: 'asc' } },
];
const SORT_LABELS = {
  retain_until: { asc: 'Retention ends, soonest first', desc: 'Retention ends, latest first' },
  project: { asc: 'Project A–Z', desc: 'Project Z–A' },
  id: { asc: 'ID A–Z', desc: 'ID Z–A' },
};
const SORT_KEYS = new Set(['retain_until', 'project', 'id']);

function readTab(params: URLSearchParams): RetentionTab {
  const value = params.get('tab');
  return (RETENTION_TABS as readonly string[]).includes(value ?? '')
    ? (value as RetentionTab)
    : 'coming';
}

/**
 * Retention (STRATA-90, DESIGN.md › Round 6; route /disposal-retention, sidebar "Due and
 * overdue"): pipeline tabs in the order the work flows, each with the server's count; shared table
 * tools; rows open the unit drawer (?open=); Decide opens the decision drawer (STRATA-91).
 * Approval never disposes: units leave stock only through the disposal scan.
 */
export function DisposalPage() {
  const navigate = useNavigate();
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const peek = usePeekParam();
  const peekAvailable = usePeekAvailable();
  const tab = readTab(params);
  const projectId = params.get('projectId');
  const page = Math.max(1, Number.parseInt(params.get('page') ?? '1', 10) || 1);
  const sort = query.sort && SORT_KEYS.has(query.sort.key) ? query.sort : null;
  const filters = query.filters.filter((f) => FILTER_IDS.has(f));
  const search = useDebounced(query.search);
  // MM-V2-C26: concrete specimens' ready list stays on this page behind "Show". Page state, not
  // the URL: a reload returns to Storage units, the default view (concrete-holds T2).
  const [concrete, setConcrete] = useState(false);

  const requestKey = useMemo(() => {
    const request = new URLSearchParams({ tab });
    if (search.trim()) request.set('search', search.trim());
    for (const f of filters) request.append('filter', f);
    if (projectId) request.set('projectId', projectId);
    if (sort) {
      request.set('sort', sort.key);
      request.set('dir', sort.dir);
    }
    if (page > 1) request.set('page', String(page));
    return request.toString();
  }, [tab, search, filters, projectId, sort, page]);

  const [result, setResult] = useState<{ key: string; value: Loaded<RetentionPipeline> } | null>(
    null,
  );
  const [reloads, setReloads] = useState(0);
  const reload = useCallback(() => setReloads((n) => n + 1), []);
  useEffect(() => {
    window.addEventListener(RETENTION_CHANGED_EVENT, reload);
    return () => window.removeEventListener(RETENTION_CHANGED_EVENT, reload);
  }, [reload]);
  useEffect(() => {
    if (concrete) return;
    let cancelled = false;
    void fetchPipeline(new URLSearchParams(requestKey)).then((value) => {
      if (!cancelled) setResult({ key: requestKey, value });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads, concrete]);

  const loading = !result || result.key !== requestKey;
  // Counts stay from the last load while the next tab loads (tab counts stay live).
  const last = result?.value.ok ? result.value.data : null;
  const data = !loading && last ? last : null;
  const today = last?.asOf ?? '';

  const [decide, setDecide] = useState<DecideTarget | null>(null);

  const rows = useMemo(
    () => (data ? [...data.rows, ...(data.tab === 'coming' ? data.tested : [])] : []),
    [data],
  );
  const openRow = peekAvailable ? (rows.find((r) => r.readableId === peek.openId) ?? null) : null;
  const nav = peekNeighbours(
    rows.map((r) => r.readableId),
    openRow?.readableId ?? null,
  );
  usePeekKeys({
    enabled: openRow !== null,
    onClose: peek.close,
    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
  });
  const onOpenRow = useCallback(
    (row: RetentionPipelineUnit) =>
      peekAvailable
        ? peek.open(row.readableId)
        : navigate(`/sample-storage/${encodeURIComponent(row.readableId)}`),
    [peekAvailable, peek, navigate],
  );

  const setParam = (key: string, value: string | null) =>
    setParams((current) => {
      const next = new URLSearchParams(current);
      if (value) next.set(key, value);
      else next.delete(key);
      if (key !== 'page' && key !== 'open') next.delete('page');
      return next;
    });

  const toolbarQuery: TableQuery = { ...query, filters, sort, view: null };
  const listProps = data
    ? {
        data,
        today,
        openId: openRow?.readableId ?? null,
        onOpenRow,
        onDecide: setDecide,
        onChanged: reload,
      }
    : null;

  let list: ReactNode;
  if (result && !result.value.ok && !loading) {
    list = <LoadFailed message={result.value.message} onRetry={reload} />;
  } else if (!listProps) {
    list = (
      <div aria-busy="true" className="flex flex-col gap-3">
        <span className="sr-only">Loading retention</span>
        <Skeleton className="h-6 w-40" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
        <Skeleton className="h-9 w-full" />
      </div>
    );
  } else {
    list = (
      <>
        {tab === 'coming' ? <ComingUp {...listProps} /> : null}
        {tab === 'eligible' ? <EligibleList {...listProps} /> : null}
        {tab === 'list' ? <DisposalListTab {...listProps} /> : null}
        {tab === 'approved' ? <ApprovedTab {...listProps} /> : null}
        {tab === 'disposed' ? <DisposedTab {...listProps} /> : null}
        <TablePager
          page={page}
          pageSize={listProps.data.pageSize}
          total={listProps.data.total}
          noun={listProps.data.total === 1 ? 'unit' : 'units'}
          onPage={(next) => setParam('page', next > 1 ? String(next) : null)}
        />
      </>
    );
  }

  const showToggle = (
    <ButtonGroup aria-label="Show">
      {(
        [
          [false, 'Storage units'],
          [true, 'Concrete specimens'],
        ] as const
      ).map(([value, text]) => (
        <Button
          key={text}
          size="sm"
          variant={concrete === value ? 'secondary' : 'outline'}
          aria-pressed={concrete === value}
          onClick={() => setConcrete(value)}
        >
          {text}
        </Button>
      ))}
    </ButtonGroup>
  );

  return (
    <div className="flex min-h-0 flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Retention</h1>
          <p className="text-muted-foreground text-sm">
            Decide what happens when retention ends, approve the disposal list and see what’s been
            disposed.
          </p>
        </div>
        {showToggle}
      </div>

      {concrete ? (
        <ConcreteReadyForDisposal />
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b pb-3">
            <Tabs
              className="min-w-0 max-w-full"
              value={tab}
              onValueChange={(next) => {
                setParams((current) => {
                  const nextParams = new URLSearchParams(current);
                  if (next === 'coming') nextParams.delete('tab');
                  else nextParams.set('tab', next);
                  nextParams.delete('page');
                  nextParams.delete('open');
                  return nextParams;
                });
              }}
            >
              <TabsList
                aria-label="Retention stage"
                className="max-w-full justify-start overflow-x-auto overflow-y-hidden"
              >
                {RETENTION_TABS.map((id) => (
                  <TabsTrigger key={id} value={id}>
                    {TAB_LABELS[id]}{' '}
                    <span className="text-muted-foreground font-mono text-[11px]">
                      {last ? last.counts[id] : '…'}
                    </span>
                  </TabsTrigger>
                ))}
              </TabsList>
            </Tabs>
            <TableToolbar
              label="Retention tools"
              query={toolbarQuery}
              onQueryChange={(patch) => {
                const { view: _view, ...rest } = patch;
                void _view;
                setQuery(rest);
              }}
              pageAction={{
                label: 'Disposal scan',
                icon: ScanLine,
                onClick: () => navigate('/disposal-retention/scan'),
              }}
              filters={FILTERS}
              sortOptions={SORT_OPTIONS}
              sortLabels={SORT_LABELS}
              searchPlaceholder="Search retention…"
            />
          </div>
          {projectId ? (
            <div
              className="flex flex-wrap items-center gap-2 text-sm"
              role="group"
              aria-label="Project"
            >
              <span className="inline-flex h-7 items-center gap-1 rounded-full border bg-secondary pr-0.5 pl-2.5">
                <Lock aria-hidden="true" className="size-3.5" />
                One project
                <Button
                  variant="ghost"
                  size="icon-xs"
                  aria-label="Show every project"
                  onClick={() => setParam('projectId', null)}
                >
                  <X aria-hidden="true" />
                </Button>
              </span>
            </div>
          ) : null}
          <PeekSplit
            className="min-h-[24rem]"
            open={openRow !== null}
            openId={openRow?.readableId ?? null}
            listLabel="Retention"
            drawerLabelledBy={UNIT_DRAWER_TITLE_ID}
            list={<div aria-busy={loading}>{list}</div>}
            drawer={
              openRow ? (
                <UnitDrawer
                  key={openRow.readableId}
                  readableId={openRow.readableId}
                  toolbar={{
                    onClose: peek.close,
                    position: { index: nav.index, total: nav.total },
                    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
                    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
                  }}
                />
              ) : null
            }
          />
        </>
      )}
      <RetentionDecisionDrawer
        open={decide !== null}
        onOpenChange={(open) => !open && setDecide(null)}
        unitIds={decide?.unitIds}
        context={decide?.context}
        initialChoice={decide?.initialChoice}
        onDone={reload}
      />
    </div>
  );
}
