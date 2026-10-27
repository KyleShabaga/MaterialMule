import { z } from 'zod';
import { formatReceiver } from './staff';

// Label printing (MM-T15): request and response shapes shared by the API and the web app.

export const PRINT_JOB_KINDS = ['initial', 'reprint'] as const;
export const PRINT_JOB_STATUSES = ['queued', 'sending', 'sent', 'failed', 'uncertain'] as const;

export type PrintJobKind = (typeof PRINT_JOB_KINDS)[number];
export type PrintJobStatus = (typeof PRINT_JOB_STATUSES)[number];

/** Most storage units in one print job (a receipt holds at most 50). */
export const MAX_PRINT_JOB_UNITS = 50;

const printerKey = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'Unknown printer' });

/**
 * `POST /api/print-jobs`. Only a configured printer's key may be named: a host or port in the
 * request is rejected (strict object), never used.
 */
export const createPrintJobRequestSchema = z.strictObject({
  storageUnitIds: z
    .array(z.uuid({ error: 'Each storage unit ID must be a UUID' }))
    .min(1, { error: 'Choose at least one storage unit' })
    .max(MAX_PRINT_JOB_UNITS, { error: `At most ${MAX_PRINT_JOB_UNITS} labels per print` })
    .refine((ids) => new Set(ids).size === ids.length, {
      error: 'A storage unit appears twice',
    }),
  kind: z.enum(PRINT_JOB_KINDS),
  printerId: printerKey.optional(),
  /** Staff member at a shared LAB station; defaults to the receipt's receiver. */
  receiverUserId: z.uuid().optional(),
});

export type CreatePrintJobRequest = z.infer<typeof createPrintJobRequestSchema>;

const person = z.object({
  userId: z.string(),
  initials: z.string().nullable(),
  name: z.string(),
});

export const printJobSchema = z.object({
  id: z.string(),
  kind: z.enum(PRINT_JOB_KINDS),
  printerId: z.string(),
  printerName: z.string(),
  templateVersion: z.string(),
  status: z.enum(PRINT_JOB_STATUSES),
  attempts: z.number(),
  /** Plain-language reason for the last failed or uncertain attempt. */
  lastError: z.string().nullable(),
  /** Printer condition from host status, e.g. "Printer out of labels". */
  printerMessage: z.string().nullable(),
  requestedBy: person,
  receiver: person.nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  sentAt: z.string().nullable(),
  physicallyConfirmedAt: z.string().nullable(),
  physicallyConfirmedBy: person.nullable(),
  items: z.array(
    z.object({ storageUnitId: z.string(), readableId: z.string(), position: z.number() }),
  ),
});

export type PrintJob = z.infer<typeof printJobSchema>;

/** `GET /api/storage-units/:id/print-history`: newest job first. */
export const printHistoryResponseSchema = z.object({
  storageUnit: z.object({ id: z.string(), readableId: z.string() }),
  jobs: z.array(printJobSchema),
});

export type PrintHistoryResponse = z.infer<typeof printHistoryResponseSchema>;

/** Jobs the worker hasn't finished; the UI keeps polling while a job is in one of these. */
export function isPrintJobActive(status: PrintJobStatus): boolean {
  return status === 'queued' || status === 'sending';
}

export type PrintStatusTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

export interface PrintStatusText {
  label: string;
  tone: PrintStatusTone;
  /** What the person should do next, if anything. */
  hint: string | null;
}

/** "JS · Jordan Smith", or the name alone for staff without confirmed initials. */
function personText(person: { initials: string | null; name: string }): string {
  return person.initials
    ? formatReceiver({ initials: person.initials, displayName: person.name, position: null })
    : person.name;
}

/** "Tried 3 times." / "Tried once." */
function attemptsText(attempts: number): string {
  return attempts === 1 ? 'Tried once.' : `Tried ${attempts} times.`;
}

/**
 * Honest wording for a job's status. "Sent to printer" is never worded as a physical print:
 * only a person's "Labels came out OK" confirmation says the labels exist. With who confirmed a
 * job (print history), an uncertain job marked printed names them (MM-T61).
 */
export function printJobStatusText(
  job: Pick<PrintJob, 'status' | 'attempts' | 'printerMessage' | 'physicallyConfirmedAt'> &
    Partial<Pick<PrintJob, 'physicallyConfirmedBy'>>,
): PrintStatusText {
  const confirmed = job.physicallyConfirmedAt !== null;
  switch (job.status) {
    case 'queued':
      return job.attempts > 0
        ? {
            label: job.printerMessage
              ? `${job.printerMessage} — trying again`
              : "Printer didn't respond — trying again",
            tone: 'warning',
            hint: null,
          }
        : { label: 'Waiting to print', tone: 'info', hint: null };
    case 'sending':
      return { label: 'Sending to printer…', tone: 'info', hint: null };
    case 'sent':
      return confirmed
        ? { label: 'Printed (confirmed)', tone: 'success', hint: null }
        : {
            label: 'Sent to printer',
            tone: 'success',
            hint: 'Check the labels came out, then confirm.',
          };
    case 'failed':
      return {
        label: job.printerMessage
          ? `${job.printerMessage} — not printed`
          : "Printer didn't respond — not printed",
        tone: 'danger',
        hint: `${job.attempts > 0 ? `${attemptsText(job.attempts)} ` : ''}Fix the printer, then Reprint.`,
      };
    case 'uncertain':
      return confirmed
        ? {
            label: 'Marked as printed',
            tone: 'success',
            hint: `The printer result was uncertain; ${
              job.physicallyConfirmedBy ? personText(job.physicallyConfirmedBy) : 'a person'
            } marked it as printed.`,
          }
        : {
            label: 'Unknown — check the printer before reprinting',
            tone: 'warning',
            hint: 'Check the printer, then Reprint or Mark as printed.',
          };
  }
}

// ---------------------------------------------------------------------------------------------
// Printer administration (admin only)
// ---------------------------------------------------------------------------------------------

export const printerSchema = z.object({
  id: z.string(),
  name: z.string(),
  host: z.string(),
  port: z.number(),
  enabled: z.boolean(),
  isDefault: z.boolean(),
  checkStatus: z.boolean(),
});

export type Printer = z.infer<typeof printerSchema>;

export const printersResponseSchema = z.array(printerSchema);

const hostPattern = /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/;

/** `PUT /api/admin/printers`: adds or updates each listed printer (printers are never deleted). */
export const putPrintersRequestSchema = z.strictObject({
  printers: z
    .array(
      z.strictObject({
        id: z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, {
          error: 'Use lowercase letters, digits and dashes (up to 40)',
        }),
        name: z.string().trim().min(1, { error: 'Name is required' }).max(100),
        host: z.string().trim().regex(hostPattern, { error: 'Enter an IP address or host name' }),
        port: z.number().int().min(1).max(65535).default(9100),
        enabled: z.boolean().default(true),
        isDefault: z.boolean().default(false),
        checkStatus: z.boolean().default(true),
      }),
    )
    .min(1)
    .max(20)
    .refine((list) => new Set(list.map((p) => p.id)).size === list.length, {
      error: 'A printer appears twice',
    })
    .refine((list) => list.filter((p) => p.isDefault).length <= 1, {
      error: 'Only one printer can be the default',
    }),
});

export type PutPrintersRequest = z.input<typeof putPrintersRequestSchema>;
