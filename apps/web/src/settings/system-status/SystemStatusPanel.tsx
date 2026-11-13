import {
  type BackupState,
  type PrinterOutcome,
  type SystemStatusResponse,
} from '@materialmule/shared';
import { CircleAlert, RefreshCw, TriangleAlert } from 'lucide-react';
import { useEffect, useState, type ReactNode } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { formatAge, formatBytes, formatExpiry } from '../../lib/format';
import { useMe } from '../../session/context';
import { SettingsGroup, SettingsPanel } from '../modal/SettingsPanel';
import {
  PanelError,
  PanelLoading,
  ReadOnlyNote,
  StateBadge,
  TOUCH,
  type Tone,
} from '../reference/panel-parts';
import { fetchSystemStatus } from './api';
import { LabStationSwitch } from './LabStationSwitch';

// Settings › System status (MM-T21, STRATA-102; canvas R9SystemPanel default, down, notsetup and
// loading). How the host is doing, state only: database, version, checked time, backups, print
// queue and disk space. Never a secret, a path the server keeps private, or a stack trace. The
// administrator's "This computer is the LAB station" switch closes the panel.

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; status: SystemStatusResponse };

const BACKUP_BADGE: Record<BackupState, { tone: Tone; text: string }> = {
  ok: { tone: 'storage', text: 'OK' },
  overdue: { tone: 'due', text: 'Overdue' },
  failed: { tone: 'danger', text: 'Failed' },
  unknown: { tone: 'due', text: 'No record' },
  not_configured: { tone: 'due', text: 'Not set up' },
};

/** What the last attempt says about the default printer, never more than the app knows. */
const PRINTER_OUTCOME: Record<PrinterOutcome, { tone: Tone; text: string }> = {
  ok: { tone: 'storage', text: 'Last label sent' },
  retrying: { tone: 'due', text: 'Retrying' },
  failed: { tone: 'danger', text: 'Unavailable' },
  uncertain: { tone: 'due', text: 'Not sure if printed' },
};

/** One fact: label, value, and a muted note. */
function StatusRow({
  label,
  children,
  note,
}: {
  label: string;
  children: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="grid grid-cols-1 items-start gap-1 py-3.5 sm:grid-cols-[10rem_minmax(0,12rem)_1fr] sm:gap-4">
      <dt className="text-sm font-medium">{label}</dt>
      <dd className="m-0 min-w-0 text-sm break-words">{children}</dd>
      <dd className="m-0 min-w-0 text-[13px] text-muted-foreground">{note}</dd>
    </div>
  );
}

const Mono = ({ children }: { children: ReactNode }) => (
  <span className="font-mono text-[13px]">{children}</span>
);

function Facts({ children }: { children: ReactNode }) {
  return <dl className="m-0 divide-y">{children}</dl>;
}

function BackupGroup({ backup }: { backup: SystemStatusResponse['backup'] }) {
  const badge = BACKUP_BADGE[backup.state];
  const alert = backup.state === 'failed' || backup.state === 'overdue';
  return (
    <SettingsGroup id="system-status-backups" title="Backups">
      {alert ? (
        <Alert variant="destructive" className="mt-4">
          <CircleAlert aria-hidden="true" />
          <AlertTitle>{backup.message}</AlertTitle>
        </Alert>
      ) : null}
      {backup.state === 'not_configured' ? (
        <Alert role="note" className="mt-4">
          <TriangleAlert aria-hidden="true" />
          <AlertTitle>Backups aren’t set up on this host.</AlertTitle>
          <AlertDescription>
            Nothing is being backed up. The host PC’s install script sets up the backup job.
          </AlertDescription>
        </Alert>
      ) : null}
      <Facts>
        <StatusRow label="State" note={alert ? null : backup.message}>
          <StateBadge tone={badge.tone}>{badge.text}</StateBadge>
        </StatusRow>
        {backup.state === 'not_configured' ? null : (
          <>
            <StatusRow
              label="Last run"
              note={
                backup.lastRunResult === 'failed' && backup.lastRunMessage
                  ? backup.lastRunMessage
                  : null
              }
            >
              {backup.lastRunAt ? (
                <Mono>
                  {`${formatExpiry(backup.lastRunAt)} – ${backup.lastRunResult === 'success' ? 'succeeded' : 'failed'}`}
                </Mono>
              ) : (
                'Never'
              )}
            </StatusRow>
            <StatusRow
              label="Last success"
              note={
                backup.lastSuccessFile
                  ? `${backup.lastSuccessFile}${
                      backup.lastSuccessSizeBytes !== null
                        ? ` (${formatBytes(backup.lastSuccessSizeBytes)})`
                        : ''
                    }`
                  : null
              }
            >
              {backup.lastSuccessAt ? (
                <Mono>{formatExpiry(backup.lastSuccessAt)}</Mono>
              ) : (
                'None yet'
              )}
            </StatusRow>
            {backup.rpoHours !== null ? (
              <StatusRow label="Recovery point" note="A backup must succeed at least this often.">
                <Mono>{backup.rpoHours} h</Mono>
              </StatusRow>
            ) : null}
            <StatusRow label="Backup owner">{backup.owner ?? 'Not set'}</StatusRow>
            <StatusRow label="Alerts go to">{backup.alertRecipient ?? 'Not set'}</StatusRow>
          </>
        )}
      </Facts>
    </SettingsGroup>
  );
}

function PrintQueueGroup({ status }: { status: SystemStatusResponse }) {
  const queue = status.printQueue;
  const printer = status.defaultPrinter;
  const outcome = printer?.lastAttempt ? PRINTER_OUTCOME[printer.lastAttempt.outcome] : null;
  return (
    <SettingsGroup id="system-status-print-queue" title="Print queue">
      <Facts>
        <StatusRow
          label="Print worker"
          note={
            status.printWorker.lastPollAt
              ? `Last checked ${formatExpiry(status.printWorker.lastPollAt)}.`
              : null
          }
        >
          <StateBadge tone={status.printWorker.running ? 'storage' : 'due'}>
            {status.printWorker.running ? 'Running' : 'Stopped'}
          </StateBadge>
        </StatusRow>
        {queue === null ? (
          <StatusRow label="Labels">Unavailable while the database is down.</StatusRow>
        ) : (
          <>
            <StatusRow
              label="Waiting to print"
              note={
                <>
                  Oldest waiting:{' '}
                  {queue.oldestQueuedAgeSeconds === null ? (
                    '—'
                  ) : (
                    <span>{`${formatAge(queue.oldestQueuedAgeSeconds)} ago`}</span>
                  )}
                </>
              }
            >
              <Mono>{queue.queued}</Mono>
            </StatusRow>
            <StatusRow label="Sending now">
              <Mono>{queue.sending}</Mono>
            </StatusRow>
            <StatusRow
              label="Not sure if printed"
              note={queue.uncertain > 0 ? 'Check those labels before printing them again.' : null}
            >
              {queue.uncertain > 0 ? (
                <StateBadge tone="due">{queue.uncertain}</StateBadge>
              ) : (
                <Mono>{queue.uncertain}</Mono>
              )}
            </StatusRow>
            <StatusRow label="Failed">
              {queue.failed > 0 ? (
                <StateBadge tone="danger">{queue.failed}</StateBadge>
              ) : (
                <Mono>{queue.failed}</Mono>
              )}
            </StatusRow>
          </>
        )}
        {printer ? (
          <StatusRow
            label="Default printer"
            note={
              printer.lastAttempt
                ? [
                    formatExpiry(printer.lastAttempt.at),
                    printer.lastAttempt.printerMessage ?? printer.lastAttempt.error,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                : 'No label sent to it yet.'
            }
          >
            <span className="grid gap-1">
              <span className="font-medium">{printer.name}</span>
              {outcome ? <StateBadge tone={outcome.tone}>{outcome.text}</StateBadge> : null}
            </span>
          </StatusRow>
        ) : null}
      </Facts>
    </SettingsGroup>
  );
}

function DiskGroup({ disks }: { disks: SystemStatusResponse['disks'] }) {
  return (
    <SettingsGroup id="system-status-disks" title="Disk space">
      {disks.length === 0 ? (
        <p className="py-3.5 text-sm text-muted-foreground">Not available on this server.</p>
      ) : (
        <ul className="m-0 grid list-none divide-y p-0">
          {disks.map((disk) => {
            const used =
              disk.totalBytes > 0
                ? Math.round(((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100)
                : 0;
            return (
              <li key={disk.label} className="grid gap-2 py-3.5">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="text-sm font-medium">{disk.label}</span>
                  <span className="font-mono text-[13px] text-muted-foreground">
                    {formatBytes(disk.freeBytes)} free of {formatBytes(disk.totalBytes)}
                  </span>
                </div>
                <Progress value={used} aria-label={`${used}% used`} />
              </li>
            );
          })}
        </ul>
      )}
    </SettingsGroup>
  );
}

/** Settings › System status (administrators, `system.status.read`). Read-only. */
export function SystemStatusPanel() {
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

  const ready = load.state === 'ready' ? load.status : null;
  const checkNow = allowed ? (
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={TOUCH}
      onClick={() => setAttempt((a) => a + 1)}
    >
      <RefreshCw aria-hidden="true" />
      Check now
    </Button>
  ) : null;

  let body: ReactNode;
  if (!allowed) body = <ReadOnlyNote>Only administrators can see system status.</ReadOnlyNote>;
  else if (load.state === 'loading') body = <PanelLoading label="Checking system status…" />;
  else if (load.state === 'error') {
    body = <PanelError message={load.message} onRetry={() => setAttempt((a) => a + 1)} />;
  } else {
    const { status } = load;
    body = (
      <>
        <SettingsGroup id="system-status-service" title="Service">
          <Facts>
            <StatusRow
              label="Database"
              note={status.database === 'up' ? 'PostgreSQL on the host PC' : null}
            >
              <StateBadge tone={status.database === 'up' ? 'storage' : 'danger'}>
                {status.database === 'up' ? 'Connected' : 'Unavailable'}
              </StateBadge>
            </StatusRow>
            <StatusRow label="Version">
              <Mono>{status.version}</Mono>
            </StatusRow>
            <StatusRow label="Checked">
              <Mono>{formatExpiry(status.checkedAt)}</Mono>
            </StatusRow>
          </Facts>
        </SettingsGroup>
        <BackupGroup backup={status.backup} />
        <PrintQueueGroup status={status} />
        <DiskGroup disks={status.disks} />
      </>
    );
  }

  return (
    <SettingsPanel
      id="system-status"
      title="System status"
      description="How the host is doing, state only. Administrators only."
      actions={checkNow}
      notice={
        ready?.database === 'down' ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>The database is unavailable.</AlertTitle>
            <AlertDescription>
              Material Mule can’t save or load records until it’s back. Work in progress on each
              computer is kept.
            </AlertDescription>
          </Alert>
        ) : undefined
      }
    >
      {body}
      <LabStationSwitch />
    </SettingsPanel>
  );
}
