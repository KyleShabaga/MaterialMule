import { useId, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '../components/ui';

/**
 * A confirmation that needs a reason (D15): removals, revocations and decisions on the Team &
 * Permissions screen (MM-AO05). The dialog stays open until a reason is entered.
 */
export function ReasonDialog({
  open,
  title,
  confirmLabel,
  danger = true,
  children,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  confirmLabel: string;
  danger?: boolean;
  /** What happens, and any extra fields (e.g. the emergency-suspension choice). */
  children?: ReactNode;
  onConfirm: (reason: string) => void;
  onCancel: () => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const reset = () => {
    setReason('');
    setError(null);
  };
  return (
    <ConfirmDialog
      open={open}
      title={title}
      confirmLabel={confirmLabel}
      danger={danger}
      onConfirm={() => {
        if (!reason.trim()) {
          setError('Enter a reason.');
          return;
        }
        const text = reason.trim();
        reset();
        onConfirm(text);
      }}
      onCancel={() => {
        reset();
        onCancel();
      }}
    >
      {children}
      <label htmlFor={id}>Reason</label>
      <textarea
        id={id}
        value={reason}
        maxLength={2000}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        onChange={(event) => setReason(event.target.value)}
      />
      {error ? (
        <p id={`${id}-error`} className="field-error">
          {error}
        </p>
      ) : null}
    </ConfirmDialog>
  );
}
