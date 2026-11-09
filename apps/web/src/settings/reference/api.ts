import {
  companyHolidayListSchema,
  companyHolidaySchema,
  companyHolidayVersionConflictResponseSchema,
  concreteSupplierListSchema,
  concreteSupplierSchema,
  concreteSupplierVersionConflictResponseSchema,
  type CompanyHoliday,
  type CompanyHolidayList,
  type ConcreteSupplier,
  type ConcreteSupplierList,
  type CreateCompanyHolidayRequest,
  type CreateConcreteSupplierRequest,
  type FieldError,
  type RemoveCompanyHolidayRequest,
  type UpdateCompanyHolidayRequest,
  type UpdateConcreteSupplierRequest,
} from '@materialmule/shared';
import { z } from 'zod';
import { apiFetch } from '../../api/client';

// Settings → Suppliers and Settings → Holidays (MM-V2-C37). Every call resolves; failures carry a
// readable message.

const UNREACHABLE = "Material Mule couldn't be reached. Check the connection.";
const UNEXPECTED = 'Material Mule returned an unexpected response.';

export type LoadResult<T> = { ok: true; data: T } | { ok: false; message: string };

export type SaveResult<T> =
  | { ok: true; data: T }
  | { ok: false; kind: 'conflict'; current: T; message: string }
  | { ok: false; kind: 'invalid'; errors: FieldError[]; message: string }
  | { ok: false; kind: 'failed'; message: string };

const errorBodySchema = z.object({
  code: z.string().optional(),
  message: z.string().optional(),
  errors: z
    .array(z.object({ field: z.string(), code: z.string(), message: z.string() }))
    .optional(),
});

async function load<T>(path: string, schema: z.ZodType<T>, failed: string) {
  try {
    const response = await apiFetch(path);
    if (!response.ok) return { ok: false, message: failed } as const;
    const parsed = schema.safeParse(await response.json().catch(() => null));
    return parsed.success
      ? ({ ok: true, data: parsed.data } as const)
      : ({ ok: false, message: UNEXPECTED } as const);
  } catch {
    return { ok: false, message: UNREACHABLE } as const;
  }
}

async function save<T>(
  path: string,
  method: 'POST' | 'PATCH',
  body: unknown,
  schema: z.ZodType<T>,
  conflictSchema: z.ZodType<{ current: T }>,
): Promise<SaveResult<T>> {
  let response: Response;
  try {
    response = await apiFetch(path, { method, body: JSON.stringify(body) });
  } catch {
    return { ok: false, kind: 'failed', message: UNREACHABLE };
  }
  const json: unknown = await response.json().catch(() => null);
  if (response.ok) {
    const parsed = schema.safeParse(json);
    return parsed.success
      ? { ok: true, data: parsed.data }
      : { ok: false, kind: 'failed', message: UNEXPECTED };
  }
  if (response.status === 409) {
    const conflict = conflictSchema.safeParse(json);
    if (conflict.success) {
      return {
        ok: false,
        kind: 'conflict',
        current: conflict.data.current,
        message: 'Someone else changed this first. Showing the latest; check it and try again.',
      };
    }
  }
  const error = errorBodySchema.safeParse(json);
  if (error.success && error.data.errors && error.data.errors.length > 0) {
    return {
      ok: false,
      kind: 'invalid',
      errors: error.data.errors,
      message: error.data.message ?? 'Check the highlighted fields.',
    };
  }
  if (response.status === 403) {
    return { ok: false, kind: 'failed', message: "You don't have permission to change this." };
  }
  return {
    ok: false,
    kind: 'failed',
    message: (error.success && error.data.message) || "The change couldn't be saved.",
  };
}

export function fetchSuppliers(
  includeInactive: boolean,
): Promise<LoadResult<ConcreteSupplierList>> {
  return load(
    `/api/concrete/suppliers${includeInactive ? '?includeInactive=true' : ''}`,
    concreteSupplierListSchema,
    "The supplier list couldn't load.",
  );
}

export function createSupplier(
  body: CreateConcreteSupplierRequest,
): Promise<SaveResult<ConcreteSupplier>> {
  return save(
    '/api/concrete/suppliers',
    'POST',
    body,
    concreteSupplierSchema,
    concreteSupplierVersionConflictResponseSchema,
  );
}

export function updateSupplier(
  id: string,
  body: UpdateConcreteSupplierRequest,
): Promise<SaveResult<ConcreteSupplier>> {
  return save(
    `/api/concrete/suppliers/${encodeURIComponent(id)}`,
    'PATCH',
    body,
    concreteSupplierSchema,
    concreteSupplierVersionConflictResponseSchema,
  );
}

export function fetchHolidays(year: number | null): Promise<LoadResult<CompanyHolidayList>> {
  return load(
    `/api/concrete/holidays${year === null ? '' : `?year=${year}`}`,
    companyHolidayListSchema,
    "The holiday calendar couldn't load.",
  );
}

export function createHoliday(
  body: CreateCompanyHolidayRequest,
): Promise<SaveResult<CompanyHoliday>> {
  return save(
    '/api/concrete/holidays',
    'POST',
    body,
    companyHolidaySchema,
    companyHolidayVersionConflictResponseSchema,
  );
}

export function renameHoliday(
  id: string,
  body: UpdateCompanyHolidayRequest,
): Promise<SaveResult<CompanyHoliday>> {
  return save(
    `/api/concrete/holidays/${encodeURIComponent(id)}`,
    'PATCH',
    body,
    companyHolidaySchema,
    companyHolidayVersionConflictResponseSchema,
  );
}

export function removeHoliday(
  id: string,
  body: RemoveCompanyHolidayRequest,
): Promise<SaveResult<CompanyHoliday>> {
  return save(
    `/api/concrete/holidays/${encodeURIComponent(id)}/remove`,
    'POST',
    body,
    companyHolidaySchema,
    companyHolidayVersionConflictResponseSchema,
  );
}

/** The holiday dates in effect, for flag previews (empty when the calendar can't load). */
export async function fetchHolidayDates(): Promise<ReadonlySet<string>> {
  const result = await fetchHolidays(null);
  return new Set(result.ok ? result.data.items.map((item) => item.holidayOn) : []);
}
