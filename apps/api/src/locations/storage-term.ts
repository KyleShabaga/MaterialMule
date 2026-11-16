import type { EffectiveStorageTerm, StorageTerm, StorageTermSource } from '@materialmule/shared';

// STRATA-106: every read of a location's effective storage term goes through the database view
// `location_effective_storage_term` (migration 0043): the nearest own term walking up the
// warehouse › bay › shelf chain. Nothing stores a copy, so reparenting, clearing an override or
// changing a warehouse's term shows on every descendant at the next read.

/** Columns a query selects from the view, aliased `alias`, to build an EffectiveStorageTerm. */
export function effectiveTermColumns(alias: string): string {
  return `${alias}.term AS effective_term, ${alias}.source AS effective_term_source,
          ${alias}.from_location_id AS effective_term_from_id,
          ${alias}.from_code AS effective_term_from_code,
          ${alias}.from_name AS effective_term_from_name`;
}

/** `LEFT JOIN` of the view for the location `locationIdExpr`, aliased `alias`. */
export function effectiveTermJoin(alias: string, locationIdExpr: string): string {
  return `LEFT JOIN location_effective_storage_term ${alias}
            ON ${alias}.location_id = ${locationIdExpr}`;
}

export interface EffectiveTermRow {
  effective_term: StorageTerm | null;
  effective_term_source: StorageTermSource | null;
  effective_term_from_id: string | null;
  effective_term_from_code: string | null;
  effective_term_from_name: string | null;
}

export function toEffectiveStorageTerm(row: EffectiveTermRow): EffectiveStorageTerm {
  if (row.effective_term === null || row.effective_term_from_id === null) {
    return { term: null, source: 'unset', fromLocation: null };
  }
  return {
    term: row.effective_term,
    source: row.effective_term_source === 'own' ? 'own' : 'inherited',
    fromLocation: {
      id: row.effective_term_from_id,
      code: row.effective_term_from_code ?? '',
      name: row.effective_term_from_name ?? '',
    },
  };
}
