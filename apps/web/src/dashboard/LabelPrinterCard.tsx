import { Link } from 'react-router';
import { ErrorState, StatusBadge } from '../components/ui';
import { fetchSystemStatus } from '../settings/system-status/api';
import { useLoad } from './useLoad';

/**
 * Label printer summary for admins, from Settings → System status (MM-T21): jobs waiting, jobs
 * that may or may not have printed, and whether the print worker is running. The server refuses
 * everyone without system.status.read, so the dashboard only shows this card to them.
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
            <StatusBadge tone="success">Running</StatusBadge>
          ) : (
            <StatusBadge tone="danger">Stopped</StatusBadge>
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
        )}
        <p className="field-hint">
          <Link to="/settings/system-status">Print queue in System status</Link>
        </p>
      </div>
    </section>
  );
}
