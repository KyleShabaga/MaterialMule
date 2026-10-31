import { z } from 'zod';

// Operational status (MM-T21): the backup status record written by deploy/windows/backup.ps1 and
// the admin-only `GET /api/admin/system-status` response shown under Settings → System status.

export const BACKUP_RESULTS = ['success', 'failed'] as const;
export type BackupResult = (typeof BACKUP_RESULTS)[number];

const isoTimestamp = z.iso.datetime({ offset: true });

const backupRunSchema = z.object({
  startedAt: isoTimestamp,
  finishedAt: isoTimestamp,
  result: z.enum(BACKUP_RESULTS),
  /** Plain-language outcome; never a password or connection string. */
  message: z.string().max(1000),
  /** Dump file name, e.g. materialmule-production-20261026T080000Z-0.2.0-ab12cd3.dump. */
  file: z.string().max(260).nullable(),
  sizeBytes: z.number().int().nonnegative().nullable(),
  version: z.string().max(100).nullable(),
});

/**
 * The status record backup.ps1 writes after every run (`StatusFile` in backup.config.psd1). The
 * API reads it from BACKUP_STATUS_FILE. Unknown fields are ignored so the scripts can add more.
 */
export const backupStatusFileSchema = z.object({
  schemaVersion: z.literal(1),
  lastRun: backupRunSchema,
  lastSuccess: backupRunSchema.nullable(),
  /** D39 values as configured on the host (no defaults: the backup refuses to run without them). */
  rpoHours: z.number().positive(),
  rtoHours: z.number().positive(),
  owner: z.string().max(200),
  alertRecipient: z.string().max(200),
  target: z
    .object({
      freeBytes: z.number().nonnegative().nullable(),
      totalBytes: z.number().nonnegative().nullable(),
    })
    .nullable(),
});

export type BackupStatusFile = z.infer<typeof backupStatusFileSchema>;

/**
 * - not_configured: BACKUP_STATUS_FILE is not set on this server (backup design pending, D39).
 * - unknown: configured, but no readable status record yet.
 * - ok: the last run succeeded within the recovery point objective.
 * - overdue: no successful backup within the RPO (AC4).
 * - failed: the most recent run failed (AC3).
 */
export const BACKUP_STATES = ['not_configured', 'unknown', 'ok', 'overdue', 'failed'] as const;
export type BackupState = (typeof BACKUP_STATES)[number];

const diskSchema = z.object({
  label: z.string(),
  freeBytes: z.number().nonnegative(),
  totalBytes: z.number().nonnegative(),
  /** When the figure was measured (the backup target's comes from the last backup run). */
  measuredAt: isoTimestamp,
});

export type DiskSpace = z.infer<typeof diskSchema>;

/**
 * The newest finished attempt on the default printer (MTR-45), from its print jobs:
 * - ok: the labels went out (sent, or a person confirmed they printed);
 * - retrying: nothing reached the printer and the job will be tried again;
 * - failed: nothing reached the printer and the retries ran out (or the job couldn't be sent);
 * - uncertain: the connection broke part-way, so the labels may or may not have printed.
 */
export const PRINTER_OUTCOMES = ['ok', 'retrying', 'failed', 'uncertain'] as const;
export type PrinterOutcome = (typeof PRINTER_OUTCOMES)[number];

const defaultPrinterSchema = z.object({
  key: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  /** Whether the worker asks the printer for its host status before sending (Settings). */
  checkStatus: z.boolean(),
  /** Null until a job for this printer has been attempted. */
  lastAttempt: z
    .object({
      outcome: z.enum(PRINTER_OUTCOMES),
      at: isoTimestamp,
      /** Plain-language reason, e.g. "Printer refused the connection"; null when ok. */
      error: z.string().nullable(),
      /** The printer's own condition from the host status check, e.g. "Printer out of labels". */
      printerMessage: z.string().nullable(),
    })
    .nullable(),
  /** When the printer stopped printing: the first attempt since its last good print. */
  failingSince: isoTimestamp.nullable(),
});

export type DefaultPrinterStatus = z.infer<typeof defaultPrinterSchema>;

export const systemStatusResponseSchema = z.object({
  checkedAt: isoTimestamp,
  version: z.string(),
  database: z.enum(['up', 'down']),
  backup: z.object({
    state: z.enum(BACKUP_STATES),
    message: z.string(),
    lastRunAt: isoTimestamp.nullable(),
    lastRunResult: z.enum(BACKUP_RESULTS).nullable(),
    lastRunMessage: z.string().nullable(),
    lastSuccessAt: isoTimestamp.nullable(),
    lastSuccessFile: z.string().nullable(),
    lastSuccessSizeBytes: z.number().nullable(),
    rpoHours: z.number().nullable(),
    rtoHours: z.number().nullable(),
    owner: z.string().nullable(),
    alertRecipient: z.string().nullable(),
  }),
  /** Null when the database is down. */
  printQueue: z
    .object({
      queued: z.number().int().nonnegative(),
      sending: z.number().int().nonnegative(),
      uncertain: z.number().int().nonnegative(),
      failed: z.number().int().nonnegative(),
      oldestQueuedAt: isoTimestamp.nullable(),
      oldestQueuedAgeSeconds: z.number().int().nonnegative().nullable(),
    })
    .nullable(),
  printWorker: z.object({
    running: z.boolean(),
    lastPollAt: isoTimestamp.nullable(),
  }),
  /** Null when no printer is the default, or the database is down. */
  defaultPrinter: defaultPrinterSchema.nullable(),
  /** Only the disks whose space could be measured. */
  disks: z.array(diskSchema),
});

export type SystemStatusResponse = z.infer<typeof systemStatusResponseSchema>;
