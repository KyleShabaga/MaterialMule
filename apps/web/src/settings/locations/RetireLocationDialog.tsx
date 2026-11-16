import { LOCATION_REASON_MAX, type StorageLocation } from '@materialmule/shared';
import { useId, useState, type RefObject } from 'react';
import { Link } from 'react-router';
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
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import { Textarea } from '@/components/ui/textarea';
import { retireLocation } from './api';
import { shelfLink } from './location-links';
import { storageUnitsText } from './location-tree';
import { RequiredMark } from './LocationForm';

// Retire a location (MM-T37; canvas Round 9 locations-retire / locations-retire-blocked). A
// reason is required and kept in the location's history. A location still holding units can't
// be retired: the dialog says how many and opens the shelf page instead. The server checks both
// again, so a unit moved there meanwhile turns the reason dialog into the blocked one.

export function RetireLocationDialog({
  location,
  returnFocus,
  onClose,
  onRetired,
  onConflict,
}: {
  location: StorageLocation;
  /** Where focus goes when the dialog closes (it has no Radix trigger). */
  returnFocus?: RefObject<HTMLElement | null>;
  onClose: () => void;
  onRetired: (location: StorageLocation) => void;
  onConflict: (current: StorageLocation, message: string) => void;
}) {
  const id = useId();
  const [blocked, setBlocked] = useState<number | null>(
    location.inStockCount > 0 ? location.inStockCount : null,
  );
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit() {
    if (!reason.trim()) {
      setReasonError('Give a reason');
      document.getElementById(`${id}-reason`)?.focus();
      return;
    }
    setReasonError(null);
    setError(null);
    setBusy(true);
    const result = await retireLocation(location.id, {
      reason: reason.trim(),
      version: location.version,
    });
    setBusy(false);
    if (result.ok) onRetired(result.data);
    else if (result.kind === 'occupied') setBlocked(result.inStockCount);
    else if (result.kind === 'conflict') onConflict(result.current, result.message);
    else if (result.kind === 'invalid') {
      setReasonError(
        result.errors.find((item) => item.field === 'reason')?.message ?? result.message,
      );
      document.getElementById(`${id}-reason`)?.focus();
    } else setError(result.message);
  }

  return (
    <AlertDialog open onOpenChange={(open) => (open ? undefined : onClose())}>
      <AlertDialogContent
        onCloseAutoFocus={(event) => {
          if (!returnFocus?.current?.isConnected) return;
          event.preventDefault();
          returnFocus.current.focus();
        }}
      >
        {blocked !== null ? (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>{location.code} can’t be retired</AlertDialogTitle>
              <AlertDialogDescription>
                {storageUnitsText(blocked)} {blocked === 1 ? 'is' : 'are'} at this location. Move{' '}
                {blocked === 1 ? 'it' : 'them'} to another place first, then retire it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Close</AlertDialogCancel>
              <AlertDialogAction size="sm" asChild>
                <Link to={shelfLink(location)}>Open shelf page</Link>
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        ) : (
          <>
            <AlertDialogHeader>
              <AlertDialogTitle>Retire {location.code}?</AlertDialogTitle>
              <AlertDialogDescription>
                {location.name} is empty. Once retired it can’t receive units or be printed. Its
                history stays, and every record that names it keeps it.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <Field data-invalid={reasonError ? true : undefined}>
              <FieldLabel htmlFor={`${id}-reason`}>
                Reason
                <RequiredMark />
              </FieldLabel>
              <Textarea
                id={`${id}-reason`}
                rows={3}
                value={reason}
                maxLength={LOCATION_REASON_MAX}
                required
                aria-invalid={Boolean(reasonError)}
                aria-describedby={`${id}-reason-hint${reasonError ? ` ${id}-reason-error` : ''}`}
                onChange={(event) => setReason(event.target.value)}
              />
              <FieldDescription id={`${id}-reason-hint`}>
                Kept in the location’s history.
              </FieldDescription>
              {reasonError ? (
                <FieldError id={`${id}-reason-error`}>{reasonError}</FieldError>
              ) : null}
            </Field>
            {error ? <FieldError>{error}</FieldError> : null}
            <AlertDialogFooter>
              <AlertDialogCancel size="sm">Cancel</AlertDialogCancel>
              <AlertDialogAction
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={(event) => {
                  // Stay open until the server answers (or the reason is missing).
                  event.preventDefault();
                  void submit();
                }}
              >
                {busy ? 'Retiring…' : 'Retire location'}
              </AlertDialogAction>
            </AlertDialogFooter>
          </>
        )}
      </AlertDialogContent>
    </AlertDialog>
  );
}
