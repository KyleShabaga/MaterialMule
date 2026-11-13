import {
  DISPOSED_AFTER_TESTING_LABEL,
  STORAGE_UNIT_RECORD_STATUS_LABELS,
  TESTED_CONTENTS_LABEL,
  formatBulkBadge,
  currentLocationName,
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  storageUnitStatusLabel,
  storageUnitTypeLabel,
  type InventoryItem,
  type InventoryListItem,
} from '@materialmule/shared';
import { useMemo, type MouseEvent } from 'react';
import { Link } from 'react-router';
import { Badge } from '@/components/ui/badge';
import { DataTable, type DataTableColumn } from '../components/strata/data-table';
import { StageTag, UnitStatusTag } from '../components/strata/stage-tag';
import type { SortState } from '../components/strata/table-query';
import { cn } from '@/lib/utils';
import type { QueuedMove } from '../moves/store';
import { rowRecordStatus, rowStage } from './list-columns';
import { unitContentsText } from './unit-contents';

/** Router state for the storage unit detail page's "Back" link. */
export interface StorageUnitLinkState {
  from?: string;
}

/** Test hole names (or a sampled unit's source), as the Test hole column's first line shows. */
function holeNames(item: InventoryItem): string {
  if (item.sample) return formatSampleIdentity(item.sample);
  return item.holes.map((h) => h.testHoleName).join(', ');
}

/**
 * Storage units as a Strata DataTable (STRATA-79, canvas R3Inventory): ID (mono, stage stripe),
 * project, test hole, type, where (location code over its warehouse › bay › shelf path), stage
 * tag in record status words, received and retain until. Rows arrive sorted and paged by the
 * server. Received and Retain until hide first as the list narrows (1024 px, a drawer), then
 * Type, Test hole and Where. Nothing folds into the ID cell: IDs are never cut (DESIGN.md › Tables),
 * and a clipped value keeps its full text in a title.
 *
 * Kept from Field Ledger: a tested unit's Retain until reads "Not applicable" (MM-T71); an active
 * hold shows "On hold" under the date; a tested tube still on the shelf shows "Tested"; this
 * device's unsaved move shows "Pending" beside the saved location, which it never replaces
 * (MM-T81).
 */
export function StorageUnitTable({
  items,
  caption = 'Storage units',
  linkState,
  density = 'comfortable',
  pendingMoves,
  selectedIds,
  onSelectedIdsChange,
  sort = null,
  onSortChange,
  onOpenRow,
  openRowId = null,
  hiddenColumns = [],
  loading = false,
}: {
  items: readonly InventoryListItem[];
  /** The table's accessible name. */
  caption?: string;
  linkState?: StorageUnitLinkState;
  density?: 'comfortable' | 'compact';
  /** This device's unsaved moves by storage unit ID (MM-T81). */
  pendingMoves?: ReadonlyMap<string, QueuedMove>;
  /** Selected readable IDs; with `onSelectedIdsChange`, adds the checkbox column. */
  selectedIds?: ReadonlySet<string>;
  onSelectedIdsChange?: (next: Set<string>) => void;
  sort?: SortState | null;
  onSortChange?: (next: SortState | null) => void;
  /** Opens a row (the drawer). The ID link still opens the page on a modified click. */
  onOpenRow?: (item: InventoryListItem) => void;
  openRowId?: string | null;
  hiddenColumns?: readonly string[];
  loading?: boolean;
}) {
  const columns = useMemo<DataTableColumn<InventoryListItem>[]>(() => {
    const all: DataTableColumn<InventoryListItem>[] = [
      {
        id: 'id',
        header: 'ID',
        priority: 'identity',
        mono: true,
        width: '15ch',
        sortKey: 'id',
        cell: (item) => (
          <Link
            to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
            state={linkState}
            className="font-semibold whitespace-nowrap text-foreground underline-offset-4 hover:underline"
            onClick={(event: MouseEvent) => {
              if (!onOpenRow || event.metaKey || event.ctrlKey || event.shiftKey) return;
              event.preventDefault();
              onOpenRow(item);
            }}
          >
            {item.readableId}
          </Link>
        ),
      },
      {
        id: 'project',
        header: 'Project',
        priority: 'identity',
        mono: true,
        width: '10ch',
        sortKey: 'project',
        cell: (item) => (
          <span
            className="whitespace-nowrap"
            title={`${item.project.projectNumber} · ${item.project.name}`}
          >
            {item.project.projectNumber}
          </span>
        ),
      },
      {
        id: 'hole',
        header: 'Test hole',
        priority: 'attribute',
        width: '9rem',
        hideBelow: '40rem',
        cell: (item) => {
          const text = unitContentsText(item);
          // A bulk soil bucket names its bucket of the bulk sample (MM-T36); never its ID.
          const summaries = item.sample
            ? item.bulkGroup
              ? formatBulkBadge(item.sample, item.bulkGroup)
              : null
            : item.holes.map((h) => formatStorageUnitHoleSummary(h)).join(', ');
          return (
            <span className="flex min-w-0 flex-col" title={text || undefined}>
              <span className="truncate font-mono text-[13px]">{holeNames(item) || '—'}</span>
              {summaries ? (
                <span className="truncate text-[13px] text-muted-foreground">{summaries}</span>
              ) : null}
            </span>
          );
        },
      },
      {
        id: 'type',
        header: 'Type',
        priority: 'attribute',
        width: '8rem',
        hideBelow: '52rem',
        sortKey: 'type',
        cell: (item) => (
          <span className="block truncate" title={storageUnitTypeLabel(item.unitType)}>
            {storageUnitTypeLabel(item.unitType)}
          </span>
        ),
      },
      {
        id: 'where',
        header: 'Where',
        priority: 'attribute',
        hideBelow: '34rem',
        sortKey: 'where',
        cell: (item) => <WhereCell item={item} pending={pendingMoves?.get(item.id)} />,
      },
      {
        id: 'stage',
        header: 'Stage',
        priority: 'state',
        // Fits the longest tag, "Disposed after testing": a status is never cut off.
        width: '12rem',
        wrap: true,
        sortKey: 'stage',
        cell: (item) => <StageCell item={item} />,
      },
      {
        id: 'received',
        header: 'Received',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        hideBelow: '58rem',
        sortKey: 'received',
        cell: (item) => <span className="whitespace-nowrap">{item.receivedDate}</span>,
      },
      {
        id: 'retain',
        header: 'Retain until',
        priority: 'attribute',
        mono: true,
        width: '10ch',
        hideBelow: '58rem',
        sortKey: 'retain_until',
        cell: (item) => <RetainUntil item={item} />,
      },
    ];
    return all.filter((column) => !hiddenColumns.includes(column.id));
  }, [hiddenColumns, linkState, onOpenRow, pendingMoves]);

  return (
    <DataTable
      columns={columns}
      data={items}
      getRowId={(item) => item.readableId}
      rowLabel={(item) => item.readableId}
      density={density}
      sort={sort}
      onSortChange={onSortChange}
      stage={rowStage}
      selectedIds={selectedIds}
      onSelectedIdsChange={onSelectedIdsChange}
      onOpenRow={onOpenRow}
      openRowId={openRowId}
      caption={caption}
      loading={loading}
      freeColumnMin="9rem"
    />
  );
}

/** The location code over its path ("Warehouse A · Bay 2 · Shelf 3"), and a Pending move. */
function WhereCell({ item, pending }: { item: InventoryListItem; pending?: QueuedMove }) {
  const disposed = item.status === 'disposed';
  const path = item.locationPath?.length ? item.locationPath.join(' · ') : item.location.name;
  return (
    <span className="flex min-w-0 items-center gap-2">
      <span className="flex min-w-0 flex-col">
        {disposed ? (
          // MISC-12: a disposed unit has no current location; its last one stays in History.
          <span className="text-[13px] text-muted-foreground">{currentLocationName(item)}</span>
        ) : (
          <>
            <span className="truncate font-mono text-[13px]" title={item.location.code}>
              {item.location.code}
            </span>
            <span className="truncate text-[13px] text-muted-foreground" title={path}>
              {path}
            </span>
          </>
        )}
      </span>
      {pending ? (
        <Badge
          variant="outline"
          data-testid="pending-move"
          className="shrink-0"
          title={`Pending → ${pending.destination.name} (scanned on this device, not saved yet)`}
        >
          Pending
        </Badge>
      ) : null}
    </span>
  );
}

function StageCell({ item }: { item: InventoryItem }) {
  const status = rowRecordStatus(item);
  const tested = Boolean(item.contentsDestroyed && item.status !== 'disposed');
  const words =
    status === 'disposed' && item.testedRemovalReason
      ? DISPOSED_AFTER_TESTING_LABEL
      : status
        ? STORAGE_UNIT_RECORD_STATUS_LABELS[status]
        : storageUnitStatusLabel(item.status);
  return (
    // The title keeps the words readable should a narrow list ever clip the tag.
    <span className="flex min-w-0 flex-col items-start gap-0.5" title={words}>
      {status === 'disposed' && item.testedRemovalReason ? (
        // MM-T36: removed through the post-testing route.
        <StageTag stage="closed" label={DISPOSED_AFTER_TESTING_LABEL} />
      ) : status ? (
        <UnitStatusTag status={status} />
      ) : (
        <StageTag stage="storage" label={storageUnitStatusLabel(item.status)} />
      )}
      {tested ? (
        // MM-T36: tested, still on the shelf until its removal is confirmed.
        <span
          className="text-[13px] text-muted-foreground"
          title={`Contents: ${TESTED_CONTENTS_LABEL}`}
        >
          Tested
        </span>
      ) : null}
    </span>
  );
}

function RetainUntil({ item }: { item: InventoryItem }) {
  if (!item.retention) return null;
  if (item.retention.retentionExempt) {
    return (
      <span
        className="font-sans text-[13px] text-muted-foreground"
        title="Tested unit: use Confirm removal after testing on its page; retention and holds don’t apply"
      >
        Not applicable
      </span>
    );
  }
  const status = rowRecordStatus(item);
  const onHold = item.retention.onHold && item.status !== 'disposed';
  return (
    <span className="flex flex-col">
      <span
        className={cn(
          'whitespace-nowrap',
          status === 'retention_due' && 'font-semibold text-stage-due-fg',
          status === 'retention_overdue' && 'font-semibold text-stage-danger-fg',
          status === 'disposed' && 'text-muted-foreground',
        )}
      >
        {item.retention.effectiveRetainUntil}
      </span>
      {onHold ? (
        // MM-T29: an active hold covers this unit (a tested unit shows only Not applicable).
        <span
          className="font-sans text-[13px] text-muted-foreground"
          title="An active hold covers this unit"
        >
          On hold
        </span>
      ) : null}
    </span>
  );
}
