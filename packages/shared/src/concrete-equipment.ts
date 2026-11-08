import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// Concrete equipment register (MM-V2-C27, migration 0018): the one testing machine and the air
// meters, each with an append-only calibration history.
//
// Confirmed (CD-44, CD-45): one testing machine (no per-test selector) whose make, model and last
// and next calibration the Lab Manager keeps with history; air meters registered and assigned to
// technicians, and a field report's air-meter ID autofills from the performing technician's
// meter (optional, editable). Overdue calibration or an unresolved equipment issue flags the work
// when the equipment is used; work is still recorded and only needs review before issuance.
//
// Gated (owner inputs): the air-meter calibration form is not mapped, so a calibration entry holds
// only the fields the card lists (date, next due, performer, result as free text); procedure
// readings come with the form. Attachments are C15's. The overdue rule uses the recorded next-due
// date only: there is no calibration interval anywhere. The due-date boundary procedure is open,
// so use ON the due date gets its own flag, separate from use after it (both only warn).

export const CONCRETE_EQUIPMENT_KINDS = ['testing_machine', 'air_meter'] as const;
export const concreteEquipmentKindSchema = z.enum(CONCRETE_EQUIPMENT_KINDS, {
  error: 'Choose testing machine or air meter',
});
export type ConcreteEquipmentKind = z.infer<typeof concreteEquipmentKindSchema>;

export const CONCRETE_EQUIPMENT_KIND_LABEL: Record<ConcreteEquipmentKind, string> = {
  testing_machine: 'Testing machine',
  air_meter: 'Air meter',
};

/** `out_of_service`: an unresolved equipment issue (flags use). `retired`: final. */
export const CONCRETE_EQUIPMENT_STATUSES = ['in_service', 'out_of_service', 'retired'] as const;
export const concreteEquipmentStatusSchema = z.enum(CONCRETE_EQUIPMENT_STATUSES, {
  error: 'Choose in service, out of service or retired',
});
export type ConcreteEquipmentStatus = z.infer<typeof concreteEquipmentStatusSchema>;

export const CONCRETE_EQUIPMENT_STATUS_LABEL: Record<ConcreteEquipmentStatus, string> = {
  in_service: 'In service',
  out_of_service: 'Out of service',
  retired: 'Retired',
};

/** The permission that manages each kind (docs/permissions.md, MM-V2-C27). */
export const CONCRETE_EQUIPMENT_MANAGE_PERMISSION: Record<ConcreteEquipmentKind, string> = {
  testing_machine: 'concrete_settings.testing_machine.manage',
  air_meter: 'concrete_settings.air_meter.manage',
};

// ---------------------------------------------------------------------------------------------
// The flag rule (T1)
// ---------------------------------------------------------------------------------------------

export const CONCRETE_EQUIPMENT_FLAGS = [
  'no_calibration_recorded',
  'calibration_overdue',
  'calibration_due_on_use_date',
  'equipment_out_of_service',
  'equipment_retired',
] as const;
export const concreteEquipmentFlagSchema = z.enum(CONCRETE_EQUIPMENT_FLAGS);
export type ConcreteEquipmentFlag = z.infer<typeof concreteEquipmentFlagSchema>;

export const CONCRETE_EQUIPMENT_FLAG_LABEL: Record<ConcreteEquipmentFlag, string> = {
  no_calibration_recorded: 'No calibration recorded for this date',
  calibration_overdue: 'Calibration overdue',
  calibration_due_on_use_date: 'Calibration due on this date',
  equipment_out_of_service: 'Out of service',
  equipment_retired: 'Retired',
};

/** The fields of a calibration entry the rule reads. Dates are YYYY-MM-DD. */
export interface CalibrationForRule {
  id: string;
  entryNumber: number;
  calibratedOn: string;
  nextDueOn: string;
  voided: boolean;
}

/**
 * The calibration in effect on `useDate`: the latest entry not voided whose calibration date is on
 * or before that date (ties: the higher entry number). Null when none.
 */
export function calibrationInEffect<T extends CalibrationForRule>(
  calibrations: readonly T[],
  useDate: string,
): T | null {
  let best: T | null = null;
  for (const entry of calibrations) {
    if (entry.voided || entry.calibratedOn > useDate) continue;
    if (
      !best ||
      entry.calibratedOn > best.calibratedOn ||
      (entry.calibratedOn === best.calibratedOn && entry.entryNumber > best.entryNumber)
    ) {
      best = entry;
    }
  }
  return best;
}

/**
 * CD-45: the warnings for using equipment on `useDate` (YYYY-MM-DD, business time zone). Uses the
 * recorded next-due date only; never an interval. Flags warn and never block. Status is the
 * equipment's current status (use is recorded as it happens; later status changes don't rewrite
 * flags a result already stored).
 */
export function concreteEquipmentFlags(
  equipment: { status: ConcreteEquipmentStatus },
  calibrations: readonly CalibrationForRule[],
  useDate: string,
): { calibration: CalibrationForRule | null; flags: ConcreteEquipmentFlag[] } {
  const calibration = calibrationInEffect(calibrations, useDate);
  const flags: ConcreteEquipmentFlag[] = [];
  if (equipment.status === 'retired') flags.push('equipment_retired');
  if (equipment.status === 'out_of_service') flags.push('equipment_out_of_service');
  if (!calibration) flags.push('no_calibration_recorded');
  else if (useDate > calibration.nextDueOn) flags.push('calibration_overdue');
  else if (useDate === calibration.nextDueOn) flags.push('calibration_due_on_use_date');
  return { calibration, flags };
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/** One-line text, trimmed; blank becomes null (cleared). */
function optionalLine(label: string, max: number) {
  return z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, { error: `${label} must be ${max} characters or fewer` })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: `${label} can't contain control characters`,
    })
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

function requiredLine(label: string, max: number) {
  return z
    .string({ error: `${label} is required` })
    .trim()
    .min(1, { error: `${label} is required` })
    .max(max, { error: `${label} must be ${max} characters or fewer` })
    .refine((value) => !CONTROL_CHARACTERS.test(value), {
      message: `${label} can't contain control characters`,
    });
}

/** Multi-line text, trimmed; blank becomes null. */
function optionalText(label: string, max: number) {
  return z
    .string({ error: `${label} must be text` })
    .trim()
    .max(max, { error: `${label} must be ${max} characters or fewer` })
    .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
      message: `${label} can't contain control characters`,
    })
    .transform((value) => (value === '' ? null : value))
    .nullable();
}

const isoDate = (label: string) => z.iso.date({ error: `${label} must be a date (YYYY-MM-DD)` });

const idempotencyKey = z.uuid({ error: 'Idempotency key must be a UUID' });

/** `POST /api/concrete/equipment`. An air meter needs its ID; only an air meter is assigned. */
export const createConcreteEquipmentRequestSchema = z
  .strictObject({
    kind: concreteEquipmentKindSchema,
    identifier: optionalLine('Equipment ID', 40).optional(),
    description: optionalText('Description', 500).optional(),
    make: optionalLine('Make', 120).optional(),
    model: optionalLine('Model', 120).optional(),
    assignedUserId: z.uuid({ error: 'Choose a technician' }).nullable().optional(),
    idempotencyKey,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'air_meter' && !value.identifier) {
      ctx.addIssue({ code: 'custom', path: ['identifier'], message: 'Air meter ID is required' });
    }
    if (value.kind !== 'air_meter' && value.assignedUserId) {
      ctx.addIssue({
        code: 'custom',
        path: ['assignedUserId'],
        message: 'Only an air meter is assigned to a technician',
      });
    }
  });
export type CreateConcreteEquipmentRequest = z.input<typeof createConcreteEquipmentRequestSchema>;

/**
 * `PATCH /api/concrete/equipment/:id`. Omitted fields are unchanged; `null` clears. Out of service
 * and retired need a status note (why); returning to service clears it. Retiring unassigns.
 */
export const updateConcreteEquipmentRequestSchema = z.strictObject({
  version: z
    .number({ error: 'Version is required' })
    .int({ error: 'Version is required' })
    .min(1, { error: 'Version is required' }),
  identifier: optionalLine('Equipment ID', 40).optional(),
  description: optionalText('Description', 500).optional(),
  make: optionalLine('Make', 120).optional(),
  model: optionalLine('Model', 120).optional(),
  assignedUserId: z.uuid({ error: 'Choose a technician' }).nullable().optional(),
  status: concreteEquipmentStatusSchema.optional(),
  statusNote: optionalText('Status note', 2000).optional(),
  reason: optionalText('Reason', 2000).optional(),
});
export type UpdateConcreteEquipmentRequest = z.input<typeof updateConcreteEquipmentRequestSchema>;

/** The equipment fields a save may change, as audited. */
export const CONCRETE_EQUIPMENT_FIELDS = [
  'identifier',
  'description',
  'make',
  'model',
  'assignedUserId',
  'status',
  'statusNote',
] as const;
export type ConcreteEquipmentField = (typeof CONCRETE_EQUIPMENT_FIELDS)[number];

/**
 * `POST /api/concrete/equipment/:id/calibrations`: the history fields the card lists. The
 * air-meter procedure readings are gated on the calibration form (owner input) and attachments
 * on C15; neither is accepted here.
 */
export const recordConcreteCalibrationRequestSchema = z
  .strictObject({
    calibratedOn: isoDate('Calibration date'),
    nextDueOn: isoDate('Next due date'),
    performedBy: requiredLine('Performed by', 200),
    result: optionalText('Result', 2000).optional(),
    idempotencyKey,
  })
  .superRefine((value, ctx) => {
    if (value.nextDueOn <= value.calibratedOn) {
      ctx.addIssue({
        code: 'custom',
        path: ['nextDueOn'],
        message: 'Next due date must be after the calibration date',
      });
    }
  });
export type RecordConcreteCalibrationRequest = z.input<
  typeof recordConcreteCalibrationRequestSchema
>;

/** `POST /api/concrete/equipment/:id/calibrations/:calibrationId/void`: the entry stays listed. */
export const voidConcreteCalibrationRequestSchema = z.strictObject({
  reason: requiredLine('Reason', 2000),
});
export type VoidConcreteCalibrationRequest = z.input<typeof voidConcreteCalibrationRequestSchema>;

/** `GET /api/concrete/equipment?kind=&includeRetired=`. */
export const concreteEquipmentListQuerySchema = z.strictObject({
  kind: concreteEquipmentKindSchema.optional(),
  includeRetired: z
    .enum(['true', 'false'], { error: 'includeRetired must be true or false' })
    .transform((value) => value === 'true')
    .optional(),
});

/** `GET /api/concrete/equipment/:id/use-check?on=` (default: today in the business time zone). */
export const concreteEquipmentUseQuerySchema = z.strictObject({
  on: isoDate('Date').optional(),
});

/** `GET /api/concrete/air-meters/assigned?technicianUserId=&on=`: the field-report autofill. */
export const assignedAirMeterQuerySchema = z.strictObject({
  technicianUserId: z.uuid({ error: 'Choose a technician' }),
  on: isoDate('Date').optional(),
});

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const concreteCalibrationSchema = z.object({
  id: z.string(),
  entryNumber: z.number(),
  calibratedOn: z.string(),
  nextDueOn: z.string(),
  performedBy: z.string(),
  result: z.string().nullable(),
  recordedAt: z.string(),
  recordedBy: personSnapshotSchema,
  voided: z.boolean(),
  voidedAt: z.string().nullable(),
  voidedBy: personSnapshotSchema.nullable(),
  voidReason: z.string().nullable(),
});
export type ConcreteCalibration = z.infer<typeof concreteCalibrationSchema>;

export const concreteEquipmentSchema = z.object({
  id: z.string(),
  kind: concreteEquipmentKindSchema,
  identifier: z.string().nullable(),
  description: z.string().nullable(),
  make: z.string().nullable(),
  model: z.string().nullable(),
  assignedTo: personSnapshotSchema.nullable(),
  status: concreteEquipmentStatusSchema,
  statusNote: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
  updatedBy: personSnapshotSchema,
  version: z.number(),
  /** The calibration in effect today (business time zone): last calibration and next due. */
  currentCalibration: concreteCalibrationSchema.nullable(),
  /** What using it today would flag. */
  flagsToday: z.array(concreteEquipmentFlagSchema),
  /** The caller may manage this kind, as it stands. */
  canManage: z.boolean(),
});
export type ConcreteEquipment = z.infer<typeof concreteEquipmentSchema>;

export const concreteEquipmentListSchema = z.object({
  today: z.string(),
  items: z.array(concreteEquipmentSchema),
  canManage: z.record(concreteEquipmentKindSchema, z.boolean()),
});
export type ConcreteEquipmentList = z.infer<typeof concreteEquipmentListSchema>;

/** One audited change to the equipment record or its calibration history, newest first. */
export const concreteEquipmentEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  changedBy: personSnapshotSchema.nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
});
export type ConcreteEquipmentEvent = z.infer<typeof concreteEquipmentEventSchema>;

export const CONCRETE_EQUIPMENT_HISTORY_LIMIT = 100;

export const concreteEquipmentDetailSchema = concreteEquipmentSchema.extend({
  today: z.string(),
  /** Every calibration entry, voided ones included, newest entry first. */
  calibrations: z.array(concreteCalibrationSchema),
  history: z.array(concreteEquipmentEventSchema),
  historyTotal: z.number(),
});
export type ConcreteEquipmentDetail = z.infer<typeof concreteEquipmentDetailSchema>;

/**
 * What using the equipment on `useDate` flags, for the record that uses it to store with itself
 * (field report air meter, testing-table result): the equipment and calibration entry in effect.
 */
export const concreteEquipmentUseSchema = z.object({
  equipmentId: z.string(),
  useDate: z.string(),
  calibrationId: z.string().nullable(),
  nextDueOn: z.string().nullable(),
  flags: z.array(concreteEquipmentFlagSchema),
});
export type ConcreteEquipmentUse = z.infer<typeof concreteEquipmentUseSchema>;

/**
 * The autofill: the technician's assigned air meter that is not retired, when exactly one. With
 * none or several, `meter` is null and the field stays for the technician to fill (it is optional).
 */
export const assignedAirMeterSchema = z.object({
  technicianUserId: z.string(),
  useDate: z.string(),
  assignedCount: z.number(),
  meter: concreteEquipmentSchema.nullable(),
  use: concreteEquipmentUseSchema.nullable(),
});
export type AssignedAirMeter = z.infer<typeof assignedAirMeterSchema>;

/** 409 body when the equipment changed since it was loaded. */
export const concreteEquipmentVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteEquipmentDetailSchema,
});
export type ConcreteEquipmentVersionConflictResponse = z.infer<
  typeof concreteEquipmentVersionConflictResponseSchema
>;
