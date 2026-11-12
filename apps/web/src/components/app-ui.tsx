import { useEffect, useId, useRef, type HTMLAttributes, type ReactNode } from 'react';
import { usePageTitle } from '../layout/page-title';
import { useMediaQuery } from './useMediaQuery';
import { PHONE_QUERY, type TableView } from './useTableView';

export type { TableView } from './useTableView';

// Shared building blocks (MM-T34) in the Field Ledger design (docs/redesign/design.md,
// "Components"). Keep them plain and accessible; colours come only from the styles.css tokens.

export function PageHeader({
  title,
  actions,
  documentTitle = true,
}: {
  title: string;
  actions?: ReactNode;
  /** MTR-134: names the browser tab after this heading. Layouts whose pages name it set false. */
  documentTitle?: boolean;
}) {
  usePageTitle(documentTitle ? title : null);
  return (
    <div className="page-header">
      <h1>{title}</h1>
      {actions ? <div className="page-actions">{actions}</div> : null}
    </div>
  );
}

/**
 * Card with a header band (MM-T55): heading, optional subtitle, and meta text, badges or actions on
 * the right. The section is named by its heading. `tone="attention"` adds the amber edge for
 * handover, offline and pending cards; the heading must still say why.
 */
export function BandedCard({
  title,
  subtitle,
  aside,
  tone = 'default',
  as: Tag = 'section',
  id,
  className,
  headingLevel = 2,
  headingId: fixedHeadingId,
  focusableHeading = false,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  /** Right side of the band: meta text, status badges or buttons. */
  aside?: ReactNode;
  tone?: 'default' | 'attention';
  as?: 'section' | 'div';
  id?: string;
  className?: string;
  /** h3 for cards nested under a section's h2 (e.g. each storage unit in the wizard). */
  headingLevel?: 2 | 3;
  /** Fixed heading id, e.g. so an error summary or "Edit" link can move focus to it. */
  headingId?: string;
  /** Let script move focus to the heading (tabIndex -1). */
  focusableHeading?: boolean;
  children?: ReactNode;
}) {
  const generatedId = useId();
  const headingId = fixedHeadingId ?? generatedId;
  const Heading = headingLevel === 3 ? 'h3' : 'h2';
  const classes = ['banded-card', tone === 'attention' ? 'banded-card-attention' : null, className]
    .filter(Boolean)
    .join(' ');
  return (
    <Tag
      id={id}
      className={classes}
      aria-labelledby={headingId}
      role={Tag === 'div' ? 'group' : undefined}
    >
      <div className="banded-card-head">
        <div className="banded-card-titles">
          <Heading
            id={headingId}
            className="banded-card-title"
            tabIndex={focusableHeading ? -1 : undefined}
          >
            {title}
          </Heading>
          {subtitle ? <p className="banded-card-subtitle">{subtitle}</p> : null}
        </div>
        {aside ? <div className="banded-card-aside">{aside}</div> : null}
      </div>
      {children ? <div className="banded-card-body">{children}</div> : null}
    </Tag>
  );
}

/**
 * Status tag tones. The Field Ledger names (storage, lab, waiting, danger, closed, flag) and the
 * older names share the five fills: success = storage, info = lab, warning = waiting,
 * neutral = closed. `flag` is the in-progress / due fill (ink text on flag).
 */
export type BadgeTone =
  | 'neutral'
  | 'info'
  | 'success'
  | 'warning'
  | 'danger'
  | 'storage'
  | 'lab'
  | 'waiting'
  | 'closed'
  | 'flag';

/** Status shown as text, with colour only as a supplement. */
export function StatusBadge({
  tone = 'neutral',
  children,
}: {
  tone?: BadgeTone;
  children: ReactNode;
}) {
  return <span className={`badge badge-${tone}`}>{children}</span>;
}

/**
 * Empty: a dashed frame. Children alone keep the one-line form; with `title` it is one bold
 * sentence, one line of explanation and at most one action (nothing to do; no matches, with
 * Clear filters; or first use, with the action that creates the first record).
 */
export function EmptyState({
  title,
  action,
  children,
}: {
  title?: ReactNode;
  action?: ReactNode;
  children?: ReactNode;
}) {
  if (!title && !action) return <p className="empty-state">{children}</p>;
  return (
    <div className="empty-state">
      {title ? <p className="empty-state-title">{title}</p> : null}
      {children ? <p>{children}</p> : null}
      {action ?? null}
    </div>
  );
}

/**
 * Error: a solid frame with an optional status tag, a bold sentence saying what happened, an
 * optional line on what was kept or not saved, and one way forward. Never server values,
 * stack traces or codes.
 */
export function ErrorState({
  message,
  detail,
  tag,
  onRetry,
  retryLabel = 'Retry',
}: {
  message: string;
  detail?: ReactNode;
  tag?: string;
  onRetry?: () => void;
  retryLabel?: string;
}) {
  return (
    <div className="error-state" role="alert">
      {tag ? <StatusBadge tone="danger">{tag}</StatusBadge> : null}
      <p className={detail || tag ? 'error-state-title' : undefined}>{message}</p>
      {detail ? <p>{detail}</p> : null}
      {onRetry ? (
        <button type="button" className="primary" onClick={onRetry}>
          {retryLabel}
        </button>
      ) : null}
    </div>
  );
}

/** A notice strip. `danger` is an alert; the other tones are polite status messages. */
export function Notice({
  tone = 'neutral',
  children,
  className,
}: {
  tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger';
  children: ReactNode;
  className?: string;
}) {
  const classes = ['notice', tone === 'neutral' ? null : `notice-${tone}`, className]
    .filter(Boolean)
    .join(' ');
  return (
    <div className={classes} role={tone === 'danger' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

/** Section heading over a 2 px ink rule, with optional mono meta (e.g. "5 ITEMS") at the right. */
export function SectionHead({
  title,
  meta,
  level = 2,
  id,
}: {
  title: ReactNode;
  meta?: ReactNode;
  level?: 2 | 3;
  id?: string;
}) {
  const Heading = level === 3 ? 'h3' : 'h2';
  return (
    <div className="section-head">
      <Heading id={id}>{title}</Heading>
      {meta ? <span className="section-meta">{meta}</span> : null}
    </div>
  );
}

/** Side panel: 2 px frame with a rail-coloured head ("On confirm", "Disposal list"). */
export function SidePanel({
  title,
  aside,
  children,
  className,
}: {
  title: ReactNode;
  aside?: ReactNode;
  children?: ReactNode;
  className?: string;
}) {
  const headingId = useId();
  return (
    <section
      className={className ? `side-panel ${className}` : 'side-panel'}
      aria-labelledby={headingId}
    >
      <div className="side-panel-head">
        <h2 id={headingId}>{title}</h2>
        {aside ?? null}
      </div>
      {children ? <div className="side-panel-body">{children}</div> : null}
    </section>
  );
}

/** Segmented filter: buttons joined in one frame; the active one is ink-filled (aria-pressed). */
export function Segmented<Value extends string>({
  label,
  options,
  value,
  onChange,
  className,
}: {
  label: string;
  options: readonly { value: Value; label: ReactNode }[];
  value: Value;
  onChange: (value: Value) => void;
  className?: string;
}) {
  return (
    <div
      className={className ? `segmented ${className}` : 'segmented'}
      role="group"
      aria-label={label}
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
        >
          {option.label}
        </button>
      ))}
    </div>
  );
}

/** Selection: the ink action bar shown above a table while rows are selected. */
export function SelectionBar({ count, children }: { count: number; children?: ReactNode }) {
  return (
    <div className="selection-bar" role="group" aria-label="Selection">
      <span className="selection-bar-count">{count} selected</span>
      {children}
    </div>
  );
}

export type CountedCellState = 'done' | 'current' | 'empty';

/**
 * Counted cells (progress, shelf fill): one bordered cell per real thing. Ink = done or
 * occupied, flag = in progress or due, sheet = empty. Always carries an accessible label and,
 * when `count` is given, the count in text beside the cells.
 */
export function CountedCells({
  cells,
  label,
  count,
}: {
  cells: readonly CountedCellState[];
  /** e.g. "Progress: 4 done, 1 in progress, 3 not started". */
  label: string;
  /** Visible count text, e.g. "4 / 8". */
  count?: ReactNode;
}) {
  return (
    <span className="counted-cells">
      <span className="counted-cells-row" role="img" aria-label={label}>
        {cells.map((state, index) => (
          <span key={index} className={`counted-cell counted-cell-${state}`} />
        ))}
      </span>
      {count != null ? (
        <span className="counted-cells-count" aria-hidden="true">
          {count}
        </span>
      ) : null}
    </span>
  );
}

/**
 * Unit label block: ink head strip (holder type, project), the ID in mono 30, then one mono line
 * per test hole (hole, then samples and depth range as text, never a bar). Only for issued
 * storage units: drafts have no ID. A disposed unit keeps its label, drawn grey (`closed`).
 */
export function UnitLabel({
  holder,
  project,
  unitId,
  lines = [],
  closed = false,
  headingLevel,
}: {
  holder: ReactNode;
  project?: ReactNode;
  unitId: string;
  lines?: readonly { hole: ReactNode; summary?: ReactNode }[];
  closed?: boolean;
  /** Render the ID as a heading (e.g. 1 on the unit page); otherwise plain text. */
  headingLevel?: 1 | 2 | 3;
}) {
  const Id = headingLevel ? (`h${headingLevel}` as const) : 'div';
  return (
    <div className={closed ? 'unit-label unit-label-closed' : 'unit-label'}>
      <div className="unit-label-head">
        <span className="unit-label-holder">{holder}</span>
        {project ? <span className="unit-label-project">{project}</span> : null}
      </div>
      <div className="unit-label-body">
        <Id className="unit-label-id">{unitId}</Id>
        {lines.map((line, index) => (
          <div key={index} className="unit-label-line">
            <span>{line.hole}</span>
            {line.summary ? <span>{line.summary}</span> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * The view selector at the right of a table's filter or title row: three thick lines =
 * comfortable, five thin lines = compact. Not shown on phones, which always use comfortable.
 */
export function TableViewSelector({
  value,
  onChange,
}: {
  value: TableView;
  onChange: (view: TableView) => void;
}) {
  const phone = useMediaQuery(PHONE_QUERY);
  if (phone) return null;
  return (
    <div className="segmented table-view" role="group" aria-label="Table view">
      <button
        type="button"
        aria-label="Comfortable rows"
        title="Comfortable rows"
        aria-pressed={value === 'comfortable'}
        onClick={() => onChange('comfortable')}
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2.5" />
        </svg>
      </button>
      <button
        type="button"
        aria-label="Compact rows"
        title="Compact rows"
        aria-pressed={value === 'compact'}
        onClick={() => onChange('compact')}
      >
        <svg aria-hidden="true" width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path
            d="M3 4h14M3 7h14M3 10h14M3 13h14M3 16h14"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
      </button>
    </div>
  );
}

export interface Column<Row> {
  header: string;
  cell: (row: Row) => ReactNode;
}

/** Table on wide screens; each row stacks into a labelled card at phone width (CSS). */
export function DataTable<Row>({
  rows,
  columns,
  rowKey,
  caption,
  empty,
  view = 'comfortable',
}: {
  rows: Row[];
  columns: Column<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
  empty: ReactNode;
  /** From useTableView; pair with a TableViewSelector in the table's title or filter row. */
  view?: TableView;
}) {
  if (rows.length === 0) {
    return <EmptyState>{empty}</EmptyState>;
  }
  return (
    <table className={view === 'compact' ? 'data-table is-compact' : 'data-table'}>
      <caption className="visually-hidden">{caption}</caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th key={column.header} scope="col">
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row) => (
          <tr key={rowKey(row)}>
            {columns.map((column) => (
              <td key={column.header} data-label={column.header}>
                {column.cell(row)}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * A wide table scrolls sideways inside this box instead of widening or clipping the page
 * (MTR-58, MTR-93). It is a labelled, focusable region so keyboard users can scroll it too.
 */
export function TableScroll({
  label,
  className,
  children,
  ...rest
}: {
  label: string;
  className?: string;
  children: ReactNode;
} & Omit<HTMLAttributes<HTMLDivElement>, 'className' | 'children' | 'role' | 'tabIndex'>) {
  return (
    <div
      {...rest}
      className={className ? `table-scroll ${className}` : 'table-scroll'}
      role="region"
      aria-label={label}
      tabIndex={0}
    >
      {children}
    </div>
  );
}

/** Label, input and error text wired together with aria attributes. */
/**
 * Visible "(required)" after a label (MTR-133). Hidden from screen readers, which hear the
 * input's own required state instead, so the field's name stays the label text.
 */
export function RequiredMarker() {
  return (
    <span className="required-marker" aria-hidden="true">
      {' '}
      (required)
    </span>
  );
}

export function FormField({
  id: fixedId,
  label,
  error,
  hint,
  required = false,
  children,
}: {
  /** Fixed id for the input, e.g. so an error summary can link to it. */
  id?: string;
  label: string;
  error?: string | null;
  hint?: string;
  /** Shows the "(required)" marker; the input itself still sets `required`. */
  required?: boolean;
  children: (props: {
    id: string;
    'aria-invalid': boolean;
    'aria-describedby'?: string;
  }) => ReactNode;
}) {
  const generatedId = useId();
  const id = fixedId ?? generatedId;
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(' ');
  return (
    <div className="form-field">
      <label htmlFor={id}>
        {label}
        {required ? <RequiredMarker /> : null}
      </label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy || undefined,
      })}
      {hint ? (
        <p id={`${id}-hint`} className="field-hint">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** Modal confirmation using the native <dialog> element (focus trapping and Escape for free). */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel,
  danger = false,
  onConfirm,
  onCancel,
  cancelOnBackdrop = false,
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Destructive action (discard, disable): the confirm button is red instead of primary. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
  /** A click outside the box cancels it, the same as Escape (MISC-03). */
  cancelOnBackdrop?: boolean;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal?.();
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  return (
    <dialog
      ref={ref}
      className="confirm-dialog"
      onCancel={onCancel}
      onClick={
        cancelOnBackdrop
          ? (event) => {
              // A click on the backdrop targets the dialog itself, outside its box.
              const dialog = event.currentTarget;
              if (event.target !== dialog) return;
              const box = dialog.getBoundingClientRect();
              const inside =
                event.clientX >= box.left &&
                event.clientX <= box.right &&
                event.clientY >= box.top &&
                event.clientY <= box.bottom;
              if (!inside) onCancel();
            }
          : undefined
      }
      aria-labelledby={titleId}
    >
      <div className="dialog-head">
        <h2 id={titleId}>{title}</h2>
      </div>
      <div className="dialog-body">{children}</div>
      <div className="dialog-actions">
        <button type="button" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className={danger ? 'danger' : 'primary'} onClick={onConfirm}>
          {confirmLabel}
        </button>
      </div>
    </dialog>
  );
}
