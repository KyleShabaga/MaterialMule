import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import { concreteSpecimenAgeSchema } from './concrete-settings';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C26: HOLD management, bulk HOLD actions and concrete specimen disposal.
//
// - Ordinary HOLD: a spare specimen assigned HOLD (C05). The lead or any Lab Manager (role alone,
//   `concrete_ordinary_hold.manage`) releases it by scheduling a test age or authorizing disposal.
// - Failed-specimen hold: placed by C25 on a tested specimen. Released only by authorizing
//   disposal, by the lead or a Lab Manager holding the project's concrete grant
//   (`concrete_hold.manage`). Reaching an ordinary HOLD date never releases it.
// - Reaching a HOLD expiry only flags the specimen for review (`review_due`); nothing is scheduled,
//   released or disposed of by a date (AC3).
// - Disposal is authorized first, then actual removal is recorded by lab staff
//   (`concrete_specimen.dispose_record`; LAB names the performing person). Authorized-but-not-
//   removed specimens appear in Ready for disposal (MISC-13 list, Concrete specimens filter) and
//   stay distinct from disposed ones.

export const CONCRETE_HOLD_KIND_VALUES = ['ordinary', 'failed'] as const;
export type ConcreteHoldKind = (typeof CONCRETE_HOLD_KIND_VALUES)[number];

export const CONCRETE_HOLD_KIND_LABEL: Record<ConcreteHoldKind, string> = {
  ordinary: 'HOLD',
  failed: 'Failed-specimen hold',
};

/** Where a held specimen stands. `review_due`: the HOLD expiry is reached (a flag only). */
export const CONCRETE_HOLD_STATUSES = [
  'held',
  'review_due',
  'disposal_authorized',
  'disposed',
] as const;
export type ConcreteHoldStatus = (typeof CONCRETE_HOLD_STATUSES)[number];

export const CONCRETE_HOLD_STATUS_LABEL: Record<ConcreteHoldStatus, string> = {
  held: 'On hold',
  review_due: 'Review due',
  disposal_authorized: 'Disposal authorized',
  disposed: 'Disposed',
};

/** The HOLD table's status filter: open = on hold or review due. */
export const CONCRETE_HOLD_STATUS_FILTERS = [
  'open',
  'disposal_authorized',
  'disposed',
  'all',
] as const;
export type ConcreteHoldStatusFilter = (typeof CONCRETE_HOLD_STATUS_FILTERS)[number];

export const CONCRETE_HOLD_PAGE_SIZE = 100;
/** The most specimens one bulk action takes. */
export const CONCRETE_HOLD_BULK_MAX = 200;

/** HOLD status from its facts; the shared rule the API applies. */
export function concreteHoldStatusOf(input: {
  holdKind: ConcreteHoldKind;
  holdExpiresOn: string | null;
  today: string;
  disposalAuthorized: boolean;
  disposed: boolean;
}): ConcreteHoldStatus {
  if (input.disposed) return 'disposed';
  if (input.disposalAuthorized) return 'disposal_authorized';
  if (input.holdKind === 'ordinary' && input.holdExpiresOn !== null) {
    return input.holdExpiresOn <= input.today ? 'review_due' : 'held';
  }
  return 'held';
}

const dateSchema = z.iso.date({ error: 'must be a date (YYYY-MM-DD)' });
const idSchema = z.uuid({ error: 'must be an ID' });

/** `GET /api/concrete/holds` (`inventory.read`). */
export const concreteHoldListQuerySchema = z.strictObject({
  kind: z.enum(['all', ...CONCRETE_HOLD_KIND_VALUES]).default('all'),
  status: z.enum(CONCRETE_HOLD_STATUS_FILTERS).default('open'),
  projectId: idSchema.optional(),
  /** The business date to read as "today"; defaults to the lab's date now. */
  on: dateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ConcreteHoldListQuery = z.infer<typeof concreteHoldListQuerySchema>;

export const concreteDisposalInfoSchema = z.object({
  reason: z.string(),
  authorizedAt: z.string(),
  authorizedBy: personSnapshotSchema,
  disposedAt: z.string().nullable(),
  disposedBy: personSnapshotSchema.nullable(),
  recordedAt: z.string().nullable(),
});
export type ConcreteDisposalInfo = z.infer<typeof concreteDisposalInfoSchema>;

export const concreteHoldRowSchema = z.object({
  specimenId: z.string(),
  setId: z.string(),
  fieldReportId: z.string(),
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  letter: z.string(),
  identity: concreteSpecimenIdentitySchema,
  holdKind: z.enum(CONCRETE_HOLD_KIND_VALUES),
  assignedAge: concreteSpecimenAgeSchema,
  castingDate: z.string().nullable(),
  /** Ordinary HOLD only: casting date + the set's HOLD duration. */
  holdExpiresOn: z.string().nullable(),
  status: z.enum(CONCRETE_HOLD_STATUSES),
  /** Failed-specimen hold only: why it was held (C25). */
  failureReason: z.string().nullable(),
  disposal: concreteDisposalInfoSchema.nullable(),
  /** What the caller may do with this specimen now (the server rechecks on submit). */
  actions: z.object({
    scheduleTest: z.boolean(),
    authorizeDisposal: z.boolean(),
    recordDisposal: z.boolean(),
  }),
  version: z.number().int(),
});
export type ConcreteHoldRow = z.infer<typeof concreteHoldRowSchema>;

export const concreteHoldListSchema = z.object({
  today: z.string(),
  kind: z.enum(['all', ...CONCRETE_HOLD_KIND_VALUES]),
  status: z.enum(CONCRETE_HOLD_STATUS_FILTERS),
  counts: z.object({
    open: z.number().int().min(0),
    disposal_authorized: z.number().int().min(0),
    disposed: z.number().int().min(0),
    all: z.number().int().min(0),
  }),
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  rows: z.array(concreteHoldRowSchema),
  /** Projects with any held specimen, for the filter. */
  projects: z.array(z.object({ id: z.string(), projectNumber: z.string(), name: z.string() })),
});
export type ConcreteHoldList = z.infer<typeof concreteHoldListSchema>;

const reasonSchema = z
  .string({ error: 'A reason is required' })
  .trim()
  .min(1, { error: 'A reason is required' })
  .max(2000, { error: 'Keep the reason under 2000 characters' });

const itemsSchema = z
  .array(z.strictObject({ specimenId: idSchema, version: z.number().int().min(1) }))
  .min(1, { error: 'Choose at least one specimen' })
  .max(CONCRETE_HOLD_BULK_MAX, { error: `at most ${CONCRETE_HOLD_BULK_MAX} specimens at once` })
  .refine((items) => new Set(items.map((i) => i.specimenId)).size === items.length, {
    error: 'Each specimen once',
  });

/**
 * `POST /api/concrete/holds/schedule-test`: ordinary HOLD specimens get a test age in days; the
 * target follows from the casting date (casting + age, never shifted). Owner decision (C22/C38):
 * an age is chosen, not a free date.
 */
export const concreteHoldScheduleTestRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  items: itemsSchema,
  newAge: z
    .number({ error: 'Enter the test age in days' })
    .int({ error: 'Enter whole days' })
    .min(1, { error: 'Enter 1 to 999 days' })
    .max(999, { error: 'Enter 1 to 999 days' }),
  reason: reasonSchema,
});
export type ConcreteHoldScheduleTestRequest = z.infer<typeof concreteHoldScheduleTestRequestSchema>;

/** `POST /api/concrete/holds/authorize-disposal`: never records removal. */
export const concreteHoldAuthorizeDisposalRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  items: itemsSchema,
  reason: reasonSchema,
});
export type ConcreteHoldAuthorizeDisposalRequest = z.infer<
  typeof concreteHoldAuthorizeDisposalRequestSchema
>;

/**
 * `POST /api/concrete/disposal/record` (`concrete_specimen.dispose_record`): actual removal of
 * specimens already authorized. LAB must name the performing staff member.
 */
export const concreteRecordDisposalRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  specimenIds: z
    .array(idSchema)
    .min(1, { error: 'Choose at least one specimen' })
    .max(CONCRETE_HOLD_BULK_MAX, { error: `at most ${CONCRETE_HOLD_BULK_MAX} specimens at once` })
    .refine((ids) => new Set(ids).size === ids.length, { error: 'Each specimen once' }),
  /** When the specimens were physically removed (with offset), not in the future. */
  disposedAt: z.iso.datetime({ offset: true, error: 'Enter the date and time of removal' }),
  performedByUserId: idSchema.optional(),
});
export type ConcreteRecordDisposalRequest = z.infer<typeof concreteRecordDisposalRequestSchema>;

export const CONCRETE_HOLD_PROBLEM_CODES = [
  'not_found',
  'version_conflict',
  'report_void',
  'set_void',
  'not_on_hold',
  'failed_hold',
  'no_casting_time',
  'unnumbered_set',
  'disposal_authorized',
  'not_authorized_for_disposal',
  'disposed',
  'before_authorization',
] as const;
export type ConcreteHoldProblemCode = (typeof CONCRETE_HOLD_PROBLEM_CODES)[number];

export const CONCRETE_HOLD_PROBLEM_LABEL: Record<ConcreteHoldProblemCode, string> = {
  not_found: 'Not found',
  version_conflict: 'Changed since you chose it; reload',
  report_void: 'Its report is Void',
  set_void: 'Its set is Void',
  not_on_hold: 'Not on hold',
  failed_hold: 'A failed-specimen hold can only be released by authorizing disposal',
  no_casting_time: 'Casting time unknown',
  unnumbered_set: 'Its set has no permanent number yet',
  disposal_authorized: 'Already authorized for disposal',
  not_authorized_for_disposal: 'Not authorized for disposal',
  disposed: 'Already disposed',
  before_authorization: 'Removal time is before the disposal authorization',
};

/** 409 body of a bulk action that changed nothing because some specimens aren't eligible. */
export const concreteHoldProblemsSchema = z.object({
  code: z.literal('not_eligible'),
  problems: z.array(
    z.object({ specimenId: z.string(), code: z.enum(CONCRETE_HOLD_PROBLEM_CODES) }),
  ),
});
export type ConcreteHoldProblems = z.infer<typeof concreteHoldProblemsSchema>;

export const concreteHoldActionResultSchema = z.object({
  commandId: z.string(),
  rows: z.array(concreteHoldRowSchema),
});
export type ConcreteHoldActionResult = z.infer<typeof concreteHoldActionResultSchema>;

// ---------------------------------------------------------------------------------------------
// Per-specimen history
// ---------------------------------------------------------------------------------------------

export const CONCRETE_HOLD_EVENT_KINDS = [
  'failure_hold',
  'test_scheduled',
  'disposal_authorized',
  'disposed',
] as const;

export const concreteHoldEventSchema = z.object({
  kind: z.enum(CONCRETE_HOLD_EVENT_KINDS),
  at: z.string(),
  by: personSnapshotSchema,
  /** Recording account when it differs from the performing person (LAB). */
  recordedBy: personSnapshotSchema.nullable(),
  reason: z.string().nullable(),
  /** test_scheduled: the age and target; disposed: the removal time. */
  newAge: z.number().int().nullable(),
  newTargetDate: z.string().nullable(),
  previousHoldExpiresOn: z.string().nullable(),
  disposedAt: z.string().nullable(),
  /** The bulk command the entry belongs to. */
  commandId: z.string().nullable(),
});
export type ConcreteHoldEvent = z.infer<typeof concreteHoldEventSchema>;

export const concreteHoldHistorySchema = z.object({
  specimenId: z.string(),
  identity: concreteSpecimenIdentitySchema,
  events: z.array(concreteHoldEventSchema),
});
export type ConcreteHoldHistory = z.infer<typeof concreteHoldHistorySchema>;

// ---------------------------------------------------------------------------------------------
// Ready for disposal (MISC-13 list, Concrete specimens filter)
// ---------------------------------------------------------------------------------------------

export const concreteDisposalReadyQuerySchema = z.strictObject({
  page: z.coerce.number().int().min(1).default(1),
});

export const concreteDisposalReadyRowSchema = z.object({
  specimenId: z.string(),
  identity: concreteSpecimenIdentitySchema,
  project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  holdKind: z.enum(CONCRETE_HOLD_KIND_VALUES),
  castingDate: z.string().nullable(),
  reason: z.string(),
  authorizedAt: z.string(),
  authorizedBy: personSnapshotSchema,
});
export type ConcreteDisposalReadyRow = z.infer<typeof concreteDisposalReadyRowSchema>;

export const concreteDisposalReadySchema = z.object({
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  specimens: z.array(concreteDisposalReadyRowSchema),
  /** The caller may record actual disposal (lab staff). */
  canRecord: z.boolean(),
  /** LAB: the performing staff member must be chosen. */
  requiresPerformer: z.boolean(),
});
export type ConcreteDisposalReady = z.infer<typeof concreteDisposalReadySchema>;
