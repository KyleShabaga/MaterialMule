import {
  formatStorageUnitHoleSummary,
  storageUnitTypeLabel,
  type InventoryItem,
} from '@materialmule/shared';
import { Link } from 'react-router';
import { DataTable, type Column } from '../components/ui';
import { StorageUnitStatusBadge } from './StorageUnitStatusBadge';

/** Router state for the storage unit detail page's "Back" link. */
export interface StorageUnitLinkState {
  from?: string;
}

/**
 * One row per storage unit (MM-T12). Shared by Sample Storage and the project detail page
 * (MM-T35), which leaves out the project column because every row is the same project. The
 * storage unit ID is the link to its page (MM-T50 canvas), so there is no separate View column.
 */
export function StorageUnitTable({
  items,
  linkState,
  showProject = true,
}: {
  items: InventoryItem[];
  linkState?: StorageUnitLinkState;
  showProject?: boolean;
}) {
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
              <span className="unit-cell">
                <span className="project-number">{item.project.projectNumber}</span>
                <span className="muted">{item.project.name}</span>
              </span>
            ),
          },
        ]
      : []),
    { header: 'Test holes', cell: (item) => <HoleList item={item} /> },
    { header: 'Location', cell: (item) => item.location.name },
    { header: 'Received', cell: (item) => <span className="nowrap">{item.receivedDate}</span> },
    {
      header: 'Status',
      cell: (item) => <StorageUnitStatusBadge status={item.status} />,
    },
  ];
  return (
    <div className="inventory-table table-stack">
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

function HoleList({ item }: { item: InventoryItem }) {
  return (
    <ul className="hole-list">
      {item.holes.map((hole) => (
        <li key={hole.testHoleId} className="hole-tag">
          {hole.testHoleName}: {formatStorageUnitHoleSummary(hole)}
        </li>
      ))}
    </ul>
  );
}
