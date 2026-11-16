import {
  RECEIPT_LOG_STATUS_LABELS,
  storageUnitHistoryActionLabel,
  storageUnitTypeLabel,
  type ReceiptDetail,
  type ReceiptHistoryPage,
  type ReceiptUnit,
  type StageKey,
} from '@materialmule/shared';
import { Ellipsis, FileDown, Link2 } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Link, useLocation, useParams } from 'react-router';
import { DataTable, type DataTableColumn } from '@/components/strata/data-table';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { StageTag } from '@/components/strata/stage-tag';
import { notifyError, notifySuccess } from '@/components/strata/toast';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@/components/ui/empty';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Skeleton } from '@/components/ui/skeleton';
import { cn } from '@/lib/utils';
import { UnitContentsList } from '../inventory/UnitContents';
import { usePageTitle } from '../layout/page-title';
import { PrintLabelsPanel } from '../printing/PrintLabelsPanel';
import { receiptPrintPath } from '../printing/print-paths';
import { useSession } from '../session/context';
import { fetchReceipt, fetchReceiptHistory, type ReceiptLogResult } from './api';
import { formatClock, formatConfirmedAt, receiptName } from './format';
import type { ReceiptLinkState } from './ReceivingLogPage';

// Receipt page (MM-T51, STRATA-78, canvas R2ReceiptContent): the record pattern. The header
// names the receipt by its received date and receiver (receipts have no number), with project,
// received date and by, "Entered by X, for Y" when the confirming account differs, the status
// tag and the main action Print all labels (a reprint). The body has the storage units in this
// receipt and the original receipt record as confirmed, corrected values highlighted; corrections
// and paged history sit beside it (below it in the drawer and under 56rem). Corrections (MM-T13)
// and disposal never rewrite the header or take a unit off its receipt; disposed units can't be
// reprinted. Opening this page prints nothing.

export function ReceiptDetailPage() {
  const { receiptId = '' } = useParams();
  const location = useLocation();
  const from = (location.state as ReceiptLinkState | null)?.from ?? '';
  return <ReceiptRecord receiptId={receiptId} variant="page" backTo={`/receiving-log${from}`} />;
}

const UNIT_STATUS: Record<ReceiptUnit['status'], { stage: StageKey; label: string }> = {
  in_stock: { stage: 'storage', label: 'In storage' },
  approved_for_disposal: { stage: 'due', label: 'Approved for disposal' },
  disposed: { stage: 'closed', label: 'Disposed' },
};

export function ReceiptRecord({
  receiptId,
  variant,
  backTo = '/receiving-log',
  titleId = 'receipt-title',
}: {
  receiptId: string;
  /** `page` is the full page; `drawer` the receiving log's peek (one column, no breadcrumb). */
  variant: 'page' | 'drawer';
  backTo?: string;
  titleId?: string;
}) {
  const [loaded, setLoaded] = useState<{
    key: string;
    result: ReceiptLogResult<ReceiptDetail>;
  } | null>(null);
  const [reloads, setReloads] = useState(0);
  const page = variant === 'page';

  useEffect(() => {
    let cancelled = false;
    void fetchReceipt(receiptId).then((result) => {
      if (!cancelled) setLoaded({ key: receiptId, result });
    });
    return () => {
      cancelled = true;
    };
  }, [receiptId, reloads]);

  const current = loaded?.key === receiptId ? loaded.result : null;
  usePageTitleIf(page, current?.ok ? `Receipt ${receiptName(current.data)}` : 'Receipt');

  const crumbs = page ? (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={backTo}>Receiving log</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage>
            {current?.ok
              ? `Receipt ${current.data.project.projectNumber} · ${current.data.receivedDate}`
              : 'Receipt'}
          </BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  ) : null;

  if (!current) {
    return (
      <div className={cn('space-y-4', page ? 'p-6' : 'p-4')} aria-busy="true">
        {crumbs}
        <span role="status" className="sr-only">
          Loading receipt…
        </span>
        <Skeleton className="h-4 w-56" />
        <Skeleton className="h-8 w-72" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }
  if (!current.ok) {
    const missing = current.kind === 'not_found' || current.kind === 'invalid';
    return (
      <div className={cn('space-y-4', page ? 'p-6' : 'p-4')}>
        {crumbs}
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>{missing ? 'No receipt found' : 'The receipt didn’t load'}</EmptyTitle>
            <EmptyDescription>
              {missing ? 'Find it in the Receiving log instead.' : current.message}
            </EmptyDescription>
          </EmptyHeader>
          {!missing && current.kind !== 'unauthenticated' ? (
            <Button variant="outline" onClick={() => setReloads((n) => n + 1)}>
              Try again
            </Button>
          ) : null}
        </Empty>
      </div>
    );
  }

  const receipt = current.data;
  return (
    <div className={cn('space-y-6', page ? 'p-6' : 'p-4')} data-slot="receipt-record">
      {crumbs}
      <ReceiptHeader receipt={receipt} titleId={titleId} page={page} />
      <div
        className={cn('grid gap-6', page && 'min-[56rem]:grid-cols-[minmax(0,2fr)_minmax(0,1fr)]')}
      >
        <div className="min-w-0 space-y-6">
          <UnitsSection receipt={receipt} />
          <OriginalRecord receipt={receipt} />
        </div>
        <HistoryAside receiptId={receipt.id} />
      </div>
    </div>
  );
}

function usePageTitleIf(on: boolean, title: string) {
  // The drawer never renames the page it sits on.
  usePageTitle(on ? title : undefined);
}

function enteredBy(receipt: ReceiptDetail): string | null {
  const account = receipt.account;
  if (!account.sharedStation && account.name === receipt.receiver.name) return null;
  return `${account.sharedStation ? `${account.name} (shared station)` : account.name}, for ${receipt.receiver.name}`;
}

function ReceiptHeader({
  receipt,
  titleId,
  page,
}: {
  receipt: ReceiptDetail;
  titleId: string;
  page: boolean;
}) {
  const { session } = useSession();
  const canPrint = session.status === 'active' && session.me.permissions.includes('label.print');
  const status = receipt.status ?? 'confirmed';
  const printable = receipt.units.filter((unit) => unit.status !== 'disposed');
  const disposed = receipt.units.filter((unit) => unit.status === 'disposed');
  const entered = enteredBy(receipt);
  const HeadingTag = page ? 'h1' : 'h2';

  async function copyLink() {
    try {
      await navigator.clipboard.writeText(
        new URL(`/receiving-log/${receipt.id}`, window.location.origin).toString(),
      );
      notifySuccess('Link copied');
    } catch {
      notifyError("The link couldn't be copied.");
    }
  }

  return (
    <header className="flex flex-wrap items-start justify-between gap-4">
      <div className="min-w-0 space-y-1">
        <p className="text-sm text-muted-foreground">
          Receipt · <span className="font-mono">{receipt.project.projectNumber}</span>{' '}
          {receipt.project.name}
        </p>
        <HeadingTag id={titleId} className="text-2xl font-semibold">
          <span className="sr-only">Receipt</span>{' '}
          <span className="font-mono">{receipt.receivedDate}</span> · {receipt.receiver.name}
        </HeadingTag>
        <p className="flex flex-wrap items-center gap-1.5 text-sm text-muted-foreground">
          Received by{' '}
          <span className="inline-flex items-center gap-1.5 text-foreground">
            <PersonAvatar name={receipt.receiver.name} userId={receipt.receiver.userId} />
            {receipt.receiver.initials} · {receipt.receiver.name}
          </span>
        </p>
      </div>
      <div className="flex min-w-0 flex-col items-start gap-3 min-[40rem]:items-end">
        <StageTag stage="storage" label={RECEIPT_LOG_STATUS_LABELS[status]} />
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
          <dt className="text-muted-foreground">Confirmed</dt>
          <dd>
            <time dateTime={receipt.confirmedAt}>{formatConfirmedAt(receipt.confirmedAt)}</time>
          </dd>
          {entered ? (
            <>
              <dt className="text-muted-foreground">Entered by</dt>
              <dd>{entered}</dd>
            </>
          ) : null}
          {receipt.lastCorrection ? (
            <>
              <dt className="text-muted-foreground">Last corrected</dt>
              <dd>
                <time dateTime={receipt.lastCorrection.at}>
                  {formatConfirmedAt(receipt.lastCorrection.at)}
                </time>
                {receipt.lastCorrection.by ? ` by ${receipt.lastCorrection.by}` : ''}
              </dd>
            </>
          ) : null}
        </dl>
        <div className="flex items-start gap-2">
          {canPrint && printable.length > 0 ? (
            <PrintLabelsPanel
              storageUnitIds={printable.map((unit) => unit.id)}
              // Labels were issued and first printed at confirmation; this prints them again.
              kind="reprint"
              buttonLabel="Print all labels"
            />
          ) : null}
          <DropdownMenu modal={false}>
            <DropdownMenuTrigger asChild>
              <Button variant="outline" size="icon" aria-label="More actions">
                <Ellipsis aria-hidden="true" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onSelect={() => void copyLink()}>
                <Link2 aria-hidden="true" />
                Copy link
              </DropdownMenuItem>
              <DropdownMenuItem asChild>
                {/* Print views open in a new tab so this receipt stays open. */}
                <Link to={receiptPrintPath(receipt.id)} target="_blank" rel="noopener">
                  <FileDown aria-hidden="true" />
                  Preview or save labels as PDF
                </Link>
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {canPrint ? (
          <p className="max-w-80 text-sm text-muted-foreground min-[40rem]:text-right">
            {printable.length === 0
              ? 'Every storage unit in this receipt is disposed; there are no labels to print.'
              : `Prints ${printable.length} ${printable.length === 1 ? 'label' : 'labels'}.`}
            {disposed.length > 0 && printable.length > 0 ? (
              <>
                {' '}
                <span className="font-mono">
                  {disposed.map((unit) => unit.readableId).join(', ')}
                </span>{' '}
                {disposed.length === 1 ? 'is' : 'are'} disposed, so{' '}
                {disposed.length === 1 ? 'its label' : 'their labels'} can’t be reprinted.
              </>
            ) : null}
          </p>
        ) : null}
      </div>
    </header>
  );
}

const unitPath = (unit: ReceiptUnit) => `/sample-storage/${encodeURIComponent(unit.readableId)}`;

function UnitsSection({ receipt }: { receipt: ReceiptDetail }) {
  const disposed = receipt.units.filter((unit) => unit.status === 'disposed').length;
  const columns: DataTableColumn<ReceiptUnit>[] = [
    {
      id: 'unit',
      header: 'Storage unit',
      priority: 'identity',
      mono: true,
      // PREFIX-YYYY-NNNNNN in semibold mono plus the stage stripe: IDs are never cut.
      width: '17ch',
      cell: (unit) => (
        <Link
          className="font-mono text-link underline-offset-4 hover:underline"
          to={unitPath(unit)}
          aria-label={`Open ${unit.readableId}`}
        >
          {unit.readableId}
        </Link>
      ),
    },
    {
      id: 'holder',
      header: 'Holder and test hole',
      priority: 'attribute',
      wrap: true,
      cell: (unit) => (
        <span className="flex min-w-0 flex-col">
          <span>{storageUnitTypeLabel(unit.unitType)}</span>
          <span className="text-muted-foreground">
            <UnitContentsList unit={unit} listClassName="inline" itemClassName="" />
          </span>
        </span>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      priority: 'state',
      wrap: true,
      width: '11rem',
      cell: (unit) => (
        <StageTag stage={UNIT_STATUS[unit.status].stage} label={UNIT_STATUS[unit.status].label} />
      ),
    },
  ];
  return (
    <section aria-labelledby="receipt-units-heading" className="space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 id="receipt-units-heading" className="text-base font-semibold">
          Storage units in this receipt
        </h2>
        <span className="text-sm text-muted-foreground">
          {receipt.units.length}
          {disposed > 0 ? ` · ${disposed} disposed` : ''}
        </span>
      </div>
      <DataTable
        columns={columns}
        data={receipt.units}
        getRowId={(unit) => unit.id}
        rowLabel={(unit) => unit.readableId}
        stage={(unit) => UNIT_STATUS[unit.status].stage}
        caption="Storage units in this receipt"
        empty="No storage units."
        freeColumnMin="10rem"
      />
    </section>
  );
}

/** A value from the original record, highlighted with what it was corrected to. */
function Corrected({ original, now }: { original: ReactNode; now: ReactNode }) {
  return (
    <>
      <mark className="rounded-sm bg-stage-due-bg px-1 text-stage-due-fg">{original}</mark>{' '}
      <span className="text-muted-foreground">(corrected to {now})</span>
    </>
  );
}

function OriginalRecord({ receipt }: { receipt: ReceiptDetail }) {
  const entered = enteredBy(receipt);
  return (
    <section
      aria-labelledby="receipt-original-heading"
      className="space-y-2 rounded-lg border bg-card p-4"
    >
      <div className="flex items-baseline gap-2">
        <h2 id="receipt-original-heading" className="text-base font-semibold">
          Original receipt record
        </h2>
        <span className="text-sm text-muted-foreground">As confirmed</span>
      </div>
      <p className="text-sm text-muted-foreground">
        Confirmed {formatConfirmedAt(receipt.confirmedAt)}
        {entered ? ` by ${entered}` : ''}. Corrections never change this record; they are listed in
        History.
      </p>
      <dl className="grid grid-cols-[minmax(8rem,auto)_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-muted-foreground">Project</dt>
        <dd>
          <span className="font-mono">{receipt.project.projectNumber}</span> {receipt.project.name}{' '}
          ({receipt.project.client})
        </dd>
        <dt className="text-muted-foreground">Received</dt>
        <dd className="font-mono">{receipt.receivedDate}</dd>
        <dt className="text-muted-foreground">Received by</dt>
        <dd>
          {receipt.receiver.initials} · {receipt.receiver.name}
        </dd>
        <dt className="text-muted-foreground">Confirmed by account</dt>
        <dd>
          {receipt.account.sharedStation
            ? `${receipt.account.name} (shared station)`
            : receipt.account.initials
              ? `${receipt.account.initials} · ${receipt.account.name}`
              : receipt.account.name}
        </dd>
        <dt className="text-muted-foreground">Description</dt>
        <dd>{receipt.description ?? 'None'}</dd>
        {receipt.units.map((unit) => (
          <UnitLine key={unit.id} receipt={receipt} unit={unit} />
        ))}
      </dl>
    </section>
  );
}

function UnitLine({ receipt, unit }: { receipt: ReceiptDetail; unit: ReceiptUnit }) {
  const projectChanged = unit.project.id !== receipt.project.id;
  const dateChanged = unit.receivedDate !== receipt.receivedDate;
  return (
    <>
      <dt className="font-mono text-muted-foreground">{unit.readableId}</dt>
      <dd className="space-y-0.5">
        <span>{storageUnitTypeLabel(unit.unitType)}</span>
        {projectChanged ? (
          <span className="block">
            Project:{' '}
            <Corrected
              original={<span className="font-mono">{receipt.project.projectNumber}</span>}
              now={<span className="font-mono">{unit.project.projectNumber}</span>}
            />
          </span>
        ) : null}
        {dateChanged ? (
          <span className="block">
            Received:{' '}
            <Corrected
              original={<span className="font-mono">{receipt.receivedDate}</span>}
              now={<span className="font-mono">{unit.receivedDate}</span>}
            />
          </span>
        ) : null}
      </dd>
    </>
  );
}

function historyLine(event: ReceiptHistoryPage['items'][number]): string {
  const who = event.actor.name ?? 'Material Mule';
  const what = storageUnitHistoryActionLabel(event.action, event.after);
  const unit = event.readableId ? ` · ${event.readableId}` : '';
  const forWhom =
    event.receiver && event.receiver.name !== who ? `, for ${event.receiver.name}` : '';
  return `${what}${unit} — ${who}${forWhom}`;
}

function HistoryAside({ receiptId }: { receiptId: string }) {
  const [page, setPage] = useState(1);
  const [loaded, setLoaded] = useState<{
    key: string;
    result: ReceiptLogResult<ReceiptHistoryPage>;
  } | null>(null);
  const key = `${receiptId}|${page}`;
  useEffect(() => {
    let cancelled = false;
    void fetchReceiptHistory(receiptId, page).then((result) => {
      if (!cancelled) setLoaded({ key, result });
    });
    return () => {
      cancelled = true;
    };
  }, [receiptId, page, key]);
  const current = loaded?.key === key ? loaded.result : null;
  const data = current?.ok ? current.data : null;
  const pages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <aside aria-labelledby="receipt-history-heading" className="min-w-0 space-y-2">
      <div className="flex items-baseline gap-2">
        <h2 id="receipt-history-heading" className="text-base font-semibold">
          Corrections and history
        </h2>
        {data ? (
          <span className="text-sm text-muted-foreground">
            {data.total} {data.total === 1 ? 'event' : 'events'}
          </span>
        ) : null}
      </div>
      {!current ? (
        <div aria-busy="true" className="space-y-2">
          <Skeleton className="h-10 w-full" />
          <Skeleton className="h-10 w-full" />
        </div>
      ) : !current.ok ? (
        <p className="text-sm text-muted-foreground" role="status">
          History didn’t load. {current.message}
        </p>
      ) : data!.items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ItemGroup role="list" aria-label="Corrections and history, newest first">
          {data!.items.map((event) => (
            <Item key={event.id} size="sm" role="listitem" className="px-0">
              <ItemMedia>
                <PersonAvatar
                  name={event.actor.name}
                  system={event.actor.accountType === 'system'}
                />
              </ItemMedia>
              <ItemContent className="min-w-0">
                <ItemTitle className="line-clamp-none font-normal">{historyLine(event)}</ItemTitle>
                {event.reason ? (
                  <ItemDescription className="line-clamp-none">“{event.reason}”</ItemDescription>
                ) : null}
                <ItemDescription>
                  <time dateTime={event.occurredAt}>
                    {event.occurredAt.slice(0, 10)} {formatClock(event.occurredAt)}
                  </time>
                </ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
      {data && pages > 1 ? (
        <nav aria-label="History pages" className="flex items-center gap-2 text-sm">
          <Button
            variant="outline"
            size="sm"
            disabled={page <= 1}
            onClick={() => setPage((p) => p - 1)}
          >
            Newer
          </Button>
          <span className="text-muted-foreground tabular-nums">
            Page {page} of {pages}
          </span>
          <Button
            variant="outline"
            size="sm"
            disabled={page >= pages}
            onClick={() => setPage((p) => p + 1)}
          >
            Older
          </Button>
        </nav>
      ) : null}
    </aside>
  );
}
