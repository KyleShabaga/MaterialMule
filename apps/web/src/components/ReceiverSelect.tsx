import { formatReceiver, receiverListResponseSchema, type ReceiverOption } from '@trapezoid/shared';
import { useEffect, useId, useState, type KeyboardEvent } from 'react';
import { apiFetch } from '../api/client';

const SEARCH_DELAY_MS = 150;
export const NOT_LISTED_MESSAGE = 'Not listed? Ask an administrator to add them.';

type Results = { state: 'error' } | { state: 'ready'; options: ReceiverOption[] };

/**
 * "Received by" combobox (TRP-T07, used by receiving in TRP-T10). Lists active staff matching
 * the typed initials or name, shown as "JS · Jordan Smith (Tech)" so people sharing initials are
 * told apart. Starts empty, never pre-selects the signed-in account, and accepts only a listed
 * person: typing after a selection clears it, so free-text initials can't be submitted. Choosing
 * a receiver is attribution only; it grants no permissions.
 */
export function ReceiverSelect({
  value,
  onChange,
  label = 'Received by',
  required = false,
  error,
}: {
  value: ReceiverOption | null;
  onChange: (receiver: ReceiverOption | null) => void;
  label?: string;
  required?: boolean;
  error?: string | null;
}) {
  const id = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [touched, setTouched] = useState(false);
  const [latest, setLatest] = useState<{ query: string; results: Results } | null>(null);

  const query = value ? '' : text.trim();
  useEffect(() => {
    if (query === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      void apiFetch(`/api/staff/receivers?search=${encodeURIComponent(query)}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return receiverListResponseSchema.parse(await response.json());
        })
        .then(
          (options) => {
            if (!current) return;
            setLatest({ query, results: { state: 'ready', options } });
            setActive(options.length > 0 ? 0 : -1);
          },
          () => {
            if (current) setLatest({ query, results: { state: 'error' } });
          },
        );
    }, SEARCH_DELAY_MS);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [query]);

  const results = latest?.query === query ? latest.results : null;
  const options = results?.state === 'ready' ? results.options : [];
  const expanded = open && query !== '';

  function choose(option: ReceiverOption) {
    onChange(option);
    setText('');
    setOpen(false);
    setActive(-1);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        if (options.length > 0) setActive((index) => (index + 1) % options.length);
        break;
      case 'ArrowUp':
        event.preventDefault();
        setOpen(true);
        if (options.length > 0) {
          setActive((index) => (index <= 0 ? options.length - 1 : index - 1));
        }
        break;
      case 'Enter':
        if (expanded && active >= 0 && options[active]) {
          event.preventDefault();
          choose(options[active]);
        }
        break;
      case 'Escape':
        if (expanded) {
          event.preventDefault();
          setOpen(false);
        }
        break;
      default:
        break;
    }
  }

  const status = !expanded
    ? null
    : results === null
      ? 'Searching…'
      : results.state === 'error'
        ? 'Staff search failed. Try again.'
        : options.length === 0
          ? 'No active staff match.'
          : null;
  const unmatched = touched && !open && value === null && text.trim() !== '';
  const message = error ?? (unmatched ? 'Choose a person from the list.' : null);
  const describedBy = [hintId, message ? errorId : null].filter(Boolean).join(' ');
  const activeId = expanded && active >= 0 && options[active] ? `${id}-opt-${active}` : undefined;

  return (
    <div className="form-field receiver-select">
      <label htmlFor={id}>
        {label}
        {required ? <span aria-hidden="true"> *</span> : null}
      </label>
      <div className="receiver-anchor">
        <input
          id={id}
          type="text"
          role="combobox"
          autoComplete="off"
          spellCheck={false}
          aria-autocomplete="list"
          aria-expanded={expanded && options.length > 0}
          aria-controls={listId}
          aria-activedescendant={activeId}
          aria-required={required}
          aria-invalid={Boolean(message)}
          aria-describedby={describedBy}
          value={value ? formatReceiver(value) : text}
          placeholder="Initials or name"
          onChange={(event) => {
            setText(event.target.value);
            setOpen(true);
            if (value) onChange(null);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            setOpen(false);
            setTouched(true);
          }}
          onKeyDown={onKeyDown}
        />
        <ul
          id={listId}
          role="listbox"
          aria-label={`${label} options`}
          className="receiver-options"
          hidden={!expanded || options.length === 0}
        >
          {options.map((option, index) => (
            <li
              key={option.id}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'active' : undefined}
              // mousedown, not click, so the input's blur doesn't close the list first.
              onMouseDown={(event) => {
                event.preventDefault();
                choose(option);
              }}
            >
              {formatReceiver(option)}
            </li>
          ))}
        </ul>
      </div>
      <p id={hintId} className="field-hint">
        Search by initials or name. {NOT_LISTED_MESSAGE}
      </p>
      <p id={statusId} className="receiver-status" role="status">
        {status}
      </p>
      {message ? (
        <p id={errorId} className="field-error">
          {message}
        </p>
      ) : null}
    </div>
  );
}
