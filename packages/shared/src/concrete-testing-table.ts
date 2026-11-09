import { z } from 'zod';
import { concreteSpecimenIdentitySchema } from './concrete';
import {
  CONCRETE_TEST_RESULT_DIMENSION_UNITS,
  CONCRETE_TEST_RESULT_LOAD_UNITS,
} from './concrete-test-results';
import { CONCRETE_WORKLIST_FLAGS } from './concrete-worklist';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C23: the daily concrete testing table (direct entry on the lab computers).
//
// - Rows: today's breaks (target date today, America/Edmonton), optionally with the overdue
//   ones. Overdue rows are flagged and keep their target: the table never reschedules (AC4).
// - Grouped by project, then sorted by set number (numeric: 26-2 before 26-10), then letter.
// - Entry writes C07 test-result drafts (PUT …/test-results/:resultId). The row shows the
//   latest attempt; a row with no attempt saves a new one with a client-chosen ID.
// - "Complete" is an entry-completeness check only (test date, tester, max load and at least one
//   height and one diameter reading). It is not a completed test: strength, rounding and
//   pass/fail wait on C24 (owner gate G2), and the number of readings and units on G8.
// - Each saved row keeps its own tester: the page's "Tested by" only fills new rows (AC1).

/** `GET /api/concrete/testing-table` query (`inventory.read`). */
export const concreteTestingTableQuerySchema = z.strictObject({
  /** The business date to read as today; defaults to the lab's date now. */
  on: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).optional(),
  /** Also list overdue, not-yet-complete specimens (flagged; their targets never change). */
  includeOverdue: z
    .enum(['true', 'false'], { error: 'Use true or false' })
    .transform((value) => value === 'true')
    .default(false),
  projectId: z.uuid({ error: 'must be an ID' }).optional(),
});
export type ConcreteTestingTableQuery = z.infer<typeof concreteTestingTableQuerySchema>;

/** Rows per response; the table says when there are more. */
export const CONCRETE_TESTING_TABLE_MAX_ROWS = 500;

/** The latest attempt as the table shows and edits it. */
export const concreteTestingTableResultSchema = z.object({
  id: z.string(),
  attemptNo: z.number().int(),
  version: z.number().int(),
  testedOn: z.string().nullable(),
  tester: personSnapshotSchema.nullable(),
  maxLoad: z.number().nullable(),
  heightReadings: z.array(z.number()),
  diameterReadings: z.array(z.number()),
  units: z.object({
    load: z.enum(CONCRETE_TEST_RESULT_LOAD_UNITS),
    dimension: z.enum(CONCRETE_TEST_RESULT_DIMENSION_UNITS),
    provisional: z.boolean(),
  }),
  /** When the latest change was entered (kept apart from the test date). */
  enteredAt: z.string(),
});
export type ConcreteTestingTableResult = z.infer<typeof concreteTestingTableResultSchema>;

export const concreteTestingTableRowSchema = z.object({
  specimenId: z.string(),
  setId: z.string(),
  fieldReportId: z.string(),
  projectId: z.string(),
  letter: z.string(),
  identity: concreteSpecimenIdentitySchema,
  /** The set's permanent counter (null until numbered): the numeric sort key. */
  permanentNumber: z.number().int().nullable(),
  assignedAge: z.number().int(),
  castingDate: z.string(),
  targetDate: z.string(),
  /** Whole days past the target (overdue rows), else null. */
  daysOverdue: z.number().int().nullable(),
  /** Actual age on the test date (or today while untested), in whole days from casting. */
  actualAge: z.number().int(),
  reportState: z.string(),
  flags: z.array(z.enum(CONCRETE_WORKLIST_FLAGS)),
  result: concreteTestingTableResultSchema.nullable(),
  /** Entry complete (see `concreteTestEntryComplete`); never a completed test. */
  complete: z.boolean(),
});
export type ConcreteTestingTableRow = z.infer<typeof concreteTestingTableRowSchema>;

export const concreteTestingTableGroupSchema = z.object({
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  rows: z.array(concreteTestingTableRowSchema),
});
export type ConcreteTestingTableGroup = z.infer<typeof concreteTestingTableGroupSchema>;

export const concreteTestingTableSchema = z.object({
  today: z.string(),
  includeOverdue: z.boolean(),
  /** Rows listed (all groups). */
  total: z.number().int().min(0),
  /** Rows whose entry is complete. */
  completed: z.number().int().min(0),
  /** More rows matched than were returned (CONCRETE_TESTING_TABLE_MAX_ROWS). */
  truncated: z.boolean(),
  groups: z.array(concreteTestingTableGroupSchema),
});
export type ConcreteTestingTable = z.infer<typeof concreteTestingTableSchema>;

/**
 * Whether a result's entry is complete enough to count as done on the table: a test date, a
 * tester, the maximum load and at least one height and one diameter reading. Incomplete rows are
 * saved but not counted. The API's SQL applies the same rule (`CONCRETE_ENTRY_COMPLETE_SQL`).
 */
export function concreteTestEntryComplete(
  result: {
    testedOn: string | null;
    tester: unknown;
    maxLoad: number | null;
    heightReadings: readonly number[];
    diameterReadings: readonly number[];
  } | null,
): boolean {
  return (
    result !== null &&
    result.testedOn !== null &&
    result.tester !== null &&
    result.tester !== undefined &&
    result.maxLoad !== null &&
    result.heightReadings.length > 0 &&
    result.diameterReadings.length > 0
  );
}

const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });

/**
 * The table's order within a project: numbered sets by their permanent counter (numeric, so 2
 * comes before 10), then unnumbered sets by temporary ID (numeric-aware), then by set, then by
 * specimen letter.
 */
export function compareConcreteTestingRows(
  a: Pick<ConcreteTestingTableRow, 'permanentNumber' | 'identity' | 'setId' | 'letter'>,
  b: Pick<ConcreteTestingTableRow, 'permanentNumber' | 'identity' | 'setId' | 'letter'>,
): number {
  if (a.permanentNumber !== b.permanentNumber) {
    if (a.permanentNumber === null) return 1;
    if (b.permanentNumber === null) return -1;
    return a.permanentNumber - b.permanentNumber;
  }
  if (a.permanentNumber === null) {
    const at = a.identity.temporaryId;
    const bt = b.identity.temporaryId;
    if (at !== bt) {
      if (at === null) return 1;
      if (bt === null) return -1;
      // Compare the set part only, so the letter decides last.
      const bySet = collator.compare(at.slice(0, -a.letter.length), bt.slice(0, -b.letter.length));
      if (bySet !== 0) return bySet;
    }
  }
  if (a.setId !== b.setId) return a.setId < b.setId ? -1 : 1;
  return collator.compare(a.letter, b.letter);
}

/**
 * Readings typed into one cell: numbers separated by spaces, commas or semicolons. Returns null
 * when something isn't a positive number (the cell shows it as invalid, nothing is sent).
 */
export function parseConcreteReadings(text: string): number[] | null {
  const parts = text
    .split(/[\s,;]+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
  const values: number[] = [];
  for (const part of parts) {
    if (!/^\d+(\.\d+)?$|^\.\d+$/.test(part)) return null;
    const value = Number(part);
    if (!Number.isFinite(value) || value <= 0) return null;
    values.push(value);
  }
  return values;
}

/** The hideable columns of the testing table (the specimen ID and save status always show). */
export const CONCRETE_TESTING_TABLE_COLUMNS = [
  'project',
  'age',
  'testedOn',
  'tester',
  'maxLoad',
  'height',
  'diameter',
  'strength',
  'flags',
] as const;
export type ConcreteTestingTableColumn = (typeof CONCRETE_TESTING_TABLE_COLUMNS)[number];

export const CONCRETE_TESTING_TABLE_COLUMN_LABEL: Record<ConcreteTestingTableColumn, string> = {
  project: 'Project',
  age: 'Age (assigned / actual)',
  testedOn: 'Test date',
  tester: 'Tested by',
  maxLoad: 'Max load',
  height: 'Height',
  diameter: 'Diameter',
  strength: 'Strength',
  flags: 'Flags',
};
