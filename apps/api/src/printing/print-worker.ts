import type { Pool } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { withTransaction } from '../db/transaction.js';
import { renderZpl } from '../labels/zpl.js';
import { statusAfterAttempt, MAX_PRINT_ATTEMPTS } from './status-rules.js';
import type { PrinterTarget, PrinterTransport, SendOutcome } from './zebra-client.js';

// Print queue worker (TRP-T15). Runs inside the API process (single host, D25). One job at a
// time per printer, oldest first, so labels come out in the order they were requested.
//
// Guardrails: a job is claimed (status `sending`) and committed BEFORE any byte goes to the
// printer, so a crash mid-send leaves evidence that is turned into `uncertain` on the next start.
// Only `not_sent` outcomes are retried automatically; `uncertain` waits for a person.

export interface PrintWorkerOptions {
  /** How often to look for queued jobs when nothing woke the worker. */
  pollIntervalMs: number;
  /** First retry delay after a safe failure; doubles for each further attempt. */
  retryBaseMs: number;
  maxAttempts: number;
}

export const DEFAULT_PRINT_WORKER_OPTIONS: PrintWorkerOptions = {
  pollIntervalMs: 1_000,
  retryBaseMs: 5_000,
  maxAttempts: MAX_PRINT_ATTEMPTS,
};

export interface WorkerLog {
  error(message: string): void;
  warn(message: string): void;
}

const SYSTEM_ACTOR: AuditActor = {
  userId: null,
  accountType: 'system',
  initials: null,
  name: 'Print queue',
};

interface ClaimedJob {
  id: string;
  attempts: number;
  templateVersion: string;
  target: PrinterTarget;
  readableIds: string[];
  zpl: string | null;
  renderError: string | null;
}

export class PrintWorker {
  private running = false;
  private recovered = false;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly busyPrinters = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();

  constructor(
    private readonly pool: Pool,
    private readonly transport: PrinterTransport,
    private readonly options: PrintWorkerOptions = DEFAULT_PRINT_WORKER_OPTIONS,
    private readonly log: WorkerLog = console,
  ) {}

  /** Starts the background loop: recovery first, then polling. */
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  /** Stops polling and waits for any send in progress to finish. */
  async stop(): Promise<void> {
    this.running = false;
    this.wakeUp?.();
    await this.loop;
    await Promise.allSettled([...this.inFlight]);
  }

  /** Looks for work now instead of at the next poll (called after a job is queued). */
  wake(): void {
    this.wakeUp?.();
  }

  private async run(): Promise<void> {
    while (this.running) {
      try {
        if (!this.recovered) {
          await this.recoverInterrupted();
        }
        await this.dispatch();
      } catch (error) {
        // Database unavailable or similar: keep the process up and try again at the next poll.
        this.log.error(`Print worker poll failed: ${(error as Error).message}`);
      }
      if (!this.running) break;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, this.options.pollIntervalMs);
        this.wakeUp = () => {
          clearTimeout(timer);
          resolve();
        };
      });
      this.wakeUp = null;
    }
  }

  /**
   * Startup recovery: a job still `sending` means the process stopped mid-send, so whether its
   * labels printed is unknown. Mark it uncertain (never resend) so later jobs can run.
   */
  async recoverInterrupted(): Promise<number> {
    const count = await withTransaction(this.pool, async (client) => {
      const { rows } = await client.query<{ id: string; attempts: number }>(
        `UPDATE print_job
         SET status = 'uncertain', last_error = $1, updated_at = now()
         WHERE status = 'sending'
         RETURNING id, attempts`,
        ['Trapezoid restarted while sending these labels'],
      );
      for (const job of rows) {
        await recordAudit(client, {
          action: 'label.print_uncertain',
          entityType: 'print_job',
          entityId: job.id,
          actor: SYSTEM_ACTOR,
          reason: 'Service restarted while the job was sending',
          before: { status: 'sending' },
          after: { status: 'uncertain', attempts: job.attempts },
        });
      }
      return rows.length;
    });
    this.recovered = true;
    if (count > 0) {
      this.log.warn(`Marked ${count} interrupted print job(s) uncertain after restart`);
    }
    return count;
  }

  /** Starts the next due job on every idle printer. */
  private async dispatch(): Promise<void> {
    // Printers whose oldest queued job is due and that have nothing mid-send.
    const { rows } = await this.pool.query<{ printer_key: string }>(
      `SELECT p.key AS printer_key
       FROM printer p
       WHERE p.enabled
         AND NOT EXISTS (SELECT 1 FROM print_job s
                         WHERE s.printer_key = p.key AND s.status = 'sending')
         AND (SELECT j.next_attempt_at <= now()
              FROM print_job j
              WHERE j.printer_key = p.key AND j.status = 'queued'
              ORDER BY j.created_at, j.id
              LIMIT 1)`,
    );
    for (const { printer_key: printerKey } of rows) {
      if (this.busyPrinters.has(printerKey)) continue;
      this.busyPrinters.add(printerKey);
      const task = this.processNext(printerKey)
        .then((processed) => {
          // More may be waiting on this printer; look again straight away.
          if (processed) this.wake();
        })
        .catch((error: unknown) => {
          this.log.error(`Print job failed to process: ${(error as Error).message}`);
        })
        .finally(() => {
          this.busyPrinters.delete(printerKey);
          this.inFlight.delete(task);
        });
      this.inFlight.add(task);
    }
  }

  /**
   * Processes due jobs until none is left (for tests and manual draining): every printer's
   * queue is worked through in order. Retry delays are honoured, so a job waiting for its next
   * attempt stays queued.
   */
  async drain(): Promise<void> {
    if (!this.recovered) await this.recoverInterrupted();
    for (;;) {
      await this.dispatch();
      if (this.inFlight.size === 0) return;
      await Promise.allSettled([...this.inFlight]);
    }
  }

  /** Claims, sends and settles the oldest queued job of one printer. False when none was due. */
  private async processNext(printerKey: string): Promise<boolean> {
    const job = await this.claim(printerKey);
    if (!job) return false;
    let outcome: SendOutcome;
    if (job.zpl === null) {
      outcome = {
        result: 'not_sent',
        error: job.renderError ?? 'Label error',
        printerMessage: null,
      };
      // Bad label data won't fix itself: fail without retrying.
      await this.settle(job, outcome, true);
      return true;
    }
    try {
      outcome = await this.transport.send(job.target, job.zpl);
    } catch (error) {
      // The transport promises not to throw; if it does, bytes may have gone out.
      outcome = { result: 'uncertain', error: `Printer client error: ${(error as Error).message}` };
    }
    await this.settle(job, outcome, false);
    return true;
  }

  private async claim(printerKey: string): Promise<ClaimedJob | null> {
    return withTransaction(this.pool, async (client) => {
      // Oldest queued job first. If it is waiting for a retry, later jobs wait too, so labels
      // never come out of order.
      const { rows } = await client.query<{
        id: string;
        attempts: number;
        template_version: string;
        due: boolean;
        host: string;
        port: number;
        check_status: boolean;
      }>(
        `SELECT j.id, j.attempts, j.template_version, j.next_attempt_at <= now() AS due,
                p.host, p.port, p.check_status
         FROM print_job j JOIN printer p ON p.key = j.printer_key
         WHERE j.printer_key = $1 AND j.status = 'queued' AND p.enabled
         ORDER BY j.created_at, j.id
         LIMIT 1
         FOR UPDATE OF j SKIP LOCKED`,
        [printerKey],
      );
      const row = rows[0];
      if (!row || !row.due) return null;

      await client.query(
        `UPDATE print_job SET status = 'sending', attempts = attempts + 1, updated_at = now()
         WHERE id = $1`,
        [row.id],
      );

      // Current values: a reprint after a correction prints the corrected details.
      const { rows: units } = await client.query<{
        readable_id: string;
        received_date: string;
        project_number: string;
        project_name: string;
        test_holes: string[];
      }>(
        `SELECT su.readable_id, su.received_date::text AS received_date,
                p.project_number, p.name AS project_name,
                COALESCE(array_agg(th.name ORDER BY th.name_normalized)
                           FILTER (WHERE th.id IS NOT NULL), '{}') AS test_holes
         FROM print_job_item i
         JOIN storage_unit su ON su.id = i.storage_unit_id
         JOIN project p ON p.id = su.project_id
         LEFT JOIN storage_unit_hole_summary s ON s.storage_unit_id = su.id
         LEFT JOIN test_hole th ON th.id = s.test_hole_id
         WHERE i.print_job_id = $1
         GROUP BY i.position, su.id, p.id
         ORDER BY i.position`,
        [row.id],
      );

      let zpl: string | null = null;
      let renderError: string | null = null;
      try {
        zpl = units
          .map(
            (unit) =>
              renderZpl(
                {
                  storageUnitId: unit.readable_id,
                  projectNumber: unit.project_number,
                  projectName: unit.project_name,
                  receivedDate: unit.received_date,
                  testHoles: unit.test_holes,
                },
                row.template_version,
              ).zpl,
          )
          .join('');
      } catch {
        renderError = 'The label could not be prepared';
      }

      return {
        id: row.id,
        attempts: row.attempts + 1,
        templateVersion: row.template_version,
        target: { host: row.host, port: row.port, checkStatus: row.check_status },
        readableIds: units.map((unit) => unit.readable_id),
        zpl,
        renderError,
      };
    });
  }

  private async settle(job: ClaimedJob, outcome: SendOutcome, permanent: boolean): Promise<void> {
    const next = permanent
      ? { status: 'failed' as const, retryInMs: null }
      : statusAfterAttempt(
          outcome,
          job.attempts,
          this.options.retryBaseMs,
          this.options.maxAttempts,
        );
    const error = outcome.result === 'sent' ? null : outcome.error;
    const printerMessage = outcome.result === 'not_sent' ? outcome.printerMessage : null;

    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE print_job
         SET status = $2,
             last_error = $3,
             printer_message = $4,
             sent_at = CASE WHEN $2 = 'sent' THEN now() END,
             next_attempt_at = now() + ($5::int * interval '1 millisecond'),
             updated_at = now()
         WHERE id = $1 AND status = 'sending'`,
        [job.id, next.status, error, printerMessage, next.retryInMs ?? 0],
      );
      if (next.status === 'failed' || next.status === 'uncertain') {
        await recordAudit(client, {
          action: next.status === 'failed' ? 'label.print_failed' : 'label.print_uncertain',
          entityType: 'print_job',
          entityId: job.id,
          actor: SYSTEM_ACTOR,
          reason: error,
          before: { status: 'sending' },
          after: {
            status: next.status,
            attempts: job.attempts,
            readableIds: job.readableIds,
            unitCount: job.readableIds.length,
          },
        });
      }
    });
  }
}
