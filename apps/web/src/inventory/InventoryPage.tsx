import {
  INVENTORY_CONFLICT_FILTERS,
  INVENTORY_RETENTION_FILTERS,
  INVENTORY_RETENTION_FILTER_LABEL,
  INVENTORY_STATUS_FILTERS,
  STORAGE_UNIT_TYPES,
  inventoryStatusFilterLabel,
  inventorySortDirection,
  storageUnitTypeLabel,
  type InventoryLocation,
  type InventoryPage as InventoryPageData,
  type InventoryQuery,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { listTestHoles } from '../api/projects';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { fetchInventory, fetchLocations, fetchProject } from './api';
import './inventory.css';
import { LookUpId } from './LookUpId';
import { ProjectFilter } from './ProjectFilter';
import { usePendingMoves } from '../moves/usePendingMoves';
import { CameraScanButton } from '../scanning/CameraScanButton';
import { useMe } from '../session/context';
import { StorageUnitTable, type StorageUnitTableView } from './StorageUnitTable';
import { readTableView, rememberTableView } from './table-view';
import { useLatestSearchParams } from './useLatestSearchParams';
import {
  clearedInventoryQuery,
  hasActiveFilters,
  inventorySearchParams,
  readInventoryQuery,
} from './url-state';

type Loaded<T> = { key: string; ok: true; data: T } | { key: string; ok: false; message: string };

/** Where the detail page's "Back to Sample Storage" link returns to. */
export interface InventoryLinkState {
  from?: string;
}

const SORT_OPTIONS = [
  { value: 'received:desc', label: 'Received (newest first)' },
  { value: 'received:asc', label: 'Received (oldest first)' },
  { value: 'id:asc', label: 'Storage unit ID (A–Z)' },
  { value: 'id:desc', label: 'Storage unit ID (Z–A)' },
] as const;

function countLabel(total: number): string {
  return `${total.toLocaleString('en-CA')} storage ${total === 1 ? 'unit' : 'units'}`;
}

/** Inventory: one row per storage unit, searched, filtered and paged on the server (MM-T12). */
export function InventoryPage() {
  const [params, setParams] = useLatestSearchParams();
  const location = useLocation();
  const me = useMe();
  // MM-T81: this device's unsaved moves for the signed-in account only.
  const pendingMoves = usePendingMoves(me.id);
  const query = useMemo(() => readInventoryQuery(params), [params]);
  const [view, setView] = useState<StorageUnitTableView>(readTableView);
  const chooseView = (next: StorageUnitTableView) => {
    setView(next);
    rememberTableView(next);
  };
  const requestKey = inventorySearchParams(query).toString();

  const [result, setResult] = useState<Loaded<InventoryPageData> | null>(null);
  const [reloads, setReloads] = useState(0);
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

  const chips = activeChips(query, selectedProject, projectHoles, locations);
  const loading = !result || result.key !== requestKey;
  const page = result && result.ok ? result.data : null;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const linkState: InventoryLinkState = { from: location.search };

  return (
    <>
      <PageHeader
        title="Sample Storage"
        actions={
          <>
            <Link className="button" to="/sample-storage/scan">
              Scan labels
            </Link>
            <Link className="button" to="/sample-storage/move">
              Move units
            </Link>
          </>
        }
      />
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

      <fieldset className="tool-card inventory-filters">
        <legend className="visually-hidden">Filters</legend>
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
        <SelectFilter
          label="Location"
          value={query.locationId ?? ''}
          onChange={(value) => update({ locationId: value || undefined })}
          options={[
            { value: '', label: 'All locations' },
            ...locations.map((item) => ({
              value: item.id,
              label: item.active ? item.name : `${item.name} (inactive)`,
            })),
          ]}
        />
        <SelectFilter
          label="Status"
          value={query.status}
          onChange={(value) => update({ status: value as InventoryQuery['status'] })}
          options={INVENTORY_STATUS_FILTERS.map((status) => ({
            value: status,
            label: inventoryStatusFilterLabel(status),
          }))}
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
          label="Location conflict"
          value={query.conflict ?? ''}
          onChange={(value) =>
            update({ conflict: (value || undefined) as InventoryQuery['conflict'] })
          }
          options={[
            { value: '', label: 'Any' },
            ...INVENTORY_CONFLICT_FILTERS.map((value) => ({ value, label: 'Open conflict' })),
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
        <div className="view-switch" role="group" aria-label="Table view">
          {(['standard', 'compact'] as const).map((option) => (
            <button
              key={option}
              type="button"
              aria-pressed={view === option}
              onClick={() => chooseView(option)}
            >
              {option === 'standard' ? 'Standard' : 'Compact'}
            </button>
          ))}
        </div>
        <p className="inventory-count" role="status" aria-live="polite" aria-busy={loading}>
          {page ? countLabel(page.total) : 'Loading…'}
        </p>
        {hasActiveFilters(query) ? (
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

      {result && !result.ok ? (
        <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
      ) : null}

      {page ? (
        page.total === 0 ? (
          <EmptyState>
            No storage units match{' '}
            {hasActiveFilters(query) ? 'this search and these filters' : 'yet'}.
          </EmptyState>
        ) : (
          <div className="table-card">
            <StorageUnitTable
              items={page.items}
              linkState={linkState}
              view={view}
              pendingMoves={pendingMoves}
            />
            {page.total > page.pageSize ? (
              <nav className="pager" aria-label="Pages">
                <button type="button" disabled={query.page <= 1} onClick={() => turnPage(-1)}>
                  Previous
                </button>
                <span>
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
      label: 'Location conflict: Open',
      remove: { conflict: undefined },
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
