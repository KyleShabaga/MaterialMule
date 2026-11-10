import {
  CONCRETE_STRENGTH_METHOD,
  concreteCalculationMethodLine,
  type ConcreteCalculationMethod,
  type ConcreteStrengthCalculation,
  type ConcreteStrengthSpecimenFlag,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// MM-V2-C24: reading and writing the stored strength calculation of a test result (migration
// 0033). The calculation itself is the shared, pure `CONCRETE_STRENGTH_CALCULATORS[version]`.

type Db = Pool | PoolClient;

export interface MethodRow {
  method: string;
  version: string;
  provisional: boolean;
}

export function methodOf(row: MethodRow): ConcreteCalculationMethod {
  return {
    method: row.method,
    version: row.version,
    provisional: row.provisional,
    line: concreteCalculationMethodLine(row.version, row.provisional),
  };
}

/** The method version new attempts are calculated with (null if reference data is missing). */
export async function currentMethod(db: Db): Promise<MethodRow | null> {
  const { rows } = await db.query<MethodRow>(
    `SELECT method, version, provisional FROM concrete_calculation_method
     WHERE method = $1 AND is_current`,
    [CONCRETE_STRENGTH_METHOD],
  );
  return rows[0] ?? null;
}

export async function findMethod(db: Db, version: string): Promise<MethodRow | null> {
  const { rows } = await db.query<MethodRow>(
    `SELECT method, version, provisional FROM concrete_calculation_method
     WHERE method = $1 AND version = $2`,
    [CONCRETE_STRENGTH_METHOD, version],
  );
  return rows[0] ?? null;
}

/** The calculation columns of `concrete_test_result` (alias `t`), as text to keep precision. */
export function calcColumnsSql(alias: string): string {
  return `${alias}.calc_mean_diameter::text AS calc_mean_diameter,
    ${alias}.calc_mean_height::text AS calc_mean_height,
    ${alias}.calc_area_raw::text AS calc_area_raw, ${alias}.calc_area::text AS calc_area,
    ${alias}.calc_ld_ratio::text AS calc_ld_ratio,
    ${alias}.calc_correction_factor::text AS calc_correction_factor,
    ${alias}.calc_strength_raw::text AS calc_strength_raw,
    ${alias}.calc_strength::text AS calc_strength, ${alias}.calc_flags,
    ${alias}.calculation_method_version AS calc_method_version,
    (SELECT m.provisional FROM concrete_calculation_method m
     WHERE m.method = ${alias}.calculation_method
       AND m.version = ${alias}.calculation_method_version) AS calc_method_provisional`;
}

export interface CalcSql {
  calc_mean_diameter: string | null;
  calc_mean_height: string | null;
  calc_area_raw: string | null;
  calc_area: string | null;
  calc_ld_ratio: string | null;
  calc_correction_factor: string | null;
  calc_strength_raw: string | null;
  calc_strength: string | null;
  calc_flags: string[] | null;
  calc_method_version: string | null;
  calc_method_provisional: boolean | null;
}

const num = (value: string | null) => (value === null ? null : Number(value));

/** The stored calculation of a row (null while the entry is incomplete or not calculated). */
export function calculationOf(row: CalcSql): ConcreteStrengthCalculation | null {
  if (row.calc_area_raw === null || row.calc_method_version === null) return null;
  return {
    methodVersion: row.calc_method_version,
    provisional: row.calc_method_provisional ?? true,
    meanDiameter: Number(row.calc_mean_diameter),
    meanHeight: Number(row.calc_mean_height),
    areaRaw: Number(row.calc_area_raw),
    area: Number(row.calc_area),
    ldRatio: Number(row.calc_ld_ratio),
    correctionFactor: num(row.calc_correction_factor),
    strengthRaw: num(row.calc_strength_raw),
    strength: num(row.calc_strength),
    flags: (row.calc_flags ?? []) as ConcreteStrengthSpecimenFlag[],
  };
}

/** The values to write for a calculation (all null when there is none). */
export function calcValues(calc: ConcreteStrengthCalculation | null): unknown[] {
  if (!calc) return [null, null, null, null, null, null, null, null, [], null];
  return [
    calc.meanDiameter,
    calc.meanHeight,
    calc.areaRaw,
    calc.area,
    calc.ldRatio,
    calc.correctionFactor,
    calc.strengthRaw,
    calc.strength,
    calc.flags,
    new Date(),
  ];
}

/** `SET` list for the ten values of `calcValues`, starting at parameter `$from`. */
export function calcSetSql(from: number): string {
  const cols = [
    'calc_mean_diameter',
    'calc_mean_height',
    'calc_area_raw',
    'calc_area',
    'calc_ld_ratio',
    'calc_correction_factor',
    'calc_strength_raw',
    'calc_strength',
    'calc_flags',
    'calculated_at',
  ];
  return cols.map((col, i) => `${col} = $${from + i}`).join(', ');
}

/** The calculation as the revision history records it (before / after a recalculation). */
export function describeCalculation(
  version: string | null,
  calc: ConcreteStrengthCalculation | null,
): unknown {
  return {
    methodVersion: version,
    area: calc?.area ?? null,
    strength: calc?.strength ?? null,
    strengthRaw: calc?.strengthRaw ?? null,
    correctionFactor: calc?.correctionFactor ?? null,
    flags: calc?.flags ?? [],
  };
}
