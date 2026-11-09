import { z } from 'zod';
import { concreteSpecimenAgeSchema } from './concrete-settings';

// The project Concrete section's Specimens tab (MM-V2-C30): every specimen of the project, one row
// each, newest casting first. Read only; a row opens its field report. Strength is C07/C23's (the
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
  /** Measured strength (MPa): C07/C23. Null until a result exists. */
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
