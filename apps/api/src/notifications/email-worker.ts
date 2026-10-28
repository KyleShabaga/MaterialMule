import type { Pool } from 'pg';
import { withTransaction } from '../db/transaction.js';

// MM-T27 email outbox worker. Claims one due row at a time (SKIP LOCKED, so two workers never
// take the same row), skips rows whose item was resolved meanwhile, and retries failures with
// exponential backoff until `maxAttempts`, then marks the row failed. Delivery is at-least-once:
// a crash between a successful send and the commit can repeat that one email.
//
// No real transport exists yet: sending stays disabled until IT approves the configuration, and
// tests drive this class with an in-memory transport only.

export interface EmailMessage {
  to: string;
  subject: string;
  body: string;
}

export interface EmailTransport {
  send(message: EmailMessage): Promise<void>;
}

export interface EmailWorkerOptions {
  maxAttempts?: number;
  /** First retry delay; doubles each attempt, capped at `maxDelayMs`. */
  baseDelayMs?: number;
  maxDelayMs?: number;
  now?: () => Date;
}

export interface EmailRunResult {
  sent: number;
  retried: number;
  failed: number;
  skipped: number;
}

/** Never keep an address (or anything that looks like one) in the stored error. */
export function sanitizeEmailError(error: unknown): string {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : 'Send failed';
  return text.replace(/\S+@\S+/g, '<address>').slice(0, 500);
}

export class EmailWorker {
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<unknown> | null = null;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly now: () => Date;

  constructor(
    private readonly pool: Pool,
    private readonly transport: EmailTransport,
    options: EmailWorkerOptions = {},
  ) {
    this.maxAttempts = options.maxAttempts ?? 8;
    this.baseDelayMs = options.baseDelayMs ?? 60_000;
    this.maxDelayMs = options.maxDelayMs ?? 6 * 60 * 60 * 1000;
    this.now = options.now ?? (() => new Date());
  }

  retryDelayMs(attempts: number): number {
    return Math.min(this.baseDelayMs * 2 ** Math.max(attempts - 1, 0), this.maxDelayMs);
  }

  /** Processes up to `limit` due rows. */
  async runOnce(limit = 20): Promise<EmailRunResult> {
    const result: EmailRunResult = { sent: 0, retried: 0, failed: 0, skipped: 0 };
    for (let i = 0; i < limit; i += 1) {
      const outcome = await withTransaction(this.pool, async (client) => {
        const now = this.now();
        const { rows } = await client.query<{
          id: string;
          to_address: string;
          subject: string;
          body: string;
          attempts: number;
          item_status: string;
        }>(
          `SELECT o.id, o.to_address, o.subject, o.body, o.attempts, a.status AS item_status
           FROM email_outbox o JOIN action_item a ON a.id = o.action_item_id
           WHERE o.status = 'pending' AND o.next_attempt_at <= $1
           ORDER BY o.next_attempt_at, o.id
           LIMIT 1
           FOR UPDATE OF o SKIP LOCKED`,
          [now],
        );
        const row = rows[0];
        if (!row) return null;
        if (row.item_status !== 'open') {
          await client.query(`UPDATE email_outbox SET status = 'skipped' WHERE id = $1`, [row.id]);
          return 'skipped' as const;
        }
        try {
          await this.transport.send({ to: row.to_address, subject: row.subject, body: row.body });
        } catch (error) {
          const attempts = row.attempts + 1;
          const failed = attempts >= this.maxAttempts;
          await client.query(
            `UPDATE email_outbox
             SET attempts = $2, last_error = $3, status = $4, next_attempt_at = $5
             WHERE id = $1`,
            [
              row.id,
              attempts,
              sanitizeEmailError(error),
              failed ? 'failed' : 'pending',
              new Date(now.getTime() + this.retryDelayMs(attempts)),
            ],
          );
          return failed ? ('failed' as const) : ('retried' as const);
        }
        await client.query(
          `UPDATE email_outbox SET status = 'sent', sent_at = $2, attempts = attempts + 1,
                  last_error = NULL
           WHERE id = $1`,
          [row.id, now],
        );
        return 'sent' as const;
      });
      if (outcome === null) break;
      result[outcome] += 1;
    }
    return result;
  }

  start(intervalMs = 30_000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      if (this.running) return;
      this.running = this.runOnce()
        .catch(() => undefined)
        .finally(() => {
          this.running = null;
        });
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.running;
  }
}
