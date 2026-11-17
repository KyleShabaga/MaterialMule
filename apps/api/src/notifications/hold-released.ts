import {
  holdReleasedHref,
  holdReleasedRecord,
  holdReleasedSentence,
  holdReleasedTitle,
  type InboxRecord,
  type NotificationLinkedHold,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

// STRATA-133: "hold released" notices (migration 0051). The database writes one, in the release's
// own transaction, to the person the hold was for: the requester when it came from a retention
// request, else the placer; never the releaser, never LAB or a disabled account. Here the Inbox
// and the notification list read the hold live: its project, units, releaser and reason.

interface ReleasedHoldRow {
  id: string;
  project_id: string;
  project_number: string;
  scope: 'project' | 'units';
  unit_ids: string[];
  released_by_user_id: string | null;
  released_by_initials_snapshot: string | null;
  released_by_name_snapshot: string | null;
  released_at: Date | null;
  release_reason: string | null;
  requested: boolean;
}

export interface ReleasedHold {
  projectId: string;
  projectNumber: string;
  title: string;
  record: InboxRecord;
  href: string;
  from: PersonSnapshot | null;
  sentence: string;
  linked: NotificationLinkedHold;
}

/** The named holds as they stand now, keyed by hold ID. */
export async function loadReleasedHolds(
  db: Pool | PoolClient,
  ids: readonly string[],
): Promise<Map<string, ReleasedHold>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<ReleasedHoldRow>(
    `SELECT h.id, h.project_id, p.project_number, h.scope,
            coalesce((SELECT array_agg(su.readable_id ORDER BY su.readable_id)
                      FROM retention_hold_unit hu
                      JOIN storage_unit su ON su.id = hu.storage_unit_id
                      WHERE hu.hold_id = h.id), '{}') AS unit_ids,
            h.released_by_user_id, h.released_by_initials_snapshot, h.released_by_name_snapshot,
            h.released_at, h.release_reason, h.request_id IS NOT NULL AS requested
     FROM retention_hold h JOIN project p ON p.id = h.project_id
     WHERE h.id = ANY($1::uuid[])`,
    [ids],
  );
  return new Map(rows.map((row) => [row.id, releasedHoldOf(row)]));
}

function releasedHoldOf(row: ReleasedHoldRow): ReleasedHold {
  const facts = { projectNumber: row.project_number, scope: row.scope, unitIds: row.unit_ids };
  const from = row.released_by_user_id
    ? {
        userId: row.released_by_user_id,
        initials: row.released_by_initials_snapshot,
        name: row.released_by_name_snapshot ?? '',
      }
    : null;
  return {
    projectId: row.project_id,
    projectNumber: row.project_number,
    title: holdReleasedTitle(facts),
    record: holdReleasedRecord({ ...facts, holdId: row.id, projectId: row.project_id }),
    href: holdReleasedHref({ ...facts, projectId: row.project_id }),
    from,
    sentence: holdReleasedSentence({
      releasedByName: row.released_by_name_snapshot,
      requested: row.requested,
      releaseReason: row.release_reason,
    }),
    linked: {
      id: row.id,
      scope: row.scope,
      unitIds: row.unit_ids,
      releasedBy: from,
      releasedAt: row.released_at?.toISOString() ?? null,
      releaseReason: row.release_reason,
      requested: row.requested,
    },
  };
}
