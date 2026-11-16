// Confirming an irreversible action on several records (STRATA-66; DESIGN.md › Dialogs).
//
// The dialog lists every ID (mono, scrolling past about six), the confirm button repeats the
// count ("Record disposal of 3 units"), and the outcome is reported honestly: a partial failure
// keeps the dialog open and names each record that was not done, with the reason.

import { useId, useState } from 'react';
import { TriangleAlert } from 'lucide-react';
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { StageStripe } from './stage-stripe';

export interface BulkResult {
  succeeded: string[];
  failed: { id: string; reason: string }[];
}

export interface BulkRecord {
  id: string;
  /** Optional plain-text detail after the ID, e.g. the project. */
  label?: string;
}

export interface BulkConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The action and the record, e.g. "Record disposal of 3 units". */
  title: string;
  /** One sentence on what will change. */
  description: string;
  records: BulkRecord[];
  /** Confirm button text from the count, e.g. (n) => `Record disposal of ${n} units`. */
  confirmLabel: (count: number) => string;
  noun: { one: string; other: string };
  /**
   * Does the work. Resolve with a BulkResult when some records can fail independently; resolve
   * with nothing (or no failures) for full success; throw when nothing was done.
   */
  onConfirm: () => Promise<BulkResult | void>;
  /** Names what cannot be undone, e.g. "Disposal can't be undone." */
  irreversibleNote?: string;
  /** The verb in the partial-failure summary ("2 of 3 recorded."); default "recorded". */
  doneWord?: string;
}

function countOf(count: number, noun: { one: string; other: string }): string {
  return `${count} ${count === 1 ? noun.one : noun.other}`;
}

export function BulkConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  records,
  confirmLabel,
  noun,
  onConfirm,
  irreversibleNote,
  doneWord = 'recorded',
}: BulkConfirmDialogProps) {
  const [pending, setPending] = useState(false);
  const [partial, setPartial] = useState<BulkResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const errorId = useId();

  // Each opening starts clean (adjusted during render, not in an effect).
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setPending(false);
      setPartial(null);
      setError(null);
    }
  }

  const count = records.length;

  const handleOpenChange = (next: boolean) => {
    if (!next && pending) return;
    onOpenChange(next);
  };

  const confirm = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const result = await onConfirm();
      if (result && result.failed.length > 0) {
        setPartial(result);
        setPending(false);
        return;
      }
      setPending(false);
      onOpenChange(false);
    } catch (thrown) {
      const message = thrown instanceof Error && thrown.message ? thrown.message : '';
      setError(message || "That didn't work. Try again.");
      setPending(false);
    }
  };

  const failedCount = partial?.failed.length ?? 0;

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogContent
        className="data-[size=default]:sm:max-w-[30rem]"
        onEscapeKeyDown={(event) => {
          if (pending) event.preventDefault();
        }}
      >
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>
            {description}
            {irreversibleNote ? ` ${irreversibleNote}` : null}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {/* Keyboard-scrollable: focusable region named by the count. */}
        <div
          role="region"
          aria-label={countOf(count, noun)}
          tabIndex={0}
          data-slot="bulk-confirm-records"
          className="max-h-48 overflow-y-auto rounded-lg border focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          <ul className="divide-y">
            {records.map((record) => (
              <li key={record.id} className="flex items-baseline gap-2 px-3 py-1 leading-6">
                <span className="font-mono text-sm">{record.id}</span>
                {record.label && (
                  <span className="truncate text-sm text-muted-foreground">{record.label}</span>
                )}
              </li>
            ))}
          </ul>
        </div>

        {partial && (
          <Alert className="overflow-hidden pl-5">
            <StageStripe stage="due" variant="edge" />
            <TriangleAlert aria-hidden="true" />
            <AlertTitle className="line-clamp-none">
              {partial.succeeded.length} of {partial.succeeded.length + failedCount} {doneWord}.{' '}
              {failedCount} {failedCount === 1 ? 'was' : 'were'} not:
            </AlertTitle>
            <AlertDescription>
              <ul className="grid gap-1">
                {partial.failed.map((failure) => (
                  <li key={failure.id}>
                    <span className="font-mono text-foreground">{failure.id}</span>
                    {' — '}
                    {failure.reason}
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <p id={errorId} role="alert" className="text-sm text-destructive-text">
            {error}
          </p>
        )}

        <AlertDialogFooter>
          {partial ? (
            <AlertDialogCancel>Close</AlertDialogCancel>
          ) : (
            <>
              <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
              <Button
                type="button"
                variant="destructive"
                disabled={pending || count === 0}
                aria-describedby={error ? errorId : undefined}
                onClick={() => void confirm()}
              >
                {pending ? (
                  <>
                    <Spinner aria-hidden="true" role="presentation" />
                    Working…
                  </>
                ) : (
                  confirmLabel(count)
                )}
              </Button>
            </>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
