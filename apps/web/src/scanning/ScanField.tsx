import { ScanLine } from 'lucide-react';
import { useId, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { InputGroup, InputGroupAddon, InputGroupInput } from '@/components/ui/input-group';
import type { Scanner } from './useScanner';

/**
 * The Strata scan field (round 3 Move, STRATA-80): one field that takes scanner reads and typed
 * IDs (Enter after each), with the useScanner behaviour of the MM-T16 panel. When focus leaves it
 * the field says so and offers Resume scanning, so a scan is never silently typed elsewhere.
 * Results are announced by the page's own live region, not here.
 */
export function ScanField({
  scanner,
  label = 'Scan or type a label',
  placeholder = 'Shelf or storage unit label',
  description = 'Labels in any order. Typed IDs work like scans: press Enter after each.',
  disabled = false,
  children,
}: {
  scanner: Scanner;
  label?: string;
  placeholder?: string;
  description?: ReactNode;
  disabled?: boolean;
  /** Extra controls under the field (Scan with camera). */
  children?: ReactNode;
}) {
  const id = useId();
  const paused = scanner.paused && !disabled;
  return (
    <div className="grid gap-2" {...scanner.containerProps}>
      <Field className="gap-1.5" data-disabled={disabled ? true : undefined}>
        <FieldLabel htmlFor={id}>{label}</FieldLabel>
        <InputGroup className="h-11">
          <InputGroupAddon>
            <ScanLine aria-hidden="true" />
          </InputGroupAddon>
          <InputGroupInput
            id={id}
            type="text"
            className="font-mono"
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="characters"
            spellCheck={false}
            enterKeyHint="go"
            placeholder={placeholder}
            disabled={disabled}
            aria-describedby={`${id}-hint`}
            {...scanner.inputProps}
          />
        </InputGroup>
        <FieldDescription id={`${id}-hint`}>
          {paused ? 'Scanning paused: the field isn’t focused.' : description}
        </FieldDescription>
      </Field>
      {paused ? (
        <div>
          <Button
            className="pointer-coarse:h-11"
            type="button"
            variant="outline"
            size="sm"
            onClick={scanner.resume}
          >
            <ScanLine aria-hidden="true" />
            Resume scanning
          </Button>
        </div>
      ) : null}
      {children}
    </div>
  );
}
