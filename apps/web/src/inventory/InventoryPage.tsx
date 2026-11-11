import {
  INVENTORY_CONFLICT_FILTERS,
  INVENTORY_RETENTION_FILTERS,
  INVENTORY_RETENTION_FILTER_LABEL,
  STORAGE_UNIT_TYPES,
  inventoryStatusFilterLabel,
  inventorySortDirection,
  storageUnitTypeLabel,
  type InventoryItem,
  type InventoryLocation,
  type InventoryPage as InventoryPageData,
  type InventoryQuery,
  type InventoryStatusFilter,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate } from 'react-router';
import { listTestHoles } from '../api/projects';
import {
  EmptyState,
  ErrorState,
  PageHeader,
  Segmented,
  SelectionBar,
  TableViewSelector,
} from '../components/ui';
import { useTableView } from '../components/useTableView';
import { ContextRow } from '../layout/ContextRow';
import type { MoveLinkState } from '../moves/move-link';
import { usePendingMoves } from '../moves/usePendingMoves';
import { unitsLabelPrintPath } from '../printing/print-paths';
import { CameraScanButton } from '../scanning/CameraScanButton';
import { useMe } from '../session/context';
import { fetchInventory, fetchLocations, fetchProject } from './api';
import './inventory.css';
import { LookUpId } from './LookUpId';
import { ProjectFilter } from './ProjectFilter';
import { StorageUnitTable } from './StorageUnitTable';
import { useLatestSearchParams } from './useLatestSearchParams';
import {
  clearedInventoryQuery,
  hasActiveFilters,
  inventorySearchParams,
  readInventoryQuery,
} from './url-state';

type Loaded<T> = { key: string; ok: true; data: T } | { key: string; ok: false; message: string };

/** Where the detail page's "Back to inventory" link returns to. */
export interface InventoryLinkState {
  from?: string;
}

const SORT_OPTIONS = [
  { value: 'received:desc', label: 'Received (newest first)' },
  { value: 'received:asc', label: 'Received (oldest first)' },
  { value: 'id:asc', label: 'Storage unit ID (A–Z)' },
  { value: 'id:desc', label: 'Storage unit ID (Z–A)' },
] as const;

/** The Status segmented filter, in reading order; "Current stock" is the default view. */
const STATUS_OPTIONS: readonly InventoryStatusFilter[] = [
  'current',
  'in_stock',
  'approved_for_disposal',
  'disposed',
  'all',
];

function countLabel(total: number): string {
  return `${total.toLocaleString('en-CA')} storage ${total === 1 ? 'unit' : 'units'}`;
}

/**
 * Inventory: one row per storage unit, searched, filtered and paged on the server (MM-T12).
 * Field Ledger: Status as a segmented filter, the table view selector, and a selection bar
 * (Move, Print labels, Add to lab request) over the selected rows.
 */
export function InventoryPage() {
  const [params, setParams] = useLatestSearchParams();
  const location = useLocation();
  const navigate = useNavigate();
  const me = useMe();
  // MM-T81: this device's unsaved moves for the signed-in account only. When one settles in
  // another tab, the rows are fetched again (same filters and page) for the new location or
  // conflict (review fix, #107).
  const [reloads, setReloads] = useState(0);
  const pendingMoves = usePendingMoves(me.id, { onSettled: () => setReloads((n) => n + 1) });
  const query = useMemo(() => readInventoryQuery(params), [params]);
  const [view, setView] = useTableView('inventory');
  const requestKey = inventorySearchParams(query).toString();
  /** Selected rows by unit ID; kept across pages and filters until cleared. */
  const [selection, setSelection] = useState<ReadonlyMap<string, InventoryItem>>(new Map());

  const [result, setResult] = useState<Loaded<InventoryPageData> | null>(null);
  useEffect(() => {
    let cancelled = false;
    void fetchInventory(new URLSearchParams(requestKey)).then((response) => {
      if (cancelled) return;
      setResult(
        response.ok
          ? { key: requestKey, ok: true, data: response.data }
          : { key: requestKey, ok: false, message: response.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  const [locations, setLocations] = useState<InventoryLocation[]>([]);
  useEffect(() => {
    let cancelled = false;
    void fetchLocations().then((response) => {
      if (!cancelled && response.ok) setLocations(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

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

  const [holes, setHoles] = useState<{ projectId: string; holes: TestHole[] } | null>(null);
  const projectHoles = holes && holes.projectId === query.projectId ? holes.holes : [];
  useEffect(() => {
    const projectId = query.projectId;
    if (!projectId) return;
    let cancelled = false;
    listTestHoles(projectId).then(
      (list) => !cancelled && setHoles({ projectId, holes: list }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [query.projectId]);

  /**
   * Applies filter changes to the latest URL (not this render's, MM-T46); any change other than
   * the page returns to page 1.
   */
  function update(changes: Partial<InventoryQuery>) {
    setParams((prev) =>
      inventorySearchParams({ ...readInventoryQuery(prev), page: 1, ...changes }),
    );
  }

  function turnPage(by: number) {
    setParams((prev) => {
      const latest = readInventoryQuery(prev);
      return inventorySearchParams({ ...latest, page: Math.max(1, latest.page + by) });
    });
  }

  function toggle(items: InventoryItem[], checked: boolean) {
    setSelection((current) => {
      const next = new Map(current);
      for (const item of items) {
        if (checked) next.set(item.id, item);
        else next.delete(item.id);
      }
      return next;
    });
  }

  const chips = activeChips(query, selectedProject, projectHoles, locations);
  const loading = !result || result.key !== requestKey;
  const page = result && result.ok ? result.data : null;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const linkState: InventoryLinkState = { from: location.search };
  const filtered = hasActiveFilters(query);

  const selectedItems = [...selection.values()];
  const selectedProjects = new Set(selectedItems.map((item) => item.project.id));
  // Disposed units are never moved or given a fresh label (MTR-48).
  const current = selectedItems.filter((item) => item.status !== 'disposed');

  return (
    <>
      <ContextRow align="end">
        <Link className="button" to="/sample-storage/scan">
          Scan labels
        </Link>
        <Link className="button" to="/sample-storage/move">
          Move units
        </Link>
        <Link className="button primary" to="/receiving-log/new">
          Receive samples
        </Link>
      </ContextRow>
      <div className="inventory-title">
        <PageHeader title="Inventory" />
        <p className="inventory-count" role="status" aria-live="polite" aria-busy={loading}>
          {page ? countLabel(page.total) : 'Loading…'}
        </p>
      </div>

      <div className="storage-tools">
        <div className="tool-card">
          <LookUpId />
          <CameraScanButton />
        </div>
        <SearchForm
          initial={query.search ?? ''}
          onSearch={(search) => update({ search: search || undefined })}
        />
      </div>

      <div className="inventory-filter-row">
        <Segmented
          label="Status"
          className="inventory-status"
          value={query.status}
          onChange={(status) => update({ status })}
          options={STATUS_OPTIONS.map((status) => ({
            value: status,
            label: status === 'all' ? 'All' : inventoryStatusFilterLabel(status),
          }))}
        />
        <InlineSelect
          label="Type"
          value={query.type ?? ''}
          onChange={(value) =>
            update({ type: (value || undefined) as InventoryQuery['type'] | undefined })
          }
          options={[
            { value: '', label: 'All types' },
            ...STORAGE_UNIT_TYPES.map((type) => ({
              value: type,
              label: storageUnitTypeLabel(type),
            })),
          ]}
        />
        <InlineSelect
          label="Location"
          value={query.locationId ?? ''}
          onChange={(value) => update({ locationId: value || undefined })}
          options={[
            { value: '', label: 'Anywhere' },
            ...locations.map((item) => ({
              value: item.id,
              label: item.active ? item.name : `${item.name} (inactive)`,
            })),
          ]}
        />
        <TableViewSelector value={view} onChange={setView} />
      </div>

      <fieldset className="inventory-filters">
        <legend className="field-label">More filters</legend>
        <ProjectFilter
          selected={selectedProject}
          selectedId={query.projectId}
          onSelect={(picked) => {
            if (picked) setProject(picked);
            update({ projectId: picked?.id, testHoleId: undefined });
          }}
        />
        <SelectFilter
          label="Test hole"
          value={query.testHoleId ?? ''}
          disabled={!query.projectId}
          onChange={(value) => update({ testHoleId: value || undefined })}
          options={[
            { value: '', label: query.projectId ? 'All test holes' : 'Choose a project first' },
            ...projectHoles.map((hole) => ({ value: hole.id, label: hole.name })),
          ]}
        />
        <SelectFilter
          label="Retention"
          value={query.retention ?? ''}
          onChange={(value) =>
            update({ retention: (value || undefined) as InventoryQuery['retention'] })
          }
          options={[
            { value: '', label: 'Any' },
            ...INVENTORY_RETENTION_FILTERS.map((value) => ({
              value,
              label: INVENTORY_RETENTION_FILTER_LABEL[value],
            })),
          ]}
        />
        <SelectFilter
          label="Conflict"
          value={query.conflict ?? ''}
          onChange={(value) =>
            update({ conflict: (value || undefined) as InventoryQuery['conflict'] })
          }
          options={[
            { value: '', label: 'Any' },
            ...INVENTORY_CONFLICT_FILTERS.map((value) => ({
              value,
              label: 'Open location conflict',
            })),
          ]}
        />
        <DateFilter
          label="Received from"
          value={query.receivedFrom ?? ''}
          onChange={(value) => update({ receivedFrom: value || undefined })}
        />
        <DateFilter
          label="Received through"
          value={query.receivedTo ?? ''}
          onChange={(value) => update({ receivedTo: value || undefined })}
        />
        <SelectFilter
          label="Sort by"
          value={`${query.sort}:${inventorySortDirection(query)}`}
          onChange={(value) => {
            const [sort, dir] = value.split(':') as [InventoryQuery['sort'], InventoryQuery['dir']];
            update({ sort, dir });
          }}
          options={SORT_OPTIONS.map((option) => ({ ...option }))}
        />
      </fieldset>

      {chips.length > 0 || filtered ? (
        <div className="inventory-summary">
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
          {filtered ? (
            <button
              type="button"
              onClick={() =>
                setParams((prev) =>
                  inventorySearchParams(clearedInventoryQuery(readInventoryQuery(prev))),
                )
              }
            >
              Clear filters
            </button>
          ) : null}
        </div>
      ) : null}

      {selection.size > 0 ? (
        <SelectionBar count={selection.size}>
          <button
            type="button"
            disabled={current.length === 0}
            onClick={() =>
              navigate('/sample-storage/move', {
                state: { units: current.map((item) => item.readableId) } satisfies MoveLinkState,
              })
            }
          >
            Move
          </button>
          <button
            type="button"
            disabled={current.length === 0}
            onClick={() => navigate(unitsLabelPrintPath(current.map((item) => item.readableId)))}
          >
            Print labels
          </button>
          <button
            type="button"
            className="primary"
            disabled={selectedProjects.size !== 1}
            title={
              selectedProjects.size === 1
                ? undefined
                : 'A lab request covers one project: select units from one project'
            }
            onClick={() =>
              navigate('/lab-testing/programs/new', {
                state: {
                  projectId: selectedItems[0]!.project.id,
                  storageUnitIds: selectedItems.map((item) => item.id),
                },
              })
            }
          >
            Add to lab request
          </button>
          <button type="button" onClick={() => setSelection(new Map())}>
            Clear selection
          </button>
        </SelectionBar>
      ) : null}

      {result && !result.ok ? (
        <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
      ) : null}

      {page ? (
        page.total === 0 ? (
          <EmptyState
            title={
              filtered
                ? 'No storage units match this search and these filters.'
                : 'No storage units yet.'
            }
            action={
              filtered ? undefined : (
                <Link className="button primary" to="/receiving-log/new">
                  Receive samples
                </Link>
              )
            }
          >
            {filtered
              ? 'Change the search, or clear the filters to see everything in stock.'
              : 'Receive samples to add the first.'}
          </EmptyState>
        ) : (
          <div className="inventory-results">
            <StorageUnitTable
              items={page.items}
              linkState={linkState}
              view={view}
              pendingMoves={pendingMoves}
              selection={{
                selected: new Set(selection.keys()),
                onToggle: (item, checked) => toggle([item], checked),
                onToggleAll: toggle,
              }}
            />
            {page.total > page.pageSize ? (
              <nav className="pager" aria-label="Pages">
                <button type="button" disabled={query.page <= 1} onClick={() => turnPage(-1)}>
                  Previous
                </button>
                <span className="mono">
                  Page {query.page} of {totalPages}
                </span>
                <button
                  type="button"
                  disabled={query.page >= totalPages}
                  onClick={() => turnPage(1)}
                >
                  Next
                </button>
              </nav>
            ) : null}
          </div>
        )
      ) : null}
    </>
  );
}

interface Chip {
  key: string;
  label: string;
  remove: Partial<InventoryQuery>;
}

function activeChips(
  query: InventoryQuery,
  project: ProjectSummary | null,
  holes: TestHole[],
  locations: InventoryLocation[],
): Chip[] {
  const chips: Chip[] = [];
  if (query.search) {
    chips.push({ key: 'search', label: `Search: ${query.search}`, remove: { search: undefined } });
  }
  if (query.projectId) {
    chips.push({
      key: 'project',
      label: `Project: ${project?.projectNumber ?? '…'}`,
      remove: { projectId: undefined, testHoleId: undefined },
    });
  }
  if (query.testHoleId) {
    const hole = holes.find((item) => item.id === query.testHoleId);
    chips.push({
      key: 'testHole',
      label: `Test hole: ${hole?.name ?? '…'}`,
      remove: { testHoleId: undefined },
    });
  }
  if (query.type) {
    chips.push({
      key: 'type',
      label: `Type: ${storageUnitTypeLabel(query.type)}`,
      remove: { type: undefined },
    });
  }
  if (query.locationId) {
    const location = locations.find((item) => item.id === query.locationId);
    chips.push({
      key: 'location',
      label: `Location: ${location?.name ?? '…'}`,
      remove: { locationId: undefined },
    });
  }
  if (query.receiptId) {
    chips.push({ key: 'receipt', label: 'One receipt', remove: { receiptId: undefined } });
  }
  if (query.status !== 'current') {
    chips.push({
      key: 'status',
      label: `Status: ${inventoryStatusFilterLabel(query.status)}`,
      remove: { status: 'current' },
    });
  }
  if (query.retention) {
    chips.push({
      key: 'retention',
      label: `Retention: ${INVENTORY_RETENTION_FILTER_LABEL[query.retention]}`,
      remove: { retention: undefined },
    });
  }
  if (query.conflict) {
    chips.push({
      key: 'conflict',
      label: 'Conflict: Open',
      remove: { conflict: undefined },
    });
  }
  if (query.retainUntilFrom || query.retainUntilTo) {
    chips.push({
      key: 'retainUntil',
      label: `Retain until ${query.retainUntilFrom ?? '…'} to ${query.retainUntilTo ?? '…'}`,
      remove: { retainUntilFrom: undefined, retainUntilTo: undefined },
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

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(initial);
  // Follow the URL's search (Clear filters, a removed chip, Back), but never wipe text typed since
  // the box last matched it, e.g. typed right after Clear filters (MM-T46).
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
    <form role="search" aria-label="Search inventory" className="tool-card" onSubmit={submit}>
      <label htmlFor={id}>Search inventory</label>
      <div className="inline-input">
        <input
          id={id}
          type="search"
          value={text}
          aria-describedby={`${id}-hint`}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Search</button>
      </div>
      <p id={`${id}-hint`} className="field-hint">
        Storage unit ID, project, client, test hole, summary or location
      </p>
    </form>
  );
}

/** Field Ledger filter row: the mono caps label sits left of its select. */
function InlineSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="inline-select">
      <label htmlFor={id} className="field-label">
        {label}
      </label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function SelectFilter({
  label,
  value,
  options,
  onChange,
  disabled,
}: {
  label: string;
  value: string;
  options: { value: string; label: string }[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        disabled={disabled}
        onChange={(event) => onChange(event.target.value)}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </div>
  );
}

function DateFilter({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <input id={id} type="date" value={value} onChange={(event) => onChange(event.target.value)} />
    </div>
  );
}
