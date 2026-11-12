import { useMemo, useState } from 'react';
import { CheckCheck, CircleDot, Flag, Hourglass } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useThemeChoice, type ThemeChoice } from '@/theme/theme';
import { BulkConfirmDialog } from './bulk-confirm-dialog';
import { DataTable, DENSITY_VIEW_OPTIONS, type DataTableColumn } from './data-table';
import { LifecycleTrack, CONCRETE_SET_STEPS, STORAGE_UNIT_STEPS } from './lifecycle-track';
import { PeekSplit, PeekToolbar, peekNeighbours, usePeekKeys, usePeekParam } from './peek';
import { PersonAvatar, PersonCell } from './person-avatar';
import { STAGE_KEYS, type StageKey, type WorkDomain } from '@materialmule/shared';
import { StageStripe } from './stage-stripe';
import { StageSrText, StageTag } from './stage-tag';
import { TableToolbar } from './table-toolbar';
import { describeSort, useTableQuery, type SortLabels, type SortOption } from './table-query';
import { notifyError, notifySuccess, StrataToaster } from './toast';

// Dev-only gallery (/dev/strata, not in the production build): every lane-1B shared component
// with fictional data, for checking light, dark and 1024 px by eye. Nothing may depend on it.

interface InboxRow {
  id: string;
  title: string;
  job: string;
  kind: 'Request' | 'Update';
  task: string;
  stage: StageKey;
  domain: WorkDomain;
  from: string | null;
  received: string;
}

const ROWS: InboxRow[] = [
  {
    id: 'r1',
    title: 'Approve retention extension for BKT-2026-000019',
    job: 'DEMO-2601',
    kind: 'Request',
    task: 'Extension',
    stage: 'due',
    domain: 'retention',
    from: 'Alex Tester',
    received: '2026-11-12',
  },
  {
    id: 'r2',
    title: 'Hold period ended on set 0425-32-07',
    job: 'DEMO-2601',
    kind: 'Update',
    task: 'Hold',
    stage: 'danger',
    domain: 'concrete',
    from: null,
    received: '2026-11-11',
  },
  {
    id: 'r3',
    title: 'Breaks due today for TH26-01 cylinders',
    job: 'DEMO-2610',
    kind: 'Update',
    task: 'Breaks',
    stage: 'lab',
    domain: 'concrete',
    from: 'Sam Sample',
    received: '2026-11-10',
  },
  {
    id: 'r4',
    title: 'Receipt 2026-11-11 · Pat Example is still a draft',
    job: 'DEMO-2611',
    kind: 'Request',
    task: 'Receipt',
    stage: 'draft',
    domain: 'receipt',
    from: 'Pat Example',
    received: '2026-11-09',
  },
  {
    id: 'r5',
    title: 'Correction requested on CT-2026-000004 depth',
    job: 'DEMO-2612',
    kind: 'Request',
    task: 'Correction',
    stage: 'due',
    domain: 'correction',
    from: 'Jordan Lab',
    received: '2026-11-08',
  },
  {
    id: 'r6',
    title: 'LP-2026-0012 closed with 5 tests',
    job: 'DEMO-2613',
    kind: 'Update',
    task: 'Program',
    stage: 'closed',
    domain: 'lab',
    from: 'Sam Sample',
    received: '2026-11-07',
  },
  {
    id: 'r7',
    title: 'CRE-2026-000110 put away on WH-A-B2-S3',
    job: 'DEMO-2614',
    kind: 'Update',
    task: 'Move',
    stage: 'storage',
    domain: 'storage',
    from: 'Pat Example',
    received: '2026-11-06',
  },
];

const FILTERS = [
  { id: 'requests', label: 'Requests' },
  { id: 'updates', label: 'Updates' },
  { id: 'urgent', label: 'Urgent' },
];

const SORT_OPTIONS: SortOption[] = [
  { label: 'Newest first', sort: null },
  { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
];

const SORT_LABELS: SortLabels = {
  title: { asc: 'Title A–Z', desc: 'Title Z–A' },
  received: { asc: 'Received oldest first', desc: 'Received newest first' },
};

const VIEWS = [...DENSITY_VIEW_OPTIONS, { id: 'table', label: 'Table' }];

function KindIcon({ row }: { row: InboxRow }) {
  const Icon = row.kind === 'Request' ? CircleDot : CheckCheck;
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span tabIndex={-1} className="inline-flex shrink-0 text-muted-foreground">
          <Icon aria-hidden="true" className="size-4" />
          <span className="sr-only">{`${row.kind} · ${row.task}`}</span>
        </span>
      </TooltipTrigger>
      <TooltipContent>{`${row.kind} · ${row.task}`}</TooltipContent>
    </Tooltip>
  );
}

const COLUMNS: DataTableColumn<InboxRow>[] = [
  {
    id: 'title',
    header: 'Title',
    priority: 'identity',
    sortKey: 'title',
    cell: (row) => <span className="truncate font-medium">{row.title}</span>,
  },
  {
    id: 'job',
    header: 'Job number',
    priority: 'identity',
    mono: true,
    width: '10ch',
    cell: (row) => row.job,
  },
  {
    id: 'stage',
    header: 'Stage',
    priority: 'state',
    wrap: true,
    width: '10rem',
    cell: (row) => <StageTag stage={row.stage} domain={row.domain} />,
  },
  {
    id: 'task',
    header: 'Task',
    priority: 'attribute',
    hideBelow: '48rem',
    width: '9rem',
    fold: (row) => <KindIcon row={row} />,
    cell: (row) => `${row.kind} · ${row.task}`,
  },
  {
    id: 'from',
    header: 'From',
    priority: 'attribute',
    hideBelow: '40rem',
    width: '10rem',
    cell: (row) => (
      <PersonCell name={row.from ?? undefined} system={row.from === null} size="compact" />
    ),
  },
  {
    id: 'received',
    header: 'Received',
    priority: 'attribute',
    hideBelow: '35rem',
    mono: true,
    width: '12ch',
    sortKey: 'received',
    cell: (row) => row.received,
  },
];

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="space-y-3">
      <h2 className="text-base font-semibold">{title}</h2>
      {children}
    </section>
  );
}

function InboxDemo() {
  const [query, setQuery] = useTableQuery();
  const peek = usePeekParam();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());

  // Stands in for the server: filter, search and order the rows, then the table renders them as
  // given (the table itself never sorts).
  const rows = useMemo(() => {
    let list = ROWS.filter((r) => r.title.toLowerCase().includes(query.search.toLowerCase()));
    if (query.filters.includes('requests')) list = list.filter((r) => r.kind === 'Request');
    if (query.filters.includes('updates')) list = list.filter((r) => r.kind === 'Update');
    if (query.filters.includes('urgent')) list = list.filter((r) => r.stage === 'danger');
    const sort = query.sort ?? { key: 'received', dir: 'desc' as const };
    const key = sort.key === 'title' ? 'title' : 'received';
    list = [...list].sort((a, b) => a[key].localeCompare(b[key]) * (sort.dir === 'asc' ? 1 : -1));
    return list;
  }, [query]);

  const view = query.view ?? 'comfortable';
  const density = view === 'compact' ? 'compact' : view === 'table' ? 'table' : 'comfortable';
  const nav = peekNeighbours(
    rows.map((r) => r.id),
    peek.openId,
  );
  const openRow = rows.find((r) => r.id === peek.openId) ?? null;
  usePeekKeys({
    enabled: openRow !== null,
    onClose: peek.close,
    onPrevious: nav.previousId ? () => peek.open(nav.previousId!) : undefined,
    onNext: nav.nextId ? () => peek.open(nav.nextId!) : undefined,
  });

  return (
    <div className="flex h-[30rem] flex-col overflow-hidden rounded-xl border bg-card">
      <div className="flex items-center justify-between gap-3 border-b px-4 py-2">
        <p className="truncate text-sm text-muted-foreground">
          Sort: {describeSort(query.sort, SORT_OPTIONS, SORT_LABELS)}
        </p>
        <TableToolbar
          label="Inbox tools"
          query={query}
          onQueryChange={setQuery}
          pageAction={{
            label: 'Mark all read',
            icon: CheckCheck,
            onClick: () => notifySuccess('All marked read'),
          }}
          filters={FILTERS}
          sortOptions={SORT_OPTIONS}
          sortLabels={SORT_LABELS}
          views={VIEWS}
          searchPlaceholder="Search the inbox"
        />
      </div>
      <PeekSplit
        className="min-h-0 flex-1"
        open={openRow !== null}
        openId={peek.openId}
        listLabel="Inbox list"
        drawerLabelledBy="gallery-peek-title"
        list={
          <DataTable
            columns={COLUMNS}
            data={rows}
            getRowId={(r) => r.id}
            rowLabel={(r) => r.title}
            density={density}
            sort={query.sort}
            onSortChange={(sort) => setQuery({ sort })}
            stage={(r) => r.stage}
            selectedIds={selected}
            onSelectedIdsChange={setSelected}
            onOpenRow={(r) => peek.open(r.id)}
            openRowId={peek.openId}
            caption="Inbox"
            empty="Nothing matches. Clear filters to see everything."
            className="m-3"
          />
        }
        drawer={
          openRow ? (
            <div className="flex h-full flex-col">
              <PeekToolbar
                onClose={peek.close}
                fullPageHref="#"
                position={{ index: nav.index, total: nav.total }}
                onPrevious={nav.previousId ? () => peek.open(nav.previousId!) : undefined}
                onNext={nav.nextId ? () => peek.open(nav.nextId!) : undefined}
              />
              <div className="space-y-3 overflow-y-auto p-4">
                <StageTag stage={openRow.stage} domain={openRow.domain} />
                <h3 id="gallery-peek-title" className="text-lg font-semibold">
                  {openRow.title}
                </h3>
                <PersonCell name={openRow.from ?? undefined} system={openRow.from === null} />
                <LifecycleTrack steps={STORAGE_UNIT_STEPS} current="short_term" compact />
              </div>
            </div>
          ) : null
        }
      />
    </div>
  );
}

function ThemeSwitch() {
  const [choice, setChoice] = useThemeChoice();
  return (
    <ToggleGroup
      type="single"
      variant="outline"
      size="sm"
      value={choice}
      onValueChange={(v) => v && setChoice(v as ThemeChoice)}
      aria-label="Theme"
    >
      <ToggleGroupItem value="light">Light</ToggleGroupItem>
      <ToggleGroupItem value="dark">Dark</ToggleGroupItem>
      <ToggleGroupItem value="system">System</ToggleGroupItem>
    </ToggleGroup>
  );
}

export function StrataGallery() {
  const [bulkOpen, setBulkOpen] = useState(false);
  const units = [
    'BKT-2026-000019',
    'CT-2026-000004',
    'CRE-2026-000110',
    'ST-2026-000031',
    'BKT-2026-000020',
    'BKT-2026-000021',
    'BKT-2026-000022',
    'CT-2026-000005',
  ];
  return (
    <TooltipProvider>
      <main className="mx-auto max-w-6xl space-y-10 bg-background p-6 text-foreground">
        <header className="flex flex-wrap items-center justify-between gap-3">
          <h1 className="text-2xl font-bold">Strata shared components</h1>
          <ThemeSwitch />
        </header>

        <Section title="Stage tags">
          <div className="flex flex-wrap gap-2">
            {STAGE_KEYS.map((stage) => (
              <StageTag key={stage} stage={stage} domain="retention" />
            ))}
          </div>
          <div className="flex flex-wrap gap-2">
            <StageTag stage="lab" label="In lab" />
            <StageTag stage="storage" label="Short-term" />
            <StageTag stage="storage" label="Long-term" />
            <StageTag stage="due" label="Retention due" />
            <StageTag stage="danger" label="Retention overdue" />
            <StageTag stage="closed" label="Disposed" />
            <StageTag variant="neutral" label="Hold · 3 days left" icon={Hourglass} />
            <StageTag variant="outline" label="Urgent · Priority" icon={Flag} />
          </div>
        </Section>

        <Section title="Stage stripes">
          <div className="grid gap-3 sm:grid-cols-3">
            {(['due', 'danger', 'lab'] as const).map((stage) => (
              <div
                key={stage}
                className="relative overflow-hidden rounded-xl border bg-card p-4 pl-6"
              >
                <StageStripe stage={stage} variant="edge" />
                <p className="font-semibold">Card with a {stage} edge</p>
                <StageSrText stage={stage} />
              </div>
            ))}
          </div>
        </Section>

        <Section title="Lifecycle track">
          <div className="space-y-4 rounded-xl border bg-card p-4">
            <LifecycleTrack
              steps={STORAGE_UNIT_STEPS}
              current="long_term"
              passedWithout={['in_lab']}
            />
            <LifecycleTrack steps={STORAGE_UNIT_STEPS} current="in_lab" />
            <LifecycleTrack steps={CONCRETE_SET_STEPS} current="testing" label="Set lifecycle" />
            <LifecycleTrack steps={STORAGE_UNIT_STEPS} current="short_term" compact />
          </div>
        </Section>

        <Section title="People">
          <div className="flex flex-wrap items-center gap-4">
            <PersonAvatar name="Alex Tester" size="lg" />
            <PersonAvatar name="Sam Sample" />
            <PersonAvatar name="Pat Example (LAB)" size="compact" />
            <PersonAvatar system size="lg" />
            <div className="w-40">
              <PersonCell name="Jordan Lab" />
            </div>
            <div className="w-40">
              <PersonCell name="" />
            </div>
          </div>
        </Section>

        <Section title="Table, tools and peek drawer">
          <p className="text-sm text-muted-foreground">
            Open a row to see the drawer (Esc closes, J/K move). Drag the divider: columns hide by
            the list&rsquo;s own width.
          </p>
          <InboxDemo />
        </Section>

        <Section title="Toasts and bulk confirm">
          <div className="flex flex-wrap gap-2">
            <Button
              variant="outline"
              onClick={() =>
                notifySuccess('Moved BKT-2026-000019 to WH-A-B2-S3', {
                  undo: { run: () => new Promise((resolve) => setTimeout(resolve, 400)) },
                })
              }
            >
              Move with Undo
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                notifySuccess('Added CT-2026-000004 to the disposal list', {
                  undo: { run: () => Promise.reject(new Error('The unit moved since.')) },
                })
              }
            >
              Undo that fails
            </Button>
            <Button
              variant="outline"
              onClick={() =>
                notifyError("Couldn't print the label", 'The Receiving bench printer is offline.')
              }
            >
              Error toast
            </Button>
            <Button variant="destructive" onClick={() => setBulkOpen(true)}>
              Record disposal…
            </Button>
          </div>
          <BulkConfirmDialog
            open={bulkOpen}
            onOpenChange={setBulkOpen}
            title={`Record disposal of ${units.length} units`}
            description="These units will be marked disposed and leave the shelf counts."
            records={units.map((id) => ({ id, label: 'DEMO-2601' }))}
            confirmLabel={(n) => `Record disposal of ${n} units`}
            noun={{ one: 'unit', other: 'units' }}
            irreversibleNote="Disposal can't be undone."
            onConfirm={async () => {
              await new Promise((resolve) => setTimeout(resolve, 600));
              return {
                succeeded: units.slice(1),
                failed: [{ id: units[0]!, reason: 'It is checked out to LP-2026-0012.' }],
              };
            }}
          />
        </Section>
      </main>
      <StrataToaster />
    </TooltipProvider>
  );
}
