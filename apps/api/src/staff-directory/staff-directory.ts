import { effectiveJobTitle, type Position, type StaffOption } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { AuditReceiver } from '../audit/audit.js';

// Active staff who can be credited on a record: a project's Lead Project Engineer or the receiver of a receipt.
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

/**
 * Every active staff member, by name, with their position so pickers can list Engineers first
 * (MM-T61) and Receiving can offer Engineers as Lead Project Engineer nominees (MISC-06), and
 * their effective job title to show beside the name. Pickers never show the position. The list
 * itself isn't narrowed: people added ahead of time may have no position yet.
 */
export async function listActiveStaff(pool: Pool): Promise<StaffOption[]> {
  const { rows } = await pool.query<
    StaffRow & {
      position: Position | null;
      job_title: string | null;
      job_title_override: string | null;
    }
  >(
    `SELECT id, display_name, official_initials, position, job_title, job_title_override
     FROM app_user
     WHERE ${ACTIVE_STAFF}
     ORDER BY lower(display_name), official_initials NULLS LAST, id`,
  );
  return rows.map((row) => ({
    ...toOption(row),
    position: row.position,
    jobTitle: effectiveJobTitle(row.job_title, row.job_title_override)?.value ?? null,
  }));
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

/** A staff member as the receiver of an audit event, copied at the time (MM-T56). */
export function auditReceiver(staff: StaffOption): AuditReceiver {
  return { userId: staff.id, initials: staff.initials, name: staff.displayName };
}
