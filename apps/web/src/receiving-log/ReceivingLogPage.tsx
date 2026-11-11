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
import {
  DataTable,
  EmptyState,
  ErrorState,
  SectionHead,
  StatusBadge,
  TableScroll,
  TableViewSelector,
  type Column,
  type TableView,
} from '../components/ui';
import { useTableView } from '../components/useTableView';
import { fetchProject } from '../inventory/api';
import '../inventory/inventory.css';
import { ProjectFilter } from '../inventory/ProjectFilter';
import { useLatestSearchParams } from '../inventory/useLatestSearchParams';
import { ContextRow } from '../layout/ContextRow';
import { usePageTitle } from '../layout/page-title';
import { useOnline } from '../lib/online';
import { visibleTo, type StoredDraft } from '../receiving/drafts/record';
import { indexedDbDraftStore } from '../receiving/drafts/store';
import { useMe } from '../session/context';
import {
  RECEIPT_RECEIVERS_PATH,
  fetchReceiptLog,
  fetchReceiptReceiver,
  type ReceiptLogResult,
} from './api';
import { draftContents, formatAccount, formatConfirmedAt, formatReceiver } from './format';
import { continueDraftPath, START_DELIVERY_PATH } from './paths';
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
 * Receiving log (MM-T51, Field Ledger "ReceivingLog"): the drafts on this computer that are not
 * confirmed yet (dashed, Continue), then confirmed receipts, one row per receipt, newest
 * confirmation first. Search, filters and page live in the URL. Drafts are not receipts: they
 * stay on the computer that saved them, and have no storage unit IDs.
 */
export function ReceivingLogPage() {
  usePageTitle('Receiving Log');
  const [view, setView] = useTableView('receiving-log');
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
    <div className="receiving-log">
      <ContextRow align="end">
        <Link className="button" to="/sample-storage/scan">
          Scan label
        </Link>
        <Link className="button primary" to={START_DELIVERY_PATH}>
          Start a delivery
        </Link>
      </ContextRow>
      <div className="receiving-log-title">
        <h1>Receiving log</h1>
        <span className="section-meta">Every delivery, newest first</span>
      </div>

      <LocalDrafts />

      <section className="receiving-log-section" aria-labelledby="receiving-log-received">
        <div className="receiving-log-head">
          <StatusBadge tone="storage">CONFIRMED</StatusBadge>
          <SectionHead id="receiving-log-received" title="Received" meta="Newest first" />
          <TableViewSelector value={view} onChange={setView} />
        </div>
        <ReceivedSection
          query={query}
          ignored={ignored}
          chips={chips}
          update={update}
          clearFilters={clearFilters}
          turnPage={turnPage}
          selectedProject={selectedProject}
          setProject={setProject}
          selectedReceiver={selectedReceiver}
          setReceiver={setReceiver}
          loading={loading}
          failed={failed}
          online={online}
          shown={shown}
          filtered={filtered}
          totalPages={totalPages}
          linkState={linkState}
          view={view}
          retry={() => setReloads((n) => n + 1)}
        />
      </section>
    </div>
  );
}

function ReceivedSection({
  query,
  ignored,
  chips,
  update,
  clearFilters,
  turnPage,
  selectedProject,
  setProject,
  selectedReceiver,
  setReceiver,
  loading,
  failed,
  online,
  shown,
  filtered,
  totalPages,
  linkState,
  view,
  retry,
}: {
  query: ReceiptLogQuery;
  ignored: string[];
  chips: Chip[];
  update: (changes: Partial<ReceiptLogQuery>) => void;
  clearFilters: () => void;
  turnPage: (by: number) => void;
  selectedProject: ProjectSummary | null;
  setProject: (project: ProjectSummary) => void;
  selectedReceiver: ReceiverOption | null;
  setReceiver: (receiver: ReceiverOption) => void;
  loading: boolean;
  failed: Extract<ReceiptLogResult<ReceiptLogPageData>, { ok: false }> | null;
  online: boolean;
  shown: ReceiptLogPageData | null;
  filtered: boolean;
  totalPages: number;
  linkState: ReceiptLinkState;
  view: TableView;
  retry: () => void;
}) {
  return (
    <>
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
              ? 'You’re offline. The Receiving log needs a connection to Material Mule. Drafts on this computer still open from the list above.'
              : failed.message
          }
          onRetry={failed.kind === 'unauthenticated' ? undefined : retry}
        />
      ) : null}

      {!failed && shown ? (
        shown.total === 0 ? (
          filtered ? (
            <EmptyState
              title="No receipts match these filters."
              action={
                <button type="button" onClick={clearFilters}>
                  Clear filters
                </button>
              }
            />
          ) : (
            <EmptyState
              title="No receipts yet."
              action={
                <Link className="button primary" to={START_DELIVERY_PATH}>
                  Start a delivery
                </Link>
              }
            >
              Confirmed deliveries are listed here, newest first.
            </EmptyState>
          )
        ) : (
          <TableScroll
            label="Receipt table"
            className="receiving-log-table table-frame table-stack"
            aria-busy={loading}
          >
            <ReceiptTable items={shown.items} linkState={linkState} view={view} />
          </TableScroll>
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
  view,
}: {
  items: ReceiptLogItem[];
  linkState: ReceiptLinkState;
  view: TableView;
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
          <span className="receipt-date mono">{item.receivedDate}</span>
        </Link>
      ),
    },
    {
      header: 'Project',
      cell: (item) => (
        <span className="unit-cell">
          <span className="mono receipt-project">{item.project.projectNumber}</span>
          <span className="receipt-secondary">{item.project.name}</span>
        </span>
      ),
    },
    { header: 'Received by', cell: (item) => formatReceiver(item.receiver) },
    {
      header: 'Storage units',
      cell: (item) => <span className="mono">{item.quantity}</span>,
    },
    {
      header: 'Confirmed',
      cell: (item) => (
        <span className="unit-cell">
          <time className="mono" dateTime={item.confirmedAt}>
            {formatConfirmedAt(item.confirmedAt)}
          </time>
          <span className="field-hint receipt-secondary">by {formatAccount(item.account)}</span>
        </span>
      ),
    },
  ];
  return (
    <DataTable
      view={view}
      rows={items}
      rowKey={(item) => item.id}
      caption="Confirmed receipts"
      empty="No receipts."
      columns={columns}
    />
  );
}

type DraftListing =
  { state: 'loading' } | { state: 'ready'; drafts: StoredDraft[] } | { state: 'error' };

/**
 * Drafts on this computer that the signed-in person may open (MM-T11 visibility), newest saved
 * first. A draft never shows a storage unit ID: IDs are issued only at confirmation.
 */
function LocalDrafts() {
  const me = useMe();
  const [listing, setListing] = useState<DraftListing>({ state: 'loading' });
  useEffect(() => {
    let current = true;
    indexedDbDraftStore.list().then(
      ({ drafts }) => {
        if (!current) return;
        const visible = drafts
          .filter((draft) => visibleTo(draft, me))
          .sort((a, b) => b.lastSavedAt.localeCompare(a.lastSavedAt));
        setListing({ state: 'ready', drafts: visible });
      },
      () => current && setListing({ state: 'error' }),
    );
    return () => {
      current = false;
    };
  }, [me]);

  if (listing.state === 'loading') return null;
  if (listing.state === 'error') {
    return (
      <p className="notice notice-warning" role="status">
        Drafts on this computer couldn’t be read. They are still kept; open Receive samples to try
        again.
      </p>
    );
  }
  if (listing.drafts.length === 0) return null;
  const count = listing.drafts.length;
  return (
    <section className="receiving-log-section" aria-labelledby="receiving-log-drafts">
      <div className="receiving-log-head">
        <StatusBadge tone="waiting">DRAFT</StatusBadge>
        <SectionHead
          id="receiving-log-drafts"
          title="Not confirmed yet"
          meta={`${count} ${count === 1 ? 'delivery' : 'deliveries'} · No IDs issued`}
        />
      </div>
      <ul className="receiving-log-drafts">
        {listing.drafts.map((draft) => {
          const project = draft.data.project?.projectNumber ?? null;
          return (
            <li key={draft.draftId} className="receiving-log-draft" data-row>
              <div className="receiving-log-draft-main">
                <span className="mono receiving-log-draft-project">
                  {project ?? 'No project yet'}
                </span>
                <span className="receipt-secondary">{draftContents(draft.data.units)}</span>
              </div>
              <div className="receiving-log-draft-fact">
                <span className="field-label">Started by</span>
                <span>
                  {draft.receiver
                    ? `${draft.receiver.initials} · ${draft.receiver.displayName}`
                    : 'Not chosen'}
                </span>
              </div>
              <div className="receiving-log-draft-fact">
                <span className="field-label">Last saved</span>
                <time dateTime={draft.lastSavedAt}>{formatConfirmedAt(draft.lastSavedAt)}</time>
              </div>
              <Link
                className="button primary"
                to={continueDraftPath(draft.draftId)}
                aria-label={`Continue draft for ${project ?? 'a delivery with no project yet'}`}
              >
                Continue
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
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
