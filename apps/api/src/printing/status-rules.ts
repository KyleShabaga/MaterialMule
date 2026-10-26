import type { PrintJobStatus } from '@materialmule/shared';
import type { SendOutcome } from './zebra-client.js';

/** Attempts per job, counting the first. Only `not_sent` outcomes are retried. */
export const MAX_PRINT_ATTEMPTS = 3;

export interface AttemptResult {
  status: Extract<PrintJobStatus, 'queued' | 'sent' | 'failed' | 'uncertain'>;
  /** Delay before the next automatic attempt; only when `status` is queued again. */
  retryInMs: number | null;
}

/**
 * The job's status after an attempt (MM-T15 status rules):
 * - nothing sent (refused, timed out, printer reported a problem) → retry with backoff, then
 *   failed after MAX_PRINT_ATTEMPTS;
 * - all bytes written and the connection closed cleanly → sent;
 * - anything after label bytes started → uncertain, never retried automatically.
 */
export function statusAfterAttempt(
  outcome: SendOutcome,
  attemptsSoFar: number,
  retryBaseMs: number,
  maxAttempts = MAX_PRINT_ATTEMPTS,
): AttemptResult {
  switch (outcome.result) {
    case 'sent':
      return { status: 'sent', retryInMs: null };
    case 'uncertain':
      return { status: 'uncertain', retryInMs: null };
    case 'not_sent':
      return attemptsSoFar < maxAttempts
        ? { status: 'queued', retryInMs: retryBaseMs * 2 ** (attemptsSoFar - 1) }
        : { status: 'failed', retryInMs: null };
  }
}
