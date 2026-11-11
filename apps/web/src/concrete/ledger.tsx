import type { ReactNode } from 'react';
import './ledger.css';

// Field Ledger pieces shared by the concrete screens (docs/redesign/design.md, "Concrete (V2)" and
// "Concrete pages"). Concrete never uses storage-unit IDs, receipts or label blocks: a specimen is
// its set's ID in mono followed by its letter in a small ink square.

/**
 * Specimen identity: the set ID in mono, then the letter in an ink square (`26-03` + `A`). The
 * accessible text reads as one ID ("26-03A"), the way it is typed and searched.
 */
export function SpecimenId({
  set,
  letter,
  className,
}: {
  /** The set's readable name (permanent ID, temporary ID or "Unnumbered set"). */
  set: ReactNode;
  letter?: string | null;
  className?: string;
}) {
  return (
    <span className={className ? `specimen-id ${className}` : 'specimen-id'}>
      <span className="specimen-id-set">{set}</span>
      {letter ? <span className="specimen-letter">{letter}</span> : null}
    </span>
  );
}

/** Tone of one view tile, one fact cell or one specimen letter cell. */
export type LedgerTone = 'default' | 'flag' | 'danger' | 'waiting' | 'storage' | 'lab' | 'closed';

/**
 * Facts as a row of bordered cells (mono caps label, value under it), e.g. a field report's four
 * status dimensions or a strength report's version / workflow / strength / method. Each cell is
 * its own fact: the cells are never merged into one status.
 */
export function FactCells({
  label,
  cells,
  className,
}: {
  /** Accessible name of the group, e.g. "Report status". */
  label: string;
  cells: readonly { label: ReactNode; value: ReactNode; tone?: LedgerTone; key?: string }[];
  className?: string;
}) {
  return (
    <dl className={className ? `fact-cells ${className}` : 'fact-cells'} aria-label={label}>
      {cells.map((cell, index) => (
        <div
          key={cell.key ?? index}
          className={`fact-cell${cell.tone && cell.tone !== 'default' ? ` fact-cell-${cell.tone}` : ''}`}
        >
          <dt>{cell.label}</dt>
          <dd>{cell.value}</dd>
        </div>
      ))}
    </dl>
  );
}

/**
 * A set's specimens as lettered cells coloured by state (tested, due, waiting, on hold). Each
 * cell carries its state in its accessible name and title, never colour alone.
 */
export function LetterCells({
  label,
  cells,
}: {
  label: string;
  cells: readonly { letter: string; state: string; tone?: LedgerTone }[];
}) {
  return (
    <span className="letter-cells" role="list" aria-label={label}>
      {cells.map((cell) => (
        <span
          key={cell.letter}
          role="listitem"
          className={`letter-cell${cell.tone && cell.tone !== 'default' ? ` letter-cell-${cell.tone}` : ''}`}
          title={`${cell.letter}: ${cell.state}`}
          aria-label={`${cell.letter}: ${cell.state}`}
        >
          {cell.letter}
        </span>
      ))}
    </span>
  );
}

/**
 * Big-count tile (Breaks views, dashboard counts): the count in sans 800 and the label in mono
 * caps. Render inside a `.view-tiles` container; the caller supplies the element (a link, a
 * button with aria-pressed, or a tab) through `as`.
 */
export function TileBody({ count, label }: { count: ReactNode; label: ReactNode }) {
  return (
    <>
      <span className="view-tile-count">{count}</span>
      <span className="view-tile-label">{label}</span>
    </>
  );
}
