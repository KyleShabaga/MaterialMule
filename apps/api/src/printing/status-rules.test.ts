import { describe, expect, it } from 'vitest';
import { MAX_PRINT_ATTEMPTS, statusAfterAttempt } from './status-rules.js';

const notSent = {
  result: 'not_sent',
  error: 'Printer refused the connection',
  printerMessage: null,
} as const;

describe('statusAfterAttempt (T1)', () => {
  it('marks a clean, complete send as sent', () => {
    expect(statusAfterAttempt({ result: 'sent' }, 1, 1000)).toEqual({
      status: 'sent',
      retryInMs: null,
    });
  });

  it('retries a send that never started, with growing backoff', () => {
    expect(statusAfterAttempt(notSent, 1, 1000)).toEqual({ status: 'queued', retryInMs: 1000 });
    expect(statusAfterAttempt(notSent, 2, 1000)).toEqual({ status: 'queued', retryInMs: 2000 });
  });

  it('fails after the last attempt', () => {
    expect(MAX_PRINT_ATTEMPTS).toBe(3);
    expect(statusAfterAttempt(notSent, 3, 1000)).toEqual({ status: 'failed', retryInMs: null });
  });

  it('never retries an uncertain send, even on the first attempt', () => {
    expect(
      statusAfterAttempt({ result: 'uncertain', error: 'Printer dropped the connection' }, 1, 1000),
    ).toEqual({ status: 'uncertain', retryInMs: null });
  });
});
