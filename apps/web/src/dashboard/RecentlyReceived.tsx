import {
  formatStorageUnitHoleSummary,
  printJobStatusText,
  storageUnitTypeLabel,
  type RecentlyReceivedItem,
  type RecentlyReceivedShow,
} from '@materialmule/shared';
import { useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge, type Column } from '../components/ui';
import type { InventoryLinkState } from '../inventory/InventoryPage';
import { fetchRecentlyReceived } from './api';
import { labDate, receivedWhen } from './format';
import { useLoad } from './useLoad';

// "Recently received": the newest storage units with their latest label print status, worded
// exactly as on the storage unit's Labels section (printJobStatusText).

const FILTERS: { show: RecentlyReceivedShow; label: string }[] = [
  { show: 'all', label: 'All' },
  { show: 'today', label: 'Today' },
  { show: 'labels', label: 'Labels to check' },
];

const EMPTY: Record<RecentlyReceivedShow, string> = {
  all: 'No storage units yet. Receive samples to add the first.',
  today: 'Nothing received today.',
  labels: 'No labels to check. Every recent label is confirmed or still on its way.',
};

const SHOWING: Record<RecentlyReceivedShow, string> = {
  all: 'in Sample Storage',
  today: 'received today',
  labels: 'with labels to check',
};

const linkState: InventoryLinkState = { from: '' };

function LabelStatus({ item }: { item: RecentlyReceivedItem }) {
  if (!item.latestPrint) return <StatusBadge tone="neutral">No label yet</StatusBadge>;
  const text = printJobStatusText(item.latestPrint);
  return <StatusBadge tone={text.tone}>{text.label}</StatusBadge>;
}

const columns: Column<RecentlyReceivedItem>[] = [
  {
    header: 'Storage unit',
    cell: (item) => (
      <span className="dash-unit">
        <Link
          className="dash-unit-id"
          to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
          state={linkState}
        >
          {item.readableId}
        </Link>
        <span className="dash-tag">{storageUnitTypeLabel(item.unitType)}</span>
      </span>
    ),
  },
  {
    header: 'Project',
    cell: (item) => (
      <span className="dash-stack">
        <span className="dash-project">{item.project.projectNumber}</span>
        <span className="muted">{item.project.name}</span>
      </span>
    ),
  },
  {
    header: 'SAMPLE#/DEPTH',
    cell: (item) => (
      <ul className="dash-holes">
        {item.holes.map((hole) => (
          <li key={hole.testHoleId} className="dash-tag dash-tag-plain">
            {hole.testHoleName}: {formatStorageUnitHoleSummary(hole)}
          </li>
        ))}
      </ul>
    ),
  },
  { header: 'Location', cell: (item) => item.location.name },
  {
    header: 'Received',
    cell: (item) => (
      <span className="dash-stack">
        <time className="dash-mono" dateTime={item.receivedAt}>
          {receivedWhen(item.receivedDate, item.receivedAt)}
        </time>
        <span className="muted" title={item.receiver.name}>
          by {item.receiver.initials}
        </span>
      </span>
    ),
  },
  { header: 'Label', cell: (item) => <LabelStatus item={item} /> },
];

/** The Sample Storage list that shows the same units, newest first. */
function sampleStorageLink(show: RecentlyReceivedShow): string {
  if (show !== 'today') return '/sample-storage';
  const today = labDate(new Date());
  return `/sample-storage?receivedFrom=${today}&receivedTo=${today}`;
}

export function RecentlyReceived() {
  const [show, setShow] = useState<RecentlyReceivedShow>('all');
  const [load, retry] = useLoad(show, () => fetchRecentlyReceived(show));
  const data = load.state === 'ready' ? load.data : null;

  return (
    <section className="dash-panel dash-recent" aria-labelledby="dash-recent">
      <div className="dash-head">
        <div className="dash-head-title">
          <h2 id="dash-recent">Recently received</h2>
          {data ? <span className="dash-tag">{data.receivedThisWeek} this week</span> : null}
        </div>
        <div className="dash-filters" role="group" aria-label="Show">
          {FILTERS.map((filter) => (
            <button
              key={filter.show}
              type="button"
              aria-pressed={show === filter.show}
              className={filter.show === 'labels' ? 'dash-filter-labels' : undefined}
              onClick={() => setShow(filter.show)}
            >
              {filter.label}
              {filter.show === 'labels' && data && data.labelsToCheck > 0 ? (
                <>
                  {' '}
                  <span className="dash-filter-count">{data.labelsToCheck}</span>
                </>
              ) : null}
            </button>
          ))}
        </div>
      </div>
      <div className="dash-body" aria-busy={load.state === 'loading'}>
        {load.state === 'loading' ? (
          <ul className="activity skeleton" aria-label="Loading recently received storage units">
            <li />
            <li />
            <li />
          </ul>
        ) : load.state === 'error' ? (
          <ErrorState message={load.message} onRetry={retry} />
        ) : (
          <div className="dash-table">
            <DataTable
              rows={load.data.items}
              rowKey={(item) => item.id}
              caption="Recently received storage units"
              empty={EMPTY[show]}
              columns={columns}
            />
          </div>
        )}
      </div>
      <div className="dash-foot">
        <span className="muted">
          {data && data.items.length > 0
            ? `Showing the ${data.items.length} most recent of ${data.total} ${SHOWING[show]}`
            : null}
        </span>
        <Link to={sampleStorageLink(show)}>See all in Sample Storage →</Link>
      </div>
    </section>
  );
}
