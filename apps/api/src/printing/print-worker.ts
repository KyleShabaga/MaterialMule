import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { withTransaction } from '../db/transaction.js';
import { renderLocationLabelZpl } from '../labels/location-template-v1.js';
import { renderZpl } from '../labels/zpl.js';
import { statusAfterAttempt, MAX_PRINT_ATTEMPTS } from './status-rules.js';
import type { PrinterTarget, PrinterTransport, SendOutcome } from './zebra-client.js';

// Print queue worker (MM-T15). Runs inside the API process (single host, D25). One job at a
// time per printer, oldest first, so labels come out in the order they were requested.
//
// Guardrails: a job is claimed (status `sending`) and committed BEFORE any byte goes to the
// printer, so a crash mid-send leaves evidence that is turned into `uncertain` on the next start.
// Only `not_sent` outcomes are retried automatically; `uncertain` waits for a person.
//
// Settlement recovery (MM-T42): if saving an attempt's result fails (database briefly away), the
// outcome is kept in memory and saved again before the next dispatch. The job stays `sending`
// meanwhile, so nothing else is sent to that printer and the labels are never resent. If the
// process stops before the result is saved, startup recovery marks the job uncertain.
//
// Claim recovery (MM-T64): if a claim fails after its UPDATE ran, the COMMIT may still have
// succeeded (reply lost), leaving the job `sending` although no byte went out. The worker keeps
// the claim in memory and, before the next dispatch, puts the job back in the queue exactly as it
// was. That printer gets nothing new meanwhile, so a job is never reset while it is being sent.
//
// Location labels (MM-T37) go through exactly the same claim, send, settle and recovery path; only
// the rendering differs. They print the code and name recorded when the job was requested.

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
  /** What the job prints: storage units by readable ID, or location codes. */
  labelTarget: 'storage_unit' | 'location';
  labels: string[];
  zpl: string | null;
  renderError: string | null;
}

/** A claim that may have committed although it reported failure. Nothing was sent for it. */
interface UnresolvedClaim {
  jobId: string;
  /** The job's attempts had the claim committed; only that exact claim is undone. */
  attempts: number;
  resolving: boolean;
}

/** An attempt whose transport finished but whose result is not saved yet. */
interface UnsettledAttempt {
  job: ClaimedJob;
  outcome: SendOutcome;
  permanent: boolean;
  /** True while a save is in progress, so two dispatches never save it at once. */
  saving: boolean;
}

export class PrintWorker {
  private running = false;
  private recovered = false;
  private lastPoll: Date | null = null;
  private loop: Promise<void> | null = null;
  private wakeUp: (() => void) | null = null;
  private readonly busyPrinters = new Set<string>();
  private readonly inFlight = new Set<Promise<void>>();
  /** Per printer: the finished attempt waiting for its result to be saved (MM-T42). */
  private readonly unsettled = new Map<string, UnsettledAttempt>();
  /** Per printer: the claim whose outcome is unknown (MM-T64). */
  private readonly unresolvedClaims = new Map<string, UnresolvedClaim>();

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
    // Last chance to save finished attempts. Any still unsaved stay `sending` and become
    // uncertain at the next start, which is the safe reading of an unrecorded send.
    await this.settlePending();
    await this.resolveClaims();
    if (this.unsettled.size > 0) {
      this.log.warn(
        `Stopped with ${this.unsettled.size} print result(s) unsaved; they will be marked uncertain at the next start`,
      );
    }
  }

  /** Heartbeat for Settings → System status (MM-T21): last poll that reached the database. */
  get health(): { running: boolean; lastPollAt: Date | null } {
    return { running: this.running, lastPollAt: this.lastPoll };
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
        this.lastPoll = new Date();
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
        ['Material Mule restarted while sending these labels'],
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
    await this.settlePending();
    await this.resolveClaims();
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
      if (
        this.busyPrinters.has(printerKey) ||
        this.unsettled.has(printerKey) ||
        this.unresolvedClaims.has(printerKey)
      ) {
        continue;
      }
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
   * Saves the results of finished attempts whose first save failed. The kept outcome is written
   * as it was; ZPL is never sent again. Failures stay pending for the next dispatch.
   */
  private async settlePending(): Promise<void> {
    for (const [printerKey, attempt] of [...this.unsettled]) {
      if (attempt.saving) continue;
      attempt.saving = true;
      try {
        await this.settle(attempt.job, attempt.outcome, attempt.permanent);
        this.unsettled.delete(printerKey);
        this.wake();
      } catch (error) {
        this.log.error(`Print result still not saved, will retry: ${(error as Error).message}`);
      } finally {
        attempt.saving = false;
      }
    }
  }

  /**
   * Puts back jobs whose claim may have committed although it reported failure. The UPDATE only
   * matches the exact claim (still `sending`, same attempt count), and no byte was sent for it, so
   * the job is queued again as it was and not counted as an attempt. If the claim had rolled back,
   * nothing matches. Failures stay pending for the next dispatch.
   */
  private async resolveClaims(): Promise<void> {
    for (const [printerKey, claim] of [...this.unresolvedClaims]) {
      if (claim.resolving) continue;
      claim.resolving = true;
      try {
        const { rowCount } = await this.pool.query(
          `UPDATE print_job
           SET status = 'queued', attempts = attempts - 1, updated_at = now()
           WHERE id = $1 AND status = 'sending' AND attempts = $2`,
          [claim.jobId, claim.attempts],
        );
        this.unresolvedClaims.delete(printerKey);
        if (rowCount) {
          this.log.warn('Print job claim was saved but not confirmed; job queued again, unsent');
        }
        this.wake();
      } catch (error) {
        this.log.error(`Print job claim still unresolved, will retry: ${(error as Error).message}`);
      } finally {
        claim.resolving = false;
      }
    }
  }

  /** Saves an attempt's result, or keeps it for settlePending when the database fails. */
  private async settleOrKeep(
    printerKey: string,
    job: ClaimedJob,
    outcome: SendOutcome,
    permanent: boolean,
  ): Promise<boolean> {
    try {
      await this.settle(job, outcome, permanent);
      return true;
    } catch (error) {
      this.unsettled.set(printerKey, { job, outcome, permanent, saving: false });
      this.log.error(`Print result not saved, will retry: ${(error as Error).message}`);
      return false;
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
      return this.settleOrKeep(printerKey, job, outcome, true);
    }
    try {
      outcome = await this.transport.send(job.target, job.zpl);
    } catch (error) {
      // The transport promises not to throw; if it does, bytes may have gone out.
      outcome = { result: 'uncertain', error: `Printer client error: ${(error as Error).message}` };
    }
    return this.settleOrKeep(printerKey, job, outcome, false);
  }

  private async claim(printerKey: string): Promise<ClaimedJob | null> {
    let claimed: UnresolvedClaim | null = null;
    try {
      return await this.claimInTransaction(printerKey, (claim) => (claimed = claim));
    } catch (error) {
      // Once the UPDATE was sent, the transaction may have committed: settle that before the
      // printer gets anything else.
      if (claimed) this.unresolvedClaims.set(printerKey, claimed);
      throw error;
    }
  }

  private async claimInTransaction(
    printerKey: string,
    onClaim: (claim: UnresolvedClaim) => void,
  ): Promise<ClaimedJob | null> {
    return withTransaction(this.pool, async (client) => {
      // Oldest queued job first. If it is waiting for a retry, later jobs wait too, so labels
      // never come out of order.
      const { rows } = await client.query<{
        id: string;
        attempts: number;
        template_version: string;
        target_type: 'storage_unit' | 'location';
        due: boolean;
        host: string;
        port: number;
        check_status: boolean;
      }>(
        `SELECT j.id, j.attempts, j.template_version, j.target_type,
                j.next_attempt_at <= now() AS due,
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

      onClaim({ jobId: row.id, attempts: row.attempts + 1, resolving: false });
      await client.query(
        `UPDATE print_job SET status = 'sending', attempts = attempts + 1, updated_at = now()
         WHERE id = $1`,
        [row.id],
      );

      const rendered =
        row.target_type === 'location'
          ? await renderLocationJob(client, row.id, row.template_version)
          : await renderStorageUnitJob(client, row.id, row.template_version);

      return {
        id: row.id,
        attempts: row.attempts + 1,
        templateVersion: row.template_version,
        target: { host: row.host, port: row.port, checkStatus: row.check_status },
        labelTarget: row.target_type,
        ...rendered,
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
      const { rowCount } = await client.query(
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
      // No row means an earlier save committed although its reply was lost (or the job was
      // already reconciled): don't write the audit entry twice.
      if (rowCount === 0) return;
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
            ...(job.labelTarget === 'location'
              ? { target: 'location', locationCodes: job.labels, labelCount: job.labels.length }
              : { readableIds: job.labels, unitCount: job.labels.length }),
          },
        });
      }
    });
  }
}

interface RenderedJob {
  labels: string[];
  zpl: string | null;
  renderError: string | null;
}

/** Stickers from the units' current values: a reprint after a correction prints the corrections. */
async function renderStorageUnitJob(
  client: PoolClient,
  jobId: string,
  templateVersion: string,
): Promise<RenderedJob> {
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
    [jobId],
  );
  const labels = units.map((unit) => unit.readable_id);
  try {
    const zpl = units
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
            templateVersion,
          ).zpl,
      )
      .join('');
    return { labels, zpl, renderError: null };
  } catch {
    return { labels, zpl: null, renderError: 'The label could not be prepared' };
  }
}

/**
 * Location labels (MM-T37) from the code and name recorded with the job. The code is locked from
 * the request on, so the payload is the one the location still carries.
 */
async function renderLocationJob(
  client: PoolClient,
  jobId: string,
  templateVersion: string,
): Promise<RenderedJob> {
  const { rows } = await client.query<{ code_snapshot: string; name_snapshot: string }>(
    `SELECT code_snapshot, name_snapshot FROM print_job_location_item
     WHERE print_job_id = $1 ORDER BY position`,
    [jobId],
  );
  const labels = rows.map((row) => row.code_snapshot);
  try {
    if (rows.length === 0) throw new Error('No labels');
    const zpl = rows
      .map((row) =>
        renderLocationLabelZpl(
          { code: row.code_snapshot, name: row.name_snapshot },
          templateVersion,
        ),
      )
      .join('');
    return { labels, zpl, renderError: null };
  } catch {
    return { labels, zpl: null, renderError: 'The label could not be prepared' };
  }
}
