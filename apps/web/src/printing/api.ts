import {
  labelPreviewSchema,
  printHistoryResponseSchema,
  printJobSchema,
  printersResponseSchema,
  receiptLabelPreviewsSchema,
  type CreatePrintJobRequest,
  type LabelPreview,
  type PrintHistoryResponse,
  type PrintJob,
  type Printer,
  type PutPrintersRequest,
  type ReceiptLabelPreviews,
} from '@trapezoid/shared';
import { apiFetch } from '../api/client';

// Label printing API calls (TRP-T15). Every call resolves; failures carry a readable message.

export type ApiResult<T> = { ok: true; data: T } | { ok: false; message: string };

interface Schema<T> {
  safeParse(data: unknown): { success: true; data: T } | { success: false };
}

async function call<T>(path: string, schema: Schema<T>, init?: RequestInit): Promise<ApiResult<T>> {
  const result = await callWithStatus(path, schema, init);
  return result.ok ? result : { ok: false, message: result.message };
}

type StatusResult<T> = { ok: true; data: T } | { ok: false; message: string; status: number };

async function callWithStatus<T>(
  path: string,
  schema: Schema<T>,
  init?: RequestInit,
): Promise<StatusResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, init);
  } catch {
    return {
      ok: false,
      status: 0,
      message: "Trapezoid couldn't be reached. Check the connection.",
    };
  }
  const body: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      body && typeof body === 'object' && 'message' in body && typeof body.message === 'string'
        ? body.message
        : response.status === 403
          ? "You don't have permission to do that."
          : `Request failed (HTTP ${response.status}).`;
    return { ok: false, message, status: response.status };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, status: response.status, message: 'Trapezoid returned an unexpected response.' };
}

export function requestPrint(request: CreatePrintJobRequest): Promise<ApiResult<PrintJob>> {
  return call('/api/print-jobs', printJobSchema, {
    method: 'POST',
    body: JSON.stringify(request),
  });
}

export function fetchPrintJob(id: string): Promise<ApiResult<PrintJob>> {
  return call(`/api/print-jobs/${encodeURIComponent(id)}`, printJobSchema);
}

export function confirmPhysicalPrint(id: string): Promise<ApiResult<PrintJob>> {
  return call(`/api/print-jobs/${encodeURIComponent(id)}/confirm-physical`, printJobSchema, {
    method: 'POST',
  });
}

export function fetchPrintHistory(storageUnit: string): Promise<ApiResult<PrintHistoryResponse>> {
  return call(
    `/api/storage-units/${encodeURIComponent(storageUnit)}/print-history`,
    printHistoryResponseSchema,
  );
}

export function fetchPrinters(): Promise<ApiResult<Printer[]>> {
  return call('/api/admin/printers', printersResponseSchema);
}

export function savePrinters(request: PutPrintersRequest): Promise<ApiResult<Printer[]>> {
  return call('/api/admin/printers', printersResponseSchema, {
    method: 'PUT',
    body: JSON.stringify(request),
  });
}

/** Label previews (TRP-T39) report "not found" separately so the screen can say so. */
export type PreviewResult<T> =
  { ok: true; data: T } | { ok: false; notFound: boolean; message: string };

async function preview<T>(path: string, schema: Schema<T>): Promise<PreviewResult<T>> {
  const result = await callWithStatus(path, schema);
  return result.ok
    ? result
    : { ok: false, notFound: result.status === 404, message: result.message };
}

/** The unit's sticker as a real-size SVG. Read-only: never a print job or a label print. */
export function fetchLabelPreview(storageUnit: string): Promise<PreviewResult<LabelPreview>> {
  return preview(
    `/api/storage-units/${encodeURIComponent(storageUnit)}/label/preview`,
    labelPreviewSchema,
  );
}

/** Every label of a receipt, in receipt order. */
export function fetchReceiptLabelPreviews(
  receiptId: string,
): Promise<PreviewResult<ReceiptLabelPreviews>> {
  return preview(
    `/api/receipts/${encodeURIComponent(receiptId)}/labels/preview`,
    receiptLabelPreviewsSchema,
  );
}
