import {
  CONCRETE_SEARCH_MATCH_LABEL,
  type ConcreteSearch,
  type ConcreteSearchResult,
} from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState, StatusBadge } from '../../components/ui';
import { setLabel, workflowLabel } from './format';

/**
 * Concrete search box (MM-V2-C31): concrete content only; the top-bar Lab search covers every
 * lab area. A text input with a search hint, so it never competes with a page's own Search box.
 */
export function ConcreteSearchForm({
  initial = '',
  to = '/concrete/search',
  label = 'Search concrete',
  button = 'Search',
}: {
  initial?: string;
  /** The page that shows the results (`?q=`). */
  to?: string;
  label?: string;
  button?: string;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const inputId = useId();
  const hintId = useId();
  useEffect(() => setText(initial), [initial]);

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (q) void navigate(`${to}?q=${encodeURIComponent(q)}`);
  }

  return (
    <form className="concrete-search-form" role="search" aria-label={label} onSubmit={submit}>
      <label htmlFor={inputId}>{label}</label>
      <p id={hintId} className="field-hint">
        Project or Field ID, specimen ID (TMP or permanent, with or without the letter), ticket,
        casting date (YYYY-MM-DD), mix or technician.
      </p>
      <div className="concrete-search-row">
        <input
          id={inputId}
          type="text"
          inputMode="search"
          enterKeyHint="search"
          autoComplete="off"
          spellCheck={false}
          maxLength={100}
          aria-describedby={hintId}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit" className="button primary">
          {button}
        </button>
      </div>
    </form>
  );
}

/** Where a set's lookup opens (the letter of a specimen ID search is kept). */
export const setLookupPath = (setId: string, letter: string | null = null) =>
  `/concrete/specimens/${encodeURIComponent(setId)}${letter ? `?letter=${letter}` : ''}`;

/**
 * Results: one card per field report, its project always shown, every set listed with both
 * aliases. Matches from different projects are all listed; nothing is chosen for the user.
 */
export function ConcreteSearchResults({
  result,
  headingLevel = 2,
}: {
  result: ConcreteSearch;
  headingLevel?: 2 | 3;
}) {
  if (result.items.length === 0) {
    return <EmptyState>No concrete records match “{result.q}”.</EmptyState>;
  }
  return (
    <div className="concrete-results">
      <p className="concrete-results-summary" role="status">
        {result.total === 1 ? '1 field report' : `${result.total} field reports`} match “{result.q}”
        {result.projectCount > 1 ? ` in ${result.projectCount} projects` : ''}.
      </p>
      {result.projectCount > 1 ? (
        <p className="notice concrete-results-projects">
          Set numbers repeat between projects. Check the project before you open a set.
        </p>
      ) : null}
      <ul className="concrete-result-list">
        {result.items.map((item) => (
          <ConcreteResultCard
            key={item.fieldReportId}
            item={item}
            letter={result.letter}
            headingLevel={headingLevel}
          />
        ))}
      </ul>
    </div>
  );
}

function ConcreteResultCard({
  item,
  letter,
  headingLevel,
}: {
  item: ConcreteSearchResult;
  letter: string | null;
  headingLevel: 2 | 3;
}) {
  const Heading = headingLevel === 2 ? 'h3' : 'h4';
  const facts: [string, string | null][] = [
    ['Casting date', item.castingDate],
    ['Report date', item.reportDate],
    ['Field ID', item.paperFieldId],
    [
      'Ticket',
      item.ticketNumber
        ? `${item.ticketNumber}${item.supplierName ? ` (${item.supplierName})` : ''}`
        : null,
    ],
    ['Mix', item.mixNumber],
    ['Technician', item.technician?.name ?? null],
  ];
  return (
    <li className="concrete-result">
      <div className="concrete-result-head">
        <Heading className="concrete-result-project">
          <Link to={`/projects/${item.projectId}`}>{item.projectNumber}</Link>{' '}
          <span className="concrete-result-project-name">{item.projectName}</span>
        </Heading>
        <StatusBadge tone={item.workflowState === 'void' ? 'danger' : 'neutral'}>
          {workflowLabel(item.workflowState)}
        </StatusBadge>
      </div>
      <dl className="concrete-facts">
        {facts
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      <p className="concrete-result-matches">
        Matched on{' '}
        {item.matches.map((m, i) => (
          <span key={m}>
            {i > 0 ? ', ' : ''}
            {CONCRETE_SEARCH_MATCH_LABEL[m]}
          </span>
        ))}
      </p>
      {item.sets.length === 0 ? (
        <p className="field-hint">No specimen sets on this report.</p>
      ) : (
        <ul className="concrete-result-sets" aria-label={`Specimen sets, ${item.projectNumber}`}>
          {item.sets.map((set) => (
            <li key={set.setId} className={set.matched ? 'concrete-set-matched' : undefined}>
              <Link to={setLookupPath(set.setId, set.matched ? letter : null)}>
                {setLabel(set.identity)}
                {set.matched && letter ? letter : ''}
              </Link>
              {set.identity.permanentId && set.identity.temporaryId ? (
                <span className="concrete-alias"> also {set.identity.temporaryId}</span>
              ) : null}
              <span className="concrete-set-count">
                {' '}
                · {set.specimenCount} {set.specimenCount === 1 ? 'specimen' : 'specimens'}
              </span>
              {set.voided ? (
                <>
                  {' '}
                  <StatusBadge tone="danger">Void</StatusBadge>
                </>
              ) : null}
              {set.matched ? <span className="visually-hidden"> (matched)</span> : null}
            </li>
          ))}
        </ul>
      )}
    </li>
  );
}
