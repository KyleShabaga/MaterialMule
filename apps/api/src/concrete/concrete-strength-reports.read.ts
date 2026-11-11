import {
  CONCRETE_STRENGTH_CALCULATION_NOTE,
  CONCRETE_STRENGTH_P1_NOTE,
  CONCRETE_STRENGTH_STANDARDS_LINE,
  CONCRETE_STRENGTH_WARNING_MESSAGE,
  concreteDaysBetween,
  concreteLabToday,
  concreteStrengthAgeLines,
  concreteTestEntryComplete,
  STRENGTH_REPORT_SCOPE,
  type ConcreteStrengthReportSnapshot,
  type ConcreteStrengthReportWarning,
  type ConcreteStrengthResultRow,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { ProjectContext } from '../auth/policy.js';
import { lockProjectGrants } from '../auth/standing.js';
import { projectContext } from '../project-access/project-access.service.js';
import { peopleOf } from './concrete-report-lifecycle.read.js';
import { currentMethod, findMethod, methodOf } from './concrete-strength.calc.js';
import { strengthTestsOf } from './concrete-strength-tests.read.js';

// MM-V2-C39: reading a specimen set as a strength report (design section 4) and the strength
// report row. Shared by the detail, the list and the lifecycle commands, so a version freezes
// exactly what the preview shows.

type Db = Pool | PoolClient;

export interface StrengthReportRow {
  id: string;
  project_id: string;
  specimen_set_id: string;
  workflow_state: 'draft' | 'submitted' | 'returned' | 'reviewed';
  issue_count: number;
  last_issued_version: number | null;
  last_issued_at: Date | null;
  /** From C32's concrete_report_number (the one source of truth), null before first issue. */
  report_number: string | null;
  version: number;
  updated_at: Date;
}

const REPORT_COLUMNS = `id, project_id, specimen_set_id, workflow_state, issue_count,
  last_issued_version, last_issued_at, version, updated_at,
  (SELECT n.report_number FROM concrete_report_number n WHERE n.report_kind = 'strength' AND n.subject_id = concrete_strength_report.id) AS report_number`;

export async function findStrengthReport(
  db: Db,
  setId: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<StrengthReportRow | null> {
  const { rows } = await db.query<StrengthReportRow>(
    `SELECT ${REPORT_COLUMNS} FROM concrete_strength_report WHERE specimen_set_id = $1 ${lock}`,
    [setId],
  );
  return rows[0] ?? null;
}

export interface SetFacts {
  id: string;
  project_id: string;
  field_report_id: string;
  /** The field report's CF number (C32), allocated at its issue; null until then. */
  field_report_number: string | null;
  permanent_id: string | null;
  temporary_id: string | null;
  specimen_type: string;
  mould_size: string | null;
  voided: boolean;
  report_void: boolean;
  cast_at: Date | null;
  casting_date: string | null;
  paper_field_id: string | null;
  location_elements: string[];
  location_element_other: string | null;
  location_description: string | null;
  supplier_name: string | null;
  mix_number: string | null;
  specified_strength_mpa: string | null;
  specified_strength_age_days: string | null;
  project_number: string;
  project_name: string;
  client: string | null;
  lead_project_engineer_user_id: string | null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export async function findSet(
  db: Db,
  setId: string,
  lock: '' | 'FOR UPDATE OF st' = '',
): Promise<SetFacts | null> {
  if (!UUID.test(setId)) return null;
  const { rows } = await db.query<SetFacts>(
    `SELECT st.id, st.project_id, st.field_report_id,
            (SELECT n.report_number FROM concrete_report_number n
             WHERE n.report_kind = 'field' AND n.subject_id = st.field_report_id)
              AS field_report_number,
            st.permanent_id, st.temporary_id,
            st.specimen_type, st.mould_size, st.voided_at IS NOT NULL AS voided,
            r.workflow_state = 'void' AS report_void, r.cast_at,
            concrete_casting_date(r.cast_at)::text AS casting_date, r.paper_field_id,
            r.location_elements, r.location_element_other, r.location_description,
            r.supplier_name, r.mix_number,
            r.project_spec->>'specifiedStrengthMpa' AS specified_strength_mpa,
            r.project_spec->>'specifiedStrengthAgeDays' AS specified_strength_age_days,
            p.project_number, p.name AS project_name, p.client, p.lead_project_engineer_user_id
     FROM concrete_specimen_set st
     JOIN concrete_field_report r ON r.id = st.field_report_id
     JOIN project p ON p.id = st.project_id
     WHERE st.id = $1 ${lock}`,
    [setId],
  );
  return rows[0] ?? null;
}

/**
 * The project context for a strength report's lifecycle checks: the lead, and the designated
 * reviewers and report issuers for the `concrete_strength` scope (read live).
 */
export async function strengthContext(
  db: Db,
  set: Pick<SetFacts, 'project_id' | 'lead_project_engineer_user_id'>,
): Promise<ProjectContext> {
  return projectContext(
    db,
    {
      id: set.project_id,
      lead_project_engineer_user_id: set.lead_project_engineer_user_id,
      project_number: '',
    },
    STRENGTH_REPORT_SCOPE,
    STRENGTH_REPORT_SCOPE,
  );
}

/**
 * Review fix (#134): the strength context for a final check, with the `concrete_strength` issuer
 * grants, reviewer assignments and approvals locked FOR SHARE first (`canUnderLock` loader).
 */
export async function lockedStrengthContext(
  client: PoolClient,
  set: Pick<SetFacts, 'project_id' | 'lead_project_engineer_user_id'>,
): Promise<ProjectContext> {
  await lockProjectGrants(client, set.project_id, {
    reportScope: STRENGTH_REPORT_SCOPE,
    reviewScope: STRENGTH_REPORT_SCOPE,
  });
  return strengthContext(client, set);
}

interface SpecimenSql {
  id: string;
  letter: string;
  assigned_age: string | null;
  target_date: string | null;
  disposed: boolean;
  result_id: string | null;
  attempt_no: number | null;
  tested_on: string | null;
  tester_user_id: string | null;
  tester_initials_snapshot: string | null;
  tester_name_snapshot: string | null;
  max_load: string | null;
  height_readings: string[] | null;
  diameter_readings: string[] | null;
  notes: string | null;
  load_unit: 'kN' | null;
  dimension_unit: 'mm' | null;
  units_provisional: boolean | null;
  entered_by: { userId: string; initials: string | null; name: string }[] | null;
}

/** The set's specimens with each one's latest result attempt, and who entered that attempt. */
async function specimensOf(db: Db, setId: string): Promise<SpecimenSql[]> {
  const { rows } = await db.query<SpecimenSql>(
    `SELECT sp.id, sp.letter, sp.assigned_age, sp.target_date::text,
            -- Disposed once removal is recorded; an authorization alone isn't removal.
            EXISTS (SELECT 1 FROM concrete_specimen_disposal d
                    WHERE d.specimen_id = sp.id AND d.disposed_at IS NOT NULL) AS disposed,
            tr.id AS result_id, tr.attempt_no, tr.tested_on::text, tr.tester_user_id,
            tr.tester_initials_snapshot, tr.tester_name_snapshot, tr.max_load::text,
            tr.height_readings::text[], tr.diameter_readings::text[], tr.notes, tr.load_unit,
            tr.dimension_unit, tr.units_provisional,
            (SELECT jsonb_agg(DISTINCT jsonb_build_object(
                      'userId', rv.entered_by_user_id::text,
                      'initials', rv.entered_by_initials_snapshot,
                      'name', rv.entered_by_name_snapshot))
             FROM concrete_test_result_revision rv WHERE rv.result_id = tr.id) AS entered_by
     FROM concrete_specimen sp
     LEFT JOIN LATERAL (
       SELECT * FROM concrete_test_result t WHERE t.specimen_id = sp.id
       ORDER BY t.attempt_no DESC LIMIT 1
     ) tr ON true
     WHERE sp.set_id = $1
     ORDER BY sp.letter`,
    [setId],
  );
  return rows;
}

async function setExtrasOf(
  db: Db,
  setId: string,
): Promise<{ received_on: string | null; curing: string | null }> {
  const { rows } = await db.query<{ received_on: string | null; curing: string | null }>(
    `SELECT
       (SELECT (min(rc.received_at) AT TIME ZONE 'America/Edmonton')::date::text
        FROM concrete_specimen_receipt rc JOIN concrete_specimen sp ON sp.id = rc.specimen_id
        WHERE sp.set_id = $1) AS received_on,
       (SELECT concat_ws(' · ', pk.curing_box, pk.curing_location)
        FROM concrete_specimen_pickup pk JOIN concrete_specimen sp ON sp.id = pk.specimen_id
        WHERE sp.set_id = $1 AND (pk.curing_box IS NOT NULL OR pk.curing_location IS NOT NULL)
        ORDER BY pk.created_at, pk.id LIMIT 1) AS curing`,
    [setId],
  );
  return rows[0] ?? { received_on: null, curing: null };
}

const numberOrNull = (value: string | null) => (value === null ? null : Number(value));

/**
 * The set as a strength report now (design section 4): the set block, one row per specimen
 * with its latest attempt, the per-age lines and the exceptions. MM-V2-C24: each tested row
 * carries its stored calculation (method version, raw and rounded values, flags, exclusion) and
 * each age line its strength test and advisory assessment. Version-specific parts (version and
 * rev numbers, revision) are the caller's.
 */
export async function buildStrengthSnapshot(
  db: Db,
  set: SetFacts,
  meta: {
    reportId: string;
    versionNo: number;
    revNo: number;
    revision: ConcreteStrengthReportSnapshot['revision'];
    today?: string;
  },
): Promise<ConcreteStrengthReportSnapshot> {
  const today = meta.today ?? concreteLabToday();
  const specimens = await specimensOf(db, set.id);
  const strength = await strengthTestsOf(db, [set.id]);
  const bySpecimen = new Map(strength.specimens.map((sp) => [sp.specimenId, sp]));
  const extras = await setExtrasOf(db, set.id);
  const lead = set.lead_project_engineer_user_id
    ? ((await peopleOf(db, [set.lead_project_engineer_user_id])).get(
        set.lead_project_engineer_user_id,
      ) ?? null)
    : null;
  const label = set.permanent_id ?? set.temporary_id ?? 'Unnumbered set';
  const results: ConcreteStrengthResultRow[] = specimens.map((sp) => {
    const tester: PersonSnapshot | null =
      sp.tester_user_id === null
        ? null
        : {
            userId: sp.tester_user_id,
            initials: sp.tester_initials_snapshot,
            name: sp.tester_name_snapshot ?? 'Unknown',
          };
    const heights = (sp.height_readings ?? []).map(Number);
    const diameters = (sp.diameter_readings ?? []).map(Number);
    const maxLoad = numberOrNull(sp.max_load);
    const facts = bySpecimen.get(sp.id);
    const calc = facts?.calculation ?? null;
    const complete =
      sp.result_id !== null &&
      concreteTestEntryComplete({
        testedOn: sp.tested_on,
        tester,
        maxLoad,
        heightReadings: heights,
        diameterReadings: diameters,
      });
    const age =
      sp.assigned_age === null
        ? null
        : sp.assigned_age === 'HOLD'
          ? 'HOLD'
          : Number(sp.assigned_age);
    const status: ConcreteStrengthResultRow['status'] = complete
      ? 'tested'
      : sp.disposed
        ? 'disposed'
        : age === 'HOLD'
          ? 'hold'
          : 'not_yet_tested';
    return {
      specimenId: sp.id,
      letter: sp.letter,
      specimenLabel: label + sp.letter,
      identity: {
        permanentId: set.permanent_id === null ? null : set.permanent_id + sp.letter,
        temporaryId: set.temporary_id === null ? null : set.temporary_id + sp.letter,
      },
      assignedAge: age,
      targetDate: sp.target_date,
      status,
      reported: complete,
      resultId: sp.result_id,
      attemptNo: sp.attempt_no,
      testedOn: sp.tested_on,
      actualAgeDays:
        sp.tested_on !== null && set.casting_date !== null
          ? concreteDaysBetween(set.casting_date, sp.tested_on)
          : null,
      heightReadings: heights,
      diameterReadings: diameters,
      averageDiameter: complete ? (calc?.meanDiameter ?? null) : null,
      averageHeight: complete ? (calc?.meanHeight ?? null) : null,
      area: complete ? (calc?.area ?? null) : null,
      maxLoad,
      strength: complete ? (calc?.strength ?? null) : null,
      strengthRaw: complete ? (calc?.strengthRaw ?? null) : null,
      ldRatio: complete ? (calc?.ldRatio ?? null) : null,
      correctionFactor: complete ? (calc?.correctionFactor ?? null) : null,
      calculationMethodVersion: complete ? (calc?.methodVersion ?? null) : null,
      flags: complete ? (facts?.flags ?? []) : [],
      excluded: facts?.excluded ?? null,
      fractureType: null,
      testedBy: tester,
      enteredBy: [...(sp.entered_by ?? [])].sort((a, b) => a.userId.localeCompare(b.userId)),
      remarks: sp.notes,
    };
  });
  const warnings: ConcreteStrengthReportWarning[] = [];
  for (const row of results) {
    const field = `results.${row.letter}`;
    if (row.status === 'tested' && row.targetDate !== null && row.testedOn !== row.targetDate) {
      warnings.push({
        code: 'strength_tested_off_target',
        field,
        message: CONCRETE_STRENGTH_WARNING_MESSAGE.strength_tested_off_target,
      });
    }
    if (row.status === 'not_yet_tested' && row.targetDate !== null && row.targetDate < today) {
      warnings.push({
        code: 'strength_overdue_untested',
        field,
        message: CONCRETE_STRENGTH_WARNING_MESSAGE.strength_overdue_untested,
      });
    }
  }
  const ages = concreteStrengthAgeLines(results).map((age) => {
    const test = strength.lines.find((l) => l.ageDays === age.ageDays);
    return test && age.complete
      ? {
          ...age,
          averageStrength: test.average,
          assessment: test.assessment,
          countedCount: test.count,
          single: test.single,
          runningAverage: test.runningAverage,
          failed: test.failed,
        }
      : age;
  });
  // The method line: the version the reported values use (the current one before any).
  const versions = [
    ...new Set(
      results.flatMap((r) => (r.calculationMethodVersion ? [r.calculationMethodVersion] : [])),
    ),
  ];
  const methodRow =
    versions.length === 1 ? await findMethod(db, versions[0]!) : await currentMethod(db);
  const unitSource = specimens.find((sp) => sp.load_unit !== null);
  return {
    kind: 'strength',
    versionNo: meta.versionNo,
    revNo: meta.revNo,
    revision: meta.revision,
    reportId: meta.reportId,
    projectId: set.project_id,
    projectNumber: set.project_number,
    projectName: set.project_name,
    client: set.client,
    leadProjectEngineer: lead,
    set: {
      setId: set.id,
      identity: { permanentId: set.permanent_id, temporaryId: set.temporary_id },
      fieldReportId: set.field_report_id,
      fieldReportNumber: set.field_report_number,
      paperFieldId: set.paper_field_id,
      castAt: set.cast_at?.toISOString() ?? null,
      castingDate: set.casting_date,
      structureElements: set.location_elements,
      structureElementOther: set.location_element_other,
      location: set.location_description,
      supplierName: set.supplier_name,
      mixNumber: set.mix_number,
      specifiedStrengthMpa: numberOrNull(set.specified_strength_mpa),
      specifiedStrengthAgeDays: numberOrNull(set.specified_strength_age_days),
      specimenType: set.specimen_type,
      specimenSize: set.mould_size,
      receivedOn: extras.received_on,
      initialFieldCuring: extras.curing || null,
      labCuring: null,
    },
    units: {
      load: unitSource?.load_unit ?? 'kN',
      dimension: unitSource?.dimension_unit ?? 'mm',
      provisional: unitSource?.units_provisional ?? true,
    },
    results,
    ages,
    agesReported: ages.filter((a) => a.complete).map((a) => a.ageDays),
    warnings,
    standardsLine: CONCRETE_STRENGTH_STANDARDS_LINE,
    calculation: methodRow
      ? {
          method: methodOf(methodRow),
          note: methodRow.provisional
            ? CONCRETE_STRENGTH_P1_NOTE
            : 'The assessment is an advisory flag for the reviewer, not acceptance.',
        }
      : { method: null, note: CONCRETE_STRENGTH_CALCULATION_NOTE },
  };
}
