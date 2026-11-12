import {
  formatReceiver,
  receiverListResponseSchema,
  type ReceiverOption,
} from '@materialmule/shared';
import { useEffect, useEffectEvent, useId, useRef, useState, type KeyboardEvent } from 'react';
import { apiFetch } from '../api/client';
import { useOptionalRecordingPerson } from '../session/recording-person-store';
import { toReceiver } from '../session/station-people';
import { RequiredMarker } from './app-ui';
import { useListHighlight } from './useListHighlight';

const SEARCH_DELAY_MS = 150;
export const NOT_LISTED_MESSAGE = 'Not listed? Ask an administrator to add them.';

type Results = { state: 'error' } | { state: 'ready'; options: ReceiverOption[] };

/**
 * "Received by" combobox (MM-T07, used by receiving in MM-T10). Lists active staff matching
 * the typed initials or name, shown as "JS · Jordan Smith" so people sharing initials are
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
  searchPath = '/api/staff/receivers',
  noMatchText = 'No active staff match.',
  hint = `Search by initials or name. ${NOT_LISTED_MESSAGE}`,
  stationPerson,
}: {
  value: ReceiverOption | null;
  onChange: (receiver: ReceiverOption | null) => void;
  label?: string;
  required?: boolean;
  error?: string | null;
  /** Where options come from; the Receiving Log filter (MM-T51) lists past receivers instead. */
  searchPath?: string;
  noMatchText?: string;
  hint?: string;
  /**
   * On a shared LAB station with someone picked (STRATA-125, one recording identity):
   * `prefill` starts as the picked person and follows a switch until changed by hand (Received
   * by, Moved by); `follow` is the picked person, read-only (performers: who did the work).
   * Personal accounts and stations with no one picked are unaffected.
   */
  stationPerson?: 'prefill' | 'follow';
}) {
  const station = useOptionalRecordingPerson();
  const picked = stationPerson && station?.isStation ? station.person : null;
  const follows = stationPerson === 'follow' && picked !== null;
  const pickedId = picked?.id ?? null;
  const prefilledId = useRef<string | null>(null);
  // Prefill: fill an empty field, or move along with a switch while it still holds the last
  // prefill; a receiver chosen by hand stays. Follow: always the picked person.
  const syncWithStation = useEffectEvent(() => {
    if (!picked) return;
    if (stationPerson === 'follow') {
      if (value?.id !== picked.id) onChange(toReceiver(picked));
      return;
    }
    if (value === null || value.id === prefilledId.current) {
      if (value?.id !== picked.id) onChange(toReceiver(picked));
    }
    prefilledId.current = picked.id;
  });
  useEffect(() => {
    if (stationPerson === 'prefill') syncWithStation();
  }, [pickedId, stationPerson]);
  useEffect(() => {
    if (stationPerson === 'follow') syncWithStation();
  }, [pickedId, stationPerson, value?.id]);

  const id = useId();
  const listId = `${id}-list`;
  const hintId = `${id}-hint`;
  const errorId = `${id}-error`;
  const statusId = `${id}-status`;
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const [touched, setTouched] = useState(false);
  const selectOnFocus = useRef(false);
  const [latest, setLatest] = useState<{ query: string; results: Results } | null>(null);

  const query = value ? '' : text.trim();
  useEffect(() => {
    if (query === '') return;
    let current = true;
    const timer = window.setTimeout(() => {
      void apiFetch(`${searchPath}?search=${encodeURIComponent(query)}`)
        .then(async (response) => {
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          return receiverListResponseSchema.parse(await response.json());
        })
        .then(
          (options) => {
            if (!current) return;
            setLatest({ query, results: { state: 'ready', options } });
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
  }, [query, searchPath]);

  const results = latest?.query === query ? latest.results : null;
  const options = results?.state === 'ready' ? results.options : [];
  const expanded = open && query !== '';
  // MM-T62: the first match is highlighted, as in the project and test-hole pickers.
  const highlight = useListHighlight(
    options.length,
    `${query}|${options.map((option) => option.id).join(',')}`,
  );
  const active = highlight.active;

  function choose(option: ReceiverOption) {
    onChange(option);
    setText('');
    setOpen(false);
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        setOpen(true);
        highlight.next();
        break;
      case 'ArrowUp':
        event.preventDefault();
        setOpen(true);
        highlight.previous();
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
          ? noMatchText
          : null;
  const unmatched = touched && !open && value === null && text.trim() !== '';
  const message = error ?? (unmatched ? 'Choose a person from the list.' : null);
  const describedBy = [hintId, message ? errorId : null].filter(Boolean).join(' ');
  const activeId = expanded && active >= 0 && options[active] ? `${id}-opt-${active}` : undefined;

  if (follows) {
    return (
      <div className="form-field receiver-select">
        <label htmlFor={id}>
          {label}
          {required ? <RequiredMarker /> : null}
        </label>
        <input
          id={id}
          type="text"
          readOnly
          aria-readonly="true"
          aria-describedby={[hintId, error ? errorId : null].filter(Boolean).join(' ')}
          value={formatReceiver(picked)}
        />
        <p id={hintId} className="field-hint">
          The person in Recording as. To credit someone else, switch person at the top.
        </p>
        {error ? (
          <p id={errorId} className="field-error">
            {error}
          </p>
        ) : null}
      </div>
    );
  }

  return (
    <div className="form-field receiver-select">
      <label htmlFor={id}>
        {label}
        {required ? <RequiredMarker /> : null}
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
          onFocus={(event) => {
            setOpen(true);
            // MM-T53: select the chosen name so the first keystroke replaces it and searches.
            if (value) {
              event.currentTarget.select();
              selectOnFocus.current = true;
            }
          }}
          // A click's mouseup would otherwise drop the selection just made on focus.
          onMouseUp={(event) => {
            if (selectOnFocus.current) event.preventDefault();
            selectOnFocus.current = false;
          }}
          onBlur={() => {
            setOpen(false);
            setTouched(true);
            selectOnFocus.current = false;
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
        {hint}
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
