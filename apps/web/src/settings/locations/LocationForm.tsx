import {
  LOCATION_AREA_MAX,
  LOCATION_CODE_MESSAGE,
  LOCATION_NAME_MAX,
  SELECTABLE_LOCATION_KINDS,
  locationKindLabel,
  normalizeLocationCode,
  type FieldError as ApiFieldError,
  type SelectableLocationKind,
  type StorageLocation,
  type UpdateLocationRequest,
} from '@materialmule/shared';
import { useId, useState, type FormEvent, type ReactNode } from 'react';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { useFocusFirstInvalid } from '../../components/useFocusFirstInvalid';
import { createLocation, updateLocation, type Failure } from './api';

// Add or edit a location (MM-T37 rules): the code is upper case, 2–20 letters, digits or hyphens;
// it can't change once a label was requested for it, nor on the system (Receiving) location,
// whose kind and area are fixed too. An edit sends only what changed, with the version it was
// based on; a stale version comes back as a conflict for the caller to show.

/** Visible "(required)" after a label (MTR-133); screen readers hear the input's `required`. */
export function RequiredMark() {
  return (
    <span aria-hidden="true" className="font-normal text-muted-foreground">
      (required)
    </span>
  );
}

function fieldError(errors: ApiFieldError[], field: string): string | null {
  return errors.find((error) => error.field === field)?.message ?? null;
}

function describedBy(...ids: (string | null | false)[]): string | undefined {
  const value = ids.filter(Boolean).join(' ');
  return value || undefined;
}

export function LocationForm({
  location,
  submitLabel,
  busyLabel = 'Saving…',
  onSaved,
  onConflict,
  footer,
}: {
  /** Null to add a new location. Give a freshly read location to edit. */
  location: StorageLocation | null;
  submitLabel: string;
  busyLabel?: string;
  onSaved: (location: StorageLocation, message: string) => void;
  onConflict: (current: StorageLocation, message: string) => void;
  /** The footer, given the submit button to place among its own buttons. */
  footer: (submit: ReactNode) => ReactNode;
}) {
  const id = useId();
  const [code, setCode] = useState(location?.code ?? '');
  const [name, setName] = useState(location?.name ?? '');
  const [kind, setKind] = useState<SelectableLocationKind>(
    location && location.kind !== 'receiving_lab' ? location.kind : 'warehouse',
  );
  const [area, setArea] = useState(location?.area ?? '');
  const [errors, setErrors] = useState<ApiFieldError[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const isSystem = location?.isSystem ?? false;
  const codeLocked = Boolean(location?.codeLocked || isSystem);
  const { formRef, focusFirstInvalid } = useFocusFirstInvalid();

  const codeError = fieldError(errors, 'code');
  const nameError = fieldError(errors, 'name');
  const kindError = fieldError(errors, 'kind');
  const areaError = fieldError(errors, 'area');

  function localErrors(): ApiFieldError[] {
    const found: ApiFieldError[] = [];
    if (!/^[A-Z0-9-]{2,20}$/.test(normalizeLocationCode(code))) {
      found.push({ field: 'code', code: 'invalid', message: LOCATION_CODE_MESSAGE });
    }
    if (!name.trim()) found.push({ field: 'name', code: 'required', message: 'Name is required' });
    return found;
  }

  function show(failure: Failure) {
    if (failure.kind === 'invalid') {
      setErrors(failure.errors);
      setError(failure.message);
      focusFirstInvalid();
    } else if (failure.kind === 'failed' && failure.field) {
      setErrors([
        { field: failure.field, code: failure.code ?? 'invalid', message: failure.message },
      ]);
      setError(null);
      focusFirstInvalid();
    } else if (failure.kind === 'conflict') {
      onConflict(failure.current, failure.message);
    } else {
      setError(failure.message);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const found = localErrors();
    setErrors(found);
    setError(null);
    if (found.length > 0) {
      focusFirstInvalid();
      return;
    }
    setBusy(true);
    const values = {
      code: normalizeLocationCode(code),
      name: name.trim(),
      kind,
      area: area.trim() || null,
    };
    let result;
    if (location) {
      const changes: UpdateLocationRequest = { version: location.version };
      if (!codeLocked && values.code !== location.code) changes.code = values.code;
      if (values.name !== location.name) changes.name = values.name;
      if (!isSystem && values.kind !== location.kind) changes.kind = values.kind;
      if (!isSystem && values.area !== location.area) changes.area = values.area;
      result = await updateLocation(location.id, changes);
    } else {
      result = await createLocation(values);
    }
    setBusy(false);
    if (result.ok) {
      onSaved(
        result.data,
        location ? `${result.data.name} was saved.` : `${result.data.name} was added.`,
      );
    } else {
      show(result);
    }
  }

  const codeHint = codeLocked
    ? isSystem
      ? 'The system location’s code can’t change.'
      : 'A label has been printed or queued for this code, so it can’t change.'
    : // MTR-133: the error already gives the rule, so the hint doesn't repeat it.
      `${codeError ? '' : `${LOCATION_CODE_MESSAGE}. `}Printed on the label as LOC-${normalizeLocationCode(code) || 'CODE'}.`;

  return (
    <form ref={formRef} noValidate onSubmit={(event) => void submit(event)} className="grid gap-6">
      <FieldGroup className="gap-5">
        <Field data-invalid={codeError ? true : undefined}>
          <FieldLabel htmlFor={`${id}-code`}>
            Code
            {codeLocked ? null : <RequiredMark />}
          </FieldLabel>
          <Input
            id={`${id}-code`}
            className="font-mono uppercase"
            value={code}
            maxLength={24}
            autoCapitalize="characters"
            autoComplete="off"
            spellCheck={false}
            readOnly={codeLocked}
            required
            aria-invalid={Boolean(codeError)}
            aria-describedby={describedBy(`${id}-code-hint`, codeError && `${id}-code-error`)}
            onChange={(event) => setCode(event.target.value.toUpperCase())}
          />
          <FieldDescription id={`${id}-code-hint`}>{codeHint}</FieldDescription>
          {codeError ? <FieldError id={`${id}-code-error`}>{codeError}</FieldError> : null}
        </Field>
        <Field data-invalid={nameError ? true : undefined}>
          <FieldLabel htmlFor={`${id}-name`}>
            Name
            <RequiredMark />
          </FieldLabel>
          <Input
            id={`${id}-name`}
            value={name}
            maxLength={LOCATION_NAME_MAX}
            required
            aria-invalid={Boolean(nameError)}
            aria-describedby={describedBy(nameError && `${id}-name-error`)}
            onChange={(event) => setName(event.target.value)}
          />
          {nameError ? <FieldError id={`${id}-name-error`}>{nameError}</FieldError> : null}
        </Field>
        {isSystem ? null : (
          <>
            <Field data-invalid={kindError ? true : undefined}>
              <FieldLabel htmlFor={`${id}-kind`}>Kind</FieldLabel>
              <Select
                value={kind}
                onValueChange={(value) => setKind(value as SelectableLocationKind)}
              >
                <SelectTrigger
                  id={`${id}-kind`}
                  className="w-full"
                  aria-invalid={Boolean(kindError)}
                  aria-describedby={describedBy(kindError && `${id}-kind-error`)}
                >
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {SELECTABLE_LOCATION_KINDS.map((option) => (
                    <SelectItem key={option} value={option}>
                      {locationKindLabel(option)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {kindError ? <FieldError id={`${id}-kind-error`}>{kindError}</FieldError> : null}
            </Field>
            <Field data-invalid={areaError ? true : undefined}>
              <FieldLabel htmlFor={`${id}-area`}>Area or group (optional)</FieldLabel>
              <Input
                id={`${id}-area`}
                value={area}
                maxLength={LOCATION_AREA_MAX}
                aria-invalid={Boolean(areaError)}
                aria-describedby={describedBy(`${id}-area-hint`, areaError && `${id}-area-error`)}
                onChange={(event) => setArea(event.target.value)}
              />
              <FieldDescription id={`${id}-area-hint`}>
                For example Warehouse C or Lab. Locations in the same area are listed together.
              </FieldDescription>
              {areaError ? <FieldError id={`${id}-area-error`}>{areaError}</FieldError> : null}
            </Field>
          </>
        )}
      </FieldGroup>
      {error ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      {footer(
        <Button type="submit" size="sm" disabled={busy}>
          {busy ? busyLabel : submitLabel}
        </Button>,
      )}
    </form>
  );
}
