import { z } from 'zod';

// MM-V2-C32: report numbers, template revisions, issued report files, the project summary report
// and the strength report snapshot shape agreed with C39. Source: "V2 Concrete — Provisional
// report designs (G2, 2026-11-09)", owner-directed provisional designs; the office's examples,
// when supplied, become a new template revision. Calculation rules (G1) and units/readings (G8)
// stay open: no strength, area, average or assessment is computed or printed anywhere here.

const idSchema = z.uuid({ error: 'must be an ID' });
const dateSchema = z.iso.date({ error: 'must be a date (YYYY-MM-DD)' });
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f-\u009f]/;
// eslint-disable-next-line no-control-regex
const CONTROL_EXCEPT_NEWLINES = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f]/;

// ---- Kinds and numbers ------------------------------------------------------------------------------

/** The numbered report kinds (design section 2). One gap-free counter per kind and year. */
export const CONCRETE_NUMBERED_REPORT_KINDS = ['field', 'strength', 'summary'] as const;
export type ConcreteNumberedReportKind = (typeof CONCRETE_NUMBERED_REPORT_KINDS)[number];

export const CONCRETE_REPORT_NUMBER_FORMAT: Record<
  ConcreteNumberedReportKind,
  { prefix: string; digits: number }
> = {
  field: { prefix: 'CF', digits: 5 },
  strength: { prefix: 'CS', digits: 5 },
  summary: { prefix: 'CSR', digits: 4 },
};

export const CONCRETE_NUMBERED_REPORT_LABEL: Record<ConcreteNumberedReportKind, string> = {
  field: 'Concrete field report',
  strength: 'Concrete compressive strength report',
  summary: 'Project concrete summary report',
};

/** CF-2026-00012, CS-2026-00031, CSR-2026-0004 (the database sets the same text). */
export function formatConcreteReportNumber(
  kind: ConcreteNumberedReportKind,
  year: number,
  seq: number,
): string {
  const { prefix, digits } = CONCRETE_REPORT_NUMBER_FORMAT[kind];
  if (!Number.isInteger(seq) || seq < 1 || seq >= 10 ** digits) {
    throw new RangeError('Report sequence out of range');
  }
  return `${prefix}-${year}-${String(seq).padStart(digits, '0')}`;
}

/** The kind, year and sequence of a report number, or null when it isn't one. */
export function parseConcreteReportNumber(
  text: string,
): { kind: ConcreteNumberedReportKind; year: number; seq: number } | null {
  const match = /^(CF|CS|CSR)-(\d{4})-(\d{4,5})$/.exec(text);
  if (!match) return null;
  const kind = (Object.keys(CONCRETE_REPORT_NUMBER_FORMAT) as ConcreteNumberedReportKind[]).find(
    (k) => CONCRETE_REPORT_NUMBER_FORMAT[k].prefix === match[1],
  )!;
  if (match[3]!.length !== CONCRETE_REPORT_NUMBER_FORMAT[kind].digits) return null;
  const seq = Number(match[3]);
  return seq >= 1 ? { kind, year: Number(match[2]), seq } : null;
}

// ---- Templates and files ---------------------------------------------------------------------------

export const concreteReportTemplateSchema = z.object({
  id: z.string(),
  kind: z.enum(CONCRETE_NUMBERED_REPORT_KINDS),
  /** e.g. "P1" (provisional revision 1). */
  revision: z.string(),
  name: z.string(),
  provisional: z.boolean(),
});
export type ConcreteReportTemplate = z.infer<typeof concreteReportTemplateSchema>;

/** "Field report template P1". */
export function concreteTemplateLabel(template: Pick<ConcreteReportTemplate, 'name' | 'revision'>) {
  return `${template.name} ${template.revision}`;
}

/** An issued file's record (never the bytes). Download: `GET /api/concrete/report-files/:id`. */
export const concreteReportFileSchema = z.object({
  id: z.string(),
  kind: z.enum(CONCRETE_NUMBERED_REPORT_KINDS),
  reportNumber: z.string(),
  /** 0 for the first issue ("Rev 0"), then 1, 2 … */
  revisionNo: z.number(),
  supersedesFileId: z.string().nullable(),
  fileName: z.string(),
  mediaType: z.literal('application/pdf'),
  byteSize: z.number(),
  sha256: z.string(),
  template: concreteReportTemplateSchema,
  includePhotos: z.boolean(),
  includeMachineInfo: z.boolean(),
  createdAt: z.string(),
});
export type ConcreteReportFile = z.infer<typeof concreteReportFileSchema>;

export function concreteReportFileUrl(fileId: string): string {
  return `/api/concrete/report-files/${encodeURIComponent(fileId)}`;
}

// ---- Report-header setting -------------------------------------------------------------------------

/** Fictional until the owner supplies branding (design section 1). No accreditation marks. */
export const CONCRETE_REPORT_HEADER_DEFAULT_NAME = 'Material Mule Testing Laboratory';

export const concreteReportHeaderSchema = z.object({
  companyName: z.string(),
  address: z.string().nullable(),
  phone: z.string().nullable(),
  version: z.number(),
  updatedAt: z.string(),
});
export type ConcreteReportHeader = z.infer<typeof concreteReportHeaderSchema>;

function headerText(name: string, max: number, multiline = false) {
  const control = multiline ? CONTROL_EXCEPT_NEWLINES : CONTROL_CHARACTERS;
  return z
    .string({ error: `${name} must be text` })
    .trim()
    .max(max, { error: `${name} must be ${max} characters or fewer` })
    .refine((value) => !control.test(value), {
      message: `${name} can't contain control characters`,
    });
}

export const updateConcreteReportHeaderRequestSchema = z.strictObject({
  version: z.int().positive(),
  companyName: headerText('Company name', 200).refine((v) => v.length > 0, {
    message: 'Enter the company name',
  }),
  address: headerText('Address', 500, true)
    .transform((v) => (v === '' ? null : v))
    .nullable(),
  phone: headerText('Phone', 50)
    .transform((v) => (v === '' ? null : v))
    .nullable(),
});
export type UpdateConcreteReportHeaderRequest = z.input<
  typeof updateConcreteReportHeaderRequestSchema
>;

// ---- Project summary report (design section 5) -----------------------------------------------------

export const concreteSummaryFiltersSchema = z
  .strictObject({
    /** Cast dates (America/Edmonton), inclusive; both absent = all dates. */
    from: dateSchema.nullable().default(null),
    to: dateSchema.nullable().default(null),
    /** A structure / element as recorded on the field report (exact, ignoring case). */
    element: headerText('Element', 100)
      .transform((v) => (v === '' ? null : v))
      .nullable()
      .default(null),
    /** A mix in the project registry. */
    mixId: idSchema.nullable().default(null),
  })
  .refine((f) => f.from === null || f.to === null || f.from <= f.to, {
    message: 'The end date is before the start date',
    path: ['to'],
  });
export type ConcreteSummaryFilters = z.output<typeof concreteSummaryFiltersSchema>;

/** Query-string form for the preview (GET): empty values mean "not set". */
export const concreteSummaryPreviewQuerySchema = z
  .object({
    from: z.preprocess((v) => (v === '' ? undefined : v), dateSchema.optional()),
    to: z.preprocess((v) => (v === '' ? undefined : v), dateSchema.optional()),
    element: z.preprocess((v) => (v === '' ? undefined : v), z.string().max(100).optional()),
    mixId: z.preprocess((v) => (v === '' ? undefined : v), idSchema.optional()),
  })
  .transform((q) => ({
    from: q.from ?? null,
    to: q.to ?? null,
    element: q.element ?? null,
    mixId: q.mixId ?? null,
  }));

export const issueConcreteSummaryReportRequestSchema = z.strictObject({
  idempotencyKey: idSchema,
  filters: concreteSummaryFiltersSchema,
});
export type IssueConcreteSummaryReportRequest = z.input<
  typeof issueConcreteSummaryReportRequestSchema
>;

/**
 * One age cell. Only an issued strength prints as a value (C39/C24); until then a tested specimen
 * reads "Pending review", an untested one "—" and a HOLD "HOLD".
 */
export const concreteSummaryAgeCellSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('issued'), averageMpa: z.number().nullable() }),
  z.object({ status: z.literal('pending_review') }),
  z.object({ status: z.literal('untested') }),
  z.object({ status: z.literal('not_scheduled') }),
]);
export type ConcreteSummaryAgeCell = z.infer<typeof concreteSummaryAgeCellSchema>;

export const concreteSummaryRowSchema = z.object({
  setId: z.string(),
  /** Permanent set ID, else the temporary one. */
  setLabel: z.string().nullable(),
  castDate: z.string().nullable(),
  fieldReportNumber: z.string().nullable(),
  elements: z.string().nullable(),
  mixNumber: z.string().nullable(),
  specifiedStrengthMpa: z.number().nullable(),
  specifiedStrengthAgeDays: z.number().nullable(),
  slumpMm: z.number().nullable(),
  airPercent: z.number().nullable(),
  concreteTempC: z.number().nullable(),
  /** Keyed by age in days, as `ages` lists them. */
  ages: z.record(z.string(), concreteSummaryAgeCellSchema),
  holdCount: z.number(),
  status: z.enum(['all_issued', 'pending']),
});
export type ConcreteSummaryRow = z.infer<typeof concreteSummaryRowSchema>;

/** What a summary prints, frozen in the issued summary report. */
export const concreteSummarySnapshotSchema = z.object({
  kind: z.literal('summary'),
  projectId: z.string(),
  projectNumber: z.string(),
  projectName: z.string(),
  client: z.string().nullable(),
  leadProjectEngineer: z.string().nullable(),
  filters: z.object({
    from: z.string().nullable(),
    to: z.string().nullable(),
    element: z.string().nullable(),
    mixId: z.string().nullable(),
    mixNumber: z.string().nullable(),
  }),
  /** Test ages (days) used on the project's sets in range, ascending. */
  ages: z.array(z.number()),
  rows: z.array(concreteSummaryRowSchema),
  totals: z.object({ sets: z.number(), allIssued: z.number(), pending: z.number() }),
});
export type ConcreteSummarySnapshot = z.infer<typeof concreteSummarySnapshotSchema>;

export const concreteSummaryReportSchema = z.object({
  id: z.string(),
  reportNumber: z.string(),
  issuedAt: z.string(),
  issuedBy: z.object({ userId: z.string(), name: z.string() }),
  filters: concreteSummarySnapshotSchema.shape.filters,
  totals: concreteSummarySnapshotSchema.shape.totals,
  file: concreteReportFileSchema,
});
export type ConcreteSummaryReport = z.infer<typeof concreteSummaryReportSchema>;

export const concreteSummaryReportListSchema = z.object({
  projectId: z.string(),
  items: z.array(concreteSummaryReportSchema),
  /** Whether the caller may issue a summary on this project (`report.issue`). */
  canIssue: z.boolean(),
});
export type ConcreteSummaryReportList = z.infer<typeof concreteSummaryReportListSchema>;

// ---- Strength report snapshot ------------------------------------------------------------------------
// The strength report's frozen version snapshot is C39's `ConcreteStrengthReportSnapshot`
// (concrete-strength-reports.ts): one shape for the record, the API and the renderer.
