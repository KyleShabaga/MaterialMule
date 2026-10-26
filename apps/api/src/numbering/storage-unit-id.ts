import type { PoolClient } from 'pg';

/** Physical holder at confirmation. It decides the prefix (owner amendment 2026-10-25). */
export type HolderKind = 'bucket' | 'shelby_tube' | 'core_box' | 'generic';
export type StorageUnitPrefix = 'BKT' | 'ST' | 'CRE' | 'CT';

export const PREFIX_BY_HOLDER: Readonly<Record<HolderKind, StorageUnitPrefix>> = {
  bucket: 'BKT',
  shelby_tube: 'ST',
  core_box: 'CRE',
  generic: 'CT',
};

export const MAX_SEQUENCE = 999_999;

export class StorageUnitIdOverflowError extends Error {
  override name = 'StorageUnitIdOverflowError';
  constructor(
    readonly prefix: StorageUnitPrefix,
    readonly year: number,
  ) {
    super(`No ${prefix} storage unit IDs left for ${year} (limit ${MAX_SEQUENCE}).`);
  }
}

export function formatStorageUnitId(prefix: StorageUnitPrefix, year: number, sequence: number) {
  if (!Number.isInteger(sequence) || sequence < 1 || sequence > MAX_SEQUENCE) {
    throw new RangeError(`Sequence ${sequence} is outside 1–${MAX_SEQUENCE}`);
  }
  return `${prefix}-${year}-${String(sequence).padStart(6, '0')}`;
}

/** The calendar year of `instant` in `timeZone` (e.g. 2027 for 2027-01-01 00:01 Edmonton). */
export function issuanceYear(instant: Date, timeZone: string): number {
  const year = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric' }).format(instant);
  return Number(year);
}

export interface AllocatedIds {
  prefix: StorageUnitPrefix;
  year: number;
  ids: string[];
}

/**
 * Allocates `count` contiguous IDs for the holder's prefix and the issuance year of `issuedAt`
 * in `timeZone`. Must run inside the caller's transaction (pass its client): the counter row is
 * locked until commit, and a rollback returns the numbers, so committed IDs are never reused.
 * The issuance year comes from confirmation time, never from the received date.
 */
export async function allocateStorageUnitIds(
  client: PoolClient,
  holderKind: HolderKind,
  count: number,
  options: { issuedAt: Date; timeZone: string },
): Promise<AllocatedIds> {
  const prefix = PREFIX_BY_HOLDER[holderKind];
  if (!prefix) {
    throw new TypeError(`Unsupported holder kind: ${String(holderKind)}`);
  }
  if (!Number.isInteger(count) || count < 1) {
    throw new RangeError(`Count must be a positive whole number, got ${count}`);
  }
  const year = issuanceYear(options.issuedAt, options.timeZone);

  // Savepoint so an overflow can be reported as a typed error without poisoning the
  // caller's transaction state before it decides to roll back.
  await client.query('SAVEPOINT allocate_storage_unit_ids');
  let lastValue: number;
  try {
    const { rows } = await client.query<{ last_value: number }>(
      `INSERT INTO storage_unit_annual_counter (prefix, year, last_value)
       VALUES ($1, $2, $3)
       ON CONFLICT (prefix, year)
       DO UPDATE SET last_value = storage_unit_annual_counter.last_value + EXCLUDED.last_value
       RETURNING last_value`,
      [prefix, year, count],
    );
    lastValue = rows[0]!.last_value;
    await client.query('RELEASE SAVEPOINT allocate_storage_unit_ids');
  } catch (error) {
    await client.query('ROLLBACK TO SAVEPOINT allocate_storage_unit_ids');
    // 23514: the counter's CHECK (last_value <= 999999) rejected the increment.
    if ((error as { code?: string }).code === '23514') {
      throw new StorageUnitIdOverflowError(prefix, year);
    }
    throw error;
  }

  const first = lastValue - count + 1;
  const ids = Array.from({ length: count }, (_, i) => formatStorageUnitId(prefix, year, first + i));
  return { prefix, year, ids };
}
