import {
  confirmReceiptResponseSchema,
  type ConfirmReceiptRequestInput,
  type ConfirmReceiptResponse,
  type FieldError,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Receipt confirmation (MM-T09 API) for the receiving wizard (MM-T10).

export type ConfirmOutcome =
  | { kind: 'confirmed'; response: ConfirmReceiptResponse }
  | { kind: 'invalid'; errors: FieldError[] }
  /** The session is gone (MM-T04/T06): sign in again, then confirm the same draft. */
  | { kind: 'unauthenticated' }
  /** No answer after every retry: the receipt may or may not exist; resending is safe. */
  | { kind: 'lost'; message: string }
  /** A definite refusal: nothing was created. */
  | { kind: 'failed'; message: string };

/**
 * Waits before each automatic retry after a lost response. Every attempt sends the same body and
 * idempotency key, so a retry of a receipt that did go through returns the original IDs.
 */
export const CONFIRM_RETRY_DELAYS_MS = [500, 1500, 3000];

const LOST =
  "The connection dropped before Material Mule answered. Your draft is kept; confirming again is safe and won't create duplicates.";

function isFieldErrors(value: unknown): value is FieldError[] {
  return (
    Array.isArray(value) &&
    value.every(
      (e) =>
        e && typeof e === 'object' && typeof e.field === 'string' && typeof e.message === 'string',
    )
  );
}

async function attempt(body: string): Promise<ConfirmOutcome | 'retry'> {
  let response: Response;
  try {
    // The wizard keeps the user on the draft and offers Sign in itself (MM-T11).
    response = await apiFetch(
      '/api/receipts',
      { method: 'POST', body },
      { reportUnauthenticated: false },
    );
  } catch {
    return 'retry';
  }
  if (response.status >= 500) return 'retry';
  const json: unknown = await response.json().catch(() => undefined);
  if (response.ok) {
    const parsed = confirmReceiptResponseSchema.safeParse(json);
    // A cut-off body is a lost response too; the retry returns the original result.
    return parsed.success ? { kind: 'confirmed', response: parsed.data } : 'retry';
  }
  const code =
    json && typeof json === 'object' && 'code' in json && typeof json.code === 'string'
      ? json.code
      : null;
  const errors = json && typeof json === 'object' && 'errors' in json ? json.errors : undefined;
  if ((response.status === 400 || response.status === 422) && isFieldErrors(errors)) {
    return { kind: 'invalid', errors };
  }
  if (code === 'idempotency_key_reused') {
    return {
      kind: 'failed',
      message:
        'This receipt was already confirmed with different details. Check the Receiving Log before receiving these units again.',
    };
  }
  if (response.status === 403) {
    return { kind: 'failed', message: "You don't have permission to confirm receipts." };
  }
  if (response.status === 401) {
    return { kind: 'unauthenticated' };
  }
  return {
    kind: 'failed',
    message: "The receipt wasn't confirmed. Check the details and try again.",
  };
}

/** Confirms a receipt, retrying automatically (same key and body) when the answer is lost. */
export async function confirmReceipt(
  request: ConfirmReceiptRequestInput,
  delays: readonly number[] = CONFIRM_RETRY_DELAYS_MS,
): Promise<ConfirmOutcome> {
  const body = JSON.stringify(request);
  for (let tries = 0; ; tries++) {
    const outcome = await attempt(body);
    if (outcome !== 'retry') return outcome;
    const delay = delays[tries];
    if (delay === undefined) return { kind: 'lost', message: LOST };
    await new Promise((resolve) => setTimeout(resolve, delay));
  }
}
