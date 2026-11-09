import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import { concreteSpecimenAgeSchema } from './concrete-settings';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C06: specimen pickup and initial curing, the Pick up window, lab receipt (one unmoulded
// mass in grams to 0.1 g), mass corrections, per-set permanent-marker confirmation, receiving
// exceptions and the receiving blockers (migration 0026). Source: combined plan field-sheet rows
// "Pickup", "Initial curing" and "Receiving", the Receiving screen, CD-29–CD-34 and CD-46.
//
// Pending, never defaulted (CD-62): the CSA/ASTM pickup window bounds and initial-curing limits.
// The Pick up window starts at 24 h from casting, editable, and is not a verified deadline; the
// curing check compares with a configured standards range only when one exists (none is seeded).
//
// Not here: the Receiving and pickup screens, scale capture (CD-70), background alerts,
// final-review submission (C19 applies these blockers) and the full exception-resolution UI.

const idSchema = z.uuid({ error: 'must be an ID' });
const timestampSchema = z.iso.datetime({ offset: true, error: 'must be a date and time' });
const keySchema = z.uuid({ error: 'must be an ID' });

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { error: `Keep the ${label} under ${max} characters` })
    .transform((value) => (value === '' ? null : value))
    .nullable();

const requiredText = (max: number, message: string) =>
  z
    .string({ error: message })
    .trim()
    .min(1, { error: message })
    .max(max, { error: `Keep it under ${max} characters` });

// ---------------------------------------------------------------------------------------------
// Pick up window
// ---------------------------------------------------------------------------------------------

/** The starting Pick up window, in hours from casting (Kyle). Not a verified standards limit. */
export const CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS = 24;
/** Becomes true only when CD-62 (CSA/ASTM pickup rules) is answered. */
export const CONCRETE_PICKUP_WINDOW_VERIFIED = false;
export const CONCRETE_PICKUP_WINDOW_MAX_HOURS = 336;

/** When the window closes, from the casting time (ISO); null while casting is unknown. */
export function concretePickupWindowEndsAt(castAt: string | null, hours: number): string | null {
  if (castAt === null) return null;
  return new Date(Date.parse(castAt) + hours * 3_600_000).toISOString();
}

// ---------------------------------------------------------------------------------------------
// Decimal values: grams to 0.1 g, °C to 0.1 °C, never rounded
// ---------------------------------------------------------------------------------------------

export const CONCRETE_MASS_PATTERN = /^[0-9]{1,6}(\.[0-9])?$/;
export const CONCRETE_TEMPERATURE_PATTERN = /^-?[0-9]{1,2}(\.[0-9])?$/;

/** Strips a trailing ".0"-style zero beyond the tenth ("12345.60" → "12345.6"); never rounds. */
function decimalText(value: string | number): string {
  const text = typeof value === 'number' ? String(value) : value.trim();
  const match = /^(-?[0-9]+)(?:\.([0-9]*?)0*)?$/.exec(text);
  if (!match) return text;
  return match[2] ? `${match[1]}.${match[2]}` : match[1]!;
}

/**
 * A receiving mass in grams, unmoulded, to one decimal (decision 3, §10). Accepts a number or a
 * decimal string; more than one decimal is refused, not rounded. The value is the decimal text
 * the database stores exactly (numeric(7,1)).
 */
export const concreteMassSchema = z
  .union([z.number({ error: 'Enter the mass in grams' }), z.string()], {
    error: 'Enter the mass in grams',
  })
  .transform((value) => decimalText(value))
  .refine((text) => CONCRETE_MASS_PATTERN.test(text), {
    error: 'Enter grams with at most one decimal place (0.1 g)',
  })
  .refine((text) => Number(text) > 0, { error: 'The mass must be more than 0 g' });

/** An initial-curing temperature in °C to one decimal. Missing is null, never 0. */
export const concreteTemperatureSchema = z
  .union([z.number({ error: 'Enter the temperature in °C' }), z.string()], {
    error: 'Enter the temperature in °C',
  })
  .transform((value) => decimalText(value))
  .refine((text) => CONCRETE_TEMPERATURE_PATTERN.test(text), {
    error: 'Enter °C between -99.9 and 99.9 with at most one decimal place',
  });

/** "12345.6" / "12345" → "12345.6" / "12345.0", the one-decimal display form. */
export function concreteFormatTenths(value: string): string {
  const [whole, fraction = '0'] = value.split('.');
  return `${whole}.${fraction.slice(0, 1).padEnd(1, '0')}`;
}

// ---------------------------------------------------------------------------------------------
// Curing check (CD-32)
// ---------------------------------------------------------------------------------------------

export const CONCRETE_CURING_FLAGS = ['min_below_range', 'max_above_range'] as const;
export type ConcreteCuringFlag = (typeof CONCRETE_CURING_FLAGS)[number];

export const concreteCuringRangeSchema = z.object({
  id: z.string(),
  specification: z.string(),
  edition: z.string(),
  minC: z.string(),
  maxC: z.string(),
});
export type ConcreteCuringRange = z.infer<typeof concreteCuringRangeSchema>;

/**
 * Flags for recorded readings against a configured range: a minimum below the lower bound, a
 * maximum above the upper bound. Null when nothing can be checked (no range, or a reading
 * missing). Never blocks pickup, receipt or submission; it is an issuance gate.
 */
export function concreteCuringFlags(
  readings: { minC: string | null; maxC: string | null },
  range: { minC: string; maxC: string } | null,
): ConcreteCuringFlag[] | null {
  if (!range || readings.minC === null || readings.maxC === null) return null;
  const flags: ConcreteCuringFlag[] = [];
  if (Number(readings.minC) < Number(range.minC)) flags.push('min_below_range');
  if (Number(readings.maxC) > Number(range.maxC)) flags.push('max_above_range');
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/concrete/specimen-sets/:setId/pickup` (`concrete_specimen.receive`, lab staff).
 * Records the same pickup details on each selected specimen (partial pickup: select fewer).
 * `complete: true` is "Mark picked up" and needs collector, date/time and both curing readings
 * (422 `pickup_incomplete` listing what is missing); `complete: false` saves what is known.
 * Every field is the whole new value: absent or null clears it. A personal account that omits
 * `collectedByUserId` is the collector; a LAB station names the actual collector.
 */
export const concretePickupRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  specimens: z
    .array(
      z.strictObject({
        id: idSchema,
        /** The specimen's pickup version as read; null when it has no pickup record yet. */
        version: z.number().int().min(1).nullable(),
      }),
      { error: 'Choose the specimens collected' },
    )
    .min(1, { error: 'Choose the specimens collected' })
    .max(26),
  complete: z.boolean({ error: 'Say whether the pickup is complete' }),
  collectedByUserId: idSchema.nullable().optional(),
  collectedAt: timestampSchema.nullable().optional(),
  curingMinC: concreteTemperatureSchema.nullable().optional(),
  curingMaxC: concreteTemperatureSchema.nullable().optional(),
  curingBox: optionalText(100, 'curing box').optional(),
  curingLocation: optionalText(200, 'location').optional(),
});
export type ConcretePickupRequest = z.infer<typeof concretePickupRequestSchema>;

/** What a completed pickup still needs (AC1), as request field names. */
export function concretePickupMissing(input: {
  collectedByUserId: string | null;
  collectedAt: string | null;
  curingMinC: string | null;
  curingMaxC: string | null;
}): ('collectedByUserId' | 'collectedAt' | 'curingMinC' | 'curingMaxC')[] {
  const missing: ('collectedByUserId' | 'collectedAt' | 'curingMinC' | 'curingMaxC')[] = [];
  if (input.collectedByUserId === null) missing.push('collectedByUserId');
  if (input.collectedAt === null) missing.push('collectedAt');
  if (input.curingMinC === null) missing.push('curingMinC');
  if (input.curingMaxC === null) missing.push('curingMaxC');
  return missing;
}

/** `PUT /api/concrete/specimen-sets/:setId/pickup-window` (`concrete_specimen.receive`). */
export const concretePickupWindowRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  /** The window's version as read; null while it is the default. */
  version: z.number().int().min(1).nullable(),
  hours: z
    .number({ error: 'Enter the window in hours' })
    .int({ error: 'Enter whole hours' })
    .min(1, { error: `Enter 1 to ${CONCRETE_PICKUP_WINDOW_MAX_HOURS} hours` })
    .max(CONCRETE_PICKUP_WINDOW_MAX_HOURS, {
      error: `Enter 1 to ${CONCRETE_PICKUP_WINDOW_MAX_HOURS} hours`,
    }),
});
export type ConcretePickupWindowRequest = z.infer<typeof concretePickupWindowRequestSchema>;

/**
 * `POST /api/concrete/specimens/:specimenId/receipt` (`concrete_specimen.receive`). Saving the
 * mass marks the specimen received with its actual receiver and time; each specimen saves on its
 * own (partial arrivals), with or without a pickup record. A personal account that omits
 * `receivedByUserId` is the receiver; a LAB station names the actual receiver.
 */
export const concreteReceiptRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  receivedAt: timestampSchema,
  receivedByUserId: idSchema.optional(),
  massG: concreteMassSchema,
});
export type ConcreteReceiptRequest = z.infer<typeof concreteReceiptRequestSchema>;

/**
 * `POST /api/concrete/specimens/:specimenId/mass-correction` (`concrete_specimen.mass_correct`,
 * CD-46): any lab staff on a personal account, with a reason. Kept as history.
 */
export const concreteMassCorrectionRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  /** The receipt version as read. */
  version: z.number({ error: 'Version is required' }).int().min(1),
  massG: concreteMassSchema,
  reason: requiredText(2000, 'A reason is required'),
});
export type ConcreteMassCorrectionRequest = z.infer<typeof concreteMassCorrectionRequestSchema>;

/**
 * `POST /api/concrete/specimen-sets/:setId/marker-confirmation` (`concrete_specimen.receive`):
 * "Permanent IDs added to all received specimens". Covers the set's received specimens that no
 * earlier confirmation covers; a specimen received later needs a confirmation of its own (AC6).
 */
export const concreteMarkerConfirmationRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  confirmedAt: timestampSchema,
  confirmedByUserId: idSchema.optional(),
});
export type ConcreteMarkerConfirmationRequest = z.infer<
  typeof concreteMarkerConfirmationRequestSchema
>;

export const CONCRETE_RECEIVING_EXCEPTION_KINDS = ['missing', 'extra', 'unmatched'] as const;
export type ConcreteReceivingExceptionKind = (typeof CONCRETE_RECEIVING_EXCEPTION_KINDS)[number];

/**
 * `POST /api/concrete/projects/:projectId/receiving-exceptions` (`concrete_specimen.receive`).
 * missing: `specimenId` (its set follows). extra: optionally the `setId` it seems to belong to;
 * never added to that set. unmatched: the `observedMarking` as written. Extra / unmatched may
 * carry the actual receipt (`receivedAt` with `massG`), kept unresolved until confirmed.
 * A LAB station names the person reporting it (`reportedByUserId`).
 */
export const concreteReceivingExceptionRequestSchema = z
  .strictObject({
    idempotencyKey: keySchema,
    id: idSchema.optional(),
    kind: z.enum(CONCRETE_RECEIVING_EXCEPTION_KINDS, { error: 'Choose missing, extra or unmatched' }),
    specimenId: idSchema.optional(),
    setId: idSchema.optional(),
    observedMarking: optionalText(200, 'marking').optional(),
    note: optionalText(2000, 'note').optional(),
    receivedAt: timestampSchema.optional(),
    receivedByUserId: idSchema.optional(),
    massG: concreteMassSchema.optional(),
    reportedByUserId: idSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'missing') {
      if (!value.specimenId) {
        ctx.addIssue({ code: 'custom', path: ['specimenId'], message: 'Choose the missing specimen' });
      }
      for (const field of ['setId', 'receivedAt', 'receivedByUserId', 'massG'] as const) {
        if (value[field] !== undefined) {
          ctx.addIssue({ code: 'custom', path: [field], message: 'Not for a missing specimen' });
        }
      }
    } else {
      if (value.specimenId !== undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['specimenId'],
          message: 'An extra or unmatched specimen is not one of the set',
        });
      }
      if (value.massG !== undefined && value.receivedAt === undefined) {
        ctx.addIssue({ code: 'custom', path: ['receivedAt'], message: 'When was it received?' });
      }
      if (value.kind === 'unmatched' && !value.observedMarking) {
        ctx.addIssue({
          code: 'custom',
          path: ['observedMarking'],
          message: 'Write what the marking shows',
        });
      }
    }
  });
export type ConcreteReceivingExceptionRequest = z.infer<
  typeof concreteReceivingExceptionRequestSchema
>;

/**
 * `POST /api/concrete/receiving-exceptions/:id/resolve` (`concrete_receiving_exception.resolve`:
 * the lead, a designated `concrete_field` reviewer, a concrete-grant Lab Manager, or the casting
 * technician for specimens they cast; personal account). Disposition and reason required. An
 * extra / unmatched record may be confirmed as an existing specimen (`matchedSpecimenId`); its
 * recorded receipt then becomes that specimen's receipt, linked to this record.
 */
export const concreteResolveReceivingExceptionRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  disposition: requiredText(200, 'A disposition is required'),
  reason: requiredText(2000, 'A reason is required'),
  matchedSpecimenId: idSchema.optional(),
});
export type ConcreteResolveReceivingExceptionRequest = z.infer<
  typeof concreteResolveReceivingExceptionRequestSchema
>;

/**
 * `POST /api/concrete/specimens/:specimenId/curing-resolution` (`concrete.review`: the lead or a
 * designated `concrete_field` reviewer; personal account). Resolves or documents an
 * out-of-range curing flag before issuance, keeping the readings, range and flag.
 */
export const concreteCuringResolutionRequestSchema = z.strictObject({
  idempotencyKey: keySchema,
  /** The pickup version as read. */
  version: z.number({ error: 'Version is required' }).int().min(1),
  note: requiredText(2000, 'Say how it was resolved'),
});
export type ConcreteCuringResolutionRequest = z.infer<typeof concreteCuringResolutionRequestSchema>;

export const concreteReceivingExceptionQuerySchema = z.strictObject({
  status: z.enum(['open', 'resolved', 'all']).default('open'),
  page: z.coerce.number().int().min(1).default(1),
});
export const CONCRETE_RECEIVING_EXCEPTION_PAGE_SIZE = 50;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const concretePickupSchema = z.object({
  id: z.string(),
  completed: z.boolean(),
  collectedBy: personSnapshotSchema.nullable(),
  collectedAt: z.string().nullable(),
  curingMinC: z.string().nullable(),
  curingMaxC: z.string().nullable(),
  curingBox: z.string().nullable(),
  curingLocation: z.string().nullable(),
  /** The range applied to these readings (kept even after a newer range), or null: not checked. */
  curingRange: concreteCuringRangeSchema.nullable(),
  curingFlags: z.array(z.enum(CONCRETE_CURING_FLAGS)).nullable(),
  curingResolution: z
    .object({ at: z.string(), by: personSnapshotSchema, note: z.string() })
    .nullable(),
  recordedBy: personSnapshotSchema,
  updatedAt: z.string(),
  version: z.number().int(),
});
export type ConcretePickup = z.infer<typeof concretePickupSchema>;

export const concreteMassCorrectionEntrySchema = z.object({
  id: z.string(),
  previousMassG: z.string(),
  newMassG: z.string(),
  reason: z.string(),
  by: personSnapshotSchema,
  at: z.string(),
});

export const concreteReceiptSchema = z.object({
  id: z.string(),
  receivedAt: z.string(),
  receivedBy: personSnapshotSchema,
  /** One decimal place, exactly as stored ("12345.6"). */
  massG: z.string(),
  recordedBy: personSnapshotSchema,
  fromExceptionId: z.string().nullable(),
  corrections: z.array(concreteMassCorrectionEntrySchema),
  version: z.number().int(),
});
export type ConcreteReceipt = z.infer<typeof concreteReceiptSchema>;

export const concreteReceivingExceptionSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  kind: z.enum(CONCRETE_RECEIVING_EXCEPTION_KINDS),
  setId: z.string().nullable(),
  specimenId: z.string().nullable(),
  observedMarking: z.string().nullable(),
  note: z.string().nullable(),
  receivedAt: z.string().nullable(),
  receivedBy: personSnapshotSchema.nullable(),
  massG: z.string().nullable(),
  reportedBy: personSnapshotSchema,
  recordedBy: personSnapshotSchema,
  createdAt: z.string(),
  resolution: z
    .object({
      at: z.string(),
      by: personSnapshotSchema,
      source: z.string(),
      disposition: z.string(),
      reason: z.string(),
      matchedSpecimenId: z.string().nullable(),
    })
    .nullable(),
});
export type ConcreteReceivingException = z.infer<typeof concreteReceivingExceptionSchema>;

export const concreteMarkerConfirmationSchema = z.object({
  id: z.string(),
  confirmedAt: z.string(),
  confirmedBy: personSnapshotSchema,
  recordedBy: personSnapshotSchema,
  specimenIds: z.array(z.string()),
});

export const CONCRETE_RECEIVING_SPECIMEN_STATES = [
  'awaiting_pickup',
  'picked_up',
  'received',
  'missing_resolved',
] as const;
export type ConcreteReceivingSpecimenState = (typeof CONCRETE_RECEIVING_SPECIMEN_STATES)[number];

export const concreteReceivingSpecimenSchema = z.object({
  specimenId: z.string(),
  letter: z.string(),
  identity: concreteSpecimenIdentitySchema,
  assignedAge: concreteSpecimenAgeSchema.nullable(),
  state: z.enum(CONCRETE_RECEIVING_SPECIMEN_STATES),
  pickup: concretePickupSchema.nullable(),
  receipt: concreteReceiptSchema.nullable(),
  markerConfirmationId: z.string().nullable(),
  openExceptionIds: z.array(z.string()),
});
export type ConcreteReceivingSpecimen = z.infer<typeof concreteReceivingSpecimenSchema>;

/**
 * What still stops final review submission (combined plan blockers table). Computed, never
 * stored; C19 applies them to submission. A specimen with a resolved missing disposition is no
 * longer expected.
 */
export const CONCRETE_RECEIVING_BLOCKERS = [
  'pickup_incomplete',
  'not_received',
  'missing_unresolved',
  'identity_unresolved',
  'marker_confirmation_missing',
] as const;
export type ConcreteReceivingBlocker = (typeof CONCRETE_RECEIVING_BLOCKERS)[number];
/** Gates issuance only, never pickup, receipt or submission (CD-32). */
export const CONCRETE_RECEIVING_ISSUANCE_GATES = ['curing_out_of_range_unresolved'] as const;

export const concreteReceivingIssueSchema = z.object({
  code: z.string(),
  specimenIds: z.array(z.string()),
  exceptionIds: z.array(z.string()),
});
export type ConcreteReceivingIssue = z.infer<typeof concreteReceivingIssueSchema>;

export interface ConcreteReceivingBlockerInput {
  setVoided: boolean;
  specimens: readonly {
    specimenId: string;
    pickupCompleted: boolean;
    received: boolean;
    markerCovered: boolean;
    missingResolved: boolean;
    curingUnresolvedFlag: boolean;
  }[];
  exceptions: readonly {
    id: string;
    kind: ConcreteReceivingExceptionKind;
    specimenId: string | null;
    resolved: boolean;
  }[];
}

/** The blockers and issuance gates for one set (AC3), from its stored records. */
export function concreteReceivingIssues(input: ConcreteReceivingBlockerInput): {
  blockers: ConcreteReceivingIssue[];
  issuanceGates: ConcreteReceivingIssue[];
} {
  if (input.setVoided) return { blockers: [], issuanceGates: [] };
  const expected = input.specimens.filter((s) => !s.missingResolved);
  const issue = (code: string, specimenIds: string[], exceptionIds: string[] = []) => ({
    code,
    specimenIds,
    exceptionIds,
  });
  const blockers: ConcreteReceivingIssue[] = [];
  const pickup = expected.filter((s) => !s.pickupCompleted).map((s) => s.specimenId);
  if (pickup.length > 0) blockers.push(issue('pickup_incomplete', pickup));
  const notReceived = expected.filter((s) => !s.received).map((s) => s.specimenId);
  if (notReceived.length > 0) blockers.push(issue('not_received', notReceived));
  const missing = input.exceptions.filter((e) => e.kind === 'missing' && !e.resolved);
  if (missing.length > 0) {
    blockers.push(
      issue(
        'missing_unresolved',
        missing.map((e) => e.specimenId!).filter(Boolean),
        missing.map((e) => e.id),
      ),
    );
  }
  const identity = input.exceptions.filter((e) => e.kind !== 'missing' && !e.resolved);
  if (identity.length > 0) {
    blockers.push(issue('identity_unresolved', [], identity.map((e) => e.id)));
  }
  const unmarked = expected.filter((s) => s.received && !s.markerCovered).map((s) => s.specimenId);
  if (unmarked.length > 0) blockers.push(issue('marker_confirmation_missing', unmarked));
  const curing = input.specimens.filter((s) => s.curingUnresolvedFlag).map((s) => s.specimenId);
  return {
    blockers,
    issuanceGates: curing.length > 0 ? [issue('curing_out_of_range_unresolved', curing)] : [],
  };
}

export const concreteSetReceivingSchema = z.object({
  setId: z.string(),
  fieldReportId: z.string(),
  projectId: z.string(),
  identity: z.object({ temporaryId: z.string().nullable(), permanentId: z.string().nullable() }),
  castAt: z.string().nullable(),
  technician: personSnapshotSchema.nullable(),
  voided: z.boolean(),
  pickupWindow: z.object({
    hours: z.number().int(),
    source: z.enum(['default', 'edited']),
    /** Casting + hours; an estimate, never an actual pickup. */
    endsAt: z.string().nullable(),
    /** False until CD-62 confirms the CSA/ASTM rule. */
    verified: z.boolean(),
    version: z.number().int().nullable(),
  }),
  /** The range a new check would use now; null when none is configured. */
  currentCuringRange: concreteCuringRangeSchema.nullable(),
  specimens: z.array(concreteReceivingSpecimenSchema),
  markerConfirmations: z.array(concreteMarkerConfirmationSchema),
  exceptions: z.array(concreteReceivingExceptionSchema),
  blockers: z.array(concreteReceivingIssueSchema),
  issuanceGates: z.array(concreteReceivingIssueSchema),
});
export type ConcreteSetReceiving = z.infer<typeof concreteSetReceivingSchema>;

export const concreteReportReceivingSchema = z.object({
  fieldReportId: z.string(),
  sets: z.array(concreteSetReceivingSchema),
  /** Every set's blockers together; empty when nothing blocks submission on receiving grounds. */
  blockers: z.array(concreteReceivingIssueSchema.extend({ setId: z.string() })),
  issuanceGates: z.array(concreteReceivingIssueSchema.extend({ setId: z.string() })),
});
export type ConcreteReportReceiving = z.infer<typeof concreteReportReceivingSchema>;

export const concreteReceivingExceptionListSchema = z.object({
  items: z.array(concreteReceivingExceptionSchema),
  page: z.number().int(),
  pageSize: z.number().int(),
  total: z.number().int(),
});
export type ConcreteReceivingExceptionList = z.infer<typeof concreteReceivingExceptionListSchema>;
