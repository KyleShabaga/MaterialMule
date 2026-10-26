import {
  systemStatusResponseSchema,
  type BackupState,
  type SystemStatusResponse,
} from '@trapezoid/shared';
import { useEffect, useState } from 'react';
import { apiFetch } from '../../api/client';
import { EmptyState, ErrorState, StatusBadge, type BadgeTone } from '../../components/ui';
import { formatAge, formatBytes, formatExpiry } from '../../lib/format';
import { useMe } from '../../session/context';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; status: SystemStatusResponse };

async function fetchSystemStatus(): Promise<
  { ok: true; data: SystemStatusResponse } | { ok: false; message: string }
> {
  let response: Response;
  try {
    response = await apiFetch('/api/admin/system-status');
  } catch {
    return { ok: false, message: "Trapezoid couldn't be reached. Check the connection." };
  }
  if (!response.ok) {
    return {
      ok: false,
      message:
        response.status === 403
          ? "You don't have permission to see system status."
          : `Request failed (HTTP ${response.status}).`,
    };
  }
  const parsed = systemStatusResponseSchema.safeParse(await response.json().catch(() => null));
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, message: 'Trapezoid returned an unexpected response.' };
}

const BACKUP_BADGE: Record<BackupState, { tone: BadgeTone; text: string }> = {
  ok: { tone: 'success', text: 'OK' },
  overdue: { tone: 'warning', text: 'Overdue' },
  failed: { tone: 'danger', text: 'Failed' },
  unknown: { tone: 'warning', text: 'No record' },
  not_configured: { tone: 'neutral', text: 'Not set up' },
};

function BackupSection({ backup }: { backup: SystemStatusResponse['backup'] }) {
  const badge = BACKUP_BADGE[backup.state];
  const alert = backup.state === 'failed' || backup.state === 'overdue';
  return (
    <section className="card" aria-labelledby="status-backup">
      <h2 id="status-backup">
        Backups <StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>
      </h2>
      <p role={alert ? 'alert' : undefined}>{backup.message}</p>
      {backup.state === 'not_configured' ? null : (
        <dl className="status">
          <dt>Last run</dt>
          <dd>
            {backup.lastRunAt
              ? `${formatExpiry(backup.lastRunAt)} – ${backup.lastRunResult === 'success' ? 'succeeded' : 'failed'}`
              : 'Never'}
          </dd>
          {backup.lastRunResult === 'failed' && backup.lastRunMessage ? (
            <>
              <dt>Reason</dt>
              <dd>{backup.lastRunMessage}</dd>
            </>
          ) : null}
          <dt>Last success</dt>
          <dd>{backup.lastSuccessAt ? formatExpiry(backup.lastSuccessAt) : 'None yet'}</dd>
          {backup.lastSuccessFile ? (
            <>
              <dt>File</dt>
              <dd>
                {backup.lastSuccessFile}
                {backup.lastSuccessSizeBytes !== null
                  ? ` (${formatBytes(backup.lastSuccessSizeBytes)})`
                  : ''}
              </dd>
            </>
          ) : null}
          {backup.rpoHours !== null ? (
            <>
              <dt>Recovery point objective</dt>
              <dd>{backup.rpoHours} h</dd>
            </>
          ) : null}
          {backup.owner ? (
            <>
              <dt>Backup owner</dt>
              <dd>{backup.owner}</dd>
            </>
          ) : null}
          {backup.alertRecipient ? (
            <>
              <dt>Alerts go to</dt>
              <dd>{backup.alertRecipient}</dd>
            </>
          ) : null}
        </dl>
      )}
    </section>
  );
}

function PrintQueueSection({ status }: { status: SystemStatusResponse }) {
  const queue = status.printQueue;
  return (
    <section className="card" aria-labelledby="status-print">
      <h2 id="status-print">Print queue</h2>
      {queue === null ? (
        <p>Unavailable while the database is down.</p>
      ) : (
        <dl className="status">
          <dt>Waiting to print</dt>
          <dd>{queue.queued}</dd>
          <dt>Oldest waiting</dt>
          <dd>
            {queue.oldestQueuedAgeSeconds === null
              ? '—'
              : `${formatAge(queue.oldestQueuedAgeSeconds)} ago`}
          </dd>
          <dt>Sending now</dt>
          <dd>{queue.sending}</dd>
          <dt>Not sure if printed</dt>
          <dd>{queue.uncertain}</dd>
          <dt>Failed</dt>
          <dd>{queue.failed}</dd>
          <dt>Print worker</dt>
          <dd>
            {status.printWorker.running ? 'Running' : 'Stopped'}
            {status.printWorker.lastPollAt
              ? `, last checked ${formatExpiry(status.printWorker.lastPollAt)}`
              : ''}
          </dd>
        </dl>
      )}
    </section>
  );
}

/** Settings → System status (admin, TRP-T21). Read-only. */
export function SystemStatusPage() {
  const me = useMe();
  const allowed = me.permissions.includes('system.status.read');
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (!allowed) return;
    let cancelled = false;
    void fetchSystemStatus().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', status: result.data }
          : { state: 'error', message: result.message },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [allowed, attempt]);

  if (!allowed) {
    return <EmptyState>Only administrators can see system status.</EmptyState>;
  }
  if (load.state === 'loading') return <p aria-busy="true">Checking system status…</p>;
  if (load.state === 'error') {
    return <ErrorState message={load.message} onRetry={() => setAttempt((a) => a + 1)} />;
  }
  const { status } = load;
  return (
    <>
      <section className="card" aria-labelledby="status-service">
        <h2 id="status-service">Service</h2>
        <dl className={`status ${status.database === 'up' ? 'status-ok' : 'status-warning'}`}>
          <dt>Database</dt>
          <dd>{status.database === 'up' ? 'Connected' : 'Unavailable'}</dd>
          <dt>Version</dt>
          <dd>{status.version}</dd>
          <dt>Checked</dt>
          <dd>{formatExpiry(status.checkedAt)}</dd>
        </dl>
        <button type="button" onClick={() => setAttempt((a) => a + 1)}>
          Check again
        </button>
      </section>
      <BackupSection backup={status.backup} />
      <PrintQueueSection status={status} />
      <section className="card" aria-labelledby="status-disk">
        <h2 id="status-disk">Disk space</h2>
        {status.disks.length === 0 ? (
          <p>Not available on this server.</p>
        ) : (
          <dl className="status">
            {status.disks.map((disk) => (
              <div key={disk.label} className="status-row">
                <dt>{disk.label}</dt>
                <dd>
                  {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </section>
    </>
  );
}
