import {
  LINE_SCOPE_LABEL,
  TAG_SHEET,
  TAG_SLOTS_PER_SHEET,
  TEST_REQUEST_STATUS_LABEL,
  formatTagDate,
  layoutTagSheets,
  splitSampleTag,
  type SampleTag,
  type SampleTagSheet,
} from '@materialmule/shared';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { Link, useParams } from 'react-router';
import { EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { fetchSampleTags, type SampleTagsResult } from './api';
import './sample-tags.css';

/**
 * Letter paper with no margins while this view is open, so card positions are true inches from
 * the sheet's corner. A fixed string: no user data is ever placed in it.
 */
const PRINT_CSS = `
@page { size: letter; margin: 0; }
@media print {
  :root, html, body { margin: 0; padding: 0; background: #fff; color: #000; }
  .tag-print { margin: 0; padding: 0; max-width: none; }
  .tag-print-controls { display: none !important; }
  .tag-preview { display: block; margin: 0; padding: 0; overflow: visible; background: none; }
  .tag-sheet-label { display: none; }
  .tag-sheet { margin: 0; box-shadow: none; border: 0; break-after: page; }
  .tag-sheet:last-child { break-after: auto; }
  .tag-slot-blank { visibility: hidden; }
  .tag-card.tag-card-overflow { outline: none; }
}
`;

const NUDGE_KEY = 'materialmule.sampleTags.nudge';
const NUDGE_LIMIT_IN = 0.25;
const MIN_FONT_PT = 6.5;

type Nudge = { x: number; y: number };

function readNudge(): Nudge {
  try {
    const value = JSON.parse(localStorage.getItem(NUDGE_KEY) ?? 'null') as Partial<Nudge> | null;
    const clamp = (n: unknown) =>
      typeof n === 'number' && Number.isFinite(n)
        ? Math.min(Math.max(n, -NUDGE_LIMIT_IN), NUDGE_LIMIT_IN)
        : 0;
    return { x: clamp(value?.x), y: clamp(value?.y) };
  } catch {
    return { x: 0, y: 0 };
  }
}

function writeNudge(nudge: Nudge) {
  try {
    localStorage.setItem(NUDGE_KEY, JSON.stringify(nudge));
  } catch {
    // Remembering the nudge is a convenience only.
  }
}

const testNames = (tag: SampleTag) => tag.tests.map((test) => test.name).join(', ');

/** The browser settings that keep cards on the perforations. */
function TagPrintSteps() {
  return (
    <ol className="label-print-steps">
      <li>Load Uline S-15619 insert card sheets (2 × 4 in, ten per sheet), printing one side.</li>
      <li>
        In the print dialog choose <strong>Letter</strong>, scale{' '}
        <strong>100% (Actual size)</strong>, margins <strong>None</strong>, headers and footers{' '}
        <strong>off</strong>.
      </li>
      <li>
        New printer or stock? Print one sheet on plain paper with card outlines on, hold it over a
        card sheet, then adjust the nudge above.
      </li>
    </ol>
  );
}

/** One 4 × 2 in card, laid out like the lab's paper tags. */
function TagCard({
  tag,
  sheet,
  date,
  overflow,
}: {
  tag: SampleTag;
  sheet: SampleTagSheet;
  date: string;
  overflow: boolean;
}) {
  const field = (label: string, value: string, wide = false, name?: string) => (
    <div className={wide ? 'tag-field tag-field-wide' : 'tag-field'}>
      <span className="tag-field-label">{label}</span>
      <span className="tag-value" data-field={name}>
        {value}
      </span>
    </div>
  );
  return (
    <div
      className={overflow ? 'tag-card tag-card-overflow' : 'tag-card'}
      data-tag-key={tag.key}
      aria-label={`Tag ${tag.sampleLabel} at ${tag.depth}, ${tag.source.label}: ${testNames(tag)}`}
    >
      <div className="tag-field">
        <span className="tag-title">Sample Identification</span>
      </div>
      {field('Pan #', '')}
      {field('Date:', date)}
      {field('Sample No.:', tag.sampleLabel, false, 'sample')}
      {field('Project:', sheet.program.project.name, true, 'project')}
      {field('Project No.:', sheet.program.project.projectNumber, false, 'projectNumber')}
      {field('Series No.:', '')}
      {field('Location:', tag.source.label, true, 'location')}
      {field('USC Symbol:', '')}
      {field('Depth:', tag.depth, false, 'depth')}
      <div className="tag-field tag-field-wide tag-field-tests">
        <span className="tag-field-label">Test Required:</span>
        <span className="tag-value tag-value-tests" data-field="tests">
          {testNames(tag)}
        </span>
      </div>
      <span className="tag-ref">
        {sheet.program.programNumber} · L{tag.lineNumbers.join(', L')}
      </span>
    </div>
  );
}

/**
 * Shrinks each card value that doesn't fit, down to a legible minimum, and reports the cards
 * whose text still doesn't fit so the preview can say so before anything is printed.
 */
function useFitText(root: React.RefObject<HTMLElement | null>, deps: unknown[]): Set<string> {
  const [overflowing, setOverflowing] = useState<Set<string>>(new Set());
  useLayoutEffect(() => {
    const frame = requestAnimationFrame(() => {
      const found = root.current ? fitValues(root.current) : new Set<string>();
      setOverflowing((current) =>
        current.size === found.size && [...found].every((key) => current.has(key))
          ? current
          : found,
      );
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  return overflowing;
}

/** Fits every card value in `container`; returns the keys of cards that still overflow. */
function fitValues(container: HTMLElement): Set<string> {
  const found = new Set<string>();
  for (const value of container.querySelectorAll<HTMLElement>('.tag-value')) {
    value.style.fontSize = '';
    const fits = () =>
      value.scrollWidth <= value.clientWidth + 0.5 &&
      value.scrollHeight <= value.clientHeight + 0.5;
    let size = parseFloat(getComputedStyle(value).fontSize) * 0.75; // px → pt
    while (!fits() && size > MIN_FONT_PT) {
      size = Math.max(MIN_FONT_PT, size - 0.5);
      value.style.fontSize = `${size}pt`;
    }
    if (!fits()) {
      const key = value.closest<HTMLElement>('[data-tag-key]')?.dataset.tagKey;
      if (key) found.add(key);
    }
  }
  return found;
}

/**
 * /lab-testing/programs/:programId/tags (MM-T69): preview and print sample ID tags for a
 * submitted program on letter sheets of ten 2 × 4 in cards. Tags are computed from the program's
 * current requests; printing (or not) changes nothing in the program.
 */
export function SampleTagsPage() {
  const { programId = '' } = useParams();
  const [result, setResult] = useState<{ id: string; value: SampleTagsResult } | null>(null);
  const [reloads, setReloads] = useState(0);
  const [split, setSplit] = useState<Set<string>>(new Set());
  const [excluded, setExcluded] = useState<Set<string> | null>(null);
  const [start, setStart] = useState(1);
  const [outlines, setOutlines] = useState(false);
  const [nudge, setNudge] = useState<Nudge>(readNudge);
  const date = useMemo(() => formatTagDate(new Date()), []);
  const loadId = `${programId}:${reloads}`;

  useEffect(() => {
    let cancelled = false;
    void fetchSampleTags(programId).then((value) => {
      if (!cancelled) setResult({ id: loadId, value });
    });
    return () => {
      cancelled = true;
    };
  }, [programId, loadId]);

  const sheet = result?.id === loadId && result.value.ok ? result.value.sheet : null;
  const tags = useMemo(
    () => (sheet?.tags ?? []).flatMap((tag) => (split.has(tag.key) ? splitSampleTag(tag) : [tag])),
    [sheet, split],
  );
  // By default only tags with work still to do are printed (reprints don't waste cards).
  const notSelected = useMemo(
    () => excluded ?? new Set(tags.filter((tag) => !tag.pending).map((tag) => tag.key)),
    [excluded, tags],
  );
  const chosen = tags.filter((tag) => !notSelected.has(tag.key));
  const sheets = layoutTagSheets(chosen.length, start);
  const previewRef = useRef<HTMLDivElement>(null);
  const overflowing = useFitText(previewRef, [chosen.map((tag) => tag.key).join('|'), start]);

  const toggle = useCallback(
    (key: string) => {
      const next = new Set(notSelected);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      setExcluded(next);
    },
    [notSelected],
  );
  const splitTag = (tag: SampleTag) => {
    setSplit(new Set(split).add(tag.key));
    if (notSelected.has(tag.key)) {
      const next = new Set(notSelected);
      for (const part of splitSampleTag(tag)) next.add(part.key);
      setExcluded(next);
    }
  };
  const changeNudge = (axis: keyof Nudge, value: number) => {
    const next = {
      ...nudge,
      [axis]: Number.isFinite(value)
        ? Math.min(Math.max(value, -NUDGE_LIMIT_IN), NUDGE_LIMIT_IN)
        : 0,
    };
    setNudge(next);
    writeNudge(next);
  };

  const back = (
    <Link to={`/lab-testing/programs/${encodeURIComponent(programId)}`}>
      ← Back to {sheet?.program.programNumber ?? 'the program'}
    </Link>
  );

  let status = null;
  if (!result || result.id !== loadId) {
    status = <p aria-busy="true">Loading tags…</p>;
  } else if (!result.value.ok) {
    status =
      result.value.reason === 'not_found' ? (
        <EmptyState>This program doesn’t exist, or it is someone else’s draft.</EmptyState>
      ) : result.value.reason === 'not_submitted' ? (
        <EmptyState>Sample ID tags are available once the program is submitted.</EmptyState>
      ) : (
        <ErrorState
          message="The tags couldn’t be loaded."
          onRetry={() => setReloads((n) => n + 1)}
        />
      );
  }

  return (
    <main className="tag-print">
      <style>{PRINT_CSS}</style>
      <section className="tag-print-controls" aria-labelledby="tags-heading">
        <p className="back-link">{back}</p>
        <h1 id="tags-heading">
          Sample ID tags
          {sheet ? <span className="mono"> · {sheet.program.programNumber}</span> : null}
        </h1>
        {status}
        {sheet ? (
          <>
            <p>
              {sheet.program.project.projectNumber} · {sheet.program.project.name}. Tags show
              today’s date ({date}) and the program’s current tests. Printing changes nothing in the
              program.
            </p>
            {tags.length === 0 ? (
              <EmptyState>No test in this program needs a sample ID tag.</EmptyState>
            ) : (
              <TagTable
                tags={tags}
                notSelected={notSelected}
                overflowing={overflowing}
                onToggle={toggle}
                onSplit={splitTag}
                onSelectAll={(all) =>
                  setExcluded(all ? new Set() : new Set(tags.map((tag) => tag.key)))
                }
              />
            )}
            <UntaggedNotes sheet={sheet} />
            {tags.length > 0 ? (
              <div className="tag-options">
                <div className="form-field">
                  <label htmlFor="tag-start">Start at card</label>
                  <select
                    id="tag-start"
                    value={start}
                    onChange={(event) => setStart(Number(event.target.value))}
                  >
                    {Array.from({ length: TAG_SLOTS_PER_SHEET }, (_, i) => i + 1).map((n) => (
                      <option key={n} value={n}>
                        {n}
                        {n === 1 ? ' (full sheet)' : ''}
                      </option>
                    ))}
                  </select>
                  <p className="field-hint">
                    For a partly used sheet: cards are numbered left to right, top to bottom.
                  </p>
                </div>
                <div className="form-field">
                  <label className="checkbox-label">
                    <input
                      type="checkbox"
                      checked={outlines}
                      onChange={(event) => setOutlines(event.target.checked)}
                    />{' '}
                    Print card outlines (plain-paper alignment test)
                  </label>
                </div>
                <fieldset className="tag-nudge">
                  <legend>Nudge for this computer’s printer (inches)</legend>
                  <label>
                    Right
                    <input
                      type="number"
                      step={0.01}
                      min={-NUDGE_LIMIT_IN}
                      max={NUDGE_LIMIT_IN}
                      value={nudge.x}
                      onChange={(event) => changeNudge('x', event.target.valueAsNumber)}
                    />
                  </label>
                  <label>
                    Down
                    <input
                      type="number"
                      step={0.01}
                      min={-NUDGE_LIMIT_IN}
                      max={NUDGE_LIMIT_IN}
                      value={nudge.y}
                      onChange={(event) => changeNudge('y', event.target.valueAsNumber)}
                    />
                  </label>
                </fieldset>
                <TagPrintSteps />
                {overflowing.size > 0 ? (
                  <p className="notice notice-warning" role="alert">
                    {overflowing.size === 1 ? 'One tag has' : `${overflowing.size} tags have`} text
                    that doesn’t fit, marked in the list and preview. Split the tag or check the
                    printed card.
                  </p>
                ) : null}
                <p role="status">
                  {chosen.length} of {tags.length} tag{tags.length === 1 ? '' : 's'} selected ·{' '}
                  {sheets.length} sheet{sheets.length === 1 ? '' : 's'}
                </p>
                <button
                  type="button"
                  className="primary"
                  disabled={chosen.length === 0}
                  onClick={() => window.print()}
                >
                  Print / Save as PDF
                </button>
              </div>
            ) : null}
          </>
        ) : null}
      </section>
      {sheet && chosen.length > 0 ? (
        <div className="tag-preview" ref={previewRef} aria-label="Tag sheets to print">
          {sheets.map((slots, sheetIndex) => (
            <section
              key={sheetIndex}
              className={outlines ? 'tag-sheet tag-sheet-outlines' : 'tag-sheet'}
              aria-label={`Sheet ${sheetIndex + 1} of ${sheets.length}`}
            >
              {slots.map((index, slot) => {
                const column = slot % TAG_SHEET.columns;
                const row = Math.floor(slot / TAG_SHEET.columns);
                const tag = index === null ? null : chosen[index]!;
                return (
                  <div
                    key={slot}
                    className={tag ? 'tag-slot' : 'tag-slot tag-slot-blank'}
                    style={{
                      left: `${TAG_SHEET.columnLeftIn[column]! + nudge.x}in`,
                      top: `${TAG_SHEET.topIn + row * TAG_SHEET.rowPitchIn + nudge.y}in`,
                    }}
                    aria-label={tag ? undefined : `Card ${slot + 1}: blank`}
                  >
                    {tag ? (
                      <TagCard
                        tag={tag}
                        sheet={sheet}
                        date={date}
                        overflow={overflowing.has(tag.key)}
                      />
                    ) : null}
                  </div>
                );
              })}
              <p className="tag-sheet-footer">
                Sample ID Tags · {sheet.program.programNumber} · {date} · Sheet {sheetIndex + 1} of{' '}
                {sheets.length}
              </p>
            </section>
          ))}
        </div>
      ) : null}
    </main>
  );
}

function TagTable({
  tags,
  notSelected,
  overflowing,
  onToggle,
  onSplit,
  onSelectAll,
}: {
  tags: SampleTag[];
  notSelected: Set<string>;
  overflowing: Set<string>;
  onToggle: (key: string) => void;
  onSplit: (tag: SampleTag) => void;
  onSelectAll: (all: boolean) => void;
}) {
  return (
    <section aria-labelledby="tag-list-heading">
      <h2 id="tag-list-heading">Tags</h2>
      <div className="row-actions">
        <button type="button" onClick={() => onSelectAll(true)}>
          Select all
        </button>
        <button type="button" onClick={() => onSelectAll(false)}>
          Select none
        </button>
      </div>
      <ul className="tag-list">
        {tags.map((tag) => {
          const id = `tag-${tag.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
          return (
            <li key={tag.key} className="tag-list-item">
              <input
                id={id}
                type="checkbox"
                checked={!notSelected.has(tag.key)}
                onChange={() => onToggle(tag.key)}
              />
              <label htmlFor={id}>
                <strong>
                  {tag.sampleLabel} · {tag.depth}
                </strong>{' '}
                {tag.source.label} · Line {tag.lineNumbers.join(', ')}
                <span className="tag-list-tests">
                  {tag.tests.map((test) => (
                    <span key={test.requestId}>
                      {test.name}{' '}
                      <StatusBadge tone="info">
                        {TEST_REQUEST_STATUS_LABEL[test.status]}
                      </StatusBadge>
                    </span>
                  ))}
                </span>
              </label>
              {overflowing.has(tag.key) ? (
                <StatusBadge tone="warning">Text doesn’t fit</StatusBadge>
              ) : null}
              {tag.tests.length > 1 ? (
                <button type="button" onClick={() => onSplit(tag)}>
                  Split into {tag.tests.length} tags
                </button>
              ) : null}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/** Tests that get no tag, listed so nothing is silently dropped. */
function UntaggedNotes({ sheet }: { sheet: SampleTagSheet }) {
  if (sheet.noTagTests.length === 0 && sheet.untaggedLines.length === 0) return null;
  return (
    <details className="tag-untagged">
      <summary>
        Not tagged: {sheet.noTagTests.length + sheet.untaggedLines.length} item
        {sheet.noTagTests.length + sheet.untaggedLines.length === 1 ? '' : 's'}
      </summary>
      {sheet.noTagTests.length > 0 ? (
        <>
          <h3>No tag needed (catalogue setting)</h3>
          <ul>
            {sheet.noTagTests.map((item) => (
              <li key={item.test.requestId}>
                Line {item.lineNumber} · {item.sampleLabel} · {item.depth}: {item.test.name}
              </li>
            ))}
          </ul>
        </>
      ) : null}
      {sheet.untaggedLines.length > 0 ? (
        <>
          <h3>No individual sample</h3>
          <p className="field-hint">
            {LINE_SCOPE_LABEL.all}, grabs and SPT lines name no single sample, so no tag is printed
            for them.
          </p>
          <ul>
            {sheet.untaggedLines.map((item) => (
              <li key={item.lineNumber}>
                Line {item.lineNumber} · {LINE_SCOPE_LABEL[item.scope]} · {item.sourceLabel}:{' '}
                {item.tests.map((test) => test.name).join(', ')}
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </details>
  );
}
