import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import { concreteEquipmentFlagSchema } from './concrete-equipment';
import { CONCRETE_HOLD_AGE, concreteSpecimenAgeSchema } from './concrete-settings';
import {
  CONCRETE_LAB_TIME_ZONE,
  concreteAddDays,
  concreteTargetDateFlags,
} from './concrete-specimen-sets';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C22: the daily concrete lab worklist and authorized rescheduling (migration 0022).
//
// Views (combined plan "Daily lab briefing", confirmed by Kyle):
// - Today: specimens whose target date is today.
// - Overdue: untested specimens whose target date has passed. The target never changes because a
//   specimen is overdue (AC2); only an authorized reschedule (reason + history) moves it.
// - Upcoming: targets in the next seven days (tomorrow through today + 7).
// - HOLD: specimens assigned HOLD, with their hold-until date (casting + the set's saved
//   duration). On or after that date they are flagged for review; nothing is tested, released or
//   disposed of automatically (AC3; HOLD actions are C26).
// - Exceptions: a shell. Only sources that exist are wired (the testing machine's C27 flags for
//   today); identity, curing-temperature and failed-test sources land with their cards.
//
// Dates are America/Edmonton business dates. Weekend targets are kept and flagged (AC1) through
// `concreteTargetDateFlags`. Holidays: the owner decided on an admin-managed list of Alberta
// statutory holidays (2026-11-08); C37 builds it and adds its flag in that one function.
//
// "Untested": no concrete test result exists yet (C07/C23 own results), so every scheduled
// specimen counts as untested until C23 adds the tested condition to the worklist query.

export const CONCRETE_WORKLIST_VIEWS = [
  'today',
  'overdue',
  'upcoming',
  'hold',
  'exceptions',
] as const;
export type ConcreteWorklistView = (typeof CONCRETE_WORKLIST_VIEWS)[number];

export const CONCRETE_WORKLIST_VIEW_LABEL: Record<ConcreteWorklistView, string> = {
  today: 'Today',
  overdue: 'Overdue',
  upcoming: 'Upcoming (7 days)',
  hold: 'HOLD',
  exceptions: 'Exceptions',
};

/** "Upcoming" covers the next seven days after today (confirmed worklist structure). */
export const CONCRETE_UPCOMING_DAYS = 7;
/** Rows per page; groups and counts always cover the whole view. */
export const CONCRETE_WORKLIST_PAGE_SIZE = 200;

/**
 * No holiday list exists yet: C37 builds the admin-managed Alberta statutory list (owner,
 * 2026-11-08). Until then only the weekend flag is applied.
 */
export const CONCRETE_HOLIDAY_CALENDAR = null;

const dayFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: CONCRETE_LAB_TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/** Today's lab business date (America/Edmonton calendar day) for an instant. */
export function concreteLabToday(now: Date = new Date()): string {
  return dayFormat.format(now);
}

/** Whole calendar days from `from` to `to` (negative when `to` is earlier). */
export function concreteDaysBetween(from: string, to: string): number {
  const utc = (date: string) => {
    const [y, m, d] = date.split('-').map(Number) as [number, number, number];
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

export const CONCRETE_WORKLIST_FLAGS = [
  'weekend_target',
  'overdue',
  'hold_review_due',
  'rescheduled',
  'report_draft',
] as const;
export type ConcreteWorklistFlag = (typeof CONCRETE_WORKLIST_FLAGS)[number];

export const CONCRETE_WORKLIST_FLAG_LABEL: Record<ConcreteWorklistFlag, string> = {
  weekend_target: 'Weekend target',
  overdue: 'Overdue',
  hold_review_due: 'HOLD review due',
  rescheduled: 'Rescheduled',
  report_draft: 'Report still a draft',
};

/**
 * Which date view a scheduled specimen falls in on `today` (the same rule the API's SQL applies).
 * A HOLD specimen is always in HOLD; one without a date (casting unknown) is in none.
 */
export function concreteWorklistViewOf(input: {
  assignedAge: number | typeof CONCRETE_HOLD_AGE;
  targetDate: string | null;
  holdExpiresOn: string | null;
  today: string;
}): Exclude<ConcreteWorklistView, 'exceptions'> | null {
  if (input.assignedAge === CONCRETE_HOLD_AGE) return input.holdExpiresOn === null ? null : 'hold';
  if (input.targetDate === null) return null;
  const days = concreteDaysBetween(input.today, input.targetDate);
  if (days === 0) return 'today';
  if (days < 0) return 'overdue';
  return days <= CONCRETE_UPCOMING_DAYS ? 'upcoming' : null;
}

/** Flags for one worklist row (display only; nothing is shifted or scheduled). */
export function concreteWorklistFlags(input: {
  assignedAge: number | typeof CONCRETE_HOLD_AGE;
  targetDate: string | null;
  holdExpiresOn: string | null;
  today: string;
  rescheduleCount: number;
  reportState: string;
}): ConcreteWorklistFlag[] {
  const flags: ConcreteWorklistFlag[] = [];
  if (input.targetDate !== null) flags.push(...concreteTargetDateFlags(input.targetDate));
  if (input.targetDate !== null && concreteDaysBetween(input.today, input.targetDate) < 0) {
    flags.push('overdue');
  }
  if (
    input.assignedAge === CONCRETE_HOLD_AGE &&
    input.holdExpiresOn !== null &&
    concreteDaysBetween(input.today, input.holdExpiresOn) <= 0
  ) {
    flags.push('hold_review_due');
  }
  if (input.rescheduleCount > 0) flags.push('rescheduled');
  if (input.reportState === 'draft') flags.push('report_draft');
  return flags;
}

/** The target a reschedule to `newAge` would give (casting date + age, never shifted). */
export function concreteRescheduledTarget(castingDate: string, newAge: number): string {
  return concreteAddDays(castingDate, newAge);
}

// ---------------------------------------------------------------------------------------------
// Worklist
// ---------------------------------------------------------------------------------------------

const dateSchema = z.iso.date({ error: 'must be a date (YYYY-MM-DD)' });

/** `GET /api/concrete/lab-worklist` query (`inventory.read`). */
export const concreteWorklistQuerySchema = z.strictObject({
  view: z.enum(CONCRETE_WORKLIST_VIEWS).default('today'),
  projectId: z.uuid({ error: 'must be an ID' }).optional(),
  /** The business date to read as "today"; defaults to the lab's date now. */
  on: dateSchema.optional(),
  page: z.coerce.number().int().min(1).default(1),
});
export type ConcreteWorklistQuery = z.infer<typeof concreteWorklistQuerySchema>;

export const CONCRETE_HOLD_KINDS = ['ordinary'] as const;

export const concreteWorklistRowSchema = z.object({
  specimenId: z.string(),
  setId: z.string(),
  fieldReportId: z.string(),
  projectId: z.string(),
  letter: z.string(),
  identity: concreteSpecimenIdentitySchema,
  assignedAge: concreteSpecimenAgeSchema,
  castingDate: z.string(),
  targetDate: z.string().nullable(),
  holdExpiresOn: z.string().nullable(),
  /** Whole days past the target (Overdue), else null. */
  daysOverdue: z.number().int().nullable(),
  /**
   * The kind of hold: only the ordinary HOLD exists so far; a failed-specimen hold (C25) is a
   * distinct kind and is never released by reaching this date.
   */
  holdKind: z.enum(CONCRETE_HOLD_KINDS).nullable(),
  reportState: z.string(),
  flags: z.array(z.enum(CONCRETE_WORKLIST_FLAGS)),
  rescheduleCount: z.number().int().min(0),
  /**
   * The set is numbered (and not HOLD): its age changes only by a reschedule. An unnumbered set
   * is edited on its draft (C05); past draft it can't be rescheduled until numbered (MM-V2-C38).
   */
  reschedulable: z.boolean(),
  version: z.number().int(),
});
export type ConcreteWorklistRow = z.infer<typeof concreteWorklistRowSchema>;

export const concreteWorklistGroupSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  /** Specimens of this project in the whole view (not just this page). */
  count: z.number().int().min(0),
  /** Whether the caller holds `concrete_specimen.reschedule` on this project. */
  canReschedule: z.boolean(),
  rows: z.array(concreteWorklistRowSchema),
});
export type ConcreteWorklistGroup = z.infer<typeof concreteWorklistGroupSchema>;

export const CONCRETE_WORKLIST_EXCEPTION_KINDS = ['testing_machine'] as const;

export const concreteWorklistExceptionSchema = z.object({
  kind: z.enum(CONCRETE_WORKLIST_EXCEPTION_KINDS),
  equipmentId: z.string(),
  label: z.string(),
  nextDueOn: z.string().nullable(),
  flags: z.array(concreteEquipmentFlagSchema).min(1),
});
export type ConcreteWorklistException = z.infer<typeof concreteWorklistExceptionSchema>;

/** Exception sources owned by later cards: listed so the screen says what isn't checked yet. */
export const CONCRETE_WORKLIST_PENDING_EXCEPTION_SOURCES = [
  { source: 'identity', label: 'Unresolved specimen identity', card: 'C20/C21' },
  { source: 'curing_temperature', label: 'Curing temperature', card: 'C06' },
  { source: 'failed_test', label: 'Failed tests', card: 'C25' },
] as const;

export const concreteWorklistCountsSchema = z.object(
  Object.fromEntries(CONCRETE_WORKLIST_VIEWS.map((v) => [v, z.number().int().min(0)])) as Record<
    ConcreteWorklistView,
    z.ZodNumber
  >,
);

export const concreteWorklistSchema = z.object({
  view: z.enum(CONCRETE_WORKLIST_VIEWS),
  today: z.string(),
  upcomingThrough: z.string(),
  counts: concreteWorklistCountsSchema,
  /** Specimens in this view (the total the pages cover). */
  total: z.number().int().min(0),
  page: z.number().int().min(1),
  pageSize: z.number().int().min(1),
  groups: z.array(concreteWorklistGroupSchema),
  /** Exceptions view only (empty otherwise). */
  exceptions: z.array(concreteWorklistExceptionSchema),
  /** Exceptions view: whether a testing machine is registered at all. */
  testingMachineRegistered: z.boolean(),
  /** Projects with any scheduled specimen, for the filter. */
  projects: z.array(z.object({ id: z.string(), projectNumber: z.string(), name: z.string() })),
});
export type ConcreteWorklist = z.infer<typeof concreteWorklistSchema>;

// ---------------------------------------------------------------------------------------------
// Rescheduling
// ---------------------------------------------------------------------------------------------

/**
 * `POST /api/concrete/specimens/:specimenId/reschedule` (`concrete_specimen.reschedule`: the
 * project's lead, a designated `concrete_field` reviewer or a concrete-grant Lab Manager;
 * personal accounts only). Changes the assigned age in days; the target follows from the casting
 * date. HOLD specimens are C26's.
 */
export const concreteRescheduleRequestSchema = z.strictObject({
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
  /** The specimen version the change was decided from. */
  version: z.number({ error: 'Version is required' }).int().min(1),
  newAge: z
    .number({ error: 'Enter the new test age in days' })
    .int({ error: 'Enter whole days' })
    .min(1, { error: 'Enter 1 to 999 days' })
    .max(999, { error: 'Enter 1 to 999 days' }),
  reason: z
    .string({ error: 'A reason is required' })
    .trim()
    .min(1, { error: 'A reason is required' })
    .max(2000, { error: 'Keep the reason under 2000 characters' }),
});
export type ConcreteRescheduleRequest = z.infer<typeof concreteRescheduleRequestSchema>;

export const concreteRescheduleEntrySchema = z.object({
  id: z.string(),
  previousAge: z.number().int(),
  newAge: z.number().int(),
  previousTargetDate: z.string(),
  newTargetDate: z.string(),
  reason: z.string(),
  by: personSnapshotSchema,
  at: z.string(),
});
export type ConcreteRescheduleEntry = z.infer<typeof concreteRescheduleEntrySchema>;

export const concreteScheduleHistorySchema = z.object({
  specimenId: z.string(),
  identity: concreteSpecimenIdentitySchema,
  assignedAge: concreteSpecimenAgeSchema,
  castingDate: z.string().nullable(),
  targetDate: z.string().nullable(),
  holdExpiresOn: z.string().nullable(),
  version: z.number().int(),
  history: z.array(concreteRescheduleEntrySchema),
});
export type ConcreteScheduleHistory = z.infer<typeof concreteScheduleHistorySchema>;

export const concreteRescheduleResultSchema = concreteScheduleHistorySchema.extend({
  flags: z.array(z.enum(CONCRETE_WORKLIST_FLAGS)),
});
export type ConcreteRescheduleResult = z.infer<typeof concreteRescheduleResultSchema>;
