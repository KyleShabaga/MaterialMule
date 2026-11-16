import { CircleAlert, CircleDashed, Lock, RefreshCw } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { PeekSplit, PeekToolbar, usePeekAvailable } from '../../components/strata/peek';

// Shared parts of the Strata admin panels in the Settings modal (STRATA-102: Printers, System
// status, Equipment, Suppliers, Holidays, Report header). shadcn components only; 44 px targets on
// touch screens only (Kyle: desktop and LAB stations are mouse and keyboard).

/** Touch-only 44 px height for a small control. */
export const TOUCH = 'pointer-coarse:h-11';

/** Status tones: the Lifecycle colours (DESIGN.md), each a badge variant with its dot. */
export type Tone = 'draft' | 'storage' | 'lab' | 'due' | 'danger' | 'closed';

const MARK: Record<Tone, string> = {
  draft: 'bg-stage-draft-mark',
  lab: 'bg-stage-lab-mark',
  storage: 'bg-stage-storage-mark',
  due: 'bg-stage-due-mark',
  danger: 'bg-stage-danger-mark',
  closed: 'bg-stage-closed-mark',
};

/** A status badge with its stage dot (DESIGN.md › Lifecycle colours). */
export function StateBadge({ tone, children }: { tone: Tone; children: ReactNode }) {
  return (
    <Badge variant={tone}>
      <span aria-hidden="true" className={cn('size-1.5 rounded-full', MARK[tone])} />
      {children}
    </Badge>
  );
}

/** Loading: a short sentence for screen readers and a skeleton of the rows. */
export function PanelLoading({ label }: { label: string }) {
  return (
    <div aria-busy="true" className="grid gap-3">
      <p className="text-sm text-muted-foreground">{label}</p>
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-full" />
      <Skeleton className="h-10 w-2/3" />
    </div>
  );
}

/** Couldn't load: the reason and Try again. */
export function PanelError({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{message}</AlertTitle>
      {onRetry ? (
        <AlertDescription>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn('mt-2', TOUCH)}
            onClick={onRetry}
          >
            <RefreshCw aria-hidden="true" />
            Try again
          </Button>
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/** A form's refusal or failure, read out when it appears. */
export function FormMessage({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle>{message}</AlertTitle>
    </Alert>
  );
}

/** Why the controls are missing: everyone may read; only some people change it. */
export function ReadOnlyNote({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-start gap-2 text-sm text-muted-foreground">
      <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/** A gate the owner hasn't decided (G8, report templates): said, never filled in. */
export function OpenItem({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Alert role="note">
      <CircleDashed aria-hidden="true" />
      <AlertTitle>
        <span className="text-muted-foreground">Open item · </span>
        {title}
      </AlertTitle>
      <AlertDescription>{children}</AlertDescription>
    </Alert>
  );
}

function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-destructive-text">
      *
    </span>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  hint?: ReactNode;
  required?: boolean;
  disabled?: boolean;
  maxLength?: number;
  className?: string;
}

/** A labelled text (or date, number) input with its hint and error. */
export function TextField({
  label,
  value,
  onChange,
  error,
  hint,
  required = false,
  disabled,
  maxLength,
  className,
  type = 'text',
  min,
  max,
  mono = false,
}: FieldProps & {
  type?: 'text' | 'date' | 'number';
  min?: string | number;
  max?: string | number;
  mono?: boolean;
}) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
      </FieldLabel>
      <Input
        id={id}
        type={type}
        value={value}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        min={min}
        max={max}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(event.target.value)}
        className={cn('h-9', TOUCH, mono && 'font-mono')}
      />
      {hint ? <FieldDescription id={hintId}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}

/** A labelled textarea with its hint and error. */
export function TextAreaField({
  label,
  value,
  onChange,
  error,
  hint,
  required = false,
  disabled,
  maxLength,
  className,
  rows = 3,
}: FieldProps & { rows?: number }) {
  const id = useId();
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  return (
    <Field data-invalid={error ? true : undefined} className={className}>
      <FieldLabel htmlFor={id}>
        {label}
        {required ? <RequiredMark /> : null}
      </FieldLabel>
      <Textarea
        id={id}
        rows={rows}
        value={value}
        required={required}
        disabled={disabled}
        maxLength={maxLength}
        aria-invalid={error ? true : undefined}
        aria-describedby={[hintId, errorId].filter(Boolean).join(' ') || undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {hint ? <FieldDescription id={hintId}>{hint}</FieldDescription> : null}
      {error ? <FieldError id={errorId}>{error}</FieldError> : null}
    </Field>
  );
}

/** The buttons at the foot of a form. */
export function FormActions({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-center gap-2">{children}</div>;
}

/**
 * A list and, when a record is open, its drawer: beside the list (Inbox's PeekSplit, 46 %) from
 * 1024 px up, below it on narrower screens. The open record is component state, not a URL
 * parameter: inside the Settings modal a pushed history entry would make Close step back through
 * the records instead of closing the modal.
 */
export function RecordSplit({
  list,
  drawer,
  openId,
  titleId,
  onClose,
  listLabel,
}: {
  list: ReactNode;
  /** The open record's contents (without the toolbar); null when closed. */
  drawer: ReactNode | null;
  openId: string | null;
  /** The drawer title's id, which names the drawer region. */
  titleId: string;
  onClose: () => void;
  listLabel: string;
}) {
  const beside = usePeekAvailable();
  const open = drawer !== null && openId !== null;
  const contents = open ? (
    <>
      <PeekToolbar onClose={onClose} />
      <div className="grid gap-6 p-5">{drawer}</div>
    </>
  ) : null;
  if (beside) {
    return (
      <PeekSplit
        className="min-h-[28rem] rounded-lg border"
        list={list}
        drawer={contents}
        open={open}
        openId={openId}
        defaultSize="46%"
        minSize="36%"
        maxSize="65%"
        drawerLabelledBy={titleId}
        listLabel={listLabel}
      />
    );
  }
  return (
    <div className="grid gap-4">
      <div>{list}</div>
      {open ? (
        <div
          role="region"
          aria-labelledby={titleId}
          data-slot="record-drawer"
          className="rounded-lg border"
        >
          {contents}
        </div>
      ) : null}
    </div>
  );
}

/** The heading block at the top of a drawer. */
export function DrawerHead({
  titleId,
  eyebrow,
  title,
  aside,
}: {
  titleId: string;
  eyebrow?: ReactNode;
  title: ReactNode;
  aside?: ReactNode;
}) {
  return (
    <div className="flex items-start justify-between gap-3">
      <div className="grid min-w-0 gap-0.5">
        {eyebrow ? <p className="font-mono text-[13px] text-muted-foreground">{eyebrow}</p> : null}
        <h3 id={titleId} className="text-lg font-semibold tracking-tight">
          {title}
        </h3>
      </div>
      {aside ? <div className="flex shrink-0 flex-wrap items-center gap-1.5">{aside}</div> : null}
    </div>
  );
}

/** A count over a table ("3 printers"). */
export function CountLine({ children }: { children: ReactNode }) {
  return <p className="text-sm text-muted-foreground">{children}</p>;
}
