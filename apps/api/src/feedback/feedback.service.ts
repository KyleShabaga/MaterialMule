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

/**
 * Help & Feedback: each submission is an append-only audit event (no new table, nothing sent
 * off the host). The actor's name and initials are the audit snapshot taken at the time.
 */
@Injectable()
export class FeedbackService {
  constructor(private readonly database: DatabaseService) {}

  async submit(
    user: AuthUser,
    input: { kind: FeedbackKind; text: string; page?: string },
    requestId: string | null,
  ): Promise<SubmitFeedbackResponse> {
    const id = await withTransaction(this.database.pool, (client) =>
      recordAudit(client, {
        action: FEEDBACK_ACTION,
        entityType: 'feedback',
        entityId: null,
        actor: actorOf(user),
        after: { kind: input.kind, text: input.text, page: input.page ?? null },
        requestId,
      }),
    );
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
