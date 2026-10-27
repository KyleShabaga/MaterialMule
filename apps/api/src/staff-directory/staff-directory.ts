import type { StaffOption } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// Active staff who can be credited on a record: a project's PM/PE or the receiver of a receipt.
// The shared LAB account is a station, not a person, so it never appears here (App Idea §8).
const ACTIVE_STAFF = `status = 'active' AND account_type <> 'shared_lab'`;

interface StaffRow {
  id: string;
  display_name: string;
  official_initials: string | null;
}

function toOption(row: StaffRow): StaffOption {
  return { id: row.id, displayName: row.display_name, initials: row.official_initials };
}

/** Every active staff member, by name. */
export async function listActiveStaff(pool: Pool): Promise<StaffOption[]> {
  const { rows } = await pool.query<StaffRow>(
    `SELECT id, display_name, official_initials FROM app_user
     WHERE ${ACTIVE_STAFF}
     ORDER BY lower(display_name), official_initials NULLS LAST, id`,
  );
  return rows.map(toOption);
}

/** The active staff member with `id`, or null when there is none (or it's the LAB account). */
export async function findActiveStaff(
  client: Pool | PoolClient,
  id: string,
): Promise<StaffOption | null> {
  const { rows } = await client.query<StaffRow>(
    `SELECT id, display_name, official_initials FROM app_user WHERE id = $1 AND ${ACTIVE_STAFF}`,
    [id],
  );
  return rows[0] ? toOption(rows[0]) : null;
}
