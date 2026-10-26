import { useEffect, useState } from 'react';
import { fetchHealth, type HealthResult } from '../api/health';

/** API and database status panel (TRP-T01), shown on the dashboard. */
export function SystemStatus() {
  // Each "Check again" bumps the attempt; a result only counts for the attempt that fetched it.
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{ attempt: number; result: HealthResult } | null>(null);

  useEffect(() => {
    let active = true;
    void fetchHealth().then((result) => {
      if (active) {
        setLatest({ attempt, result });
      }
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  const result = latest?.attempt === attempt ? latest.result : null;

  return (
    <section className="card health" aria-live="polite">
      <h2>System status</h2>
      <HealthStatus result={result} />
      <button
        type="button"
        onClick={() => setAttempt((current) => current + 1)}
        disabled={result === null}
      >
        Check again
      </button>
    </section>
  );
}

function HealthStatus({ result }: { result: HealthResult | null }) {
  if (result === null) {
    return <p>Checking…</p>;
  }
  if (result.kind === 'unavailable') {
    return (
      <p className="status status-error" role="alert">
        <strong>API unavailable.</strong> {result.reason}
      </p>
    );
  }
  const { health } = result;
  return (
    <dl className={`status ${result.kind === 'ok' ? 'status-ok' : 'status-warning'}`}>
      <dt>API</dt>
      <dd>{result.kind === 'ok' ? 'OK' : 'Degraded'}</dd>
      <dt>Database</dt>
      <dd>{health.database === 'up' ? 'Connected' : 'Unavailable'}</dd>
      <dt>Version</dt>
      <dd>{health.version}</dd>
    </dl>
  );
}
