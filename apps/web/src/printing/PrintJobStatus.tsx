import { printJobStatusText, type PrintJob } from '@trapezoid/shared';
import { StatusBadge } from '../components/ui';

/**
 * One print job's honest status (TRP-T15): a chip, what to do next and the follow-up actions.
 * "Sent to printer" never claims the labels physically came out; only a person can confirm that.
 */
export function PrintJobStatus({
  job,
  busy = false,
  onReprint,
  onConfirm,
}: {
  job: PrintJob;
  busy?: boolean;
  onReprint?: () => void;
  onConfirm?: () => void;
}) {
  const text = printJobStatusText(job);
  const confirmed = job.physicallyConfirmedAt !== null;
  const canConfirm = !confirmed && (job.status === 'sent' || job.status === 'uncertain');
  const canReprint = job.status === 'failed' || (job.status === 'uncertain' && !confirmed);
  return (
    <div className="print-status" data-status={job.status}>
      <span role="status" aria-live="polite">
        <StatusBadge tone={text.tone}>{text.label}</StatusBadge>
      </span>
      {text.hint ? <p className="field-hint">{text.hint}</p> : null}
      {job.lastError && job.status !== 'sent' && job.lastError !== job.printerMessage ? (
        <p className="field-hint">Details: {job.lastError}</p>
      ) : null}
      {(canConfirm && onConfirm) || (canReprint && onReprint) ? (
        <div className="print-actions">
          {canReprint && onReprint ? (
            <button type="button" onClick={onReprint} disabled={busy}>
              Reprint
            </button>
          ) : null}
          {canConfirm && onConfirm ? (
            <button type="button" onClick={onConfirm} disabled={busy}>
              {job.status === 'uncertain' ? 'Mark as printed' : 'Labels came out OK'}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
