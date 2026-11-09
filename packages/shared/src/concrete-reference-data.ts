import { z } from 'zod';
import { concreteMixPlantsSchema, concreteMixSupplierSchema } from './concrete-mixes';
import { personSnapshotSchema } from './lab-programs';

// MM-V2-C37: concrete reference data (migration 0028). Owner decisions of 2026-11-08 (Kyle):
// - Suppliers: an admin- or Lab Manager-managed list of concrete suppliers and their plants
//   (`concrete_settings.supplier.manage`). Mixes keep free-text supplier and plant names and may
//   optionally link a listed supplier; mix-number uniqueness stays per project + supplier name.
// - Holidays: an admin-managed company holiday calendar (`concrete_settings.holiday.manage`),
//   seeded with the Alberta general holidays (seed/reference.sql). A specimen target on a holiday
//   is flagged like a weekend and never moved (`concreteTargetDateFlags`).
// Both lists are read by every active session (`inventory.read`).

const versionSchema = z
  .number({ error: 'Version is required' })
  .int()
  .min(1, { error: 'Version is required' });

// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;

/** An optional note kept with the audit event. */
const noteSchema = z
  .string({ error: 'Reason must be text' })
  .trim()
  .max(2000, { error: 'Reason must be 2000 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
    message: "Reason can't contain control characters",
  })
  .transform((value) => (value === '' ? null : value))
  .nullish();

// ---------------------------------------------------------------------------------------------
// Suppliers
// ---------------------------------------------------------------------------------------------

export const concreteSupplierSchema = z.object({
  id: z.string(),
  name: z.string(),
  plantNames: z.array(z.string()),
  active: z.boolean(),
  /** Mixes (any project) that link this supplier. */
  linkedMixCount: z.number(),
  createdAt: z.string(),
  createdBy: personSnapshotSchema,
  updatedAt: z.string(),
  version: z.number(),
});
export type ConcreteSupplier = z.infer<typeof concreteSupplierSchema>;

/** `GET /api/concrete/suppliers?includeInactive=` (inventory.read). Sorted by name. */
export const concreteSupplierListSchema = z.object({
  items: z.array(concreteSupplierSchema),
  /** `concrete_settings.supplier.manage` for the caller. */
  canManage: z.boolean(),
});
export type ConcreteSupplierList = z.infer<typeof concreteSupplierListSchema>;

export const concreteSupplierListQuerySchema = z.object({
  includeInactive: z.preprocess(
    (value) => value === 'true' || value === true,
    z.boolean().default(false),
  ),
});

/** `POST /api/concrete/suppliers` (concrete_settings.supplier.manage). */
export const createConcreteSupplierRequestSchema = z.strictObject({
  name: concreteMixSupplierSchema,
  plantNames: concreteMixPlantsSchema.default([]),
});
export type CreateConcreteSupplierRequest = z.input<typeof createConcreteSupplierRequestSchema>;

/**
 * `PATCH /api/concrete/suppliers/:id` (concrete_settings.supplier.manage). Omitted fields stay;
 * `plantNames` replaces the list whole. Deactivating keeps existing mix links.
 */
export const updateConcreteSupplierRequestSchema = z.strictObject({
  version: versionSchema,
  name: concreteMixSupplierSchema.optional(),
  plantNames: concreteMixPlantsSchema.optional(),
  active: z.boolean({ error: 'Active must be true or false' }).optional(),
  reason: noteSchema,
});
export type UpdateConcreteSupplierRequest = z.input<typeof updateConcreteSupplierRequestSchema>;

export const concreteSupplierVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: concreteSupplierSchema,
});

// ---------------------------------------------------------------------------------------------
// Holiday calendar
// ---------------------------------------------------------------------------------------------

export const COMPANY_HOLIDAY_SOURCES = ['alberta_general', 'company'] as const;
export type CompanyHolidaySource = (typeof COMPANY_HOLIDAY_SOURCES)[number];
export const COMPANY_HOLIDAY_SOURCE_LABEL: Record<CompanyHolidaySource, string> = {
  alberta_general: 'Alberta general holiday',
  company: 'Company holiday',
};

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A real calendar date, YYYY-MM-DD. */
export const holidayDateSchema = z
  .string({ error: 'Enter the date' })
  .regex(DATE_PATTERN, { error: 'Enter the date as YYYY-MM-DD' })
  .refine(
    (value) => {
      const [y, m, d] = value.split('-').map(Number) as [number, number, number];
      const date = new Date(Date.UTC(y, m - 1, d));
      return (
        y >= 2000 &&
        y <= 2100 &&
        date.getUTCFullYear() === y &&
        date.getUTCMonth() === m - 1 &&
        date.getUTCDate() === d
      );
    },
    { message: 'Enter a real date between 2000 and 2100' },
  );

export const holidayNameSchema = z
  .string({ error: 'Name must be text' })
  .trim()
  .min(1, { error: 'Enter the holiday name' })
  .max(200, { error: 'Name must be 200 characters or fewer' })
  .refine((value) => !CONTROL_CHARACTERS.test(value), {
    message: "Name can't contain control characters",
  });

export const companyHolidaySchema = z.object({
  id: z.string(),
  holidayOn: z.string(),
  name: z.string(),
  source: z.enum(COMPANY_HOLIDAY_SOURCES),
  createdBy: personSnapshotSchema.nullable(),
  updatedAt: z.string(),
  version: z.number(),
});
export type CompanyHoliday = z.infer<typeof companyHolidaySchema>;

/** `GET /api/concrete/holidays?year=` (inventory.read): holidays in effect, by date. */
export const companyHolidayListSchema = z.object({
  /** The year asked for, or null for every year. */
  year: z.number().nullable(),
  items: z.array(companyHolidaySchema),
  /** `concrete_settings.holiday.manage` for the caller. */
  canManage: z.boolean(),
});
export type CompanyHolidayList = z.infer<typeof companyHolidayListSchema>;

export const companyHolidayListQuerySchema = z.object({
  year: z.preprocess(
    (value) => (value === undefined || value === '' ? undefined : Number(value)),
    z.number().int().min(2000).max(2100).optional(),
  ),
});

/** `POST /api/concrete/holidays` (concrete_settings.holiday.manage): a company holiday. */
export const createCompanyHolidayRequestSchema = z.strictObject({
  holidayOn: holidayDateSchema,
  name: holidayNameSchema,
});
export type CreateCompanyHolidayRequest = z.input<typeof createCompanyHolidayRequestSchema>;

/** `PATCH /api/concrete/holidays/:id`: rename. The date never changes (remove and add instead). */
export const updateCompanyHolidayRequestSchema = z.strictObject({
  version: versionSchema,
  name: holidayNameSchema,
});
export type UpdateCompanyHolidayRequest = z.input<typeof updateCompanyHolidayRequestSchema>;

/** `POST /api/concrete/holidays/:id/remove`: final; the date can be added again later. */
export const removeCompanyHolidayRequestSchema = z.strictObject({
  version: versionSchema,
  reason: z
    .string({ error: 'Enter a reason' })
    .trim()
    .min(1, { error: 'Enter a reason' })
    .max(2000, { error: 'Reason must be 2000 characters or fewer' })
    .refine((value) => !CONTROL_CHARACTERS_EXCEPT_NEWLINES.test(value), {
      message: "Reason can't contain control characters",
    }),
});
export type RemoveCompanyHolidayRequest = z.input<typeof removeCompanyHolidayRequestSchema>;

export const companyHolidayVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: companyHolidaySchema,
});
