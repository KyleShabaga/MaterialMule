import { Injectable } from '@nestjs/common';
import {
  FEEDBACK_KINDS,
  FEEDBACK_LIST_LIMIT,
  type FeedbackItem,
  type FeedbackKind,
  type SubmitFeedbackResponse,
} from '@materialmule/shared';
import { recordAudit } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';

export const FEEDBACK_ACTION = 'feedback.submitted';

interface FeedbackRow {
  id: string;
  occurred_at: Date;
  actor_account_type: FeedbackItem['accountType'];
  actor_initials_snapshot: string | null;
  actor_name_snapshot: string | null;
  after_values: Record<string, unknown> | null;
}

function kindOf(value: unknown): FeedbackKind {
  return FEEDBACK_KINDS.find((kind) => kind === value) ?? 'not_working';
}

/** The in-app path with no query string or fragment (the request schema refuses them too). */
export function feedbackPagePath(page: string | undefined): string | null {
  if (page === undefined) return null;
  const path = page.split(/[?#]/, 1)[0]!;
  return path === '' ? null : path;
}

/**
 * Help & Feedback: each submission is an append-only audit event (no new table, nothing sent
 * off the host). The actor's name and initials are the audit snapshot taken at the time.
 *
 * STRATA-104 / STRATA-118: each accepted submission also notifies every active administrator
 * (`feedback.read`) in the Inbox (`feedback.submitted`, in-app only, never email), except the
 * person who sent it. A replay with the same `submissionId` from the same account returns the
 * first submission and notifies nobody again.
 */
@Injectable()
export class FeedbackService {
  constructor(private readonly database: DatabaseService) {}

  async submit(
    user: AuthUser,
    input: { kind: FeedbackKind; text: string; page?: string; submissionId?: string },
    requestId: string | null,
  ): Promise<SubmitFeedbackResponse> {
    const id = await withTransaction(this.database.pool, async (client) => {
      if (input.submissionId) {
        // Serialise retries of one submission, then find the first one.
        await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [
          `feedback:${user.userId}:${input.submissionId}`,
        ]);
        const { rows } = await client.query<{ id: string }>(
          `SELECT id FROM audit_event
           WHERE action = $1 AND actor_user_id = $2 AND after_values ? 'submissionId'
             AND after_values ->> 'submissionId' = $3`,
          [FEEDBACK_ACTION, user.userId, input.submissionId],
        );
        if (rows[0]) return rows[0].id;
      }
      const eventId = await recordAudit(client, {
        action: FEEDBACK_ACTION,
        entityType: 'feedback',
        entityId: null,
        actor: actorOf(user),
        after: {
          kind: input.kind,
          text: input.text,
          page: feedbackPagePath(input.page),
          ...(input.submissionId ? { submissionId: input.submissionId } : {}),
        },
        requestId,
      });
      // Every active administrator (the admin role is the only source of feedback.read), never
      // LAB, never the sender. The (recipient, event_key) key keeps it to one row each.
      await client.query(
        `INSERT INTO notification (recipient_user_id, kind, feedback_event_id, event_key)
         SELECT DISTINCT u.id, 'feedback.submitted', $1::uuid,
                'audit_event:' || $1::text || ':feedback'
         FROM app_user u
         JOIN role_assignment r ON r.user_id = u.id AND r.role = 'admin'
         WHERE u.status = 'active' AND u.account_type IN ('personal', 'test') AND u.id <> $2
         ON CONFLICT ON CONSTRAINT notification_one_per_event DO NOTHING`,
        [eventId, user.userId],
      );
      return eventId;
    });
    return { id };
  }

  async list(): Promise<FeedbackItem[]> {
    const { rows } = await this.database.pool.query<FeedbackRow>(
      `SELECT id, occurred_at, actor_account_type, actor_initials_snapshot, actor_name_snapshot,
              after_values
       FROM audit_event
       WHERE action = $1
       ORDER BY occurred_at DESC, id DESC
       LIMIT $2`,
      [FEEDBACK_ACTION, FEEDBACK_LIST_LIMIT],
    );
    return rows.map((row) => {
      const after = row.after_values ?? {};
      return {
        id: row.id,
        submittedAt: row.occurred_at.toISOString(),
        name: row.actor_name_snapshot,
        initials: row.actor_initials_snapshot,
        accountType: row.actor_account_type,
        kind: kindOf(after.kind),
        text: typeof after.text === 'string' ? after.text : '',
        page: typeof after.page === 'string' ? after.page : null,
      };
    });
  }
}
