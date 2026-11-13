import { printJobStatusText, type PrintJob, type PrintStatusTone } from '@materialmule/shared';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

/** Print status tones on Strata's tag colours: success is Stored green, warning is Due amber. */
const BADGE_VARIANT = {
  neutral: 'outline',
  info: 'secondary',
  success: 'storage',
  warning: 'due',
  danger: 'danger',
} as const satisfies Record<PrintStatusTone, string>;

/**
 * One print job's honest status (MM-T15): a tag, what to do next and the follow-up actions.
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
    <div className="print-status flex flex-col items-start gap-1.5" data-status={job.status}>
      <span role="status" aria-live="polite">
        <Badge variant={BADGE_VARIANT[text.tone]} className="whitespace-normal">
          {text.label}
        </Badge>
      </span>
      {text.hint ? <p className="text-muted-foreground m-0 text-sm">{text.hint}</p> : null}
      {job.lastError && job.status !== 'sent' && job.lastError !== job.printerMessage ? (
        <p className="text-muted-foreground m-0 text-sm">Details: {job.lastError}</p>
      ) : null}
      {(canConfirm && onConfirm) || (canReprint && onReprint) ? (
        <div className="print-actions flex flex-wrap gap-2">
          {canReprint && onReprint ? (
            <Button type="button" variant="outline" size="sm" onClick={onReprint} disabled={busy}>
              Reprint
            </Button>
          ) : null}
          {canConfirm && onConfirm ? (
            <Button type="button" variant="outline" size="sm" onClick={onConfirm} disabled={busy}>
              {job.status === 'uncertain' ? 'Mark as printed' : 'Labels came out OK'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
