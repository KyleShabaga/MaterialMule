// Operational status for Settings → System status (MM-T21). Reads only: the backup status record
// written by deploy/windows/backup.ps1, the print queue, and free disk space.
import { readFile, statfs } from 'node:fs/promises';
import {
  backupStatusFileSchema,
  type BackupStatusFile,
  type DiskSpace,
  type PrinterOutcome,
  type SystemStatusResponse,
} from '@materialmule/shared';
import type { Pool } from 'pg';

type BackupSummary = SystemStatusResponse['backup'];
type PrintQueueSummary = NonNullable<SystemStatusResponse['printQueue']>;

const HOUR_MS = 3_600_000;

/** Reads the status record. `missing` when no backup has written it yet. */
export async function readBackupStatusFile(
  path: string,
): Promise<
  { kind: 'ok'; status: BackupStatusFile } | { kind: 'missing' } | { kind: 'unreadable' }
> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT'
      ? { kind: 'missing' }
      : { kind: 'unreadable' };
  }
  try {
    // PowerShell's UTF-8 may start with a byte order mark.
    const parsed = backupStatusFileSchema.safeParse(JSON.parse(text.replace(/^\uFEFF/, '')));
    return parsed.success ? { kind: 'ok', status: parsed.data } : { kind: 'unreadable' };
  } catch {
    return { kind: 'unreadable' };
  }
}

const EMPTY_BACKUP: Omit<BackupSummary, 'state' | 'message'> = {
  lastRunAt: null,
  lastRunResult: null,
  lastRunMessage: null,
  lastSuccessAt: null,
  lastSuccessFile: null,
  lastSuccessSizeBytes: null,
  rpoHours: null,
  rtoHours: null,
  owner: null,
  alertRecipient: null,
};

/**
 * Decides what the page says about backups. A failed last run wins (AC3); otherwise no success
 * within the recovery point objective is a warning (AC4).
 */
export function summarizeBackup(
  file: Awaited<ReturnType<typeof readBackupStatusFile>> | null,
  now: Date,
): BackupSummary {
  if (file === null) {
    return {
      ...EMPTY_BACKUP,
      state: 'not_configured',
      message: 'Backups are not set up on this server yet.',
    };
  }
  if (file.kind !== 'ok') {
    return {
      ...EMPTY_BACKUP,
      state: 'unknown',
      message:
        file.kind === 'missing'
          ? 'No backup has run yet.'
          : 'The backup status record could not be read.',
    };
  }
  const { status } = file;
  const details: Omit<BackupSummary, 'state' | 'message'> = {
    lastRunAt: status.lastRun.finishedAt,
    lastRunResult: status.lastRun.result,
    lastRunMessage: status.lastRun.message,
    lastSuccessAt: status.lastSuccess?.finishedAt ?? null,
    lastSuccessFile: status.lastSuccess?.file ?? null,
    lastSuccessSizeBytes: status.lastSuccess?.sizeBytes ?? null,
    rpoHours: status.rpoHours,
    rtoHours: status.rtoHours,
    owner: status.owner,
    alertRecipient: status.alertRecipient,
  };
  if (status.lastRun.result === 'failed') {
    return { ...details, state: 'failed', message: 'The last backup failed.' };
  }
  const lastSuccess = status.lastSuccess ? Date.parse(status.lastSuccess.finishedAt) : null;
  if (lastSuccess === null || now.getTime() - lastSuccess > status.rpoHours * HOUR_MS) {
    return {
      ...details,
      state: 'overdue',
      message: `No successful backup in the last ${status.rpoHours} hours (the recovery point objective).`,
    };
  }
  return { ...details, state: 'ok', message: 'The last backup succeeded.' };
}

export async function printQueueSummary(pool: Pool, now: Date): Promise<PrintQueueSummary> {
  const { rows } = await pool.query<{
    queued: number;
    sending: number;
    uncertain: number;
    failed: number;
    oldest_queued_at: Date | null;
  }>(
    `SELECT count(*) FILTER (WHERE status = 'queued')::int AS queued,
            count(*) FILTER (WHERE status = 'sending')::int AS sending,
            count(*) FILTER (WHERE status = 'uncertain' AND physically_confirmed_at IS NULL)::int
              AS uncertain,
            count(*) FILTER (WHERE status = 'failed')::int AS failed,
            min(created_at) FILTER (WHERE status = 'queued') AS oldest_queued_at
       FROM print_job
      WHERE status IN ('queued', 'sending', 'uncertain', 'failed')`,
  );
  const row = rows[0]!;
  const oldest = row.oldest_queued_at;
  return {
    queued: row.queued,
    sending: row.sending,
    uncertain: row.uncertain,
    failed: row.failed,
    oldestQueuedAt: oldest ? oldest.toISOString() : null,
    oldestQueuedAgeSeconds: oldest
      ? Math.max(0, Math.floor((now.getTime() - oldest.getTime()) / 1000))
      : null,
  };
}

const OUTCOME_BY_STATUS = {
  sent: 'ok',
  queued: 'retrying',
  failed: 'failed',
  uncertain: 'uncertain',
} as const satisfies Record<string, PrinterOutcome>;

/**
 * The default printer and how its newest finished attempt went (MTR-45), from print_job alone.
 * An attempt is a job the worker has tried (attempts > 0) and isn't sending right now. Its time is
 * when it was sent, or when the worker last saved it. Uncertain jobs a person has since confirmed
 * are left out: the confirmation moved their updated_at, so the attempt time is no longer known.
 */
export async function defaultPrinterSummary(
  pool: Pool,
): Promise<SystemStatusResponse['defaultPrinter']> {
  const { rows } = await pool.query<{
    key: string;
    name: string;
    enabled: boolean;
    check_status: boolean;
    status: keyof typeof OUTCOME_BY_STATUS | null;
    attempt_at: Date | null;
    last_error: string | null;
    printer_message: string | null;
    failing_since: Date | null;
  }>(
    `WITH printer AS (
       SELECT key, name, enabled, check_status FROM printer WHERE is_default
     ), attempt AS (
       SELECT j.status, j.created_at, j.last_error, j.printer_message,
              coalesce(j.sent_at, j.updated_at) AS attempt_at
         FROM print_job j JOIN printer p ON p.key = j.printer_key
        WHERE j.attempts > 0
          AND (j.status IN ('sent', 'queued', 'failed')
               OR (j.status = 'uncertain' AND j.physically_confirmed_at IS NULL))
     ), last_ok AS (
       SELECT max(attempt_at) AS at FROM attempt WHERE status = 'sent'
     )
     SELECT p.key, p.name, p.enabled, p.check_status,
            latest.status, latest.attempt_at, latest.last_error, latest.printer_message,
            (SELECT min(greatest(a.created_at, coalesce(o.at, a.created_at)))
               FROM attempt a
              WHERE a.status <> 'sent' AND a.attempt_at > coalesce(o.at, '-infinity')
            ) AS failing_since
       FROM printer p
       CROSS JOIN last_ok o
       LEFT JOIN LATERAL (
         SELECT * FROM attempt ORDER BY attempt_at DESC LIMIT 1
       ) latest ON true`,
  );
  const row = rows[0];
  if (!row) return null;
  const ok = row.status === 'sent';
  return {
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    checkStatus: row.check_status,
    lastAttempt:
      row.status && row.attempt_at
        ? {
            outcome: OUTCOME_BY_STATUS[row.status],
            at: row.attempt_at.toISOString(),
            error: ok ? null : row.last_error,
            printerMessage: ok ? null : row.printer_message,
          }
        : null,
    failingSince: !ok && row.failing_since ? row.failing_since.toISOString() : null,
  };
}

/** Free space on the drive holding `path`, or null where the platform can't tell. */
export async function diskSpace(path: string, label: string, now: Date): Promise<DiskSpace | null> {
  try {
    const stats = await statfs(path);
    return {
      label,
      freeBytes: stats.bavail * stats.bsize,
      totalBytes: stats.blocks * stats.bsize,
      measuredAt: now.toISOString(),
    };
  } catch {
    return null;
  }
}

/** The backup target's space as backup.ps1 measured it (the service can't reach the target). */
export function backupTargetDisk(
  file: Awaited<ReturnType<typeof readBackupStatusFile>> | null,
): DiskSpace | null {
  if (file?.kind !== 'ok') return null;
  const { target, lastRun } = file.status;
  if (!target || target.freeBytes === null || target.totalBytes === null) return null;
  return {
    label: 'Backup location',
    freeBytes: target.freeBytes,
    totalBytes: target.totalBytes,
    measuredAt: lastRun.finishedAt,
  };
}
