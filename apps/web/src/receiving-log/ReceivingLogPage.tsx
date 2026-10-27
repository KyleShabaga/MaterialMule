import {
  formatReceiver as formatReceiverOption,
  type ProjectSummary,
  type ReceiptLogItem,
  type ReceiptLogPage as ReceiptLogPageData,
  type ReceiptLogQuery,
  type ReceiverOption,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { DataTable, ErrorState, PageHeader, type Column } from '../components/ui';
import { fetchProject } from '../inventory/api';
import '../inventory/inventory.css';
import { ProjectFilter } from '../inventory/ProjectFilter';
import { useLatestSearchParams } from '../inventory/useLatestSearchParams';
import { useOnline } from '../lib/online';
import {
  RECEIPT_RECEIVERS_PATH,
  fetchReceiptLog,
  fetchReceiptReceiver,
  type ReceiptLogResult,
} from './api';
import { formatAccount, formatConfirmedAt, formatReceiver } from './format';
import './receiving-log.css';
import {
  clearedReceiptLogQuery,
  hasActiveFilters,
  readReceiptLogQuery,
  receiptLogSearchParams,
  withFilters,
} from './url-state';

/** Where the receipt page's "Back to Receiving Log" link returns to. */
export interface ReceiptLinkState {
  from?: string;
}

type Loaded = { key: string; result: ReceiptLogResult<ReceiptLogPageData> };

function countLabel(total: number): string {
  return `${total.toLocaleString('en-CA')} ${total === 1 ? 'receipt' : 'receipts'}`;
}

/**
 * Receiving Log (MM-T51): confirmed receipts, one row per receipt, newest confirmation first.
 * Search, filters and page live in the URL. Local drafts are not receipts; they stay on the
 * computer that holds them and open from Receive samples.
 */
export function ReceivingLogPage() {
  const [params, setParams] = useLatestSearchParams();
  const location = useLocation();
  const online = useOnline();
  const { query, ignored } = useMemo(() => readReceiptLogQuery(params), [params]);
  const requestKey = receiptLogSearchParams(query).toString();

  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchReceiptLog(new URLSearchParams(requestKey)).then((result) => {
      // Only the newest filters' answer is shown; an older, slower one is dropped.
      if (!cancelled) setLoaded({ key: requestKey, result });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const [project, setProject] = useState<ProjectSummary | null>(null);
  const selectedProject = project && project.id === query.projectId ? project : null;
  useEffect(() => {
    if (!query.projectId || selectedProject) return;
    let cancelled = false;
    void fetchProject(query.projectId).then((response) => {
      if (!cancelled && response.ok) setProject(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [query.projectId, selectedProject]);

  const [receiver, setReceiver] = useState<ReceiverOption | null>(null);
  const selectedReceiver = receiver && receiver.id === query.receiverUserId ? receiver : null;
  useEffect(() => {
    if (!query.receiverUserId || selectedReceiver) return;
    let cancelled = false;
    void fetchReceiptReceiver(query.receiverUserId).then((response) => {
      if (!cancelled && response.ok && response.data) setReceiver(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [query.receiverUserId, selectedReceiver]);

  /** Applies changes to the latest URL (not this render's, MM-T46); filters reset the page. */
  function update(changes: Partial<ReceiptLogQuery>) {
    setParams((prev) => withFilters(prev, changes));
  }

  function turnPage(by: number) {
    setParams((prev) => {
      const latest = readReceiptLogQuery(prev).query;
      return receiptLogSearchParams({ ...latest, page: Math.max(1, latest.page + by) });
    });
  }

  function clearFilters() {
    setParams((prev) =>
      receiptLogSearchParams(clearedReceiptLogQuery(readReceiptLogQuery(prev).query)),
    );
  }

  const current = loaded?.key === requestKey ? loaded.result : null;
  // While newer filters load, the previous rows stay visible but marked busy.
  const shown = loaded?.result.ok ? loaded.result.data : null;
  const failed = current && !current.ok ? current : null;
  const loading = current === null;
  const filtered = hasActiveFilters(query);
  const totalPages = shown ? Math.max(1, Math.ceil(shown.total / shown.pageSize)) : 1;
  const chips = activeChips(query, selectedProject, selectedReceiver);
  const linkState: ReceiptLinkState = { from: location.search };

  return (
    <>
      <PageHeader
        title="Receiving Log"
        actions={
          <>
            <Link className="button primary" to="/receiving-log/new">
              Receive samples
            </Link>
            <Link className="button" to="/receiving-log/new">
              Drafts on this computer
            </Link>
          </>
        }
      />
      <p className="field-hint">
        Confirmed receipts, newest first. Drafts that aren’t confirmed stay on the computer that
        saved them and aren’t listed here.
      </p>

      <SearchForm
        initial={query.search ?? ''}
        onSearch={(search) => update({ search: search || undefined })}
      />

      <div className="filters receiving-log-filters" aria-label="Filters" role="group">
        <ProjectFilter
          selected={selectedProject}
          selectedId={query.projectId}
          onSelect={(picked) => {
            if (picked) setProject(picked);
            update({ projectId: picked?.id });
          }}
        />
        {query.receiverUserId ? (
          <SelectedReceiver
            receiver={selectedReceiver}
            onClear={() => update({ receiverUserId: undefined })}
          />
        ) : (
          <ReceiverSelect
            value={null}
            onChange={(picked) => {
              if (!picked) return;
              setReceiver(picked);
              update({ receiverUserId: picked.id });
            }}
            searchPath={RECEIPT_RECEIVERS_PATH}
            noMatchText="Nobody with those initials or that name has received a receipt."
            hint="Initials or name. Includes people who have since left."
          />
        )}
        <DateFilter
          label="Received from"
          value={query.receivedFrom ?? ''}
          max={query.receivedTo}
          onChange={(value) => update({ receivedFrom: value || undefined })}
        />
        <DateFilter
          label="Received through"
          value={query.receivedTo ?? ''}
          min={query.receivedFrom}
          onChange={(value) => update({ receivedTo: value || undefined })}
        />
      </div>

      {ignored.length > 0 ? (
        <p className="notice" role="status">
          Part of this link wasn’t valid and was left out: {ignored.join(', ')}.
        </p>
      ) : null}

      {chips.length > 0 ? (
        <ul className="chips" aria-label="Active filters">
          {chips.map((chip) => (
            <li key={chip.key}>
              {chip.label}
              <button
                type="button"
                aria-label={`Remove filter ${chip.label}`}
                onClick={() => update(chip.remove)}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}

      <div className="inventory-summary">
        <p role="status" aria-live="polite" aria-busy={loading}>
          {loading
            ? 'Loading receipts…'
            : failed
              ? 'Receipts didn’t load.'
              : countLabel(shown!.total)}
        </p>
        {filtered ? (
          <button type="button" onClick={clearFilters}>
            Clear filters
          </button>
        ) : null}
      </div>

      {failed ? (
        <ErrorState
          message={
            failed.kind === 'offline' && !online
              ? 'You’re offline. The Receiving Log needs a connection to Material Mule. Drafts on this computer still open from Receive samples.'
              : failed.message
          }
          onRetry={failed.kind === 'unauthenticated' ? undefined : () => setReloads((n) => n + 1)}
        />
      ) : null}

      {!failed && shown ? (
        shown.total === 0 ? (
          filtered ? (
            <div className="empty-state receiving-log-empty">
              <p>No receipts match these filters.</p>
              <button type="button" onClick={clearFilters}>
                Clear filters
              </button>
            </div>
          ) : (
            <div className="empty-state receiving-log-empty">
              <p>No receipts yet.</p>
              <Link className="button primary" to="/receiving-log/new">
                Receive samples
              </Link>
            </div>
          )
        ) : (
          <div className="receiving-log-table table-stack" aria-busy={loading}>
            <ReceiptTable items={shown.items} linkState={linkState} />
          </div>
        )
      ) : null}

      {!failed && shown && shown.total > shown.pageSize ? (
        <nav className="pager" aria-label="Pages">
          <button type="button" disabled={query.page <= 1} onClick={() => turnPage(-1)}>
            Previous
          </button>
          <span>
            Page {query.page} of {totalPages}
          </span>
          <button type="button" disabled={query.page >= totalPages} onClick={() => turnPage(1)}>
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}

function ReceiptTable({
  items,
  linkState,
}: {
  items: ReceiptLogItem[];
  linkState: ReceiptLinkState;
}) {
  const columns: Column<ReceiptLogItem>[] = [
    {
      header: 'Received',
      cell: (item) => (
        <Link
          to={`/receiving-log/${item.id}`}
          state={linkState}
          aria-label={`Open receipt: ${item.project.projectNumber}, received ${item.receivedDate} by ${formatReceiver(item.receiver)}`}
        >
          <span className="receipt-date">{item.receivedDate}</span>
        </Link>
      ),
    },
    {
      header: 'Project',
      cell: (item) => (
        <span className="unit-cell">
          <span>{item.project.projectNumber}</span>
          <span>{item.project.name}</span>
        </span>
      ),
    },
    { header: 'Received by', cell: (item) => formatReceiver(item.receiver) },
    { header: 'Storage units', cell: (item) => item.quantity },
    {
      header: 'Confirmed',
      cell: (item) => (
        <span className="unit-cell">
          <time dateTime={item.confirmedAt}>{formatConfirmedAt(item.confirmedAt)}</time>
          <span className="field-hint">by {formatAccount(item.account)}</span>
        </span>
      ),
    },
  ];
  return (
    <DataTable
      rows={items}
      rowKey={(item) => item.id}
      caption="Confirmed receipts"
      empty="No receipts."
      columns={columns}
    />
  );
}

interface Chip {
  key: string;
  label: string;
  remove: Partial<ReceiptLogQuery>;
}

function activeChips(
  query: ReceiptLogQuery,
  project: ProjectSummary | null,
  receiver: ReceiverOption | null,
): Chip[] {
  const chips: Chip[] = [];
  if (query.search) {
    chips.push({ key: 'search', label: `Search: ${query.search}`, remove: { search: undefined } });
  }
  if (query.projectId) {
    chips.push({
      key: 'project',
      label: `Project: ${project?.projectNumber ?? '…'}`,
      remove: { projectId: undefined },
    });
  }
  if (query.receiverUserId) {
    chips.push({
      key: 'receiver',
      label: `Received by: ${receiver ? `${receiver.initials} · ${receiver.displayName}` : '…'}`,
      remove: { receiverUserId: undefined },
    });
  }
  if (query.receivedFrom) {
    chips.push({
      key: 'from',
      label: `Received from ${query.receivedFrom}`,
      remove: { receivedFrom: undefined },
    });
  }
  if (query.receivedTo) {
    chips.push({
      key: 'to',
      label: `Received through ${query.receivedTo}`,
      remove: { receivedTo: undefined },
    });
  }
  return chips;
}

function SelectedReceiver({
  receiver,
  onClear,
}: {
  receiver: ReceiverOption | null;
  onClear: () => void;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <span className="field-label" id={`${id}-label`}>
        Received by
      </span>
      <div className="selected-filter" aria-labelledby={`${id}-label`}>
        <span>{receiver ? formatReceiverOption(receiver) : 'Loading…'}</span>
        <button type="button" onClick={onClear}>
          Change person
        </button>
      </div>
    </div>
  );
}

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(initial);
  // Follow the URL's search (Clear filters, a removed chip, Back) without wiping newer typing.
  const [shown, setShown] = useState(initial);
  if (initial !== shown) {
    setShown(initial);
    if (text === shown) setText(initial);
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(text.trim());
  }
  return (
    <form role="search" aria-label="Search receipts" className="inventory-search" onSubmit={submit}>
      <label htmlFor={id}>Search</label>
      <div className="inline-input">
        <input
          id={id}
          type="search"
          value={text}
          placeholder="Project, received by, or storage unit ID"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Search</button>
      </div>
    </form>
  );
}

function DateFilter({
  label,
  value,
  min,
  max,
  onChange,
}: {
  label: string;
  value: string;
  min?: string;
  max?: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input
        id={id}
        type="date"
        value={value}
        min={min}
        max={max}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}
