import { z } from 'zod';
import { concreteSpecimenAgeSchema } from './concrete-settings';

// The project Concrete section's Specimens tab (MM-V2-C30): every specimen of the project, one row
// each, newest casting first. Read only; a row opens its field report. Strength is C23's (the
// column stays empty until results exist).

export const CONCRETE_PROJECT_SPECIMEN_STATUSES = [
  'awaiting_casting',
  'scheduled',
  'due_today',
  'overdue',
  'hold',
  'void',
] as const;
export type ConcreteProjectSpecimenStatus = (typeof CONCRETE_PROJECT_SPECIMEN_STATUSES)[number];

export const CONCRETE_PROJECT_SPECIMEN_STATUS_LABEL: Record<ConcreteProjectSpecimenStatus, string> =
  {
    awaiting_casting: 'No casting time',
    scheduled: 'Scheduled',
    due_today: 'Due today',
    overdue: 'Overdue',
    hold: 'HOLD',
    void: 'Void',
  };

/** The status a specimen shows on `today` (America/Edmonton), from its stored dates. */
export function concreteProjectSpecimenStatus(row: {
  voided: boolean;
  assignedAge: string | number | null;
  targetDate: string | null;
  holdExpiresOn: string | null;
  today: string;
}): ConcreteProjectSpecimenStatus {
  if (row.voided) return 'void';
  if (row.assignedAge === 'HOLD') return row.holdExpiresOn ? 'hold' : 'awaiting_casting';
  if (!row.targetDate) return 'awaiting_casting';
  if (row.targetDate === row.today) return 'due_today';
  return row.targetDate < row.today ? 'overdue' : 'scheduled';
}

export const CONCRETE_PROJECT_SPECIMEN_PAGE_SIZE = 50;
export const CONCRETE_PROJECT_SPECIMEN_PAGE_SIZE_MAX = 100;

/** `GET /api/concrete/projects/:projectId/specimens?search=&status=&page=&pageSize=`. */
export const concreteProjectSpecimenQuerySchema = z.object({
  /** Contains, ignoring case: specimen or set ID, structure element or location. */
  search: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(200).optional(),
  ),
  status: z
    .enum(CONCRETE_PROJECT_SPECIMEN_STATUSES, { error: 'Choose a specimen status' })
    .optional(),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONCRETE_PROJECT_SPECIMEN_PAGE_SIZE_MAX)
    .default(CONCRETE_PROJECT_SPECIMEN_PAGE_SIZE),
});
export type ConcreteProjectSpecimenQueryInput = z.input<typeof concreteProjectSpecimenQuerySchema>;

export const concreteProjectSpecimenRowSchema = z.object({
  specimenId: z.string(),
  /** Permanent ID with letter (e.g. 26-07A), else the temporary one, else the set letter only. */
  label: z.string(),
  setId: z.string(),
  fieldReportId: z.string(),
  reportState: z.string(),
  castingDate: z.string().nullable(),
  /** Structure / elements and location as written on the field report. */
  structure: z.array(z.string()),
  location: z.string().nullable(),
  assignedAge: concreteSpecimenAgeSchema.nullable(),
  /** Target date for an age in days, HOLD expiry for HOLD. */
  testDate: z.string().nullable(),
  /** Measured strength (MPa): C23. Null until a result exists. */
  strengthMpa: z.number().nullable(),
  status: z.enum(CONCRETE_PROJECT_SPECIMEN_STATUSES),
});
export type ConcreteProjectSpecimenRow = z.infer<typeof concreteProjectSpecimenRowSchema>;

export const concreteProjectSpecimenListSchema = z.object({
  projectId: z.string(),
  today: z.string(),
  items: z.array(concreteProjectSpecimenRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ConcreteProjectSpecimenList = z.infer<typeof concreteProjectSpecimenListSchema>;

// ---------------------------------------------------------------------------------------------
// Sets tab (STRATA-98): one row per specimen set, with its test ages and "n of m tested".
// ---------------------------------------------------------------------------------------------

/**
 * A set's working label until permanent set numbering is decided (package 3, an open item; Kyle
 * 2026-11-11): "Set 2", its specimens "2A–2D". N is the set's place in its project in creation
 * order (oldest = 1), never stored and never an ID; the set's own temporary or permanent ID, if
 * any, is shown beside it.
 */
export const concreteSetWorkingLabel = (workingNumber: number) => `Set ${workingNumber}`;

/** "2A–2D" (or "2A" for one specimen) from the set's working number and specimen letters. */
export function concreteSetSpecimenRange(workingNumber: number, letters: readonly string[]) {
  if (letters.length === 0) return '';
  const sorted = [...letters].sort();
  const first = `${workingNumber}${sorted[0]}`;
  return sorted.length === 1 ? first : `${first}–${workingNumber}${sorted[sorted.length - 1]}`;
}

/**
 * A set's state on `today`, from its specimens. HOLD specimens wait for a scheduled test and
 * aren't counted in "n of m tested"; "tested" is a complete test entry (C23's rule).
 */
export const CONCRETE_PROJECT_SET_STATUSES = [
  'no_casting_time',
  'curing',
  'due_today',
  'overdue',
  'on_hold',
  'tested',
  'void',
] as const;
export type ConcreteProjectSetStatus = (typeof CONCRETE_PROJECT_SET_STATUSES)[number];

export const CONCRETE_PROJECT_SET_STATUS_LABEL: Record<ConcreteProjectSetStatus, string> = {
  no_casting_time: 'No casting time',
  curing: 'Curing',
  due_today: 'Break today',
  overdue: 'Break overdue',
  on_hold: 'On HOLD',
  tested: 'All tested',
  void: 'Void',
};

export function concreteProjectSetStatus(set: {
  voided: boolean;
  castingDate: string | null;
  testedCount: number;
  scheduledCount: number;
  /** Earliest target date of an untested, non-HOLD specimen. */
  nextTestDate: string | null;
  today: string;
}): ConcreteProjectSetStatus {
  if (set.voided) return 'void';
  if (set.scheduledCount > 0 && set.testedCount >= set.scheduledCount) return 'tested';
  if (!set.castingDate) return 'no_casting_time';
  if (set.scheduledCount === 0) return 'on_hold';
  if (!set.nextTestDate) return 'curing';
  if (set.nextTestDate === set.today) return 'due_today';
  return set.nextTestDate < set.today ? 'overdue' : 'curing';
}

export const CONCRETE_PROJECT_SET_PAGE_SIZE = 25;
export const CONCRETE_PROJECT_SET_PAGE_SIZE_MAX = 100;

/** `GET /api/concrete/projects/:projectId/specimen-sets?search=&page=&pageSize=`. */
export const concreteProjectSetQuerySchema = z.object({
  /** Contains, ignoring case: set ID, structure element or location. */
  search: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().trim().max(200).optional(),
  ),
  page: z.coerce.number().int().min(1).max(100000).default(1),
  pageSize: z.coerce
    .number()
    .int()
    .min(1)
    .max(CONCRETE_PROJECT_SET_PAGE_SIZE_MAX)
    .default(CONCRETE_PROJECT_SET_PAGE_SIZE),
});
export type ConcreteProjectSetQueryInput = z.input<typeof concreteProjectSetQuerySchema>;

export const concreteProjectSetRowSchema = z.object({
  setId: z.string(),
  /** The working number behind "Set N" (see `concreteSetWorkingLabel`). */
  workingNumber: z.number().int(),
  /** "Set 2". */
  workingLabel: z.string(),
  /** "2A–2D". */
  specimenRange: z.string(),
  identity: z.object({ temporaryId: z.string().nullable(), permanentId: z.string().nullable() }),
  fieldReportId: z.string(),
  reportState: z.string(),
  castingDate: z.string().nullable(),
  structure: z.array(z.string()),
  location: z.string().nullable(),
  /** Each specimen's age in letter order (days or HOLD; null: not assigned). */
  testAges: z.array(concreteSpecimenAgeSchema.nullable()),
  /** n: non-HOLD specimens with a complete test entry. */
  testedCount: z.number().int(),
  /** m: non-HOLD specimens. */
  scheduledCount: z.number().int(),
  nextTestDate: z.string().nullable(),
  voided: z.boolean(),
  status: z.enum(CONCRETE_PROJECT_SET_STATUSES),
});
export type ConcreteProjectSetRow = z.infer<typeof concreteProjectSetRowSchema>;

export const concreteProjectSetListSchema = z.object({
  projectId: z.string(),
  today: z.string(),
  items: z.array(concreteProjectSetRowSchema),
  total: z.number(),
  page: z.number(),
  pageSize: z.number(),
});
export type ConcreteProjectSetList = z.infer<typeof concreteProjectSetListSchema>;
