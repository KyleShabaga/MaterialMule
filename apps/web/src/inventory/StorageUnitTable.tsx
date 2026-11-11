import {
  currentLocationName,
  TESTED_CONTENTS_LABEL,
  storageUnitTypeLabel,
  type InventoryItem,
} from '@materialmule/shared';
import { useEffect, useRef } from 'react';
import { Link } from 'react-router';
import { TableScroll, type TableView } from '../components/ui';
import type { QueuedMove } from '../moves/store';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';
import { UnitContentsLine, UnitContentsList } from './UnitContents';

/** Router state for the storage unit detail page's "Back" link. */
export interface StorageUnitLinkState {
  from?: string;
}

/** Row selection for the selection bar (Field Ledger Inventory); leave it out for a plain list. */
export interface StorageUnitSelection {
  selected: ReadonlySet<string>;
  onToggle: (item: InventoryItem, selected: boolean) => void;
  onToggleAll: (items: InventoryItem[], selected: boolean) => void;
}

/**
 * One row per storage unit (MM-T12). Shared by Inventory and the project detail page (MM-T35),
 * which leaves out the project column because every row is the same project. The storage unit ID
 * is the link to its page, so there is no separate View column.
 *
 * Field Ledger: a sheet table in a 2 px frame with a mono caps head. Comfortable rows put the
 * unit type and project name on a second line; compact rows (desktop, mouse) fold them onto the
 * main line with less padding, cut long lists short with "…" (read in full, and shown on hover
 * through `title`) and scroll sideways inside the frame instead of stacking into cards.
 *
 * MM-T36: the contents column holds hole summaries, a Shelby tube's source or a bulk soil
 * bucket's bulk sample with its "bucket n of N" badge, in both views (UnitContents).
 *
 * MM-T81: an open location conflict shows a "Conflict" tag in Status, and a move scanned on this
 * device but not saved yet (`pendingMoves`, from the local queue) shows "Pending" beside the saved
 * location, which it never replaces.
 */
export function StorageUnitTable({
  items,
  linkState,
  showProject = true,
  view = 'comfortable',
  pendingMoves,
  selection,
}: {
  items: InventoryItem[];
  linkState?: StorageUnitLinkState;
  showProject?: boolean;
  view?: TableView;
  /** This device's unsaved moves by storage unit ID (MM-T81). */
  pendingMoves?: ReadonlyMap<string, QueuedMove>;
  selection?: StorageUnitSelection;
}) {
  const compact = view === 'compact';
  const allSelected =
    selection != null && items.length > 0 && items.every((i) => selection.selected.has(i.id));
  const someSelected = selection != null && items.some((i) => selection.selected.has(i.id));
  return (
    <TableScroll
      label="Storage unit table"
      className={
        compact
          ? 'table-frame inventory-table inventory-table-compact'
          : 'table-frame inventory-table table-stack'
      }
    >
      <table className={compact ? 'data-table is-compact' : 'data-table'}>
        <caption className="visually-hidden">Storage units</caption>
        <thead>
          <tr>
            {selection ? (
              <th scope="col" className="select-cell">
                <SelectAll
                  checked={allSelected}
                  indeterminate={someSelected && !allSelected}
                  onChange={(checked) => selection.onToggleAll(items, checked)}
                />
              </th>
            ) : null}
            <th scope="col">Unit ID</th>
            {showProject ? <th scope="col">Project</th> : null}
            <th scope="col">Test holes · samples · depth</th>
            <th scope="col">Location</th>
            <th scope="col">Status</th>
            <th scope="col">Received</th>
            <th scope="col">Retain until</th>
          </tr>
        </thead>
        <tbody>
          {items.map((item) => {
            const selected = selection?.selected.has(item.id) ?? false;
            return (
              <tr key={item.id} className={selected ? 'is-selected' : undefined}>
                {selection ? (
                  <td className="select-cell" data-label="Select">
                    <input
                      type="checkbox"
                      aria-label={`Select ${item.readableId}`}
                      checked={selected}
                      onChange={(event) => selection.onToggle(item, event.target.checked)}
                    />
                  </td>
                ) : null}
                <td data-label="Unit ID">
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
                </td>
                {showProject ? (
                  <td data-label="Project">
                    <span className="unit-cell" title={compact ? projectText(item) : undefined}>
                      <span className="project-number">{item.project.projectNumber}</span>
                      <span className="muted">{item.project.name}</span>
                    </span>
                  </td>
                ) : null}
                <td data-label="Test holes · samples · depth">
                  {compact ? <UnitContentsLine unit={item} /> : <UnitContentsList unit={item} />}
                </td>
                <td data-label="Location">
                  <LocationCell
                    item={item}
                    compact={compact}
                    pending={pendingMoves?.get(item.id)}
                  />
                </td>
                <td data-label="Status">
                  <StatusCell item={item} />
                </td>
                <td data-label="Received">
                  <span className="nowrap mono">{item.receivedDate}</span>
                </td>
                <td data-label="Retain until">
                  <RetainUntil item={item} />
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </TableScroll>
  );
}

function SelectAll({
  checked,
  indeterminate,
  onChange,
}: {
  checked: boolean;
  indeterminate: boolean;
  onChange: (checked: boolean) => void;
}) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (ref.current) ref.current.indeterminate = indeterminate;
  }, [indeterminate]);
  return (
    <input
      ref={ref}
      type="checkbox"
      aria-label="Select every unit on this page"
      checked={checked}
      onChange={(event) => onChange(event.target.checked)}
    />
  );
}

function LocationCell({
  item,
  compact,
  pending,
}: {
  item: InventoryItem;
  compact: boolean;
  pending: QueuedMove | undefined;
}) {
  const name = currentLocationName(item);
  const saved = compact ? (
    <span className="location-line" title={name}>
      {name}
    </span>
  ) : (
    name
  );
  if (!pending) return saved;
  return (
    <span className="unit-cell">
      {compact ? saved : <span>{saved}</span>}
      <span
        className="type-tag type-tag-accent"
        data-testid="pending-move"
        title={`Pending → ${pending.destination.name} (scanned on this device, not saved yet)`}
      >
        Pending
      </span>
    </span>
  );
}

function StatusCell({ item }: { item: InventoryItem }) {
  return (
    <span className="unit-cell">
      <StorageUnitStatusBadge
        status={item.status}
        testedRemovalReason={item.testedRemovalReason ?? null}
      />
      {item.openConflict ? (
        // MM-T28: the saved location needs a person to confirm it (on the unit's page).
        <span
          className="type-tag type-tag-warning"
          title="Location conflict: confirm the location on this unit’s page"
        >
          Conflict
        </span>
      ) : null}
      {item.contentsDestroyed && item.status !== 'disposed' ? (
        // MM-T36: tested, still on the shelf until its removal is confirmed.
        <span className="type-tag" title={`Contents: ${TESTED_CONTENTS_LABEL}`}>
          Tested
        </span>
      ) : null}
      {item.status !== 'disposed' && item.retention?.onHold && !item.retention.retentionExempt ? (
        // MM-T29: visible for every unit the hold covers. A tested unit shows only its
        // exception (Retain until: Not applicable); a hold doesn't block its removal (MM-T71).
        <span className="type-tag" title="An active hold covers this unit">
          On hold
        </span>
      ) : null}
    </span>
  );
}

function RetainUntil({ item }: { item: InventoryItem }) {
  if (!item.retention) return null;
  if (item.retention.retentionExempt) {
    return (
      <span title="Tested unit: use Confirm removal after testing on its page; retention and holds don’t apply">
        Not applicable
      </span>
    );
  }
  return (
    <span className="nowrap mono">
      {item.retention.effectiveRetainUntil}
      {item.retention.eligibleByDate && item.status !== 'disposed' ? ' · eligible' : ''}
    </span>
  );
}

function projectText(item: InventoryItem): string {
  return `${item.project.projectNumber} ${item.project.name}`;
}
