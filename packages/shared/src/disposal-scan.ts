import { z } from 'zod';
import { disposalBlockerSchema, DISPOSAL_SCAN_RESULTS, disposalScanResultSchema } from './disposal';
import { normalizeStorageUnitCode } from './inventory';

// STRATA-92: Disposal scan-out. Each scan is an intent with a durable unique ID made on the
// computer that scanned it (online or queued offline). `check` reports, for each intent, what
// recording would do now and changes nothing; `record` disposes the approved ones, each in its
// own transaction, and is idempotent per intent ID: a retry returns the outcome first recorded
// and adds no history. Kyle's decision STRATA-112 (2026-11-13): queued offline scans are only
// intents; after reconnecting each is checked again and the person confirms the exact ID list
// before anything is recorded. STRATA-111 (2026-11-13): any personal account with
// storage_unit.dispose_scan may record; a LAB station never, whoever it names.

/** Intents per request (the page sends every scan of one session at once). */
export const DISPOSAL_SCAN_BATCH_MAX = 200;

export const disposalScanIntentSchema = z.strictObject({
  /** Made by the scanning computer when the scan was taken; never reused. */
  intentId: z.uuid({ error: 'must be an ID' }),
  /** The scanned storage unit ID (any case), or the unit's UUID. */
  code: z.string().trim().min(1, { error: 'Scan a storage unit' }).max(64),
  /** The account signed in when the scan was taken; only that account may check or record it. */
  scannedByUserId: z.string().min(1).max(64),
  /** When it was scanned on that computer (kept in history; never used for eligibility). */
  scannedAt: z.iso.datetime({ offset: true, error: 'must be a date and time' }),
});
export type DisposalScanIntent = z.output<typeof disposalScanIntentSchema>;

/** `POST /api/disposal/scan/check` and `POST /api/disposal/scan/record`. */
export const disposalScanRequestSchema = z
  .strictObject({
    intents: z
      .array(disposalScanIntentSchema)
      .min(1, { error: 'Scan at least one unit' })
      .max(DISPOSAL_SCAN_BATCH_MAX, {
        error: `at most ${DISPOSAL_SCAN_BATCH_MAX} scans at once`,
      }),
  })
  .superRefine((body, context) => {
    const ids = new Set<string>();
    const codes = new Set<string>();
    body.intents.forEach((intent, index) => {
      if (ids.has(intent.intentId)) {
        context.addIssue({
          code: 'custom',
          path: ['intents', index, 'intentId'],
          message: 'is repeated',
        });
      }
      const code = normalizeStorageUnitCode(intent.code);
      if (codes.has(code)) {
        context.addIssue({
          code: 'custom',
          path: ['intents', index, 'code'],
          message: 'is scanned twice: send it once',
        });
      }
      ids.add(intent.intentId);
      codes.add(code);
    });
  });
export type DisposalScanRequest = z.output<typeof disposalScanRequestSchema>;

/**
 * What one intent would do now. `approved`: recording disposes it. `not_approved` (no approval,
 * revoked, approved under another project, already disposed, a tested unit), `blocked` (hold,
 * retain-until, open program, location conflict) and `not_found` are refused and stay in stock.
 * `other_account`: scanned while another account was signed in. `recorded`: this intent was
 * already recorded (its outcome is in `recorded`). `intent_reused`: the ID belongs to another scan.
 */
export const DISPOSAL_SCAN_CHECK_STATUSES = [
  'approved',
  'not_approved',
  'blocked',
  'not_found',
  'other_account',
  'recorded',
  'intent_reused',
] as const;
export type DisposalScanCheckStatus = (typeof DISPOSAL_SCAN_CHECK_STATUSES)[number];

/** A recording outcome: the standard scan results plus the two refusals of the intent itself. */
export const DISPOSAL_SCAN_OUTCOMES = [
  ...DISPOSAL_SCAN_RESULTS,
  'other_account',
  'intent_reused',
] as const;
export type DisposalScanOutcomeResult = (typeof DISPOSAL_SCAN_OUTCOMES)[number];

export const disposalScanOutcomeSchema = disposalScanResultSchema.extend({
  result: z.enum(DISPOSAL_SCAN_OUTCOMES),
});
export type DisposalScanOutcome = z.infer<typeof disposalScanOutcomeSchema>;

export const disposalScanUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  projectNumber: z.string(),
  /** Test holes of the unit's hole summaries, by name. */
  holes: z.array(z.string()),
  /** Its last saved location (where to put it back when it isn't disposed). */
  location: z.object({ code: z.string(), name: z.string() }),
});
export type DisposalScanUnit = z.infer<typeof disposalScanUnitSchema>;

export const disposalScanCheckSchema = z.object({
  intentId: z.string(),
  code: z.string(),
  status: z.enum(DISPOSAL_SCAN_CHECK_STATUSES),
  unit: disposalScanUnitSchema.nullable(),
  blockers: z.array(disposalBlockerSchema),
  message: z.string(),
  /** For `recorded`: the outcome first recorded for this intent. */
  recorded: disposalScanOutcomeSchema.nullable(),
});
export type DisposalScanCheck = z.infer<typeof disposalScanCheckSchema>;

export const disposalScanCheckResponseSchema = z.object({
  asOf: z.string(),
  results: z.array(disposalScanCheckSchema),
});
export type DisposalScanCheckResponse = z.infer<typeof disposalScanCheckResponseSchema>;

export const disposalScanRecordSchema = z.object({
  intentId: z.string(),
  code: z.string(),
  unit: disposalScanUnitSchema.nullable(),
  outcome: disposalScanOutcomeSchema,
});
export type DisposalScanRecord = z.infer<typeof disposalScanRecordSchema>;

export const disposalScanRecordResponseSchema = z.object({
  results: z.array(disposalScanRecordSchema),
});
export type DisposalScanRecordResponse = z.infer<typeof disposalScanRecordResponseSchema>;
