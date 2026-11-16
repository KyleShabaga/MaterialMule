import {
  INVENTORY_RETENTION_FILTERS,
  INVENTORY_RETENTION_FILTER_LABEL,
  STORAGE_UNIT_TYPES,
  labCalendarDate,
  projectLabel,
  storageUnitTypeLabel,
  type InventoryLocation,
  type ProjectSummary,
  type TestHole,
} from '@materialmule/shared';
import { Check, ChevronDown, Plus, X } from 'lucide-react';
import {
  useEffect,
  useId,
  useRef,
  useState,
  type Dispatch,
  type ReactNode,
  type SetStateAction,
} from 'react';
import { Button } from '@/components/ui/button';
import { ButtonGroup } from '@/components/ui/button-group';
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from '@/components/ui/command';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { listTestHoles, searchProjects } from '../api/projects';
import { fetchProject } from './api';
import {
  INVENTORY_FILTERS,
  INVENTORY_FILTER_LABELS,
  filterHasValue,
  readInventoryTable,
  withFilterValues,
  withPendingFilter,
  withoutFilter,
  type InventoryFilter,
} from './url-state';

type Update = (fn: (prev: URLSearchParams) => URLSearchParams) => void;

const CHIP_CLASS =
  'h-9 bg-accent text-[13px] text-accent-foreground shadow-none border-primary/25 hover:bg-accent/70 dark:bg-accent dark:border-primary/40';

const SEARCH_DELAY_MS = 200;

/**
 * The filter chip row under the stage tabs (STRATA-79, UX change 5): always shown, ending with
 * "+ Add filter". Each chip is a ButtonGroup: field and value open its own picker, × removes it.
 * Chips wrap to a second line. Values live in the URL under the API's keys, so tabs, counts and
 * rows all follow them; every change goes back to page 1.
 */
export function InventoryFilterChips({
  params,
  update,
  locations,
  openFilter,
  onOpenFilterChange,
  onClearFilters,
  filtered,
}: {
  params: URLSearchParams;
  update: Update;
  locations: readonly InventoryLocation[];
  /** The chip whose picker is open (page state, so "+ Add filter" can open the new chip's). */
  openFilter: InventoryFilter | null;
  /**
   * Sets the open chip (a state setter, so a close can be conditional on the latest value: a
   * picker only ever closes itself, never the one opened after it).
   */
  onOpenFilterChange: Dispatch<SetStateAction<InventoryFilter | null>>;
  onClearFilters: () => void;
  filtered: boolean;
}) {
  /** The chip whose picker opens when the "+ Add filter" menu has closed. */
  const openAfterMenu = useRef<InventoryFilter | null>(null);
  const projectId = params.get('projectId');
  const project = useProject(projectId);
  const holes = useTestHoles(projectId);
  const pending = readInventoryTable(params).filters as InventoryFilter[];

  // Filters with a value, in menu order, then chips added but not chosen yet.
  const shown = INVENTORY_FILTERS.filter((f) => filterHasValue(params, f) || pending.includes(f));
  const available = INVENTORY_FILTERS.filter((f) => !shown.includes(f));

  const set = (patch: Record<string, string | undefined>, filter: InventoryFilter) =>
    update((prev) => withPendingFilter(withFilterValues(prev, patch), filter, false));

  const value = (filter: InventoryFilter): string | null => {
    switch (filter) {
      case 'project':
        return projectId ? (project?.projectNumber ?? '…') : null;
      case 'testHole': {
        const id = params.get('testHoleId');
        return id ? (holes.find((h) => h.id === id)?.name ?? '…') : null;
      }
      case 'type': {
        const type = params.get('type');
        return STORAGE_UNIT_TYPES.find((t) => t === type)
          ? storageUnitTypeLabel(type as (typeof STORAGE_UNIT_TYPES)[number])
          : null;
      }
      case 'location': {
        const id = params.get('locationId');
        return id ? (locations.find((l) => l.id === id)?.name ?? '…') : null;
      }
      case 'received': {
        const from = params.get('receivedFrom');
        const to = params.get('receivedTo');
        if (!from && !to) return null;
        if (from && to) return `${from} – ${to}`;
        return from ? `from ${from}` : `through ${to}`;
      }
      case 'retention': {
        const r = params.get('retention');
        return INVENTORY_RETENTION_FILTERS.find((x) => x === r)
          ? INVENTORY_RETENTION_FILTER_LABEL[r as (typeof INVENTORY_RETENTION_FILTERS)[number]]
          : null;
      }
    }
  };

  const picker = (filter: InventoryFilter): ReactNode => {
    const close = () => onOpenFilterChange((current) => (current === filter ? null : current));
    switch (filter) {
      case 'project':
        return (
          <ProjectPicker
            selectedId={projectId}
            onPick={(p) => {
              set({ projectId: p.id, testHoleId: undefined }, 'project');
              close();
            }}
          />
        );
      case 'testHole':
        return projectId ? (
          <ListPicker
            label="Test hole"
            options={holes.map((h) => ({ value: h.id, label: h.name, mono: true }))}
            selected={params.get('testHoleId')}
            onPick={(id) => {
              set({ testHoleId: id }, 'testHole');
              close();
            }}
          />
        ) : (
          <p className="p-3 text-sm text-muted-foreground">
            Choose a project first: test holes belong to one project.
          </p>
        );
      case 'type':
        return (
          <ListPicker
            label="Type"
            options={STORAGE_UNIT_TYPES.map((t) => ({ value: t, label: storageUnitTypeLabel(t) }))}
            selected={params.get('type')}
            onPick={(type) => {
              set({ type }, 'type');
              close();
            }}
          />
        );
      case 'location':
        return (
          <ListPicker
            label="Location"
            searchable
            options={locations.map((l) => ({
              value: l.id,
              label: l.active ? l.name : `${l.name} (inactive)`,
              keywords: [l.code],
            }))}
            selected={params.get('locationId')}
            onPick={(locationId) => {
              set({ locationId }, 'location');
              close();
            }}
          />
        );
      case 'received':
        return (
          <ReceivedPicker
            from={params.get('receivedFrom') ?? ''}
            to={params.get('receivedTo') ?? ''}
            onChange={(from, to) =>
              set({ receivedFrom: from || undefined, receivedTo: to || undefined }, 'received')
            }
          />
        );
      case 'retention':
        return (
          <ListPicker
            label="Retention"
            options={INVENTORY_RETENTION_FILTERS.map((r) => ({
              value: r,
              label: INVENTORY_RETENTION_FILTER_LABEL[r],
            }))}
            selected={params.get('retention')}
            onPick={(retention) => {
              set({ retention }, 'retention');
              close();
            }}
          />
        );
    }
  };

  const receiptId = params.get('receiptId');
  const retainFrom = params.get('retainUntilFrom');
  const retainTo = params.get('retainUntilTo');

  return (
    <div
      role="group"
      aria-label="Filters"
      className="relative flex flex-wrap items-center gap-2"
      data-slot="inventory-filter-chips"
    >
      {receiptId ? (
        // The dashboard's "received" activity opens one receipt's units.
        <PlainChip
          field="Receipt"
          value="One receipt"
          onRemove={() => update((prev) => withFilterValues(prev, { receiptId: undefined }))}
        />
      ) : null}
      {retainFrom || retainTo ? (
        <PlainChip
          field="Retain until"
          value={`${retainFrom ?? '…'} – ${retainTo ?? '…'}`}
          onRemove={() =>
            update((prev) =>
              withFilterValues(prev, { retainUntilFrom: undefined, retainUntilTo: undefined }),
            )
          }
        />
      ) : null}
      {shown.map((filter) => {
        const label = INVENTORY_FILTER_LABELS[filter];
        const chosen = value(filter);
        return (
          <ButtonGroup key={filter} aria-label={`Filter ${label}`}>
            <Popover
              open={openFilter === filter}
              // A picker still playing its close animation keeps dismissing on outside focus and
              // clicks; that late "close" must not shut the picker opened after it (it did: pick
              // a Location, then "+ Add filter" › Type, and the Type picker shut as it opened).
              onOpenChange={(open) =>
                onOpenFilterChange((current) =>
                  open ? filter : current === filter ? null : current,
                )
              }
            >
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  size="sm"
                  className={cn(CHIP_CLASS, 'gap-1.5 pr-2 pl-2.5 font-normal')}
                >
                  <span className="text-accent-foreground/80">{label}</span>
                  <span className={cn('font-semibold', !chosen && 'font-normal italic')}>
                    {chosen ?? 'any'}
                  </span>
                  <ChevronDown aria-hidden="true" className="size-3.5" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                align="start"
                className="w-72 p-0"
                // Pickers close on a choice, Escape, a click outside or their chip, never on focus
                // moving: menus and pickers hand focus around as they animate out (a closing
                // picker returning focus to its chip, the "+ Add filter" menu unmounting), and a
                // late focus move shut the picker just opened under the person's pointer. No
                // focus return while another picker is open, either.
                onCloseAutoFocus={(event) => {
                  if (openFilter !== null && openFilter !== filter) event.preventDefault();
                }}
                onFocusOutside={(event) => event.preventDefault()}
              >
                {picker(filter)}
              </PopoverContent>
            </Popover>
            <Button
              variant="outline"
              size="icon-sm"
              aria-label={`Remove filter ${label}`}
              className={cn(CHIP_CLASS, 'w-8')}
              onClick={() => update((prev) => withoutFilter(prev, filter))}
            >
              <X aria-hidden="true" className="size-3.5" />
            </Button>
          </ButtonGroup>
        );
      })}
      {available.length > 0 ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="sm" className="text-[13px] text-muted-foreground">
              <Plus aria-hidden="true" />
              Add filter
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            align="start"
            className="w-48"
            // The new chip's picker opens once this menu has finished closing (its exit
            // animation), so the two never overlap, and it takes focus instead of this button.
            onCloseAutoFocus={(event) => {
              event.preventDefault();
              const next = openAfterMenu.current;
              openAfterMenu.current = null;
              if (next) onOpenFilterChange(next);
            }}
          >
            {available.map((filter) => (
              <DropdownMenuItem
                key={filter}
                onSelect={() => {
                  update((prev) => withPendingFilter(prev, filter, true));
                  openAfterMenu.current = filter;
                }}
              >
                {INVENTORY_FILTER_LABELS[filter]}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      ) : null}
      {filtered ? (
        <Button
          variant="link"
          className="ml-1 h-auto p-0 text-[13px] font-medium text-link"
          onClick={onClearFilters}
        >
          Clear filters
        </Button>
      ) : null}
    </div>
  );
}

/** A chip with no picker (older links: one receipt, a retain-until band); only × changes it. */
function PlainChip({
  field,
  value,
  onRemove,
}: {
  field: string;
  value: string;
  onRemove: () => void;
}) {
  return (
    <ButtonGroup aria-label={`Filter ${field}`}>
      <span
        data-slot="filter-chip-value"
        className={cn(
          CHIP_CLASS,
          'inline-flex items-center gap-1.5 rounded-l-md border pr-2 pl-2.5',
        )}
      >
        <span className="text-accent-foreground/80">{field}</span>
        <span className="font-semibold">{value}</span>
      </span>
      <Button
        variant="outline"
        size="icon-sm"
        aria-label={`Remove filter ${value}`}
        className={cn(CHIP_CLASS, 'w-8')}
        onClick={onRemove}
      >
        <X aria-hidden="true" className="size-3.5" />
      </Button>
    </ButtonGroup>
  );
}

interface ListOption {
  value: string;
  label: string;
  keywords?: string[];
  mono?: boolean;
}

/** One choice from a short list (type, retention, location, test hole). */
function ListPicker({
  label,
  options,
  selected,
  onPick,
  searchable = false,
}: {
  label: string;
  options: readonly ListOption[];
  selected: string | null;
  onPick: (value: string) => void;
  searchable?: boolean;
}) {
  return (
    <Command label={label}>
      {searchable || options.length > 8 ? (
        <CommandInput placeholder={`Find a ${label.toLowerCase()}…`} />
      ) : null}
      <CommandList>
        <CommandEmpty>No matches.</CommandEmpty>
        {options.map((option) => (
          <CommandItem
            key={option.value}
            value={option.value}
            keywords={[option.label, ...(option.keywords ?? [])]}
            onSelect={() => onPick(option.value)}
          >
            <span className={cn('flex-1', option.mono && 'font-mono')}>{option.label}</span>
            {selected === option.value ? <Check aria-hidden="true" /> : null}
          </CommandItem>
        ))}
      </CommandList>
    </Command>
  );
}

type ProjectResults =
  | { state: 'idle' }
  | { state: 'ready'; query: string; projects: ProjectSummary[] }
  | { state: 'error'; query: string };

/** Type a project number or name; the server searches (MM-T12's project filter). */
function ProjectPicker({
  selectedId,
  onPick,
}: {
  selectedId: string | null;
  onPick: (project: ProjectSummary) => void;
}) {
  const [text, setText] = useState('');
  const [results, setResults] = useState<ProjectResults>({ state: 'idle' });
  const query = text.trim();
  useEffect(() => {
    if (query === '') return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      searchProjects(query).then(
        (projects) => !cancelled && setResults({ state: 'ready', query, projects }),
        () => !cancelled && setResults({ state: 'error', query }),
      );
    }, SEARCH_DELAY_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [query]);
  const current = results.state !== 'idle' && results.query === query ? results : null;
  return (
    <Command label="Project" shouldFilter={false}>
      <CommandInput
        aria-label="Project"
        placeholder="Project number or name"
        value={text}
        onValueChange={setText}
      />
      <CommandList>
        {query === '' ? (
          <p className="p-3 text-sm text-muted-foreground">Type a project number or name.</p>
        ) : current?.state === 'error' ? (
          <p className="p-3 text-sm text-destructive">Couldn’t search projects. Try again.</p>
        ) : current?.state === 'ready' ? (
          current.projects.length === 0 ? (
            <p className="p-3 text-sm text-muted-foreground">No matching projects.</p>
          ) : (
            current.projects.map((project) => (
              <CommandItem key={project.id} value={project.id} onSelect={() => onPick(project)}>
                <span className="flex-1 truncate">{projectLabel(project)}</span>
                {selectedId === project.id ? <Check aria-hidden="true" /> : null}
              </CommandItem>
            ))
          )
        ) : (
          <p className="p-3 text-sm text-muted-foreground">Searching…</p>
        )}
      </CommandList>
    </Command>
  );
}

/** Calendar dates in America/Edmonton, YYYY-MM-DD. */
function daysAgo(today: string, days: number): string {
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

/** Received between two dates, inclusive; applies as you type. */
function ReceivedPicker({
  from,
  to,
  onChange,
}: {
  from: string;
  to: string;
  onChange: (from: string, to: string) => void;
}) {
  const id = useId();
  const today = labCalendarDate(new Date()) ?? new Date().toISOString().slice(0, 10);
  const presets = [
    { label: 'Last 7 days', from: daysAgo(today, 6), to: today },
    { label: 'Last 30 days', from: daysAgo(today, 29), to: today },
    { label: 'This year', from: `${today.slice(0, 4)}-01-01`, to: today },
  ];
  return (
    <div role="group" aria-label="Received between" className="flex flex-col gap-3 p-4">
      <p className="text-sm font-semibold">Received between</p>
      <div className="grid grid-cols-2 gap-2">
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${id}-from`} className="text-[13px]">
            Received from
          </FieldLabel>
          <Input
            id={`${id}-from`}
            type="date"
            value={from}
            max={to || undefined}
            className="h-9 font-mono text-[13px]"
            onChange={(event) => onChange(event.target.value, to)}
          />
        </Field>
        <Field className="gap-1.5">
          <FieldLabel htmlFor={`${id}-to`} className="text-[13px]">
            Received through
          </FieldLabel>
          <Input
            id={`${id}-to`}
            type="date"
            value={to}
            min={from || undefined}
            className="h-9 font-mono text-[13px]"
            onChange={(event) => onChange(from, event.target.value)}
          />
        </Field>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {presets.map((preset) => {
          const on = preset.from === from && preset.to === to;
          return (
            <Button
              key={preset.label}
              variant="outline"
              size="sm"
              aria-pressed={on}
              className={cn(
                'h-7 px-2 text-[13px] font-normal shadow-none',
                on && 'border-primary/25 bg-accent text-accent-foreground',
              )}
              onClick={() => onChange(preset.from, preset.to)}
            >
              {preset.label}
            </Button>
          );
        })}
      </div>
      <FieldDescription>Applies as you type. Dates are in America/Edmonton.</FieldDescription>
      <div className="flex justify-end">
        <Button variant="ghost" size="sm" onClick={() => onChange('', '')}>
          Clear
        </Button>
      </div>
    </div>
  );
}

/** The chosen project's summary, for its chip (number). */
function useProject(projectId: string | null): ProjectSummary | null {
  const [project, setProject] = useState<ProjectSummary | null>(null);
  useEffect(() => {
    if (!projectId || project?.id === projectId) return;
    let cancelled = false;
    void fetchProject(projectId).then((response) => {
      if (!cancelled && response.ok) setProject(response.data);
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, project?.id]);
  return project && project.id === projectId ? project : null;
}

/** The chosen project's test holes, for the Test hole picker and chip. */
function useTestHoles(projectId: string | null): TestHole[] {
  const [loaded, setLoaded] = useState<{ projectId: string; holes: TestHole[] } | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    listTestHoles(projectId).then(
      (holes) => !cancelled && setLoaded({ projectId, holes }),
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [projectId]);
  return loaded && loaded.projectId === projectId ? loaded.holes : [];
}
