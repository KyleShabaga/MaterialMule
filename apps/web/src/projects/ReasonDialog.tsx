import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { useTeamFormOpen } from './team-form-open';

/**
 * An inline decision with a reason (D15) on Team & permissions (STRATA-85, boards R4TeamPending,
 * R4PersonDrawer "grant"): removals, grant endings, declines and withdrawals. The reason is
 * required unless the server's rule makes it optional (`optional`, e.g. accepting a join request
 * or confirming a nomination, MISC-03/MISC-07); the form stays open until one is entered. While it
 * is open, its confirm button is the screen's primary (the project header's turns outline).
 */
export function ReasonForm({
  title,
  confirmLabel,
  optional = false,
  placeholder = 'Say why. It’s kept with the change.',
  busy = false,
  children,
  className,
  onConfirm,
  onCancel,
}: {
  /** The question, e.g. "Decline Jordan Lab?"; also the form's accessible name. */
  title: string;
  confirmLabel: string;
  optional?: boolean;
  placeholder?: string;
  busy?: boolean;
  /** What happens, and any extra fields (e.g. the emergency-suspension choice). */
  children?: ReactNode;
  className?: string;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useTeamFormOpen(true);
  return (
    <form
      aria-label={title}
      className={cn('flex w-full flex-col gap-3 rounded-lg border bg-card p-4', className)}
      onSubmit={(event) => {
        event.preventDefault();
        const text = reason.trim();
        if (!optional && !text) {
          setError('Enter a reason.');
          return;
        }
        onConfirm(text);
      }}
    >
      <p className="text-sm font-semibold">{title}</p>
      {children ? <div className="text-sm text-muted-foreground">{children}</div> : null}
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>{optional ? 'Reason (optional)' : 'Reason (required)'}</FieldLabel>
        <Textarea
          id={id}
          rows={2}
          maxLength={2000}
          value={reason}
          placeholder={placeholder}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? `${id}-error` : undefined}
          onChange={(event) => {
            setReason(event.target.value);
            if (error) setError(null);
          }}
        />
        {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
        {optional ? <FieldDescription>It’s kept with the decision.</FieldDescription> : null}
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" size="sm" disabled={busy}>
          {confirmLabel}
        </Button>
      </div>
    </form>
  );
}
