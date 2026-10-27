import {
  receiptDetailSchema,
  receiptLogPageSchema,
  receiverListResponseSchema,
  type ReceiptDetail,
  type ReceiptLogPage,
  type ReceiverOption,
} from '@materialmule/shared';
import { apiFetch } from '../api/client';

// Receiving Log reads (MM-T51). Every call resolves. A failure says which kind it was, so a lost
// connection or refusal is never shown as an empty history.

export type FailureKind =
  'offline' | 'unauthenticated' | 'forbidden' | 'not_found' | 'invalid' | 'error';

export type ReceiptLogResult<T> =
  { ok: true; data: T } | { ok: false; kind: FailureKind; message: string };

const MESSAGES: Record<FailureKind, string> = {
  offline: "Material Mule couldn't be reached. Check the connection, then try again.",
  unauthenticated: 'Your session has ended. Sign in again to see the Receiving Log.',
  forbidden: "You don't have permission to see receipts.",
  not_found: 'No receipt found. It may have been typed or copied wrongly.',
  invalid: "Some filters aren't valid. Check the dates and try again.",
  error: 'Material Mule had a problem loading receipts. Try again.',
};

function failure(kind: FailureKind): { ok: false; kind: FailureKind; message: string } {
  return { ok: false, kind, message: MESSAGES[kind] };
}

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function get<T>(path: string, schema: Schema<T>): Promise<ReceiptLogResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path);
  } catch {
    return failure('offline');
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    switch (response.status) {
      case 400:
        return failure('invalid');
      case 401:
        return failure('unauthenticated');
      case 403:
        return failure('forbidden');
      case 404:
        return failure('not_found');
      default:
        return failure('error');
    }
  }
  const parsed = schema.safeParse(body);
  return parsed.success ? { ok: true, data: parsed.data } : failure('error');
}

/** `params` is the page's own URL query, which uses the API's parameter names. */
export function fetchReceiptLog(
  params: URLSearchParams,
): Promise<ReceiptLogResult<ReceiptLogPage>> {
  const query = params.toString();
  return get(`/api/receipts${query ? `?${query}` : ''}`, receiptLogPageSchema);
}

export function fetchReceipt(receiptId: string): Promise<ReceiptLogResult<ReceiptDetail>> {
  return get(`/api/receipts/${encodeURIComponent(receiptId)}`, receiptDetailSchema);
}

/** The Received by filter's label after a reload, found by the receiver's user ID. */
export async function fetchReceiptReceiver(
  userId: string,
): Promise<ReceiptLogResult<ReceiverOption | null>> {
  const result = await get(
    `/api/receipts/receivers?id=${encodeURIComponent(userId)}`,
    receiverListResponseSchema,
  );
  return result.ok ? { ok: true, data: result.data[0] ?? null } : result;
}

/** Options for the Received by filter: anyone who has received a receipt. */
export const RECEIPT_RECEIVERS_PATH = '/api/receipts/receivers';
