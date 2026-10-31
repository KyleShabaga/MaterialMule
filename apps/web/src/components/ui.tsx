import { useEffect, useId, useRef, type ReactNode } from 'react';
import { usePageTitle } from '../layout/page-title';

// Small shared building blocks for later screens (MM-T34). Keep them plain and accessible.

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

export type BadgeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

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

export function EmptyState({ children }: { children: ReactNode }) {
  return <p className="empty-state">{children}</p>;
}

export function ErrorState({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div className="error-state" role="alert">
      <p>{message}</p>
      {onRetry ? (
        <button type="button" onClick={onRetry}>
          Retry
        </button>
      ) : null}
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
}: {
  rows: Row[];
  columns: Column<Row>[];
  rowKey: (row: Row) => string;
  caption: string;
  empty: ReactNode;
}) {
  if (rows.length === 0) {
    return <EmptyState>{empty}</EmptyState>;
  }
  return (
    <table className="data-table">
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
}: {
  open: boolean;
  title: string;
  children: ReactNode;
  confirmLabel: string;
  /** Destructive action (discard, disable): the confirm button is red instead of primary. */
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
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
    <dialog ref={ref} className="confirm-dialog" onCancel={onCancel} aria-labelledby={titleId}>
      <h2 id={titleId}>{title}</h2>
      <div>{children}</div>
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
