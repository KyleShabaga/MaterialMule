import type { DefaultPrinterStatus } from '@materialmule/shared';
import { Link } from 'react-router';
import { ErrorState, StatusBadge, type BadgeTone } from '../components/ui';
import { fetchSystemStatus } from '../settings/system-status/api';
import { useLoad } from './useLoad';

/**
 * Label printer summary for admins, from Settings → System status (MM-T21): jobs waiting, jobs
 * that may or may not have printed, whether the print queue (the background worker) is running,
 * and how the default printer's newest attempt went (MTR-45). The server refuses everyone without
 * system.status.read, so the dashboard only shows this card to them.
 */
export function LabelPrinterCard() {
  const [load, retry] = useLoad('status', fetchSystemStatus);
  const status = load.state === 'ready' ? load.data : null;
  const queue = status?.printQueue ?? null;

  return (
    <section className="dash-panel" aria-labelledby="dash-printer">
      <div className="dash-head">
        <h2 id="dash-printer">Label printer</h2>
        {status ? (
          status.printWorker.running ? (
            <StatusBadge tone="success">Print queue running</StatusBadge>
          ) : (
            <StatusBadge tone="danger">Print queue stopped</StatusBadge>
          )
        ) : null}
      </div>
      <div className="dash-body">
        {load.state === 'loading' ? (
          <p aria-busy="true" className="muted">
            Checking the print queue…
          </p>
        ) : load.state === 'error' ? (
          <ErrorState message={load.message} onRetry={retry} />
        ) : queue === null ? (
          <p>Unavailable while the database is down.</p>
        ) : (
          <>
            <PrinterLine printer={status?.defaultPrinter ?? null} />
            <dl className="dash-tiles">
              <div className="dash-tile">
                <dt>Waiting to print</dt>
                <dd>{queue.queued}</dd>
              </div>
              <div className={queue.uncertain > 0 ? 'dash-tile dash-tile-warning' : 'dash-tile'}>
                <dt>Not sure if printed</dt>
                <dd>{queue.uncertain}</dd>
              </div>
            </dl>
          </>
        )}
        <p className="field-hint">
          <Link to="/settings/system-status">Print queue in System status</Link>
        </p>
      </div>
    </section>
  );
}

const TIME = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const DAY = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton', dateStyle: 'medium' });

/** "23:05" today, "Oct 29, 2026 23:05" on another day (lab time zone). */
function formatWhen(iso: string): string {
  const when = new Date(iso);
  const time = TIME.format(when);
  return DAY.format(when) === DAY.format(new Date()) ? time : `${DAY.format(when)} ${time}`;
}

function printerState(printer: DefaultPrinterStatus | null): {
  tone: BadgeTone;
  badge: string;
  text: string;
} {
  if (!printer) {
    return { tone: 'warning', badge: 'No default printer', text: 'No printer is set as default.' };
  }
  const attempt = printer.lastAttempt;
  if (!printer.enabled) {
    return { tone: 'warning', badge: 'Printer off', text: `${printer.name} is turned off.` };
  }
  if (!attempt) {
    return { tone: 'neutral', badge: 'Not used yet', text: `${printer.name}: no labels sent yet.` };
  }
  const reason = attempt.printerMessage ?? attempt.error;
  const because = reason ? ` — ${reason}` : '';
  const since = formatWhen(printer.failingSince ?? attempt.at);
  switch (attempt.outcome) {
    case 'ok':
      return {
        tone: 'success',
        badge: 'Printer OK',
        text: `${printer.name}: last labels printed at ${formatWhen(attempt.at)}`,
      };
    case 'retrying':
      return {
        tone: 'warning',
        badge: 'Printer not responding',
        text: `${printer.name}: not responding since ${since}${because}. Trying again.`,
      };
    case 'failed':
      return {
        tone: 'danger',
        badge: 'Printer not responding',
        text: `${printer.name}: not responding since ${since}${because}`,
      };
    case 'uncertain':
      return {
        tone: 'warning',
        badge: 'Check the printer',
        text: `${printer.name}: not sure the last labels printed (${formatWhen(attempt.at)})${because}`,
      };
  }
}

function PrinterLine({ printer }: { printer: DefaultPrinterStatus | null }) {
  const { tone, badge, text } = printerState(printer);
  return (
    <p className="dash-printer">
      <StatusBadge tone={tone}>{badge}</StatusBadge> <span>{text}</span>
    </p>
  );
}
