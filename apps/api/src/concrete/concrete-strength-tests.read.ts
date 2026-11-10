import {
  concreteStrengthAssessment,
  concreteStrengthFailed,
  concreteStrengthRelativeFlags,
  concreteStrengthTest,
  concreteTestEntryComplete,
  type ConcreteStrengthCalculation,
  type ConcreteStrengthExclusion,
  type ConcreteStrengthFlag,
  type ConcreteStrengthTestLine,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { calcColumnsSql, calculationOf, type CalcSql } from './concrete-strength.calc.js';

// MM-V2-C24: strength tests (one set, one assigned age) and their advisory assessment, read
// live from the stored calculations and the reviewer's exclusions. Shared by the strength-tests
// read (C25 consumes `failed`), the testing table and the strength report snapshot, so every view
// agrees with what a version freezes.
//
// - A test exists once its age is complete (every specimen of the age that isn't disposed has a
//   complete entry) and at least one specimen counts (complete, with a strength, not excluded).
// - The running average uses the previous two reference-age tests of sets on the same project and
//   registry mix (field report `mix_id`), ordered by test date (latest counted test date), then
//   casting time, then set. A set without a registry mix has no running average (proposal).

type Db = Pool | PoolClient;

export interface SpecimenStrength {
  specimenId: string;
  setId: string;
  letter: string;
  assignedAge: number | 'HOLD' | null;
  disposed: boolean;
  resultId: string | null;
  complete: boolean;
  testedOn: string | null;
  calculation: ConcreteStrengthCalculation | null;
  excluded: ConcreteStrengthExclusion | null;
  /** Specimen flags plus those against the set's specified strength. */
  flags: ConcreteStrengthFlag[];
}

interface SetSpec {
  set_id: string;
  project_id: string;
  mix_id: string | null;
  cast_at: Date | null;
  specified_mpa: string | null;
  reference_age: string | null;
}

interface SpecimenSql extends CalcSql {
  specimen_id: string;
  set_id: string;
  letter: string;
  assigned_age: string | null;
  disposed: boolean;
  result_id: string | null;
  tested_on: string | null;
  tester_user_id: string | null;
  max_load: string | null;
  height_count: number | null;
  diameter_count: number | null;
}

const num = (value: string | null) => (value === null || value === '' ? null : Number(value));

/** The latest exclusion event per specimen: excluded (with reason, who, when) or not. */
export async function exclusionsOf(
  db: Db,
  specimenIds: readonly string[],
): Promise<Map<string, ConcreteStrengthExclusion | null>> {
  const map = new Map<string, ConcreteStrengthExclusion | null>();
  if (specimenIds.length === 0) return map;
  const { rows } = await db.query<{
    specimen_id: string;
    action: 'exclude' | 'reinstate';
    reason: string;
    user_id: string;
    user_initials_snapshot: string | null;
    user_name_snapshot: string;
    created_at: Date;
  }>(
    `SELECT DISTINCT ON (specimen_id) specimen_id, action, reason, user_id,
            user_initials_snapshot, user_name_snapshot, created_at
     FROM concrete_strength_exclusion WHERE specimen_id = ANY($1::uuid[])
     ORDER BY specimen_id, sequence_no DESC`,
    [specimenIds],
  );
  for (const row of rows) {
    map.set(
      row.specimen_id,
      row.action === 'exclude'
        ? {
            reason: row.reason,
            by: {
              userId: row.user_id,
              initials: row.user_initials_snapshot,
              name: row.user_name_snapshot,
            },
            at: row.created_at.toISOString(),
          }
        : null,
    );
  }
  return map;
}

async function specsOf(db: Db, setIds: readonly string[]): Promise<SetSpec[]> {
  const { rows } = await db.query<SetSpec>(
    `SELECT st.id AS set_id, st.project_id, r.mix_id, r.cast_at,
            r.project_spec->>'specifiedStrengthMpa' AS specified_mpa,
            r.project_spec->>'specifiedStrengthAgeDays' AS reference_age
     FROM concrete_specimen_set st JOIN concrete_field_report r ON r.id = st.field_report_id
     WHERE st.id = ANY($1::uuid[])`,
    [setIds],
  );
  return rows;
}

/** The other live sets on the same project and registry mix (for the running average). */
async function peerSetIds(db: Db, specs: readonly SetSpec[]): Promise<string[]> {
  const pairs = specs.filter((s) => s.mix_id !== null);
  if (pairs.length === 0) return [];
  const { rows } = await db.query<{ id: string }>(
    `SELECT st.id FROM concrete_specimen_set st
     JOIN concrete_field_report r ON r.id = st.field_report_id
     WHERE st.voided_at IS NULL AND r.workflow_state <> 'void'
       AND (st.project_id, r.mix_id) IN (
         SELECT * FROM unnest($1::uuid[], $2::uuid[]))`,
    [pairs.map((p) => p.project_id), pairs.map((p) => p.mix_id)],
  );
  return rows.map((r) => r.id);
}

/** Every specimen of the sets with its latest attempt's stored calculation and exclusion. */
export async function specimenStrengthsOf(
  db: Db,
  setIds: readonly string[],
  specs?: ReadonlyMap<string, { specifiedMpa: number | null }>,
): Promise<SpecimenStrength[]> {
  if (setIds.length === 0) return [];
  const { rows } = await db.query<SpecimenSql>(
    `SELECT sp.id AS specimen_id, sp.set_id, sp.letter, sp.assigned_age,
            -- Disposed once removal is recorded; an authorization alone isn't removal.
            EXISTS (SELECT 1 FROM concrete_specimen_disposal d
                    WHERE d.specimen_id = sp.id AND d.disposed_at IS NOT NULL) AS disposed,
            t.id AS result_id, t.tested_on::text, t.tester_user_id, t.max_load::text,
            cardinality(t.height_readings) AS height_count,
            cardinality(t.diameter_readings) AS diameter_count, ${calcColumnsSql('t')}
     FROM concrete_specimen sp
     LEFT JOIN LATERAL (
       SELECT * FROM concrete_test_result x WHERE x.specimen_id = sp.id
       ORDER BY x.attempt_no DESC LIMIT 1
     ) t ON true
     WHERE sp.set_id = ANY($1::uuid[])
     ORDER BY sp.set_id, sp.letter`,
    [setIds],
  );
  const exclusions = await exclusionsOf(
    db,
    rows.map((r) => r.specimen_id),
  );
  return rows.map((row) => {
    const calculation = calculationOf(row);
    const complete =
      row.result_id !== null &&
      concreteTestEntryComplete({
        testedOn: row.tested_on,
        tester: row.tester_user_id,
        maxLoad: num(row.max_load),
        heightReadings: Array.from({ length: row.height_count ?? 0 }, () => 1),
        diameterReadings: Array.from({ length: row.diameter_count ?? 0 }, () => 1),
      });
    const specified = specs?.get(row.set_id)?.specifiedMpa ?? null;
    return {
      specimenId: row.specimen_id,
      setId: row.set_id,
      letter: row.letter,
      assignedAge:
        row.assigned_age === null
          ? null
          : row.assigned_age === 'HOLD'
            ? 'HOLD'
            : Number(row.assigned_age),
      disposed: row.disposed,
      resultId: row.result_id,
      complete,
      testedOn: row.tested_on,
      calculation,
      excluded: exclusions.get(row.specimen_id) ?? null,
      flags: [
        ...(calculation?.flags ?? []),
        ...concreteStrengthRelativeFlags(calculation?.strength ?? null, specified),
      ],
    };
  });
}

/** One set's lines (one per numeric assigned age), without the assessment. */
function linesOf(
  setId: string,
  specimens: readonly SpecimenStrength[],
): ConcreteStrengthTestLine[] {
  const byAge = new Map<number, SpecimenStrength[]>();
  for (const sp of specimens) {
    if (sp.setId !== setId || typeof sp.assignedAge !== 'number') continue;
    byAge.set(sp.assignedAge, [...(byAge.get(sp.assignedAge) ?? []), sp]);
  }
  return [...byAge.entries()]
    .sort(([a], [b]) => a - b)
    .map(([ageDays, list]) => {
      const tested = list.filter((sp) => sp.complete).length;
      const open = list.filter((sp) => !sp.complete && !sp.disposed).length;
      const complete = tested > 0 && open === 0;
      const rows = list.map((sp) => ({
        specimenId: sp.specimenId,
        letter: sp.letter,
        resultId: sp.resultId,
        complete: sp.complete,
        calculation: sp.calculation,
        flags: sp.flags,
        excluded: sp.excluded,
        counted: sp.complete && sp.calculation?.strengthRaw != null && sp.excluded === null,
      }));
      const test = complete
        ? concreteStrengthTest(
            list
              .filter((sp) => sp.complete)
              .map((sp) => ({
                strengthRaw: sp.calculation?.strengthRaw ?? null,
                excluded: sp.excluded !== null,
              })),
          )
        : null;
      const counted = list.filter((sp, i) => rows[i]!.counted);
      const testedOn = counted.reduce<string | null>(
        (latest, sp) =>
          sp.testedOn !== null && (latest === null || sp.testedOn > latest) ? sp.testedOn : latest,
        null,
      );
      return {
        setId,
        ageDays,
        complete,
        testedOn: test ? testedOn : null,
        specimens: rows,
        count: test?.count ?? 0,
        averageRaw: test?.averageRaw ?? null,
        average: test?.average ?? null,
        single: test?.single ?? false,
        referenceAge: false,
        assessment: null,
        runningAverage: null,
        failed: false,
        methodVersions: [
          ...new Set(
            counted.flatMap((sp) => (sp.calculation ? [sp.calculation.methodVersion] : [])),
          ),
        ].sort(),
      };
    });
}

/**
 * The strength tests of the given sets, assessed (advisory). Reads the peer sets on the same
 * project and mix for the running average.
 */
export async function strengthTestsOf(
  db: Db,
  setIds: readonly string[],
): Promise<{ lines: ConcreteStrengthTestLine[]; specimens: SpecimenStrength[] }> {
  if (setIds.length === 0) return { lines: [], specimens: [] };
  const targets = await specsOf(db, setIds);
  const peers = (await peerSetIds(db, targets)).filter((id) => !setIds.includes(id));
  const peerSpecs = peers.length > 0 ? await specsOf(db, peers) : [];
  const allSpecs = [...targets, ...peerSpecs];
  const specById = new Map(
    allSpecs.map((s) => [
      s.set_id,
      { ...s, specifiedMpa: num(s.specified_mpa), referenceAge: num(s.reference_age) },
    ]),
  );
  const specimens = await specimenStrengthsOf(db, [...setIds, ...peers], specById);

  // Every reference-age test per project + mix, in running-average order.
  const history = new Map<string, { setId: string; average: number; key: string }[]>();
  for (const spec of allSpecs) {
    const facts = specById.get(spec.set_id)!;
    if (spec.mix_id === null || facts.referenceAge === null) continue;
    const line = linesOf(spec.set_id, specimens).find((l) => l.ageDays === facts.referenceAge);
    if (!line || line.average === null) continue;
    const pair = `${spec.project_id}|${spec.mix_id}`;
    const key = [line.testedOn ?? '', spec.cast_at?.toISOString() ?? '', spec.set_id].join('|');
    history.set(pair, [
      ...(history.get(pair) ?? []),
      { setId: spec.set_id, average: line.average, key },
    ]);
  }
  for (const list of history.values())
    list.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  const lines: ConcreteStrengthTestLine[] = [];
  for (const spec of targets) {
    const facts = specById.get(spec.set_id)!;
    const list =
      spec.mix_id === null ? [] : (history.get(`${spec.project_id}|${spec.mix_id}`) ?? []);
    const at = list.findIndex((h) => h.setId === spec.set_id);
    const previous =
      at > 0
        ? list
            .slice(0, at)
            .reverse()
            .map((h) => h.average)
        : [];
    for (const line of linesOf(spec.set_id, specimens)) {
      const result = concreteStrengthAssessment({
        ageDays: line.ageDays,
        referenceAgeDays: facts.referenceAge,
        specifiedMpa: facts.specifiedMpa,
        average: line.average,
        previous: line.ageDays === facts.referenceAge ? previous : [],
      });
      lines.push({
        ...line,
        referenceAge: facts.referenceAge !== null && line.ageDays === facts.referenceAge,
        assessment: result?.assessment ?? null,
        runningAverage: result?.runningAverage ?? null,
        failed: concreteStrengthFailed(result?.assessment ?? null),
      });
    }
  }
  return { lines, specimens: specimens.filter((sp) => setIds.includes(sp.setId)) };
}
