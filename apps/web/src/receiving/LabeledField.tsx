import { CircleAlert } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { cn } from '@/lib/utils';

/** Classes for a native <select> styled like shadcn's Input (kept native for its keyboard). */
export const NATIVE_SELECT_CLASS =
  'border-input bg-card dark:bg-input/30 h-11 w-full min-w-0 rounded-md border px-3 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20';

/** An inline field error: destructive text with an icon (DESIGN.md › Fields). */
export function FieldErrorText({ id, children }: { id?: string; children: ReactNode }) {
  return (
    <p id={id} className="text-destructive-text m-0 flex items-start gap-1.5 text-[13px]">
      <CircleAlert aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * A small set of exclusive choices (ft / m, core runs, sampling source) as a shadcn RadioGroup
 * laid out in a row. `id` is the group's, so an error summary link focuses its first choice.
 */
export function ChoiceGroup<T extends string>({
  id,
  label,
  options,
  value,
  onChange,
  error,
  hint,
  required = false,
  hideLabel = false,
}: {
  id: string;
  label: string;
  options: readonly { value: T; label: string }[];
  /** '' while nothing is chosen. */
  value: T | '';
  onChange: (value: T) => void;
  error?: string | null;
  hint?: string;
  required?: boolean;
  hideLabel?: boolean;
}) {
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span
        id={`${id}-label`}
        className={hideLabel ? 'sr-only' : 'text-[13px] leading-none font-semibold'}
      >
        {label}
      </span>
      <RadioGroup
        id={id}
        value={value}
        onValueChange={(next) => onChange(next as T)}
        aria-labelledby={`${id}-label`}
        aria-required={required || undefined}
        aria-invalid={Boolean(error) || undefined}
        aria-describedby={describedBy}
        className="flex min-h-11 flex-wrap items-center gap-x-4 gap-y-2"
      >
        {options.map((option) => (
          <div key={option.value} className="flex items-center gap-2">
            <RadioGroupItem id={`${id}-${option.value}`} value={option.value} />
            <Label htmlFor={`${id}-${option.value}`} className="font-normal">
              {option.label}
            </Label>
          </div>
        ))}
      </RadioGroup>
      {error ? (
        <FieldErrorText id={`${id}-error`}>{error}</FieldErrorText>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground m-0 text-[13px]">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * Label above, control, hint and error below, with `aria-invalid` and `aria-describedby` wired
 * (the receiving fields' FormField, in Strata styling). The control gets its props from the
 * render function so the label and the error links reach it by id.
 */
export function LabeledField({
  id: fixedId,
  label,
  hideLabel = false,
  error,
  hint,
  className,
  children,
}: {
  /** Fixed id for the control, so an error summary can link to it. */
  id?: string;
  label: string;
  /** The label stays for assistive technology only (a row's column header names it). */
  hideLabel?: boolean;
  error?: string | null;
  hint?: string;
  className?: string;
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
    <div className={cn('flex min-w-0 flex-col gap-1.5', className)}>
      <Label htmlFor={id} className={hideLabel ? 'sr-only' : 'text-[13px] font-semibold'}>
        {label}
      </Label>
      {children({
        id,
        'aria-invalid': Boolean(error),
        'aria-describedby': describedBy || undefined,
      })}
      {hint ? (
        <p id={`${id}-hint`} className="text-muted-foreground m-0 text-[13px]">
          {hint}
        </p>
      ) : null}
      {error ? <FieldErrorText id={`${id}-error`}>{error}</FieldErrorText> : null}
    </div>
  );
}
