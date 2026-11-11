import {
  CONCRETE_SEARCH_MATCH_LABEL,
  type ConcreteSearch,
  type ConcreteSearchResult,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { EmptyState, SectionHead, StatusBadge } from '../../components/ui';
import { setLabel, setLookupPath, workflowLabel, workflowTone } from './format';

/**
 * Concrete search box (MM-V2-C31): concrete content only; the top-bar Lab search covers every
 * lab area. One large text input with a search hint, so it never competes with a page's own
 * Search box. Pages give it `key={q}` so a new search in the URL starts it from that text.
 */
export function ConcreteSearchForm({
  initial = '',
  to = '/concrete/search',
  label = 'Search concrete',
  button = 'Search',
  primary = true,
}: {
  initial?: string;
  /** The page that shows the results (`?q=`). */
  to?: string;
  label?: string;
  button?: string;
  /** The submit button is the page's one primary action unless the page has another. */
  primary?: boolean;
}) {
  const navigate = useNavigate();
  const [text, setText] = useState(initial);
  const inputId = useId();
  const hintId = useId();

  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (q) void navigate(`${to}?q=${encodeURIComponent(q)}`);
  }

  return (
    <form className="concrete-search-form" role="search" aria-label={label} onSubmit={submit}>
      <label className="field-label" htmlFor={inputId}>
        {label}
      </label>
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
        <button type="submit" className={primary ? 'primary' : undefined}>
          {button}
        </button>
      </div>
      <p id={hintId} className="field-hint">
        Project or Field ID, specimen ID (TMP or permanent, with or without the letter), ticket,
        casting date (YYYY-MM-DD), mix or technician.
      </p>
    </form>
  );
}

/** Same supplier and ticket, ignoring case and blanks (CD-18's rule), on reports that aren't Void. */
function ticketKey(item: ConcreteSearchResult): string | null {
  if (!item.ticketNumber || item.workflowState === 'void') return null;
  const norm = (value: string | null) => (value ?? '').replace(/\s+/g, '').toLowerCase();
  return `${norm(item.supplierName)}|${norm(item.ticketNumber)}`;
}

/**
 * Results grouped as the data allows: field reports (project, facts, what matched) and the
 * specimen sets on them (each with its project and both aliases). Matches from different
 * projects are all listed; nothing is chosen for the user. `show="sets"` (Specimen lookup) lists
 * only the sets. `headingLevel` is the level of the group headings.
 */
export function ConcreteSearchResults({
  result,
  headingLevel = 2,
  show = 'all',
}: {
  result: ConcreteSearch;
  headingLevel?: 2 | 3;
  show?: 'all' | 'sets';
}) {
  if (result.items.length === 0) {
    return <EmptyState>No concrete records match “{result.q}”.</EmptyState>;
  }
  // A ticket shared by two results on this page is tagged on both (the server's duplicate check
  // covers every project; this tag only compares what is listed here).
  const ticketUses = new Map<string, number>();
  for (const item of result.items) {
    const key = ticketKey(item);
    if (key) ticketUses.set(key, (ticketUses.get(key) ?? 0) + 1);
  }
  const duplicate = (item: ConcreteSearchResult) => {
    const key = ticketKey(item);
    return key !== null && (ticketUses.get(key) ?? 0) > 1;
  };
  const setCount = result.items.reduce((n, item) => n + item.sets.length, 0);

  return (
    <div className="concrete-results">
      <p className="concrete-results-summary" role="status">
        {result.total === 1 ? '1 field report' : `${result.total} field reports`} match “{result.q}”
        {result.projectCount > 1 ? ` in ${result.projectCount} projects` : ''}.
      </p>
      {result.projectCount > 1 ? (
        <p className="notice notice-warning concrete-results-projects">
          Set numbers repeat between projects. Check the project before you open a set.
        </p>
      ) : null}

      {show === 'all' ? (
        <div className="concrete-results-group">
          <SectionHead
            level={headingLevel}
            title="Field reports"
            meta={`${result.items.length} ${result.items.length === 1 ? 'match' : 'matches'}`}
          />
          <ul className="concrete-row-list">
            {result.items.map((item) => (
              <ReportRow
                key={item.fieldReportId}
                item={item}
                duplicateTicket={duplicate(item)}
                headingLevel={headingLevel}
              />
            ))}
          </ul>
        </div>
      ) : null}

      <div className="concrete-results-group">
        <SectionHead
          level={headingLevel}
          title="Specimen sets"
          meta={`${setCount} ${setCount === 1 ? 'set' : 'sets'}`}
        />
        {setCount === 0 ? (
          <p className="field-hint">No specimen sets on these reports.</p>
        ) : (
          result.items
            .filter((item) => item.sets.length > 0)
            .map((item) => <SetRows key={item.fieldReportId} item={item} letter={result.letter} />)
        )}
      </div>
    </div>
  );
}

function ReportRow({
  item,
  duplicateTicket,
  headingLevel,
}: {
  item: ConcreteSearchResult;
  duplicateTicket: boolean;
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
    <li className="concrete-row concrete-report-row">
      <div className="concrete-row-head">
        <Heading className="concrete-row-title">
          <Link className="mono" to={`/projects/${item.projectId}`}>
            {item.projectNumber}
          </Link>{' '}
          <span className="concrete-muted">{item.projectName}</span>
        </Heading>
        <span className="concrete-row-tags">
          <StatusBadge tone={workflowTone(item.workflowState)}>
            {workflowLabel(item.workflowState)}
          </StatusBadge>
          {duplicateTicket ? <StatusBadge tone="waiting">Duplicate ticket</StatusBadge> : null}
        </span>
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
    </li>
  );
}

/** The sets on one field report, as rows: set ID, aliases, project, cast date, count, tags. */
function SetRows({ item, letter }: { item: ConcreteSearchResult; letter: string | null }) {
  return (
    <ul className="concrete-row-list" aria-label={`Specimen sets, ${item.projectNumber}`}>
      {item.sets.map((set) => (
        <li
          key={set.setId}
          className={set.matched ? 'concrete-row concrete-row-matched' : 'concrete-row'}
        >
          <span className="concrete-row-id">
            <Link to={setLookupPath(set.setId, set.matched ? letter : null)}>
              {setLabel(set.identity)}
              {set.matched && letter ? letter : ''}
            </Link>
            {set.identity.permanentId && set.identity.temporaryId ? (
              <span className="concrete-alias">also {set.identity.temporaryId}</span>
            ) : null}
          </span>
          <span className="concrete-row-main">
            <span className="mono concrete-strong">{item.projectNumber}</span>{' '}
            <span className="concrete-muted">{item.projectName}</span>
            <span className="concrete-row-sub">
              {item.castingDate ? `Cast ${item.castingDate} · ` : ''}
              {set.specimenCount} {set.specimenCount === 1 ? 'specimen' : 'specimens'}
            </span>
          </span>
          <span className="concrete-row-tags">
            {set.voided ? <StatusBadge tone="danger">Void</StatusBadge> : null}
            {set.matched ? <StatusBadge tone="flag">Matched</StatusBadge> : null}
          </span>
        </li>
      ))}
    </ul>
  );
}
