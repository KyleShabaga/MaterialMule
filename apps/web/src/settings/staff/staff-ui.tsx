import { CircleAlert, Info } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import type { StaffStatus } from '@materialmule/shared';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { STATUS_LABELS, STATUS_VARIANTS } from './format';

// Small shadcn compositions shared by the Staff page, its drawer and the sections below the
// table (STRATA-102). Nothing here uses the old Field Ledger classes.

/** 44 px targets on touch screens only (Kyle: desktop and LAB stations are mouse + keyboard). */
export const TOUCH = 'pointer-coarse:h-11';

/** A drawer or page section heading. */
export function SectionTitle({
  children,
  as: As = 'h3',
  id,
}: {
  children: ReactNode;
  as?: 'h2' | 'h3';
  id?: string;
}) {
  return (
    <As id={id} className={cn('font-semibold tracking-tight', As === 'h2' ? 'text-lg' : 'text-sm')}>
      {children}
    </As>
  );
}

/** The required reason that every role, access and grant change carries (D15, MM-AO03). */
export function ReasonField({
  value,
  onChange,
  error,
  description,
  placeholder,
  label = 'Reason',
}: {
  value: string;
  onChange: (value: string) => void;
  error?: string | null;
  description?: ReactNode;
  placeholder?: string;
  label?: string;
}) {
  const id = useId();
  return (
    <Field data-invalid={error ? true : undefined}>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Textarea
        id={id}
        value={value}
        rows={2}
        maxLength={2000}
        placeholder={placeholder}
        className="min-h-20"
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => onChange(event.target.value)}
      />
      {description ? <FieldDescription>{description}</FieldDescription> : null}
      {error ? <FieldError id={`${id}-error`}>{error}</FieldError> : null}
    </Field>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

/**
 * A labelled shadcn Select. Radix items can't use '' as a value, so '' means "nothing chosen"
 * and shows the placeholder.
 */
export function LabelledSelect({
  label,
  value,
  onValueChange,
  options,
  placeholder,
  description,
  disabled,
}: {
  label: string;
  value: string;
  onValueChange: (value: string) => void;
  options: readonly SelectOption[];
  placeholder?: string;
  description?: ReactNode;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      <Select value={value} onValueChange={onValueChange} disabled={disabled}>
        <SelectTrigger id={id} size="sm" className={cn('w-full', TOUCH)}>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>
              {option.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      {description ? <FieldDescription>{description}</FieldDescription> : null}
    </Field>
  );
}

/** "No changes to save." and similar quiet, inline outcomes. */
export function InlineInfo({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-1.5 text-sm text-muted-foreground">
      <Info aria-hidden="true" className="size-4 shrink-0" />
      {children}
    </p>
  );
}

/** A failure the person can act on, in place. */
export function ErrorAlert({
  title,
  children,
  onRetry,
}: {
  title: string;
  children?: ReactNode;
  onRetry?: () => void;
}) {
  return (
    <Alert variant="destructive">
      <CircleAlert aria-hidden="true" />
      <AlertTitle className="line-clamp-none">{title}</AlertTitle>
      {children || onRetry ? (
        <AlertDescription>
          {children}
          {onRetry ? (
            <Button type="button" variant="outline" size="sm" className={TOUCH} onClick={onRetry}>
              Retry
            </Button>
          ) : null}
        </AlertDescription>
      ) : null}
    </Alert>
  );
}

/**
 * A confirmation that may ask for a reason (revoking a grant, disabling a position rule, the LAB
 * password). With `requireReason`, confirming with an empty reason shows "Enter a reason." and
 * keeps the dialog open.
 */
export function ConfirmReasonDialog({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  requireReason = false,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  requireReason?: boolean;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  return (
    <AlertDialog open={open} onOpenChange={(next) => (next ? undefined : onCancel())}>
      {open ? (
        <ConfirmReasonContent
          title={title}
          description={description}
          confirmLabel={confirmLabel}
          destructive={destructive}
          requireReason={requireReason}
          onConfirm={onConfirm}
        />
      ) : null}
    </AlertDialog>
  );
}

/** Mounted per opening, so the reason starts empty every time. */
function ConfirmReasonContent({
  title,
  description,
  confirmLabel,
  destructive,
  requireReason,
  onConfirm,
}: {
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive: boolean;
  requireReason: boolean;
  onConfirm: (reason: string) => void;
}) {
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{title}</AlertDialogTitle>
        <AlertDialogDescription>{description}</AlertDialogDescription>
      </AlertDialogHeader>
      {requireReason ? (
        <ReasonField
          value={reason}
          error={error}
          onChange={(value) => {
            setReason(value);
            if (value.trim()) setError(null);
          }}
        />
      ) : null}
      <AlertDialogFooter>
        <AlertDialogCancel size="sm" className={TOUCH}>
          Cancel
        </AlertDialogCancel>
        <AlertDialogAction
          size="sm"
          variant={destructive ? 'destructive' : 'default'}
          className={TOUCH}
          onClick={(event) => {
            if (requireReason && !reason.trim()) {
              event.preventDefault();
              setError('Enter a reason.');
              return;
            }
            onConfirm(reason);
          }}
        >
          {confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

export function StaffStatusBadge({ status }: { status: StaffStatus }) {
  return <Badge variant={STATUS_VARIANTS[status]}>{STATUS_LABELS[status]}</Badge>;
}
