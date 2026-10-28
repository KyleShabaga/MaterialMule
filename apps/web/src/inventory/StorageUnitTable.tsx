import {
  TESTED_CONTENTS_LABEL,
  storageUnitTypeLabel,
  type InventoryItem,
} from '@materialmule/shared';
import { Link } from 'react-router';
import { DataTable, type Column } from '../components/ui';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';
import { UnitContentsLine, UnitContentsList } from './UnitContents';

/** Standard rows wrap and stack on narrow screens; compact rows keep each record on one line. */
export type StorageUnitTableView = 'standard' | 'compact';

/** Router state for the storage unit detail page's "Back" link. */
export interface StorageUnitLinkState {
  from?: string;
}

/**
 * One row per storage unit (MM-T12). Shared by Sample Storage and the project detail page
 * (MM-T35), which leaves out the project column because every row is the same project. The
 * storage unit ID is the link to its page (MM-T50 canvas), so there is no separate View column.
 *
 * The compact view (MM-T66 UI-10) shows the same records, fields and links with each record on
 * one line and less padding. A long project name or test-hole list is cut short with "…" but is
 * still read in full by screen readers and shown in full on hover (title); the table scrolls
 * sideways inside its card rather than stacking into cards.
 *
 * MM-T36: the "Sampling source" column holds hole summaries, a Shelby tube's source or a bulk
 * soil bucket's bulk sample with its "bucket n of N" badge, in both views (UnitContents).
 */
export function StorageUnitTable({
  items,
  linkState,
  showProject = true,
  view = 'standard',
}: {
  items: InventoryItem[];
  linkState?: StorageUnitLinkState;
  showProject?: boolean;
  view?: StorageUnitTableView;
}) {
  const compact = view === 'compact';
  const columns: Column<InventoryItem>[] = [
    {
      header: 'Storage unit',
      cell: (item) => (
        <span className="unit-cell">
          <Link
            className="unit-link"
            to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
            state={linkState}
          >
            {item.readableId}
          </Link>
          <span className="type-tag">{storageUnitTypeLabel(item.unitType)}</span>
        </span>
      ),
    },
    ...(showProject
      ? [
          {
            header: 'Project',
            cell: (item: InventoryItem) => (
              <span className="unit-cell" title={compact ? projectText(item) : undefined}>
                <span className="project-number">{item.project.projectNumber}</span>
                <span className="muted">{item.project.name}</span>
              </span>
            ),
          },
        ]
      : []),
    {
      header: 'Sampling source',
      cell: (item) =>
        compact ? <UnitContentsLine unit={item} /> : <UnitContentsList unit={item} />,
    },
    {
      header: 'Location',
      cell: (item) =>
        compact ? (
          <span className="location-line" title={item.location.name}>
            {item.location.name}
          </span>
        ) : (
          item.location.name
        ),
    },
    { header: 'Received', cell: (item) => <span className="nowrap">{item.receivedDate}</span> },
    {
      header: 'Status',
      cell: (item) => (
        <span className="unit-cell">
          <StorageUnitStatusBadge
            status={item.status}
            testedRemovalReason={item.testedRemovalReason ?? null}
          />
          {item.contentsDestroyed && item.status !== 'disposed' ? (
            // MM-T36: tested, still on the shelf until its removal is confirmed.
            <span className="type-tag" title={`Contents: ${TESTED_CONTENTS_LABEL}`}>
              Tested
            </span>
          ) : null}
          {item.status !== 'disposed' && item.retention?.onHold ? (
            // MM-T29: visible for every unit the hold covers; a tested unit shows its exception.
            <span className="type-tag" title="An active hold covers this unit">
              On hold
            </span>
          ) : null}
        </span>
      ),
    },
    {
      header: 'Retain until',
      cell: (item) =>
        item.retention ? (
          item.retention.retentionExempt ? (
            <span title="Tested unit: removed after testing, not by retention">Not applicable</span>
          ) : (
            <span className="nowrap">
              {item.retention.effectiveRetainUntil}
              {item.retention.eligibleByDate && item.status !== 'disposed' ? ' · eligible' : ''}
            </span>
          )
        ) : null,
    },
  ];
  return (
    <div
      className={
        compact ? 'inventory-table inventory-table-compact' : 'inventory-table table-stack'
      }
    >
      <DataTable
        rows={items}
        rowKey={(item) => item.id}
        caption="Storage units"
        empty="No storage units."
        columns={columns}
      />
    </div>
  );
}

function projectText(item: InventoryItem): string {
  return `${item.project.projectNumber} ${item.project.name}`;
}
