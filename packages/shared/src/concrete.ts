import { z } from 'zod';

// MM-V2-C01: shared contracts for the concrete domain roots (field report → specimen set →
// specimen), matching migration 0015. Schema-level only: no route reads or writes these yet. Later
// cards extend these objects with their own fields (docs/concrete.md, "Field ownership").
//
// Four status dimensions are kept apart and never folded into one value (spec page 1):
//   * draft completeness — computed from the record each time (required fields still missing);
//     never stored, never a workflow value. Missing draft data is null, never 0 or "No".
//   * workflow state     — the report's field-work state (Draft … Reviewed, Void).
//   * sync               — where a device copy stands (saved on device … conflict), and what the
//                          server acknowledged. The server never stores a device's sync status.
//   * issuance           — whether a version was issued, how often, and the latest issue.
//
// Identity: every record has an internal UUID that never changes (clients may generate it offline).
// A set's temporary ID and permanent ID are nullable aliases attached later; a specimen's IDs are
// its set's plus its letter. Attaching an alias never changes a UUID.

const idSchema = z.uuid({ error: 'must be an ID' });
const timestampSchema = z.iso.datetime({ offset: true, error: 'must be a date and time' });

// ---- Identity ----------------------------------------------------------------------------------

/** At most 26 specimens per set, lettered A–Z (CD-10). */
export const CONCRETE_MAX_SPECIMENS_PER_SET = 26;
export const CONCRETE_SPECIMEN_LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');

/** TMP-<device code>-<local set counter>, e.g. TMP-D07-001 (CD-06). Same rule as the database. */
export const CONCRETE_TEMPORARY_SET_ID_PATTERN = /^TMP-[A-Z0-9]{1,16}-[0-9]{1,6}$/;
/** YY-NN, or GYY-NN for grouts (CD-07, CD-11); NN at least two digits. */
export const CONCRETE_PERMANENT_SET_ID_PATTERN = /^G?[0-9]{2}-[0-9]{2,9}$/;

export const concreteSpecimenLetterSchema = z
  .string()
  .regex(/^[A-Z]$/, { error: 'must be one letter A–Z' });
export const concreteTemporarySetIdSchema = z
  .string()
  .regex(CONCRETE_TEMPORARY_SET_ID_PATTERN, { error: 'must look like TMP-D07-001' });
export const concretePermanentSetIdSchema = z
  .string()
  .regex(CONCRETE_PERMANENT_SET_ID_PATTERN, { error: 'must look like 27-03 or G27-03' });

/** The permanent ID's counter part as stored (`27-03` → 3). */
export function concretePermanentNumber(permanentId: string): number {
  return Number(permanentId.slice(permanentId.indexOf('-') + 1));
}

/** A specimen's alias: its set's alias plus its letter (TMP-D07-001 + A → TMP-D07-001A). */
export function concreteSpecimenAlias(setAlias: string | null, letter: string): string | null {
  return setAlias === null ? null : `${setAlias}${letter}`;
}

/**
 * A set's aliases. Both start null (a draft consumes no number, CD-05); each is attached once and
 * never changes. The permanent number is the project counter value inside the permanent ID.
 */
export const concreteSetIdentitySchema = z
  .object({
    temporaryId: concreteTemporarySetIdSchema.nullable(),
    permanentId: concretePermanentSetIdSchema.nullable(),
    permanentNumber: z.int().positive().nullable(),
  })
  .refine(
    (identity) =>
      identity.permanentId === null
        ? identity.permanentNumber === null
        : identity.permanentNumber === concretePermanentNumber(identity.permanentId),
    { error: 'permanentNumber must match permanentId', path: ['permanentNumber'] },
  );
export type ConcreteSetIdentity = z.infer<typeof concreteSetIdentitySchema>;

export const concreteSpecimenIdentitySchema = z.object({
  temporaryId: z.string().nullable(),
  permanentId: z.string().nullable(),
});
export type ConcreteSpecimenIdentity = z.infer<typeof concreteSpecimenIdentitySchema>;

// ---- Status dimensions ---------------------------------------------------------------------------

/** Draft completeness: computed, never stored. `missingRequired` names field paths (C04 owns them). */
export const concreteDraftCompletenessSchema = z
  .object({
    complete: z.boolean(),
    missingRequired: z.array(z.string().min(1)),
  })
  .refine((c) => c.complete === (c.missingRequired.length === 0), {
    error: 'complete means nothing required is missing',
    path: ['complete'],
  });
export type ConcreteDraftCompleteness = z.infer<typeof concreteDraftCompletenessSchema>;

/**
 * Field-work state (spec page 1). Issued / Revised are issuance, not workflow; sync states are
 * sync. C19 owns submission, C09 / C28 review and return.
 */
export const CONCRETE_WORKFLOW_STATES = [
  'draft',
  'ready_to_submit',
  'submitted',
  'returned',
  'reviewed',
  'void',
] as const;
export type ConcreteWorkflowState = (typeof CONCRETE_WORKFLOW_STATES)[number];
export const concreteWorkflowStateSchema = z.enum(CONCRETE_WORKFLOW_STATES);

const SUBMITTED_STATES: readonly ConcreteWorkflowState[] = ['submitted', 'returned', 'reviewed'];

export const concreteWorkflowSchema = z
  .object({
    state: concreteWorkflowStateSchema,
    /** When the technician recorded Ready to submit (device time, CD-23). */
    readyToSubmitAt: timestampSchema.nullable(),
    /** When the server submitted the report. */
    submittedAt: timestampSchema.nullable(),
  })
  .refine((w) => w.state !== 'ready_to_submit' || w.readyToSubmitAt !== null, {
    error: 'Ready to submit needs the time it was recorded',
    path: ['readyToSubmitAt'],
  })
  .refine(
    (w) => w.state === 'void' || SUBMITTED_STATES.includes(w.state) === (w.submittedAt !== null),
    { error: 'submittedAt is set exactly when the report was submitted', path: ['submittedAt'] },
  );
export type ConcreteWorkflow = z.infer<typeof concreteWorkflowSchema>;

/**
 * Where a device's copy stands (spec page 4). Device-only: the server never stores it, and it is
 * never a workflow state. "accepted" means the server acknowledged this version.
 */
export const CONCRETE_DEVICE_SYNC_STATUSES = [
  'saved_on_device',
  'pending_upload',
  'accepted',
  'needs_attention',
  'conflict',
] as const;
export type ConcreteDeviceSyncStatus = (typeof CONCRETE_DEVICE_SYNC_STATUSES)[number];
export const concreteDeviceSyncStatusSchema = z.enum(CONCRETE_DEVICE_SYNC_STATUSES);

/**
 * The server's acknowledgment of a report's data (CD-22). Each attachment is acknowledged on its
 * own (C15), never implied by this. A retry of the same version returns the same acknowledgment.
 */
export const concreteReportAcknowledgmentSchema = z.object({
  reportId: idSchema,
  acceptedVersion: z.int().positive(),
  acceptedAt: timestampSchema,
});
export type ConcreteReportAcknowledgment = z.infer<typeof concreteReportAcknowledgmentSchema>;

/** Issuance (C09): 0 issues means not issued. What "Revised" displays as is C09's decision. */
export const CONCRETE_ISSUANCE_STATUSES = ['not_issued', 'issued'] as const;
export type ConcreteIssuanceStatus = (typeof CONCRETE_ISSUANCE_STATUSES)[number];

export const concreteIssuanceSchema = z
  .object({
    status: z.enum(CONCRETE_ISSUANCE_STATUSES),
    issueCount: z.int().nonnegative(),
    lastIssuedVersion: z.int().positive().nullable(),
    lastIssuedAt: timestampSchema.nullable(),
    lastIssuedByUserId: idSchema.nullable(),
  })
  .refine(
    (i) =>
      i.issueCount === 0
        ? i.status === 'not_issued' &&
          i.lastIssuedVersion === null &&
          i.lastIssuedAt === null &&
          i.lastIssuedByUserId === null
        : i.status === 'issued' &&
          i.lastIssuedVersion !== null &&
          i.lastIssuedAt !== null &&
          i.lastIssuedByUserId !== null,
    { error: 'issuance fields must agree with issueCount', path: ['status'] },
  );
export type ConcreteIssuance = z.infer<typeof concreteIssuanceSchema>;

// ---- Records ----------------------------------------------------------------------------------------

const recordMeta = {
  id: idSchema,
  projectId: idSchema,
  version: z.int().positive(),
  createdAt: timestampSchema,
  updatedAt: timestampSchema,
};

export const concreteSpecimenSchema = z.object({
  ...recordMeta,
  setId: idSchema,
  letter: concreteSpecimenLetterSchema,
  identity: concreteSpecimenIdentitySchema,
});
export type ConcreteSpecimen = z.infer<typeof concreteSpecimenSchema>;

export const concreteSpecimenSetSchema = z
  .object({
    ...recordMeta,
    fieldReportId: idSchema,
    identity: concreteSetIdentitySchema,
    /** Zero or more, one per letter; never a fixed four or six rows. */
    specimens: z.array(concreteSpecimenSchema).max(CONCRETE_MAX_SPECIMENS_PER_SET),
  })
  .superRefine((set, ctx) => {
    const letters = new Set<string>();
    set.specimens.forEach((specimen, index) => {
      const path = ['specimens', index];
      if (letters.has(specimen.letter)) {
        ctx.addIssue({ code: 'custom', message: 'letters are unique in a set', path });
      }
      letters.add(specimen.letter);
      if (specimen.setId !== set.id || specimen.projectId !== set.projectId) {
        ctx.addIssue({ code: 'custom', message: 'specimen belongs to another set', path });
      }
      if (
        specimen.identity.temporaryId !==
          concreteSpecimenAlias(set.identity.temporaryId, specimen.letter) ||
        specimen.identity.permanentId !==
          concreteSpecimenAlias(set.identity.permanentId, specimen.letter)
      ) {
        ctx.addIssue({
          code: 'custom',
          message: "a specimen's IDs are its set's IDs plus its letter",
          path: [...path, 'identity'],
        });
      }
    });
  });
export type ConcreteSpecimenSet = z.infer<typeof concreteSpecimenSetSchema>;

/** One field report = one sampled load / test (CD-13). No sets is valid. */
export const concreteFieldReportSchema = z
  .object({
    ...recordMeta,
    /** The signed-in account that created it (authority; may be the shared LAB account). */
    createdByUserId: idSchema,
    /** The person credited with the field work (attribution); null while a draft. */
    technicianUserId: idSchema.nullable(),
    completeness: concreteDraftCompletenessSchema,
    workflow: concreteWorkflowSchema,
    issuance: concreteIssuanceSchema,
    sets: z.array(concreteSpecimenSetSchema),
  })
  .superRefine((report, ctx) => {
    report.sets.forEach((set, index) => {
      if (set.fieldReportId !== report.id || set.projectId !== report.projectId) {
        ctx.addIssue({
          code: 'custom',
          message: 'set belongs to another report or project',
          path: ['sets', index],
        });
      }
    });
    if (
      report.issuance.lastIssuedVersion !== null &&
      report.issuance.lastIssuedVersion > report.version
    ) {
      ctx.addIssue({
        code: 'custom',
        message: 'the issued version must exist',
        path: ['issuance', 'lastIssuedVersion'],
      });
    }
  });
export type ConcreteFieldReport = z.infer<typeof concreteFieldReportSchema>;
