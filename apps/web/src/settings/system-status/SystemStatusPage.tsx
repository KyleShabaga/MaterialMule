import { type BackupState, type SystemStatusResponse } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { fetchSystemStatus } from './api';
import {
  BandedCard,
  EmptyState,
  ErrorState,
  StatusBadge,
  type BadgeTone,
} from '../../components/ui';
import { formatAge, formatBytes, formatExpiry } from '../../lib/format';
import { useMe } from '../../session/context';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; status: SystemStatusResponse };

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
    <BandedCard title="Backups" aside={<StatusBadge tone={badge.tone}>{badge.text}</StatusBadge>}>
      <p role={alert ? 'alert' : undefined} className={alert ? 'notice status-alert' : undefined}>
        {backup.message}
      </p>
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
    </BandedCard>
  );
}

function PrintQueueSection({ status }: { status: SystemStatusResponse }) {
  const queue = status.printQueue;
  const worker = (
    <span>
      Print worker:{' '}
      <strong className={status.printWorker.running ? 'text-success' : 'text-warning'}>
        {status.printWorker.running ? 'Running' : 'Stopped'}
      </strong>
    </span>
  );
  return (
    <BandedCard title="Print queue" aside={worker}>
      {queue === null ? (
        <p>Unavailable while the database is down.</p>
      ) : (
        <dl className="stat-tiles stat-tiles-2">
          <div>
            <dt>Waiting to print</dt>
            <dd className="stat-number">{queue.queued}</dd>
            <dd className="stat-note">
              Oldest waiting:{' '}
              {queue.oldestQueuedAgeSeconds === null ? (
                '—'
              ) : (
                <span>{`${formatAge(queue.oldestQueuedAgeSeconds)} ago`}</span>
              )}
            </dd>
          </div>
          <div>
            <dt>Sending now</dt>
            <dd className="stat-number">{queue.sending}</dd>
          </div>
          <div className={queue.uncertain > 0 ? 'stat-tile-warning' : undefined}>
            <dt>Not sure if printed</dt>
            <dd className="stat-number">{queue.uncertain}</dd>
          </div>
          <div className={queue.failed > 0 ? 'stat-tile-danger' : undefined}>
            <dt>Failed</dt>
            <dd className="stat-number">{queue.failed}</dd>
          </div>
        </dl>
      )}
      {status.printWorker.lastPollAt ? (
        <p className="field-hint">
          Print worker last checked {formatExpiry(status.printWorker.lastPollAt)}.
        </p>
      ) : null}
    </BandedCard>
  );
}

/** Settings → System status (admin, MM-T21). Read-only. */
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
    // Canvas layout (MM-T55): Service tiles, Backups beside Print queue, then Disk space bars.
    <>
      <BandedCard
        title="Service"
        aside={
          <button type="button" onClick={() => setAttempt((a) => a + 1)}>
            Check again
          </button>
        }
      >
        <dl className="stat-tiles stat-tiles-3">
          <div>
            <dt>Database</dt>
            <dd>
              <StatusBadge tone={status.database === 'up' ? 'success' : 'danger'}>
                {status.database === 'up' ? 'Connected' : 'Unavailable'}
              </StatusBadge>
            </dd>
          </div>
          <div>
            <dt>Version</dt>
            <dd className="stat-mono">{status.version}</dd>
          </div>
          <div>
            <dt>Checked</dt>
            <dd className="stat-mono">{formatExpiry(status.checkedAt)}</dd>
          </div>
        </dl>
      </BandedCard>
      <div className="status-columns">
        <BackupSection backup={status.backup} />
        <PrintQueueSection status={status} />
      </div>
      <BandedCard title="Disk space">
        {status.disks.length === 0 ? (
          <p>Not available on this server.</p>
        ) : (
          <ul className="disk-list">
            {status.disks.map((disk) => {
              const used =
                disk.totalBytes > 0
                  ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
                  : 0;
              return (
                <li key={disk.label}>
                  <div className="disk-label">
                    <strong>{disk.label}</strong>
                    <span className="stat-mono">
                      {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                    </span>
                  </div>
                  <div className="disk-bar" role="img" aria-label={`${used}% used`}>
                    <div style={{ width: `${used}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </BandedCard>
    </>
  );
}
