import { z } from 'zod';
import {
  CONCRETE_MAX_SPECIMENS_PER_SET,
  CONCRETE_SPECIMEN_LETTERS,
  concreteSetIdentitySchema,
  concreteSpecimenIdentitySchema,
} from './concrete';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_SETTINGS_DEFAULTS,
  concreteSpecimenAgeSchema,
  type ConcreteSpecimenAge,
} from './concrete-settings';
import type { ConcreteMixSnapshot } from './concrete-mixes';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C05: specimen sets, test-age assignments and stable identity records (migration 0020).
//
// One specimen per populated age / HOLD entry: blank rows don't count, repeats (28, 28) are
// separate specimens, extra rows are allowed, and the count is always derived (no count input).
// At most 26 specimens (letters A–Z, never past Z, decided 2026-10-30).
//
// Defaults (combined plan "Defaults and history"): lab 7/28/28/HOLD → project settings (C02) →
// the report's mix snapshot (C03/C04) → explicit set entries. The resolved defaults and the HOLD
// duration are saved on the set when it is created and never recalculated (AC4).
//
// Dates: casting date (America/Edmonton calendar day of the report's casting time) plus the
// assigned age gives the target date; HOLD gives the HOLD expiry (casting + saved duration).
// Weekend targets are kept and flagged, never shifted; holidays aren't flagged (no holiday
// calendar is defined). The database computes the stored dates; these helpers give the same
// answer for previews and offline forms.
//
// Not here: permanent-number allocation (C18), device codes and temporary IDs (C12), Void
// (C18), rescheduling (C22), receiving (C06), UI (C14).

const idSchema = z.uuid({ error: 'must be an ID' });

/** The time zone whose calendar day is the casting date (as storage-unit years, CLAUDE.md). */
export const CONCRETE_LAB_TIME_ZONE = 'America/Edmonton';

export const CONCRETE_SPECIMEN_TYPES = ['cylinder', 'cube', 'beam'] as const;
export type ConcreteSpecimenType = (typeof CONCRETE_SPECIMEN_TYPES)[number];

/** The agreed default mould for concrete cylinders (card §2). Other sizes are entered as seen. */
export const CONCRETE_DEFAULT_CYLINDER_MOULD = '150x300';
export const CONCRETE_MOULD_SIZE_PATTERN = /^[1-9][0-9]{1,2}x[1-9][0-9]{1,2}$/;

/**
 * The shape and mould a new set starts with, by the report's material. Concrete: 150 × 300 mm
 * cylinders. Grouts: cubes (card §2 keeps grout = cubes for later), size not defaulted. Anything
 * else, or no material yet: cylinders with the size left blank (never guessed).
 */
export function concreteSetShapeDefault(material: string | null): {
  specimenType: ConcreteSpecimenType;
  mouldSize: string | null;
} {
  if (material === 'concrete') {
    return { specimenType: 'cylinder', mouldSize: CONCRETE_DEFAULT_CYLINDER_MOULD };
  }
  if (material === 'epoxy_grout' || material === 'cementitious_grout') {
    return { specimenType: 'cube', mouldSize: null };
  }
  return { specimenType: 'cylinder', mouldSize: null };
}

// ---------------------------------------------------------------------------------------------
// Age rows → specimens
// ---------------------------------------------------------------------------------------------

/** Rows a form may send, blanks included (more than 26 rows only if some are blank). */
export const CONCRETE_MAX_AGE_ROWS = 60;

/** One age row: a client-generated stable id and the age, or null for a blank row. */
export const concreteSpecimenRowSchema = z.strictObject({
  id: idSchema,
  age: concreteSpecimenAgeSchema.nullable(),
});
export type ConcreteSpecimenRow = z.infer<typeof concreteSpecimenRowSchema>;

export interface ConcreteNormalizedSpecimen {
  id: string;
  letter: string;
  age: ConcreteSpecimenAge;
}

/**
 * The specimens a list of rows makes (AC1/AC2): blank rows dropped, the rest lettered A, B, C… in
 * order. Throws past 26 populated rows; never trims.
 */
export function normalizeConcreteSpecimenRows(
  rows: readonly ConcreteSpecimenRow[],
): ConcreteNormalizedSpecimen[] {
  const populated = rows.filter(
    (row): row is { id: string; age: ConcreteSpecimenAge } => row.age !== null,
  );
  if (populated.length > CONCRETE_MAX_SPECIMENS_PER_SET) {
    throw new RangeError(`A set has at most ${CONCRETE_MAX_SPECIMENS_PER_SET} specimens (A–Z)`);
  }
  return populated.map((row, index) => ({
    id: row.id,
    letter: CONCRETE_SPECIMEN_LETTERS[index]!,
    age: row.age,
  }));
}

// ---------------------------------------------------------------------------------------------
// Default resolution
// ---------------------------------------------------------------------------------------------

export const CONCRETE_DEFAULT_AGES_SOURCES = ['lab_default', 'project', 'mix'] as const;
export type ConcreteDefaultAgesSource = (typeof CONCRETE_DEFAULT_AGES_SOURCES)[number];
export const CONCRETE_HOLD_DURATION_SOURCES = ['lab_default', 'project'] as const;
export type ConcreteHoldDurationSource = (typeof CONCRETE_HOLD_DURATION_SOURCES)[number];

export const concreteScheduleSnapshotSchema = z.object({
  ages: z.array(concreteSpecimenAgeSchema),
  source: z.enum(CONCRETE_DEFAULT_AGES_SOURCES),
  /** The mix revision the ages came from (source `mix` only). */
  mixRevisionId: z.string().nullable(),
  holdDurationDays: z.number(),
  holdDurationSource: z.enum(CONCRETE_HOLD_DURATION_SOURCES),
});
export type ConcreteScheduleSnapshot = z.infer<typeof concreteScheduleSnapshotSchema>;

/**
 * The defaults a new set copies: the mix snapshot's test ages when the report names a registry
 * mix, else the project's saved settings, else the lab default; the HOLD duration from the
 * project's saved settings, else the lab default (56 days).
 */
export function resolveConcreteSchedule(input: {
  projectSettings: { defaultSpecimenAges: ConcreteSpecimenAge[]; holdDurationDays: number } | null;
  mixSnapshot: Pick<ConcreteMixSnapshot, 'revisionId' | 'spec'> | null;
}): ConcreteScheduleSnapshot {
  const hold = input.projectSettings
    ? {
        holdDurationDays: input.projectSettings.holdDurationDays,
        holdDurationSource: 'project' as const,
      }
    : {
        holdDurationDays: CONCRETE_SETTINGS_DEFAULTS.holdDurationDays,
        holdDurationSource: 'lab_default' as const,
      };
  if (input.mixSnapshot) {
    return {
      ages: [...input.mixSnapshot.spec.testAges],
      source: 'mix',
      mixRevisionId: input.mixSnapshot.revisionId,
      ...hold,
    };
  }
  if (input.projectSettings) {
    return {
      ages: [...input.projectSettings.defaultSpecimenAges],
      source: 'project',
      mixRevisionId: null,
      ...hold,
    };
  }
  return {
    ages: [...CONCRETE_SETTINGS_DEFAULTS.defaultSpecimenAges],
    source: 'lab_default',
    mixRevisionId: null,
    ...hold,
  };
}

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONCRETE_LAB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** The casting date: the lab-time-zone calendar day of an instant (YYYY-MM-DD). */
export function concreteCastingDate(castAt: string): string {
  return dayFormat.format(new Date(castAt));
}

/** A calendar date plus whole days (YYYY-MM-DD; calendar arithmetic, no time zone). */
export function concreteAddDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

export function concreteIsWeekend(date: string): boolean {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  const weekday = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return weekday === 0 || weekday === 6;
}

export const CONCRETE_SPECIMEN_FLAGS = ['weekend_target'] as const;
export type ConcreteSpecimenFlag = (typeof CONCRETE_SPECIMEN_FLAGS)[number];

/**
 * The one place a target date's attention flags are decided (MM-V2-C22). A flagged target is
 * kept, never moved. Weekends only for now: the owner decided (2026-11-08) on an admin-managed
 * holiday list seeded with Alberta statutory holidays, which C37 adds here as a holiday flag.
 */
export function concreteTargetDateFlags(date: string): ConcreteSpecimenFlag[] {
  return concreteIsWeekend(date) ? ['weekend_target'] : [];
}

export interface ConcreteSpecimenDates {
  targetDate: string | null;
  holdExpiresOn: string | null;
  flags: ConcreteSpecimenFlag[];
}

/**
 * A specimen's dates from the casting time, its age and the set's saved HOLD duration. Unknown
 * casting → both null. A weekend target is kept and flagged (holidays: no calendar defined).
 */
export function concreteSpecimenDates(input: {
  castAt: string | null;
  age: ConcreteSpecimenAge;
  holdDurationDays: number | null;
}): ConcreteSpecimenDates {
  if (input.castAt === null) return { targetDate: null, holdExpiresOn: null, flags: [] };
  const casting = concreteCastingDate(input.castAt);
  if (input.age === CONCRETE_HOLD_AGE) {
    return {
      targetDate: null,
      holdExpiresOn:
        input.holdDurationDays === null ? null : concreteAddDays(casting, input.holdDurationDays),
      flags: [],
    };
  }
  const targetDate = concreteAddDays(casting, input.age);
  return {
    targetDate,
    holdExpiresOn: null,
    flags: concreteTargetDateFlags(targetDate),
  };
}

/** Flags for a stored target date (the database computed it). */
export function concreteSpecimenFlags(targetDate: string | null): ConcreteSpecimenFlag[] {
  return targetDate === null ? [] : concreteTargetDateFlags(targetDate);
}

// ---------------------------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------------------------

const mouldSizeSchema = z.string().trim().regex(CONCRETE_MOULD_SIZE_PATTERN, {
  error: 'Enter the mould as diameter x length in mm, e.g. 150x300',
});

const specimenRowsSchema = z
  .array(concreteSpecimenRowSchema)
  .max(CONCRETE_MAX_AGE_ROWS, { error: `Send at most ${CONCRETE_MAX_AGE_ROWS} rows` })
  .superRefine((rows, ctx) => {
    const ids = new Set<string>();
    rows.forEach((row, index) => {
      if (ids.has(row.id)) {
        ctx.addIssue({ code: 'custom', message: 'Each row has its own ID', path: [index, 'id'] });
      }
      ids.add(row.id);
    });
    const populated = rows.filter((row) => row.age !== null).length;
    if (populated > CONCRETE_MAX_SPECIMENS_PER_SET) {
      ctx.addIssue({
        code: 'custom',
        message: `A set has at most ${CONCRETE_MAX_SPECIMENS_PER_SET} specimens (A–Z)`,
      });
    }
  });

/**
 * `POST /api/concrete/field-reports/:reportId/specimen-sets` (`concrete_report.draft`; own
 * draft). `id` is the client's stable set UUID. `specimens` omitted → one row per resolved
 * default age; given → exactly those rows (blanks dropped, no count input). `technicianUserId`
 * names the performing person at a LAB station (attribution only).
 */
export const createConcreteSpecimenSetRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  id: idSchema.optional(),
  technicianUserId: idSchema.optional(),
  specimenType: z.enum(CONCRETE_SPECIMEN_TYPES).optional(),
  mouldSize: mouldSizeSchema.nullable().optional(),
  specimens: specimenRowsSchema.optional(),
});
export type CreateConcreteSpecimenSetRequest = z.infer<
  typeof createConcreteSpecimenSetRequestSchema
>;

/**
 * `PATCH /api/concrete/specimen-sets/:setId`. Absent = unchanged. `specimens` replaces the whole
 * list (stable row ids keep their specimen); refused once the set is numbered (its letters and
 * ages are fixed; rescheduling is C22).
 */
export const saveConcreteSpecimenSetRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  version: z.number({ error: 'Version is required' }).int().min(1),
  technicianUserId: idSchema.optional(),
  specimenType: z.enum(CONCRETE_SPECIMEN_TYPES).optional(),
  mouldSize: mouldSizeSchema.nullable().optional(),
  specimens: specimenRowsSchema.optional(),
});
export type SaveConcreteSpecimenSetRequest = z.infer<typeof saveConcreteSpecimenSetRequestSchema>;

/** `DELETE /api/concrete/specimen-sets/:setId`: discard an unnumbered draft set. */
export const discardConcreteSpecimenSetRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  version: z.number({ error: 'Version is required' }).int().min(1),
  technicianUserId: idSchema.optional(),
});

/**
 * `POST /api/concrete/field-reports/:reportId/casting-correction` (AC5). For a report with a
 * numbered set. `confirm: false` returns the dependent-date effects without changing anything;
 * `confirm: true` applies the correction with its reason. Issued IDs never change.
 */
export const concreteCastingCorrectionRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  /** The report version the effects were read from. */
  version: z.number({ error: 'Version is required' }).int().min(1),
  castAt: z.iso.datetime({ offset: true, error: 'must be a date and time' }),
  reason: z
    .string({ error: 'A reason is required' })
    .trim()
    .min(1, { error: 'A reason is required' })
    .max(2000, { error: 'Keep the reason under 2000 characters' }),
  confirm: z.boolean({ error: 'Say whether to apply the correction' }),
});
export type ConcreteCastingCorrectionRequest = z.infer<
  typeof concreteCastingCorrectionRequestSchema
>;

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export const concreteSpecimenDetailSchema = z.object({
  id: z.string(),
  letter: z.string(),
  assignedAge: concreteSpecimenAgeSchema,
  targetDate: z.string().nullable(),
  holdExpiresOn: z.string().nullable(),
  flags: z.array(z.enum(CONCRETE_SPECIMEN_FLAGS)),
  identity: concreteSpecimenIdentitySchema,
});
export type ConcreteSpecimenDetail = z.infer<typeof concreteSpecimenDetailSchema>;

export const concreteSetVoidSchema = z.object({
  voidedAt: z.string(),
  voidedByUserId: z.string(),
  reason: z.string(),
});

export const concreteSpecimenSetDetailSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  fieldReportId: z.string(),
  identity: concreteSetIdentitySchema,
  specimenType: z.enum(CONCRETE_SPECIMEN_TYPES),
  mouldSize: z.string().nullable(),
  /** From the field report (C04): one load, one casting time. */
  castAt: z.string().nullable(),
  castingDate: z.string().nullable(),
  /** The saved defaults (null for a set created before C05). */
  defaultSchedule: concreteScheduleSnapshotSchema.nullable(),
  /** Derived from the specimen rows; there is no count input. */
  specimenCount: z.number(),
  specimens: z.array(concreteSpecimenDetailSchema),
  createdBy: personSnapshotSchema.nullable(),
  technician: personSnapshotSchema.nullable(),
  void: concreteSetVoidSchema.nullable(),
  version: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Draft edits: the report is a draft, the caller may edit it, the set isn't numbered. */
  canEdit: z.boolean(),
});
export type ConcreteSpecimenSetDetail = z.infer<typeof concreteSpecimenSetDetailSchema>;

export const concreteSpecimenSetListSchema = z.object({
  fieldReportId: z.string(),
  items: z.array(concreteSpecimenSetDetailSchema),
});
export type ConcreteSpecimenSetList = z.infer<typeof concreteSpecimenSetListSchema>;

/** `GET …/specimen-set-defaults`: what a new set would copy now (nothing saved). */
export const concreteSpecimenSetDefaultsSchema = z.object({
  fieldReportId: z.string(),
  schedule: concreteScheduleSnapshotSchema,
  specimenType: z.enum(CONCRETE_SPECIMEN_TYPES),
  mouldSize: z.string().nullable(),
});
export type ConcreteSpecimenSetDefaults = z.infer<typeof concreteSpecimenSetDefaultsSchema>;

export const concreteSpecimenSetVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteSpecimenSetDetailSchema,
});

const datesSchema = z.object({
  targetDate: z.string().nullable(),
  holdExpiresOn: z.string().nullable(),
});

export const concreteCastingEffectSchema = z.object({
  setId: z.string(),
  specimenId: z.string(),
  letter: z.string(),
  permanentId: z.string().nullable(),
  temporaryId: z.string().nullable(),
  assignedAge: concreteSpecimenAgeSchema,
  before: datesSchema,
  after: datesSchema,
});
export type ConcreteCastingEffect = z.infer<typeof concreteCastingEffectSchema>;

export const concreteCastingCorrectionResultSchema = z.object({
  fieldReportId: z.string(),
  applied: z.boolean(),
  previousCastAt: z.string().nullable(),
  castAt: z.string(),
  /** Every specimen whose target date or HOLD expiry moves (confirm these before applying). */
  effects: z.array(concreteCastingEffectSchema),
  /**
   * Numbered sets whose ID year (YY) differs from the corrected casting year. Their IDs stay as
   * issued (combined plan §6); listed so the change is seen, never to renumber.
   */
  castingYearDiffers: z.array(
    z.object({ setId: z.string(), permanentId: z.string(), castingYear: z.number() }),
  ),
  reportVersion: z.number(),
});
export type ConcreteCastingCorrectionResult = z.infer<typeof concreteCastingCorrectionResultSchema>;

// ---------------------------------------------------------------------------------------------
// Allocator boundary (C18): a contract only, no route or implementation here
// ---------------------------------------------------------------------------------------------

/**
 * What C18's permanent-number allocator needs from a set and returns. C05 issues and reserves
 * nothing: a set has no permanent number until C18 attaches one, in the accepting transaction,
 * from the project's single concrete/grout counter (no annual reset; `G` prefix for grouts; YY =
 * casting year). Device codes and temporary IDs are C12's.
 */
export const concreteSetNumberAllocationRequestSchema = z.object({
  projectId: idSchema,
  setId: idSchema,
  /** YY comes from the casting date; required before a number can be allocated. */
  castingDate: z.iso.date(),
  material: z.string(),
});
export const concreteSetNumberAllocationResultSchema = z.object({
  setId: z.string(),
  permanentNumber: z.number().int().positive(),
  permanentId: z.string(),
});
