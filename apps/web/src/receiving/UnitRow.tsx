import type { ReactNode } from 'react';
import {
  UNIT_PREFIX,
  UNIT_TYPE_LABEL,
  unitContentLines,
  unitName,
  type ReceiptDraft,
  type UnitDraft,
} from './draft';

/**
 * One storage unit of a delivery (Field Ledger "Receive"): the holder prefix block, one samples
 * summary line per test hole (depth written as text, never drawn), and where it will go. No ID:
 * IDs are issued only when the delivery is confirmed. The editor opens under the row.
 */
export function UnitRow({
  unit,
  index,
  draft,
  open,
  canClose,
  onToggle,
  onDuplicate,
  onRemove,
  children,
}: {
  unit: UnitDraft;
  index: number;
  draft: Pick<ReceiptDraft, 'units'>;
  open: boolean;
  /** False while the unit has problems to fix: it stays open so the error links reach them. */
  canClose: boolean;
  onToggle: () => void;
  onDuplicate: () => void;
  onRemove: () => void;
  /** The unit's editor, shown while open. */
  children: ReactNode;
}) {
  const name = unitName(index, unit);
  const headingId = `unit-${unit.clientRowId}-heading`;
  const lines = unitContentLines(draft, unit);
  const target = (unit.targetLocation ?? '').trim();
  const holder =
    unit.unitType === 'bucket' && unit.bulk ? 'Bulk soil' : UNIT_TYPE_LABEL[unit.unitType];
  return (
    <section
      id={`unit-${unit.clientRowId}`}
      className={open ? 'receive-unit is-open' : 'receive-unit'}
      aria-labelledby={headingId}
    >
      <div className="receive-unit-row">
        <div className="receive-unit-prefix" aria-hidden="true">
          <span className="receive-unit-prefix-code">{UNIT_PREFIX[unit.unitType]}</span>
          <span className="receive-unit-prefix-type">{holder}</span>
        </div>
        <div className="receive-unit-main">
          <h3 id={headingId} tabIndex={-1} className="receive-unit-name">
            {name}
          </h3>
          <ul className="receive-unit-lines" aria-label={`${name} contents`}>
            {lines.map((line, lineIndex) => (
              <li key={`${line.hole}-${lineIndex}`}>
                <span className="receive-unit-hole">{line.hole}</span>
                <span className="receive-unit-summary">{line.text}</span>
              </li>
            ))}
          </ul>
          <p className="receive-unit-target">
            {target ? `Goes to ${target}` : 'Shelf decided when it is put away'}
          </p>
        </div>
        <div className="receive-unit-actions">
          {open && !canClose ? null : (
            <button
              type="button"
              aria-expanded={open}
              aria-controls={open ? `unit-${unit.clientRowId}-editor` : undefined}
              aria-label={open ? `Done with ${name}` : `Edit ${name}`}
              onClick={onToggle}
            >
              {open ? 'Done' : 'Edit'}
            </button>
          )}
          <button type="button" onClick={onDuplicate} aria-label={`Duplicate ${name}`}>
            Duplicate
          </button>
          <button type="button" className="danger" onClick={onRemove} aria-label={`Remove ${name}`}>
            Remove
          </button>
        </div>
      </div>
      {open ? (
        <div id={`unit-${unit.clientRowId}-editor`} className="receive-unit-body">
          {children}
        </div>
      ) : null}
    </section>
  );
}
