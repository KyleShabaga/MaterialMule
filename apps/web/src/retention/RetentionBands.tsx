import type { InventoryItem, InventoryPage } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { fetchInventory } from '../inventory/api';
import { bandInventoryLink, bandParams, type Band } from './bands';

type Loaded =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; page: InventoryPage };

/**
 * One band: its units, earliest retain-until first. Overdue units that no hold covers can be
 * put on the disposal list; the server still decides eligibility when they are approved.
 */
export function RetentionBand({
  band,
  refresh,
  listed,
  canList,
  onToggle,
  hidden = false,
  onTotal,
}: {
  band: Band;
  refresh: number;
  listed: ReadonlySet<string>;
  canList: boolean;
  onToggle: (item: InventoryItem) => void;
  /** Phone: only the chosen band shows; the others still load for their counts. */
  hidden?: boolean;
  onTotal?: (total: number) => void;
}) {
  const [loaded, setLoaded] = useState<{ key: string; value: Loaded } | null>(null);
  const [retry, setRetry] = useState(0);
  const key = `${bandParams(band).toString()}:${refresh}:${retry}`;

  useEffect(() => {
    let cancelled = false;
    void fetchInventory(bandParams(band)).then((result) => {
      if (cancelled) return;
      setLoaded({
        key,
        value: result.ok
          ? { state: 'ready', page: result.data }
          : { state: 'error', message: result.message },
      });
    });
    return () => {
      cancelled = true;
    };
    // `key` already covers the band's dates, the refresh and retries.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const value: Loaded = loaded?.key === key ? loaded.value : { state: 'loading' };
  const headingId = `retention-band-${band.key}`;
  const total = value.state === 'ready' ? value.page.total : null;
  useEffect(() => {
    if (total !== null) onTotal?.(total);
  }, [total, onTotal]);

  return (
    <section
      className={`retention-band retention-band-${band.key}`}
      aria-labelledby={headingId}
      hidden={hidden}
    >
      <div className="retention-band-head">
        <StatusBadge tone={band.tone}>{band.tag}</StatusBadge>
        <h2 id={headingId}>{band.title}</h2>
        <span className="section-meta">
          {total === null ? '…' : `${total} ${total === 1 ? 'unit' : 'units'}`}
        </span>
      </div>
      {value.state === 'loading' ? <p aria-busy="true">Loading…</p> : null}
      {value.state === 'error' ? (
        <ErrorState message={value.message} onRetry={() => setRetry((n) => n + 1)} />
      ) : null}
      {value.state === 'ready' && value.page.items.length === 0 ? (
        <EmptyState>Nothing in this band.</EmptyState>
      ) : null}
      {value.state === 'ready' && value.page.items.length > 0 ? (
        <ul className="retention-rows">
          {value.page.items.map((item) => {
            const onList = listed.has(item.id);
            const listable =
              canList &&
              band.key === 'overdue' &&
              item.status === 'in_stock' &&
              !item.retention?.onHold;
            return (
              <li key={item.id} className="retention-row" data-row>
                <div className="retention-row-unit">
                  <Link
                    className="unit-link"
                    to={`/sample-storage/${encodeURIComponent(item.readableId)}`}
                  >
                    {item.readableId}
                  </Link>
                  <span className="retention-row-where">
                    <span className="mono">{item.project.projectNumber}</span> ·{' '}
                    {item.location.name}
                  </span>
                </div>
                <div className="retention-row-ends">
                  <span className="field-label">Retention ends</span>
                  <span className="mono">{item.retention?.effectiveRetainUntil ?? '—'}</span>
                </div>
                <div className="retention-row-actions">
                  {item.status === 'approved_for_disposal' ? (
                    <StatusBadge tone="waiting">Approved</StatusBadge>
                  ) : null}
                  {item.retention?.onHold ? <StatusBadge tone="lab">On hold</StatusBadge> : null}
                  <Link
                    className="button"
                    to={`/sample-storage/${encodeURIComponent(item.readableId)}#retention`}
                    aria-label={`Extend or hold ${item.readableId}`}
                  >
                    Extend
                  </Link>
                  {listable ? (
                    <button type="button" aria-pressed={onList} onClick={() => onToggle(item)}>
                      {onList ? 'On disposal list' : 'Add to disposal'}
                    </button>
                  ) : null}
                </div>
              </li>
            );
          })}
        </ul>
      ) : null}
      {total !== null && value.state === 'ready' && total > value.page.items.length ? (
        <p className="field-hint">
          Showing {value.page.items.length} of {total}.{' '}
          <Link to={bandInventoryLink(band)}>See them all in Inventory</Link>
        </p>
      ) : null}
    </section>
  );
}
