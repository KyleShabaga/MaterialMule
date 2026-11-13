import {
  normalizeTestHoleName,
  testHoleNameKey,
  testHoleNameSchema,
  type TestHole,
} from '@materialmule/shared';
import { X } from 'lucide-react';
import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { createTestHole, listTestHoles } from '../api/projects';
import { RequiredMarker } from '../components/app-ui';
import { useListHighlight } from '../components/useListHighlight';
import { FieldErrorText } from './LabeledField';
import { PICKER_OPTION_CLASS } from './picker-option';

// Test-hole multi-select within one project, with "Add TH26-03" as the last option when nothing
// matches exactly (MM-T08). Names are kept as typed (trimmed): never renamed or re-yeared.
// With `single` (MM-T36: a Shelby tube's or bulk sample's sampling source) choosing a hole
// replaces the one chosen; keyboard, Enter/close/blur and add behaviour are the same.

type Holes = { state: 'loading' } | { state: 'error' } | { state: 'ready'; holes: TestHole[] };

type Option = { kind: 'hole'; hole: TestHole } | { kind: 'add'; name: string };

export function TestHolePicker({
  projectId,
  selected,
  onChange,
  query,
  onQueryChange,
  receiverUserId,
  online,
  addedNote,
  single = false,
  legend = 'Test holes',
  required = false,
  invalid = false,
  hideLegend = false,
  onLoadError,
}: {
  projectId: string;
  selected: TestHole[];
  onChange: (holes: TestHole[]) => void;
  query: string;
  onQueryChange: (query: string) => void;
  receiverUserId: string | null;
  online: boolean;
  /**
   * What to say after a new hole is added (it is saved on the project at once, MM-T61), e.g.
   * "Added test hole TH26-05 to DEMO-2601. It stays on the project even if you discard this
   * draft." Nothing is said when left out.
   */
  addedNote?: (holeName: string) => string;
  /** Exactly one hole: a new choice replaces the current one. */
  single?: boolean;
  legend?: string;
  /** Marks the test holes as required (MTR-133). */
  required?: boolean;
  /** The form reported a problem with the holes: the search box says so (MTR-133). */
  invalid?: boolean;
  /** The legend stays for assistive technology only (a receiving row's column names it). */
  hideLegend?: boolean;
  /** Told when the project's holes fail (true) or load (false), for a page-level Try again. */
  onLoadError?: (failed: boolean) => void;
}) {
  const id = useId();
  const [loaded, setLoaded] = useState<{ projectId: string; holes: Holes } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let current = true;
    listTestHoles(projectId).then(
      (holes) => current && setLoaded({ projectId, holes: { state: 'ready', holes } }),
      () => current && setLoaded({ projectId, holes: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [projectId, attempt]);

  const holes: Holes = loaded?.projectId === projectId ? loaded.holes : { state: 'loading' };
  const loadState = holes.state;
  const reportLoad = useRef(onLoadError);
  useEffect(() => {
    reportLoad.current = onLoadError;
  });
  useEffect(() => {
    if (loadState !== 'loading') reportLoad.current?.(loadState === 'error');
  }, [loadState]);
  const known = holes.state === 'ready' ? holes.holes : [];
  const key = testHoleNameKey(query);
  const selectedIds = new Set(selected.map((hole) => hole.id));
  const exact = [...known, ...selected].some((hole) => testHoleNameKey(hole.name) === key);
  const options: Option[] = [
    ...known
      .filter((hole) => !selectedIds.has(hole.id) && testHoleNameKey(hole.name).includes(key))
      .map((hole): Option => ({ kind: 'hole', hole })),
    ...(key !== '' && !exact && holes.state === 'ready'
      ? [{ kind: 'add', name: normalizeTestHoleName(query) } satisfies Option]
      : []),
  ];
  const listboxId = `${id}-holes`;
  const showList = open && holes.state === 'ready' && options.length > 0;
  // MM-T62: once something is typed the first match is highlighted, so Enter picks it (same in
  // every picker). The list shown on focus, before typing, starts with nothing highlighted.
  const highlight = useListHighlight(
    options.length,
    `${key}|${options.map((option) => (option.kind === 'hole' ? option.hole.id : 'add')).join(',')}`,
    key !== '',
  );
  const active = highlight.active;

  function select(hole: TestHole) {
    if (single) {
      onChange([hole]);
    } else if (!selectedIds.has(hole.id)) {
      onChange([...selected, hole]);
    }
    onQueryChange('');
  }

  /** Adds a test hole and selects it; true when it was added (or already existed). */
  async function add(name: string): Promise<boolean> {
    setMessage(null);
    const checked = testHoleNameSchema.safeParse(name);
    if (!checked.success) {
      setMessage({ tone: 'error', text: checked.error.issues[0]!.message });
      return false;
    }
    setSaving(true);
    try {
      const result = await createTestHole(projectId, { name: checked.data, receiverUserId });
      if (result.kind === 'created' || result.kind === 'exists') {
        const hole = result.kind === 'created' ? result.record : result.existing;
        setLoaded((current) =>
          current?.projectId === projectId && current.holes.state === 'ready'
            ? {
                projectId,
                holes: {
                  state: 'ready',
                  holes: current.holes.holes.some((h) => h.id === hole.id)
                    ? current.holes.holes
                    : [...current.holes.holes, hole],
                },
              }
            : current,
        );
        if (result.kind === 'exists') {
          setMessage({ tone: 'info', text: `${hole.name} already exists; it's now selected.` });
        } else if (addedNote) {
          setMessage({ tone: 'info', text: addedNote(hole.name) });
        }
        select(hole);
        return true;
      }
      setMessage({ tone: 'error', text: Object.values(result.fieldErrors).flat().join(' ') });
      return false;
    } catch {
      setMessage({ tone: 'error', text: "The test hole couldn't be saved. Check the connection." });
      return false;
    } finally {
      setSaving(false);
    }
  }

  /**
   * After Enter chose a hole (MM-T66 UI-06): close the list and leave the search box, keeping the
   * selection. A failed add keeps the box focused so the name can be corrected.
   */
  function finish() {
    setOpen(false);
    input.current?.blur();
  }

  function pick(option: Option, viaEnter = false) {
    if (option.kind === 'hole') {
      select(option.hole);
      if (viaEnter) finish();
    } else if (online && !saving) {
      void add(option.name).then((added) => {
        if (added && viaEnter) finish();
      });
    }
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setOpen(true);
      highlight.next();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      highlight.previous();
    } else if (event.key === 'Enter') {
      // Enter chooses the highlighted option and never submits the surrounding form (MM-T61).
      event.preventDefault();
      const option = showList ? options[active] : undefined;
      if (option) pick(option, true);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <fieldset className="m-0 flex min-w-0 flex-col gap-1.5 border-0 p-0">
      <legend className={hideLegend ? 'sr-only' : 'mb-1.5 text-[13px] font-semibold'}>
        {legend}
        {required ? <RequiredMarker /> : null}
      </legend>
      {selected.length > 0 ? (
        <ul
          className="m-0 flex list-none flex-wrap gap-1.5 p-0"
          aria-label={single ? 'Selected test hole' : 'Selected test holes'}
        >
          {selected.map((hole) => (
            <li
              key={hole.id}
              className="bg-accent text-accent-foreground inline-flex h-8 items-center gap-1 rounded-md pr-1 pl-2.5 font-mono text-[13px] font-semibold"
            >
              {hole.name}
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${hole.name}`}
                title={`Remove ${hole.name}`}
                onClick={() => onChange(selected.filter((h) => h.id !== hole.id))}
              >
                <X aria-hidden="true" />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="relative flex min-w-0 flex-col gap-1.5">
        <label htmlFor={`${id}-search`} className="sr-only">
          {single && selected.length > 0 ? 'Change the test hole' : 'Find or add a test hole'}
        </label>
        <Input
          ref={input}
          id={`${id}-search`}
          role="combobox"
          className="font-mono"
          placeholder={
            single && selected.length > 0
              ? 'Change the test hole'
              : selected.length > 0
                ? 'Add another test hole'
                : 'Test hole'
          }
          aria-required={required || undefined}
          aria-invalid={invalid || undefined}
          aria-autocomplete="list"
          aria-expanded={showList}
          aria-controls={listboxId}
          aria-activedescendant={showList && active >= 0 ? `${listboxId}-${active}` : undefined}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQueryChange(event.target.value);
            setOpen(true);
            setMessage(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setOpen(false)}
          onKeyDown={onKeyDown}
        />
        {showList ? (
          <ul
            id={listboxId}
            role="listbox"
            aria-label="Test holes"
            aria-multiselectable={single ? undefined : 'true'}
            className="bg-popover text-popover-foreground absolute top-full right-0 left-0 z-30 m-0 mt-1 max-h-64 list-none overflow-y-auto rounded-md border p-1 shadow-md"
          >
            {options.map((option, index) => (
              <li
                key={option.kind === 'hole' ? option.hole.id : 'add'}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={option.kind === 'add' && (!online || saving) ? 'true' : undefined}
                className={cn(
                  PICKER_OPTION_CLASS,
                  'aria-disabled:cursor-not-allowed aria-disabled:opacity-60',
                  option.kind === 'hole' ? 'font-mono' : 'font-semibold',
                )}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => pick(option)}
              >
                {option.kind === 'hole'
                  ? option.hole.name
                  : online
                    ? `Add ${option.name}`
                    : 'Connect to add a test hole'}
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {holes.state === 'error' ? (
        <div className="flex flex-wrap items-center gap-2" role="alert">
          <FieldErrorText>Test holes couldn’t load.</FieldErrorText>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => setAttempt((n) => n + 1)}
          >
            Retry
          </Button>
        </div>
      ) : null}
      {message ? (
        message.tone === 'error' ? (
          <div role="alert">
            <FieldErrorText>{message.text}</FieldErrorText>
          </div>
        ) : (
          <p className="text-muted-foreground m-0 text-[13px]" role="status">
            {message.text}
          </p>
        )
      ) : null}
    </fieldset>
  );
}
