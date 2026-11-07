import { z } from 'zod';
import { CONCRETE_MAX_SPECIMENS_PER_SET } from './concrete';
import { personSnapshotSchema } from './lab-programs';

// Per-project concrete settings (MM-V2-C02, migration 0016). Defaults confirmed by Kyle in the
// combined plan's Settings section: specimen ages 7 / 28 / 28 / HOLD and a HOLD of 56 days from
// casting. Whether issued reports include the testing machine's make/model and calibration dates
// stays unset (null) until someone chooses: its default awaits report-template mapping.
//
// Settings are defaults for specimen sets created later; saving them never changes an existing
// set, specimen schedule or issued report. Reviewers are not a setting: they are MISC-08 reviewer
// assignments for the concrete_field / concrete_strength scopes (project-access.ts).

/** A default specimen age: days from casting, or HOLD. */
export const CONCRETE_HOLD_AGE = 'HOLD' as const;
export const concreteSpecimenAgeSchema = z.union([
  z
    .number({ error: 'Age must be a number of days or HOLD' })
    .int({ error: 'Age must be a whole number of days' })
    .min(1, { error: 'Age must be at least 1 day' })
    .max(999, { error: 'Age must be 999 days or fewer' }),
  z.literal(CONCRETE_HOLD_AGE),
]);
export type ConcreteSpecimenAge = z.infer<typeof concreteSpecimenAgeSchema>;

/** One age per specimen in a default set, so at most 26 (letters A–Z). */
export const concreteSpecimenAgesSchema = z
  .array(concreteSpecimenAgeSchema, { error: 'Ages must be a list' })
  .min(1, { error: 'Give at least one specimen age' })
  .max(CONCRETE_MAX_SPECIMENS_PER_SET, {
    error: `Give at most ${CONCRETE_MAX_SPECIMENS_PER_SET} specimen ages`,
  });

export const concreteHoldDurationSchema = z
  .number({ error: 'HOLD duration must be a number of days' })
  .int({ error: 'HOLD duration must be a whole number of days' })
  .min(1, { error: 'HOLD duration must be at least 1 day' })
  .max(999, { error: 'HOLD duration must be 999 days or fewer' });

/** What a project uses before its settings are first saved (equal to the column defaults). */
export const CONCRETE_SETTINGS_DEFAULTS = {
  defaultSpecimenAges: [7, 28, 28, CONCRETE_HOLD_AGE] as ConcreteSpecimenAge[],
  holdDurationDays: 56,
  includeMachineInfo: null as boolean | null,
} as const;

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

/**
 * `PATCH /api/projects/:projectId/concrete-settings` (`project.edit`: the project's Lead Project
 * Engineer or an admin). `version` is the one last read; 0 means "never saved" (the defaults).
 * Omitted fields are unchanged; `includeMachineInfo: null` returns it to "not chosen".
 */
export const updateConcreteSettingsRequestSchema = z.strictObject({
  version: z
    .number({ error: 'Version is required' })
    .int({ error: 'Version is required' })
    .min(0, { error: 'Version is required' }),
  defaultSpecimenAges: concreteSpecimenAgesSchema.optional(),
  holdDurationDays: concreteHoldDurationSchema.optional(),
  includeMachineInfo: z.boolean({ error: 'Choose yes or no' }).nullable().optional(),
  reason: z
    .string({ error: 'Reason must be text' })
    .trim()
    .max(2000, { error: 'Reason must be 2000 characters or fewer' })
    .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
      message: "Reason can't contain control characters",
    })
    .transform((value) => (value === '' ? null : value))
    .nullish(),
});
export type UpdateConcreteSettingsRequest = z.input<typeof updateConcreteSettingsRequestSchema>;

/** The settings fields that a save may change, as audited. */
export const CONCRETE_SETTINGS_FIELDS = [
  'defaultSpecimenAges',
  'holdDurationDays',
  'includeMachineInfo',
] as const;
export type ConcreteSettingsField = (typeof CONCRETE_SETTINGS_FIELDS)[number];

/** One saved change, newest first: only the changed fields before and after. */
export const concreteSettingsChangeSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  changedBy: personSnapshotSchema.nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()),
  after: z.record(z.string(), z.unknown()),
});
export type ConcreteSettingsChange = z.infer<typeof concreteSettingsChangeSchema>;

/** Newest changes returned with the settings; `historyTotal` counts them all. */
export const CONCRETE_SETTINGS_HISTORY_LIMIT = 50;

/** `GET` / `PATCH /api/projects/:projectId/concrete-settings`. */
export const concreteProjectSettingsSchema = z.object({
  projectId: z.string(),
  defaultSpecimenAges: z.array(concreteSpecimenAgeSchema),
  holdDurationDays: z.number(),
  includeMachineInfo: z.boolean().nullable(),
  /** 0 until the settings are first saved (the defaults apply). */
  version: z.number(),
  updatedAt: z.string().nullable(),
  updatedBy: personSnapshotSchema.nullable(),
  /** `project.edit` on this project, as it stands. */
  canEdit: z.boolean(),
  history: z.array(concreteSettingsChangeSchema),
  historyTotal: z.number(),
});
export type ConcreteProjectSettings = z.infer<typeof concreteProjectSettingsSchema>;

/** 409 body when the settings changed since they were loaded. */
export const concreteSettingsVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteProjectSettingsSchema,
});
export type ConcreteSettingsVersionConflictResponse = z.infer<
  typeof concreteSettingsVersionConflictResponseSchema
>;
