import {
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
} from '@trapezoid/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router';
import { listTestHoles } from '../api/projects';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { fetchInventory, fetchLocations, fetchProject, lookupStorageUnit } from './api';
import './inventory.css';
import { ProjectFilter } from './ProjectFilter';
import { StorageUnitTable } from './StorageUnitTable';
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

/** Inventory: one row per storage unit, searched, filtered and paged on the server (TRP-T12). */
export function InventoryPage() {
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const query = useMemo(() => readInventoryQuery(params), [params]);
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

  /** Applies filter changes; any change other than the page returns to page 1. */
  function update(changes: Partial<InventoryQuery>) {
    const next = { ...query, page: 1, ...changes };
    setParams(inventorySearchParams(next));
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
          <Link className="button" to="/sample-storage/scan">
            Scan labels
          </Link>
        }
      />
      <LookUpId />

      <SearchForm
        key={query.search ?? ''}
        initial={query.search ?? ''}
        onSearch={(search) => update({ search: search || undefined })}
      />

      <div className="filters inventory-filters" aria-label="Filters" role="group">
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
      </div>

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
          {page ? countLabel(page.total) : 'Loading…'}
        </p>
        {hasActiveFilters(query) ? (
          <button
            type="button"
            onClick={() => setParams(inventorySearchParams(clearedInventoryQuery(query)))}
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
          <StorageUnitTable items={page.items} linkState={linkState} />
        )
      ) : null}

      {page && page.total > page.pageSize ? (
        <nav className="pager" aria-label="Pages">
          <button
            type="button"
            disabled={query.page <= 1}
            onClick={() => update({ page: query.page - 1 })}
          >
            Previous
          </button>
          <span>
            Page {query.page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={query.page >= totalPages}
            onClick={() => update({ page: query.page + 1 })}
          >
            Next
          </button>
        </nav>
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
  if (query.status !== 'current') {
    chips.push({
      key: 'status',
      label: `Status: ${inventoryStatusFilterLabel(query.status)}`,
      remove: { status: 'current' },
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
  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(text.trim());
  }
  return (
    <form
      role="search"
      aria-label="Search inventory"
      className="inventory-search"
      onSubmit={submit}
    >
      <label htmlFor={id}>Search</label>
      <div className="inline-input">
        <input
          id={id}
          type="search"
          value={text}
          placeholder="Storage unit ID, project, client, test hole, summary or location"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Search</button>
      </div>
    </form>
  );
}

/** "Look up ID": manual entry of a storage unit ID (scanning reuses the same lookup, T16/T17). */
function LookUpId() {
  const id = useId();
  const navigate = useNavigate();
  const location = useLocation();
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (code.trim() === '') return;
    setBusy(true);
    setError(null);
    const result = await lookupStorageUnit(code);
    setBusy(false);
    if (result.ok) {
      navigate(`/sample-storage/${encodeURIComponent(result.data.readableId)}`, {
        state: { from: location.search } satisfies InventoryLinkState,
      });
    } else {
      setError(result.notFound ? 'No storage unit found' : result.message);
    }
  }

  return (
    <form className="lookup-id" aria-label="Look up ID" onSubmit={(event) => void submit(event)}>
      <label htmlFor={id}>Look up ID</label>
      <div className="inline-input">
        <input
          id={id}
          type="text"
          value={code}
          autoComplete="off"
          spellCheck={false}
          placeholder="e.g. BKT-2026-000014"
          aria-invalid={Boolean(error)}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => setCode(event.target.value)}
        />
        <button type="submit" disabled={busy}>
          Open
        </button>
      </div>
      {error ? (
        <p id={`${id}-error`} className="field-error" role="alert">
          {error}
        </p>
      ) : null}
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
