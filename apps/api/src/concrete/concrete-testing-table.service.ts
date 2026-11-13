import { Injectable } from '@nestjs/common';
import {
  CONCRETE_TESTING_TABLE_MAX_ROWS,
  compareConcreteTestingRows,
  concreteDaysBetween,
  concreteLabToday,
  concreteStrengthRelativeFlags,
  concreteTestEntryComplete,
  concreteTestingTableQuerySchema,
  concreteWorklistFlags,
  type ConcreteTestingTable,
  type ConcreteTestingTableGroup,
  type ConcreteTestingTableResult,
  type ConcreteTestingTableRow,
} from '@materialmule/shared';
import { DatabaseService } from '../database/database.service.js';
import { parseBody } from '../validation/parse-body.js';
import { loadHolidayDates } from './concrete-reference-data.service.js';
import { calcColumnsSql, calculationOf, type CalcSql } from './concrete-strength.calc.js';

/**
 * A result whose entry is complete (the shared `concreteTestEntryComplete` rule): test date,
 * tester, max load and at least one height and one diameter reading. Entry completeness only;
 * never a completed test (strength and pass/fail wait on C24 / G2).
 */
export function entryCompleteSql(alias: string): string {
  return `(${alias}.tested_on IS NOT NULL AND ${alias}.tester_user_id IS NOT NULL
    AND ${alias}.max_load IS NOT NULL AND cardinality(${alias}.height_readings) > 0
    AND cardinality(${alias}.diameter_readings) > 0)`;
}

/** The specimen has a complete entry tested before `dateSql` (it no longer waits for a break). */
export function testedBeforeSql(specimenAlias: string, dateSql: string): string {
  return `EXISTS (SELECT 1 FROM concrete_test_result tc WHERE tc.specimen_id = ${specimenAlias}.id
    AND ${entryCompleteSql('tc')} AND tc.tested_on < ${dateSql})`;
}

interface TableRowSql extends CalcSql {
  specified_mpa: string | null;
  excluded: boolean;
  specimen_id: string;
  set_id: string;
  field_report_id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  letter: string;
  temporary_id: string | null;
  permanent_id: string | null;
  permanent_number: number | null;
  assigned_age: string;
  casting_date: string;
  target_date: string;
  workflow_state: string;
  reschedules: number;
  result_id: string | null;
  attempt_no: number | null;
  result_version: number | null;
  tested_on: string | null;
  tester_user_id: string | null;
  tester_initials_snapshot: string | null;
  tester_name_snapshot: string | null;
  max_load: string | null;
  height_readings: string[] | null;
  diameter_readings: string[] | null;
  load_unit: 'kN' | null;
  dimension_unit: 'mm' | null;
  units_provisional: boolean | null;
  entered_at: Date | null;
}

/**
 * The daily concrete testing table (MM-V2-C23): today's breaks, optionally with the overdue
 * ones, each with its latest C07 result attempt. Read only (`inventory.read`, as every concrete
 * read); entry goes through C07's PUT (`concrete_test.enter`).
 *
 * Rows are the C22 worklist's scheduled specimens (set and report not Void, a casting time, a
 * numeric age, not authorized for disposal) whose target is today, or (Include overdue) whose
 * target has passed and which have no complete entry tested before today. An overdue row keeps
 * its stored target: nothing here reschedules (AC4).
 */
@Injectable()
export class ConcreteTestingTableService {
  constructor(private readonly database: DatabaseService) {}

  async table(query: unknown): Promise<ConcreteTestingTable> {
    const input = parseBody(concreteTestingTableQuerySchema, query);
    const db = this.database.pool;
    const today = input.on ?? concreteLabToday();
    // The listed specimens ($1 today, $2 Include overdue, $3 the project or null for all, $4 a
    // specimen selection or null: STRATA-95, any target date, still only scheduled specimens).
    const listed = `FROM (SELECT $1::date AS today, $2::boolean AS include_overdue,
                                 $3::uuid AS project_id, $4::uuid[] AS specimen_ids) q
       CROSS JOIN concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       JOIN project p ON p.id = sp.project_id`;
    const listedWhere = `st.voided_at IS NULL AND r.workflow_state <> 'void' AND r.cast_at IS NOT NULL
         AND sp.assigned_age IS NOT NULL AND sp.assigned_age <> 'HOLD'
         AND (q.project_id IS NULL OR sp.project_id = q.project_id)
         AND NOT EXISTS (SELECT 1 FROM concrete_specimen_disposal d WHERE d.specimen_id = sp.id)
         AND (CASE WHEN q.specimen_ids IS NOT NULL THEN sp.id = ANY(q.specimen_ids)
                   AND sp.target_date IS NOT NULL
              ELSE sp.target_date = q.today
                   OR (q.include_overdue AND sp.target_date < q.today
                       AND NOT ${testedBeforeSql('sp', 'q.today')}) END)`;
    // Every project with a listed row, whatever the project filter and the row limit, so the
    // page can offer each one and read it on its own.
    const { rows: projects } = await db.query<{
      id: string;
      project_number: string;
      name: string;
    }>(
      `SELECT DISTINCT p.id, p.project_number, p.name ${listed} WHERE ${listedWhere}
       ORDER BY p.project_number, p.id`,
      [today, input.includeOverdue, null, null],
    );
    const { rows } = await db.query<TableRowSql>(
      `SELECT sp.id AS specimen_id, sp.set_id, st.field_report_id, sp.project_id,
              p.project_number, p.name AS project_name, sp.letter, st.temporary_id,
              st.permanent_id, st.permanent_number, sp.assigned_age,
              concrete_casting_date(r.cast_at)::text AS casting_date, sp.target_date::text,
              r.workflow_state,
              (SELECT count(*)::int FROM concrete_specimen_reschedule x
               WHERE x.specimen_id = sp.id) AS reschedules,
              tr.id AS result_id, tr.attempt_no, tr.version AS result_version,
              tr.tested_on::text, tr.tester_user_id, tr.tester_initials_snapshot,
              tr.tester_name_snapshot, tr.max_load::text, tr.height_readings::text[],
              tr.diameter_readings::text[], tr.load_unit, tr.dimension_unit,
              tr.units_provisional,
              (SELECT max(rv.created_at) FROM concrete_test_result_revision rv
               WHERE rv.result_id = tr.id) AS entered_at,
              ${calcColumnsSql('tr')},
              r.project_spec->>'specifiedStrengthMpa' AS specified_mpa,
              coalesce((SELECT e.action = 'exclude' FROM concrete_strength_exclusion e
                        WHERE e.specimen_id = sp.id ORDER BY e.sequence_no DESC LIMIT 1),
                       false) AS excluded
       ${listed}
         LEFT JOIN LATERAL (
           SELECT * FROM concrete_test_result t WHERE t.specimen_id = sp.id
           ORDER BY t.attempt_no DESC LIMIT 1
         ) tr ON true
       WHERE ${listedWhere}
       ORDER BY p.project_number, p.id, st.permanent_number NULLS LAST, st.temporary_id,
                st.id, sp.letter
       LIMIT ${CONCRETE_TESTING_TABLE_MAX_ROWS + 1}`,
      [today, input.includeOverdue, input.projectId ?? null, input.specimenIds ?? null],
    );
    const truncated = rows.length > CONCRETE_TESTING_TABLE_MAX_ROWS;
    const holidays = await loadHolidayDates(db);
    const groups: ConcreteTestingTableGroup[] = [];
    const byProject = new Map<string, ConcreteTestingTableGroup>();
    for (const row of rows.slice(0, CONCRETE_TESTING_TABLE_MAX_ROWS)) {
      let group = byProject.get(row.project_id);
      if (!group) {
        group = {
          projectId: row.project_id,
          projectNumber: row.project_number,
          projectName: row.project_name,
          rows: [],
        };
        byProject.set(row.project_id, group);
        groups.push(group);
      }
      group.rows.push(toRow(row, today, holidays));
    }
    // The shared comparator decides the order within a project (numeric set counter, letter).
    for (const group of groups) group.rows.sort(compareConcreteTestingRows);
    const all = groups.flatMap((g) => g.rows);
    return {
      today,
      includeOverdue: input.includeOverdue,
      total: all.length,
      completed: all.filter((r) => r.complete).length,
      truncated,
      projects: projects.map((p) => ({
        projectId: p.id,
        projectNumber: p.project_number,
        projectName: p.name,
      })),
      groups,
    };
  }
}

function toRow(
  row: TableRowSql,
  today: string,
  holidays: Awaited<ReturnType<typeof loadHolidayDates>>,
): ConcreteTestingTableRow {
  const assignedAge = Number(row.assigned_age);
  const late = concreteDaysBetween(row.target_date, today);
  const result: ConcreteTestingTableResult | null =
    row.result_id === null
      ? null
      : {
          id: row.result_id,
          attemptNo: row.attempt_no!,
          version: row.result_version!,
          testedOn: row.tested_on,
          tester:
            row.tester_user_id === null
              ? null
              : {
                  userId: row.tester_user_id,
                  initials: row.tester_initials_snapshot,
                  name: row.tester_name_snapshot!,
                },
          maxLoad: row.max_load === null ? null : Number(row.max_load),
          heightReadings: (row.height_readings ?? []).map(Number),
          diameterReadings: (row.diameter_readings ?? []).map(Number),
          units: {
            load: row.load_unit!,
            dimension: row.dimension_unit!,
            provisional: row.units_provisional!,
          },
          enteredAt: (row.entered_at ?? new Date()).toISOString(),
          calculation: calculationOf(row),
          strengthFlags: [],
          excluded: row.excluded,
        };
  const specified =
    row.specified_mpa === null || row.specified_mpa === '' ? null : Number(row.specified_mpa);
  if (result?.calculation) {
    result.strengthFlags = [
      ...result.calculation.flags,
      ...concreteStrengthRelativeFlags(result.calculation.strength, specified),
    ];
  }
  return {
    specimenId: row.specimen_id,
    setId: row.set_id,
    fieldReportId: row.field_report_id,
    projectId: row.project_id,
    letter: row.letter,
    identity: {
      temporaryId: row.temporary_id === null ? null : row.temporary_id + row.letter,
      permanentId: row.permanent_id === null ? null : row.permanent_id + row.letter,
    },
    permanentNumber: row.permanent_number,
    assignedAge,
    castingDate: row.casting_date,
    targetDate: row.target_date,
    daysOverdue: late > 0 ? late : null,
    actualAge: concreteDaysBetween(row.casting_date, result?.testedOn ?? today),
    reportState: row.workflow_state,
    specifiedStrengthMpa: specified,
    flags: concreteWorklistFlags({
      assignedAge,
      targetDate: row.target_date,
      holdExpiresOn: null,
      today,
      rescheduleCount: row.reschedules,
      reportState: row.workflow_state,
      holidays,
    }),
    result,
    complete: concreteTestEntryComplete(result),
  };
}
