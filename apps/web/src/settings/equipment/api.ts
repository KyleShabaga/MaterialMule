import {
  concreteEquipmentDetailSchema,
  concreteEquipmentListSchema,
  concreteEquipmentVersionConflictResponseSchema,
  type ConcreteEquipmentDetail,
  type ConcreteEquipmentKind,
  type ConcreteEquipmentList,
  type CreateConcreteEquipmentRequest,
  type FieldError,
  type RecordConcreteCalibrationRequest,
  type UpdateConcreteEquipmentRequest,
} from '@materialmule/shared';
import { z } from 'zod';
import { apiFetch } from '../../api/client';

const fieldErrorsSchema = z.object({
  message: z.string().optional(),
  errors: z.array(z.object({ field: z.string(), code: z.string(), message: z.string() })).min(1),
});

// Settings → Equipment (MM-V2-C27). Every call resolves; failures carry a readable message.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';
const SEGMENT: Record<ConcreteEquipmentKind, string> = {
  testing_machine: 'testing-machine',
  air_meter: 'air-meters',
};

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

export type SaveResult =
  | { ok: true; data: ConcreteEquipmentDetail }
  | { ok: false; kind: 'conflict'; current: ConcreteEquipmentDetail; message: string }
  | { ok: false; kind: 'invalid'; errors: FieldError[]; message: string }
  | { ok: false; kind: 'failed'; message: string };

export async function fetchEquipmentList(): Promise<LoadResult<ConcreteEquipmentList>> {
  try {
    const response = await apiFetch('/api/concrete/equipment');
    if (!response.ok) return { ok: false, message: "The equipment register couldn't load." };
    const parsed = concreteEquipmentListSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

export async function fetchEquipment(id: string): Promise<LoadResult<ConcreteEquipmentDetail>> {
  try {
    const response = await apiFetch(`/api/concrete/equipment/${encodeURIComponent(id)}`);
    if (!response.ok) return { ok: false, message: "This equipment couldn't load." };
    const parsed = concreteEquipmentDetailSchema.safeParse(await response.json().catch(() => null));
    return parsed.success ? { ok: true, data: parsed.data } : { ok: false, message: UNEXPECTED };
  } catch {
    return { ok: false, message: UNREACHABLE };
  }
}

async function save(path: string, method: 'POST' | 'PATCH', body: unknown): Promise<SaveResult> {
  let response: Response;
  try {
    response = await apiFetch(path, { method, body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'failed', message: UNREACHABLE };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = concreteEquipmentDetailSchema.safeParse(json);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: 'failed', message: UNEXPECTED };
  }
  if (response.status === 409) {
    const conflict = concreteEquipmentVersionConflictResponseSchema.safeParse(json);
    if (conflict.success) {
      return {
        ok: false,
        kind: 'conflict',
        current: conflict.data.current,
        message:
          'Someone else changed this equipment while you were editing. The current details are shown; make your change again.',
      };
    }
  }
  // 400 validation_failed, and 409/422 refusals that name a field (duplicate ID, assignee).
  const invalid = fieldErrorsSchema.safeParse(json);
  if ([400, 409, 422].includes(response.status) && invalid.success) {
    return {
      ok: false,
      kind: 'invalid',
      errors: invalid.data.errors,
      message: invalid.data.message ?? 'Check the highlighted fields.',
    };
  }
  const message =
    json && typeof json === 'object' && 'message' in json && typeof json.message === 'string'
      ? json.message
      : response.status === 403
        ? 'Only Lab Managers can change equipment.'
        : "The change wasn't saved. Try again.";
  return { ok: false, kind: 'failed', message };
}

export function registerEquipment(request: CreateConcreteEquipmentRequest): Promise<SaveResult> {
  return save(`/api/concrete/${SEGMENT[request.kind]}`, 'POST', request);
}

export function updateEquipment(
  kind: ConcreteEquipmentKind,
  id: string,
  request: UpdateConcreteEquipmentRequest,
): Promise<SaveResult> {
  return save(`/api/concrete/${SEGMENT[kind]}/${id}`, 'PATCH', request);
}

export function recordCalibration(
  kind: ConcreteEquipmentKind,
  id: string,
  request: RecordConcreteCalibrationRequest,
): Promise<SaveResult> {
  return save(`/api/concrete/${SEGMENT[kind]}/${id}/calibrations`, 'POST', request);
}

export function voidCalibration(
  kind: ConcreteEquipmentKind,
  id: string,
  calibrationId: string,
  reason: string,
): Promise<SaveResult> {
  return save(`/api/concrete/${SEGMENT[kind]}/${id}/calibrations/${calibrationId}/void`, 'POST', {
    reason,
  });
}
