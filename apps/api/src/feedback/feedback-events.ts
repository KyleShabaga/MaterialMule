import { FEEDBACK_KINDS, type FeedbackKind, type PersonSnapshot } from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';

/**
 * Where a `feedback.submitted` notice links: the Help & Feedback page, whose administrator list
 * (`GET /api/feedback`, `feedback.read`) shows the text. Following it grants nothing.
 */
export const FEEDBACK_HREF = '/help';

/** What a feedback notice shows, read live from its audit event: never the text. */
export interface FeedbackEventFacts {
  id: string;
  kind: FeedbackKind | null;
  page: string | null;
  /** The sender as they were when they sent it (audit snapshot); null for a system actor. */
  from: PersonSnapshot | null;
}

/** The feedback audit events the notices name (STRATA-104). */
export async function loadFeedbackEvents(
  db: Pool | PoolClient,
  ids: string[],
): Promise<Map<string, FeedbackEventFacts>> {
  if (ids.length === 0) return new Map();
  const { rows } = await db.query<{
    id: string;
    actor_user_id: string | null;
    actor_initials_snapshot: string | null;
    actor_name_snapshot: string | null;
    kind: string | null;
    page: string | null;
  }>(
    `SELECT id, actor_user_id, actor_initials_snapshot, actor_name_snapshot,
            after_values ->> 'kind' AS kind, after_values ->> 'page' AS page
     FROM audit_event
     WHERE id = ANY($1::uuid[]) AND action = 'feedback.submitted'`,
    [ids],
  );
  return new Map(
    rows.map((row) => [
      row.id,
      {
        id: row.id,
        kind: FEEDBACK_KINDS.find((kind) => kind === row.kind) ?? null,
        page: row.page,
        from: row.actor_user_id
          ? {
              userId: row.actor_user_id,
              initials: row.actor_initials_snapshot,
              name: row.actor_name_snapshot ?? '',
            }
          : null,
      },
    ]),
  );
}
