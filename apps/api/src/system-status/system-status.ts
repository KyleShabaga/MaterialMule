// Operational status for Settings → System status (MM-T21). Reads only: the backup status record
// written by deploy/windows/backup.ps1, the print queue, and free disk space.
import { readFile, statfs } from 'node:fs/promises';
import {
  backupStatusFileSchema,
  type BackupStatusFile,
  type DiskSpace,
  JOB_FAILURE_KINDS,
  type JobFailureKind,
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

/**
 * The default printer and how its newest contact went (MTR-45), from print_job alone. A contact
 * is an attempt that actually reached for the printer, as the worker records it on the job
 * (`last_contact_*`, review fixes #119/#124): a send, successful or not, or a send a restart
 * interrupted. Its outcome: `ok` when sent; `uncertain` when bytes may have gone out (left out
 * once a person has confirmed the job); otherwise `retrying` while the job is still queued or
 * sending, else `failed`. A failure period starts at the first unsuccessful contact after the
 * printer's last success, never at when a job was queued: the queue runs one job at a time, so
 * that is the earliest `first_failed_contact_at` among the jobs contacted since.
 *
 * A job refused before any byte went out (a unit disposed after the request, a label that
 * couldn't be prepared) says nothing about the printer: it is reported separately as
 * lastJobFailure (the kind from its label.print_failed entry) when it is newer than the latest
 * contact, and never as the printer not responding nor as it working. Its earlier contacts, if
 * any, still count as the printer's.
 */
export async function defaultPrinterSummary(
  pool: Pool,
): Promise<SystemStatusResponse['defaultPrinter']> {
  const { rows } = await pool.query<{
    key: string;
    name: string;
    enabled: boolean;
    check_status: boolean;
    outcome: PrinterOutcome | null;
    attempt_at: Date | null;
    last_error: string | null;
    printer_message: string | null;
    failing_since: Date | null;
    job_failure: string | null;
    job_failure_at: Date | null;
    job_failure_error: string | null;
  }>(
    `WITH printer AS (
       SELECT key, name, enabled, check_status FROM printer WHERE is_default
     ), contact AS (
       SELECT j.last_contact_at AS at, j.last_contact_error AS error,
              j.last_contact_printer_message AS printer_message, j.first_failed_contact_at,
              CASE j.last_contact_result
                WHEN 'sent' THEN 'ok'
                WHEN 'uncertain' THEN 'uncertain'
                ELSE CASE WHEN j.status IN ('queued', 'sending') THEN 'retrying' ELSE 'failed' END
              END AS outcome
         FROM print_job j JOIN printer p ON p.key = j.printer_key
        WHERE j.last_contact_at IS NOT NULL
          AND NOT (j.last_contact_result = 'uncertain' AND j.physically_confirmed_at IS NOT NULL)
     ), refused AS (
       SELECT j.updated_at AS at, j.last_error AS error, coalesce(f.kind, 'unknown') AS failure
         FROM print_job j JOIN printer p ON p.key = j.printer_key
         LEFT JOIN LATERAL (
           SELECT a.after_values->>'failure' AS kind
             FROM audit_event a
            WHERE a.entity_type = 'print_job' AND a.entity_id = j.id
              AND a.action = 'label.print_failed'
            ORDER BY a.occurred_at DESC
            LIMIT 1
         ) f ON true
        WHERE j.status = 'failed' AND coalesce(f.kind, 'unknown') <> 'printer'
     ), last_ok AS (
       SELECT max(at) AS at FROM contact WHERE outcome = 'ok'
     )
     SELECT p.key, p.name, p.enabled, p.check_status,
            latest.outcome, latest.at AS attempt_at, latest.error AS last_error,
            latest.printer_message,
            (SELECT min(greatest(c.first_failed_contact_at, coalesce(o.at, '-infinity')))
               FROM contact c
              WHERE c.outcome <> 'ok' AND c.at > coalesce(o.at, '-infinity')
            ) AS failing_since,
            job.failure AS job_failure, job.at AS job_failure_at, job.error AS job_failure_error
       FROM printer p
       CROSS JOIN last_ok o
       LEFT JOIN LATERAL (
         SELECT * FROM contact ORDER BY at DESC LIMIT 1
       ) latest ON true
       LEFT JOIN LATERAL (
         SELECT * FROM refused
          WHERE at > coalesce(latest.at, '-infinity')
          ORDER BY at DESC
          LIMIT 1
       ) job ON true`,
  );
  const row = rows[0];
  if (!row) return null;
  const ok = row.outcome === 'ok';
  return {
    key: row.key,
    name: row.name,
    enabled: row.enabled,
    checkStatus: row.check_status,
    lastAttempt:
      row.outcome && row.attempt_at
        ? {
            outcome: row.outcome,
            at: row.attempt_at.toISOString(),
            error: ok ? null : row.last_error,
            printerMessage: ok ? null : row.printer_message,
          }
        : null,
    failingSince: !ok && row.failing_since ? row.failing_since.toISOString() : null,
    lastJobFailure:
      row.job_failure && row.job_failure_at
        ? {
            kind: jobFailureKind(row.job_failure),
            at: row.job_failure_at.toISOString(),
            error: row.job_failure_error,
          }
        : null,
  };
}

function jobFailureKind(kind: string): JobFailureKind {
  return (JOB_FAILURE_KINDS as readonly string[]).includes(kind)
    ? (kind as JobFailureKind)
    : 'unknown';
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
