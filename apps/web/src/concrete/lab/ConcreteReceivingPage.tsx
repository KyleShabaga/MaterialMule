import {
  CONCRETE_RECEIVING_STAGE_LABEL,
  concreteSearchTerms,
  type ConcreteReceivingQueue,
  type ConcreteReceivingQueueRow,
  type ConcreteReceivingStage,
} from '@materialmule/shared';
import { Inbox, RotateCw, ScanLine } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { DataTable, type DataTableColumn } from '../../components/strata/data-table';
import { PersonCell } from '../../components/strata/person-avatar';
import { StageSrText } from '../../components/strata/stage-tag';
import { useTableQuery, type TableQuery } from '../../components/strata/table-query';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { notifySuccess } from '../../components/strata/toast';
import { useMe } from '../../session/context';
import { fetchConcreteSearch, fetchReceivingQueue, type LoadResult } from './api';
import {
  fieldReportPath,
  labDate,
  labTime,
  setLabel,
  setLookupPath,
  UNCAST_DETAIL,
  UNCAST_NOTE,
  workflowLabel,
} from './format';
import { ReceiveSetSheet, type SheetMode } from './ReceiveSetSheet';

// Concrete → Receiving (STRATA-95 part B, canvas R7Receiving*): field reports whose sets await
// receiving (or pickup), My reports first, then Other reports. A set is received by scanning a
// specimen label or ticking its specimens in the sheet; pickup and receiving keep C06's rules
// (docs/concrete.md). Sets without a casting time are listed and receivable (STRATA-120).

/** Tab order on the board: receiving first (the page's main job), then pickup. */
const STAGES: readonly ConcreteReceivingStage[] = ['awaiting_receiving', 'awaiting_pickup'];

const readStage = (value: string | null): ConcreteReceivingStage =>
  value === 'awaiting_pickup' ? 'awaiting_pickup' : 'awaiting_receiving';

/** One field report's sets in this stage (the queue is per set; the board lists reports). */
interface ReportGroup {
  fieldReportId: string;
  projectId: string;
  projectNumber: string;
  projectName: string;
  technician: ConcreteReceivingQueueRow['technician'];
  reportState: string;
  mine: boolean;
  castAt: string | null;
  sets: ConcreteReceivingQueueRow[];
}

/** Groups consecutive rows by field report, keeping the server's order. */
function groupByReport(rows: readonly ConcreteReceivingQueueRow[]): ReportGroup[] {
  const groups: ReportGroup[] = [];
  for (const row of rows) {
    const last = groups[groups.length - 1];
    if (last && last.fieldReportId === row.fieldReportId && last.mine === row.mine) {
      last.sets.push(row);
      continue;
    }
    groups.push({
      fieldReportId: row.fieldReportId,
      projectId: row.projectId,
      projectNumber: row.projectNumber,
      projectName: row.projectName,
      technician: row.technician,
      reportState: row.reportState,
      mine: row.mine,
      castAt: row.castAt,
      sets: [row],
    });
  }
  return groups;
}

/** Whether a row matches the toolbar search (this page's rows: set, project, technician). */
function matches(row: ConcreteReceivingQueueRow, search: string): boolean {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [
    row.identity.permanentId,
    row.identity.temporaryId,
    row.projectNumber,
    row.projectName,
    row.technician?.name,
  ].some((value) => value?.toLowerCase().includes(q));
}

const projectFilterId = (id: string) => `project:${id}`;

export function ConcreteReceivingPage() {
  const me = useMe();
  const canReceive = me.permissions.includes('concrete_specimen.receive');
  const [params, setParams] = useSearchParams();
  const [query, setQuery] = useTableQuery();
  const stage = readStage(params.get('stage'));
  const page = Math.max(1, Number(params.get('page')) || 1);
  const projectFilter = query.filters.find((f) => f.startsWith('project:')) ?? null;
  const projectId = projectFilter ? projectFilter.slice('project:'.length) : undefined;
  const [attempt, setAttempt] = useState(0);
  const key = `${stage}|${page}|${projectId ?? ''}|${attempt}`;
  const [answer, setAnswer] = useState<{
    key: string;
    load: LoadResult<ConcreteReceivingQueue>;
  } | null>(null);
  const [last, setLast] = useState<ConcreteReceivingQueue | null>(null);
  const [sheet, setSheet] = useState<{
    setId: string;
    mode: SheetMode;
    letter: string | null;
  } | null>(null);
  const [scan, setScan] = useState('');
  const [scanNote, setScanNote] = useState<string | null>(null);
  // Projects seen in this session's pages, for the Filter menu (the server filters by one).
  const [projects, setProjects] = useState<Map<string, string>>(new Map());

  useEffect(() => {
    let current = true;
    void fetchReceivingQueue({ stage, page, projectId }).then((load) => {
      if (!current) return;
      if (load.ok) {
        setLast(load.data);
        setProjects((known) => {
          const next = new Map(known);
          for (const row of load.data.items) next.set(row.projectId, row.projectNumber);
          return next.size === known.size ? known : next;
        });
      }
      setAnswer({ key, load });
    });
    return () => {
      current = false;
    };
  }, [stage, page, projectId, key]);

  const load = answer?.key === key ? answer.load : null;
  const queue = load?.ok ? load.data : null;
  const counts = (queue ?? last)?.counts;
  const rows = useMemo(
    () => (queue?.items ?? []).filter((row) => matches(row, query.search)),
    [queue, query.search],
  );
  const mine = groupByReport(rows.filter((r) => r.mine));
  const others = groupByReport(rows.filter((r) => !r.mine));
  const pages = queue ? Math.max(1, Math.ceil(queue.total / queue.pageSize)) : 1;
  const verb: SheetMode = stage === 'awaiting_receiving' ? 'receive' : 'pickup';

  const chooseStage = (next: string) => {
    const nextParams = new URLSearchParams(params);
    nextParams.set('stage', readStage(next));
    nextParams.delete('page');
    setParams(nextParams, { replace: true });
  };
  const goToPage = (next: number) => {
    const nextParams = new URLSearchParams(params);
    if (next > 1) nextParams.set('page', String(next));
    else nextParams.delete('page');
    setParams(nextParams, { replace: true });
  };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    if (patch.filters) {
      // One project at a time: the queue filters by one project on the server.
      const added = patch.filters.filter((f) => !query.filters.includes(f));
      patch = { ...patch, filters: added.length > 0 ? added.slice(-1) : patch.filters };
    }
    setQuery(patch);
  };

  async function onScan() {
    const text = scan.trim();
    if (!text) return;
    setScanNote(null);
    const terms = concreteSearchTerms(text);
    const alias = terms.setAlias;
    const onPage = alias
      ? (queue?.items ?? []).filter(
          (r) => r.identity.permanentId === alias || r.identity.temporaryId === alias,
        )
      : [];
    if (onPage.length === 1) {
      setSheet({ setId: onPage[0]!.setId, mode: verb, letter: terms.letter });
      setScan('');
      return;
    }
    const found = await fetchConcreteSearch(text);
    if (!found.ok) {
      setScanNote(found.message);
      return;
    }
    const sets = found.data.items.flatMap((item) => item.sets.filter((s) => s.matched));
    if (sets.length === 1) {
      setSheet({ setId: sets[0]!.setId, mode: verb, letter: found.data.letter });
      setScan('');
    } else if (sets.length > 1) {
      setScanNote(
        `${text} is marked on sets in ${found.data.projectCount} projects. Open the right one from the list.`,
      );
    } else {
      setScanNote(`No specimen set has the ID ${text}. Check the marking on the specimen.`);
    }
  }

  const filterOptions = [...projects.entries()].map(([id, number]) => ({
    id: projectFilterId(id),
    label: number,
  }));

  const columns: DataTableColumn<ReportGroup>[] = [
    {
      id: 'report',
      header: 'Field report',
      priority: 'identity',
      width: '9rem',
      cell: (g) => (
        <span className="flex min-w-0 flex-col">
          <StageSrText
            stage="due"
            label={stage === 'awaiting_receiving' ? 'Due · Receiving' : 'Due · Pickup'}
          />
          <Button
            variant="link"
            asChild
            className="h-auto justify-start p-0 font-semibold text-foreground"
          >
            <Link to={fieldReportPath(g.fieldReportId)}>Field report</Link>
          </Button>
          <span className="text-[12px] text-muted-foreground">{workflowLabel(g.reportState)}</span>
        </span>
      ),
    },
    {
      id: 'technician',
      header: 'Field technician',
      priority: 'attribute',
      hideBelow: '72rem',
      width: '11rem',
      cell: (g) =>
        g.technician ? (
          <PersonCell name={g.technician.name} userId={g.technician.userId} />
        ) : (
          <span className="text-muted-foreground">Not recorded</span>
        ),
    },
    {
      id: 'project',
      header: 'Project',
      priority: 'identity',
      cell: (g) => (
        <span className="flex min-w-0 flex-col">
          <span className="font-mono font-semibold whitespace-nowrap">{g.projectNumber}</span>
          <span className="truncate text-[12px] text-muted-foreground" title={g.projectName}>
            {g.projectName}
          </span>
        </span>
      ),
    },
    {
      id: 'sets',
      header: 'Sets and specimens',
      priority: 'identity',
      wrap: true,
      cell: (g) => (
        <span className="flex flex-col gap-0.5">
          {g.sets.map((s) => (
            <span key={s.setId} className="text-[13px]">
              <Button variant="link" asChild className="h-auto p-0 font-mono font-semibold">
                <Link to={setLookupPath(s.setId)}>{setLabel(s.identity)}</Link>
              </Button>{' '}
              <span
                className="font-mono text-muted-foreground"
                aria-label={`Specimens ${s.letters.join(', ')} ${CONCRETE_RECEIVING_STAGE_LABEL[stage].toLowerCase()}`}
              >
                {s.letters.join(' ')}
              </span>
            </span>
          ))}
        </span>
      ),
    },
    {
      id: 'count',
      header: 'Count',
      priority: 'attribute',
      numeric: true,
      width: '4rem',
      hideBelow: '48rem',
      cell: (g) => (
        <span className="font-mono">{g.sets.reduce((n, s) => n + s.letters.length, 0)}</span>
      ),
    },
    {
      id: 'cast',
      header: 'Casting time',
      priority: 'state',
      width: '10rem',
      wrap: true,
      cell: (g) =>
        g.castAt ? (
          <span className="flex flex-col">
            <span className="font-mono text-[13px] whitespace-nowrap">{labDate(g.castAt)}</span>
            <span className="font-mono text-[12px] text-muted-foreground">{labTime(g.castAt)}</span>
          </span>
        ) : (
          <span className="flex flex-col">
            <span className="text-[13px]">{UNCAST_NOTE}</span>
            <span className="text-[12px] text-muted-foreground">{UNCAST_DETAIL}</span>
          </span>
        ),
    },
    {
      id: 'action',
      header: <span className="sr-only">Actions</span>,
      priority: 'state',
      control: true,
      width: '9rem',
      align: 'end',
      cell: (g) =>
        canReceive ? (
          <span className="flex flex-col items-end gap-1">
            {g.sets.map((s) => (
              <Button
                key={s.setId}
                type="button"
                variant="outline"
                size="sm"
                aria-label={`${verb === 'receive' ? 'Receive' : 'Record pickup of'} ${setLabel(s.identity)}`}
                onClick={() => setSheet({ setId: s.setId, mode: verb, letter: null })}
              >
                {verb === 'receive' ? 'Receive' : 'Record pickup'}
                {g.sets.length > 1 ? (
                  <span className="font-mono text-muted-foreground">{setLabel(s.identity)}</span>
                ) : null}
              </Button>
            ))}
          </span>
        ) : null,
    },
  ];

  const section = (title: string, groups: ReportGroup[], note?: string) => (
    <section aria-label={title} className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2 px-1">
        <h2 className="text-base font-semibold">{title}</h2>
        <span className="font-mono text-[13px] text-muted-foreground">{groups.length}</span>
        {note ? <span className="text-[13px] text-muted-foreground">· {note}</span> : null}
      </div>
      <DataTable
        columns={columns}
        data={groups}
        getRowId={(g) => `${g.fieldReportId}|${g.mine}`}
        rowLabel={(g) => `${g.projectNumber} field report`}
        stage={() => 'due'}
        caption={`${title}, ${CONCRETE_RECEIVING_STAGE_LABEL[stage].toLowerCase()}`}
        empty={
          title === 'My reports'
            ? 'None of your field reports are waiting here.'
            : 'No one else’s field reports are waiting here.'
        }
      />
    </section>
  );

  const otherStage: ConcreteReceivingStage =
    stage === 'awaiting_receiving' ? 'awaiting_pickup' : 'awaiting_receiving';
  const filtered = query.search.trim() !== '' || projectId !== undefined;

  return (
    <div className="@container mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-4">
      <h1 className="sr-only">Concrete receiving</h1>
      <Tabs value={stage} onValueChange={chooseStage}>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <TabsList aria-label="Receiving stage">
            {STAGES.map((s) => (
              <TabsTrigger key={s} value={s}>
                {CONCRETE_RECEIVING_STAGE_LABEL[s]}
                {counts ? ' ' : null}
                {counts ? (
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {counts[s]}
                  </span>
                ) : null}
              </TabsTrigger>
            ))}
          </TabsList>
          <TableToolbar
            label="Receiving tools"
            query={query}
            onQueryChange={onQueryChange}
            filters={filterOptions}
            searchPlaceholder="Search reports or sets…"
          />
        </div>
      </Tabs>

      {stage === 'awaiting_receiving' ? (
        <form
          className="flex flex-wrap items-center gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            void onScan();
          }}
        >
          <InputGroup className="h-11 max-w-[520px] flex-1">
            <InputGroupAddon>
              <ScanLine aria-hidden="true" />
            </InputGroupAddon>
            <InputGroupInput
              aria-label="Scan a specimen label"
              placeholder="Scan a specimen label to receive it, e.g. 26-31B"
              autoComplete="off"
              value={scan}
              onChange={(e) => setScan(e.target.value)}
            />
          </InputGroup>
          <span className="text-[13px] text-muted-foreground">
            A scan opens its set with that specimen ticked.
          </span>
          {scanNote ? (
            <p role="alert" className="w-full text-sm text-destructive-text">
              {scanNote}
            </p>
          ) : null}
        </form>
      ) : (
        <p className="text-[13px] text-muted-foreground">
          The pick-up window is an estimate only; it never records a pickup. Pickup and curing
          readings are recorded per specimen.
        </p>
      )}

      {!canReceive ? (
        <p className="text-[13px] text-muted-foreground">
          Pickup and receiving are recorded by lab staff (a Lab Technician, a Lab Manager or the LAB
          station).
        </p>
      ) : null}

      {load && !load.ok ? (
        <Alert variant="destructive">
          <AlertTitle>{load.message}</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" onClick={() => setAttempt((n) => n + 1)}>
              <RotateCw aria-hidden="true" />
              Retry
            </Button>
          </AlertDescription>
        </Alert>
      ) : load === null ? (
        <div aria-busy="true" className="flex flex-col gap-2">
          <p className="sr-only" role="status">
            Loading reports {CONCRETE_RECEIVING_STAGE_LABEL[stage].toLowerCase()}
          </p>
          <DataTable
            columns={columns}
            data={[]}
            getRowId={(g) => g.fieldReportId}
            rowLabel={(g) => g.projectNumber}
            caption="Loading"
            loading
          />
        </div>
      ) : queue && queue.total === 0 && !filtered ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyMedia variant="icon">
              <Inbox aria-hidden="true" />
            </EmptyMedia>
            <EmptyTitle>
              {stage === 'awaiting_receiving'
                ? 'No sets are waiting to be received.'
                : 'No sets are waiting to be picked up.'}
            </EmptyTitle>
            <EmptyDescription>
              Sets show here once their field report records specimens.
              {counts && counts[otherStage] > 0
                ? ` ${counts[otherStage]} ${counts[otherStage] === 1 ? 'set is' : 'sets are'} still ${CONCRETE_RECEIVING_STAGE_LABEL[otherStage].toLowerCase()}.`
                : ''}
            </EmptyDescription>
          </EmptyHeader>
          {counts && counts[otherStage] > 0 ? (
            <EmptyContent>
              <Button variant="outline" onClick={() => chooseStage(otherStage)}>
                Show {CONCRETE_RECEIVING_STAGE_LABEL[otherStage].toLowerCase()}
              </Button>
            </EmptyContent>
          ) : null}
        </Empty>
      ) : queue ? (
        <>
          {section('My reports', mine, 'reports you filed')}
          {section('Other reports', others)}
          {pages > 1 ? (
            <nav className="flex flex-wrap items-center justify-end gap-2" aria-label="Pages">
              <span className="mr-auto text-[13px] text-muted-foreground">
                Sets {(page - 1) * queue.pageSize + 1}–
                {Math.min(page * queue.pageSize, queue.total)} of {queue.total}
                {page < pages ? ' · continues on the next page' : ''}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page <= 1}
                onClick={() => goToPage(page - 1)}
              >
                Previous
              </Button>
              <span className="font-mono text-sm tabular-nums">
                Page {page} of {pages}
              </span>
              <Button
                variant="outline"
                size="sm"
                disabled={page >= pages}
                onClick={() => goToPage(page + 1)}
              >
                Next
              </Button>
            </nav>
          ) : null}
        </>
      ) : null}

      <ReceiveSetSheet
        setId={sheet?.setId ?? null}
        mode={sheet?.mode ?? verb}
        scannedLetter={sheet?.letter ?? null}
        onClose={() => setSheet(null)}
        onDone={(message) => {
          setSheet(null);
          notifySuccess(message);
          setAttempt((n) => n + 1);
        }}
      />
    </div>
  );
}
