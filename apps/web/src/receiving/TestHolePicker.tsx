import {
  normalizeTestHoleName,
  testHoleNameKey,
  testHoleNameSchema,
  type TestHole,
} from '@materialmule/shared';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { createTestHole, listTestHoles } from '../api/projects';
import { useListHighlight } from '../components/useListHighlight';

// Test-hole multi-select within one project, with "Add TH26-03" as the last option when nothing
// matches exactly (MM-T08). Names are kept as typed (trimmed): never renamed or re-yeared.

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
}: {
  projectId: string;
  selected: TestHole[];
  onChange: (holes: TestHole[]) => void;
  query: string;
  onQueryChange: (query: string) => void;
  receiverUserId: string | null;
  online: boolean;
}) {
  const id = useId();
  const [loaded, setLoaded] = useState<{ projectId: string; holes: Holes } | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<{ tone: 'error' | 'info'; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

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
    if (!selectedIds.has(hole.id)) {
      onChange([...selected, hole]);
    }
    onQueryChange('');
  }

  async function add(name: string) {
    setMessage(null);
    const checked = testHoleNameSchema.safeParse(name);
    if (!checked.success) {
      setMessage({ tone: 'error', text: checked.error.issues[0]!.message });
      return;
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
        }
        select(hole);
      } else {
        setMessage({ tone: 'error', text: Object.values(result.fieldErrors).flat().join(' ') });
      }
    } catch {
      setMessage({ tone: 'error', text: "The test hole couldn't be saved. Check the connection." });
    } finally {
      setSaving(false);
    }
  }

  function pick(option: Option) {
    if (option.kind === 'hole') {
      select(option.hole);
    } else if (online && !saving) {
      void add(option.name);
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
      if (option) pick(option);
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  }

  return (
    <fieldset className="picker">
      <legend>Test holes</legend>
      {selected.length > 0 ? (
        <ul className="chips" aria-label="Selected test holes">
          {selected.map((hole) => (
            <li key={hole.id}>
              {hole.name}
              <button
                type="button"
                aria-label={`Remove ${hole.name}`}
                onClick={() => onChange(selected.filter((h) => h.id !== hole.id))}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="form-field combobox">
        <label htmlFor={`${id}-search`}>Find or add a test hole</label>
        <input
          id={`${id}-search`}
          role="combobox"
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
            aria-multiselectable="true"
            className="listbox"
          >
            {options.map((option, index) => (
              <li
                key={option.kind === 'hole' ? option.hole.id : 'add'}
                id={`${listboxId}-${index}`}
                role="option"
                aria-selected={index === active}
                aria-disabled={option.kind === 'add' && (!online || saving) ? 'true' : undefined}
                className={option.kind === 'add' ? 'add-option' : undefined}
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
        <div className="error-state" role="alert">
          <p>Test holes couldn’t load.</p>
          <button type="button" onClick={() => setAttempt((n) => n + 1)}>
            Retry
          </button>
        </div>
      ) : null}
      {message ? (
        <p
          className={message.tone === 'error' ? 'field-error' : 'field-hint'}
          role={message.tone === 'error' ? 'alert' : 'status'}
        >
          {message.text}
        </p>
      ) : null}
    </fieldset>
  );
}
