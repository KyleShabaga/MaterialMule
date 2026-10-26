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
 * (MM-T35), which leaves out the project column because every row is the same project.
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
          <strong>{item.readableId}</strong>
          <span>{storageUnitTypeLabel(item.unitType)}</span>
        </span>
      ),
    },
    ...(showProject
      ? [
          {
            header: 'Project',
            cell: (item: InventoryItem) => (
              <span className="unit-cell">
                <span>{item.project.projectNumber}</span>
                <span>{item.project.name}</span>
              </span>
            ),
          },
        ]
      : []),
    { header: 'Test holes', cell: (item) => <HoleList item={item} /> },
    { header: 'Location', cell: (item) => item.location.name },
    { header: 'Received', cell: (item) => item.receivedDate },
    {
      header: 'Status',
      cell: (item) => <StorageUnitStatusBadge status={item.status} />,
    },
    {
      header: 'View',
      cell: (item) => (
        <Link
          to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
          state={linkState}
          aria-label={`View ${item.readableId}`}
        >
          View
        </Link>
      ),
    },
  ];
  return (
    <div className="inventory-table">
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
        <li key={hole.testHoleId}>
          {hole.testHoleName}: {formatStorageUnitHoleSummary(hole)}
        </li>
      ))}
    </ul>
  );
}
