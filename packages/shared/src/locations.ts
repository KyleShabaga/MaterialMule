import { z } from 'zod';
import { printJobSchema } from './printing';

// Storage locations administration and location labels (MM-T37). Shared by the API and the web
// app so both validate codes, payloads and requests the same way.

export const LOCATION_KINDS = ['receiving_lab', 'lab', 'staging', 'warehouse', 'other'] as const;
export type LocationKind = (typeof LOCATION_KINDS)[number];

/**
 * Kinds a person may choose. "Receiving lab" belongs to the protected system location that
 * receipt confirmation uses (D03); a second one would only confuse.
 */
export const SELECTABLE_LOCATION_KINDS = ['lab', 'staging', 'warehouse', 'other'] as const;
export type SelectableLocationKind = (typeof SELECTABLE_LOCATION_KINDS)[number];

export function locationKindLabel(kind: LocationKind): string {
  switch (kind) {
    case 'receiving_lab':
      return 'Receiving lab';
    case 'lab':
      return 'Lab / bench';
    case 'staging':
      return 'Staging';
    case 'warehouse':
      return 'Warehouse';
    case 'other':
      return 'Other';
  }
}

/** Matches the database CHECK on location.code once normalised (migration 0001). */
export const LOCATION_CODE_PATTERN = /^[A-Z0-9-]{2,20}$/;
export const LOCATION_CODE_MESSAGE = 'Use 2–20 letters, digits or hyphens, e.g. WH-C1';
export const LOCATION_NAME_MAX = 100;
export const LOCATION_AREA_MAX = 60;
export const LOCATION_REASON_MAX = 500;
export const LOCATION_SEARCH_MAX = 100;

/** What a typed code is stored and compared as: trimmed and upper case. " wh-c1 " → "WH-C1". */
export function normalizeLocationCode(code: string): string {
  return code.trim().toUpperCase();
}

/** Location label payload prefix (owner approval 2026-10-25). */
export const LOCATION_PAYLOAD_PREFIX = 'LOC-';

/** What both symbols on a location label encode: `LOC-<CODE>`, e.g. LOC-WH-C1. Nothing else. */
export function locationPayload(code: string): string {
  return `${LOCATION_PAYLOAD_PREFIX}${normalizeLocationCode(code)}`;
}

/** Issued storage unit IDs: PREFIX-YYYY-NNNNNN (CLAUDE.md, amended 2026-10-25). */
const STORAGE_UNIT_PAYLOAD = /^(BKT|ST|CRE|CT)-\d{4}-\d{6}$/;

export type ParsedScanPayload =
  | { type: 'location'; code: string }
  | { type: 'storage_unit'; readableId: string }
  | { type: 'unknown' };

/**
 * Tells a scanned location label from a storage-unit label. Scanner suffixes and control
 * characters are dropped and case is ignored. Only `LOC-<CODE>` is a location; only an issued
 * storage unit ID shape is a storage unit; anything else (URLs, a bare location code, a typo) is
 * unknown. The two shapes can't overlap: no storage unit prefix is LOC.
 */
export function parseScanPayload(raw: string): ParsedScanPayload {
  const value = raw
    .replace(/[\p{Cc}\p{Cf}]/gu, '')
    .trim()
    .toUpperCase();
  if (value.startsWith(LOCATION_PAYLOAD_PREFIX)) {
    const code = value.slice(LOCATION_PAYLOAD_PREFIX.length);
    return LOCATION_CODE_PATTERN.test(code) ? { type: 'location', code } : { type: 'unknown' };
  }
  if (STORAGE_UNIT_PAYLOAD.test(value)) return { type: 'storage_unit', readableId: value };
  return { type: 'unknown' };
}

const code = z
  .string({ error: 'Code is required' })
  .transform(normalizeLocationCode)
  .pipe(
    z
      .string()
      .min(1, { error: 'Code is required' })
      .regex(LOCATION_CODE_PATTERN, { error: LOCATION_CODE_MESSAGE }),
  );

const name = z
  .string({ error: 'Name is required' })
  .trim()
  .min(1, { error: 'Name is required' })
  .max(LOCATION_NAME_MAX, { error: `Use at most ${LOCATION_NAME_MAX} characters` });

/** Optional; blank means none. */
const area = z
  .string()
  .trim()
  .max(LOCATION_AREA_MAX, { error: `Use at most ${LOCATION_AREA_MAX} characters` })
  .nullable()
  .transform((value) => (value ? value : null));

const kind = z.enum(SELECTABLE_LOCATION_KINDS, { error: 'Choose a kind' });

/** `POST /api/locations`. */
export const createLocationRequestSchema = z.strictObject({
  code,
  name,
  kind,
  area: area.optional().transform((value) => value ?? null),
});
export type CreateLocationRequest = z.input<typeof createLocationRequestSchema>;

/**
 * `PATCH /api/locations/:id`: only the fields sent change. `version` is the one the edit was
 * based on; a stale one gets 409 with the current location.
 */
export const updateLocationRequestSchema = z.strictObject({
  code: code.optional(),
  name: name.optional(),
  kind: kind.optional(),
  area: area.optional(),
  version: z.number({ error: 'Version is required' }).int().positive(),
});
export type UpdateLocationRequest = z.input<typeof updateLocationRequestSchema>;

/** `POST /api/locations/:id/retire`. */
export const retireLocationRequestSchema = z.strictObject({
  reason: z
    .string({ error: 'Give a reason' })
    .trim()
    .min(1, { error: 'Give a reason' })
    .max(LOCATION_REASON_MAX, { error: `Use at most ${LOCATION_REASON_MAX} characters` }),
  version: z.number({ error: 'Version is required' }).int().positive(),
});
export type RetireLocationRequest = z.input<typeof retireLocationRequestSchema>;

/** `GET /api/locations?search=&includeRetired=`. */
export const locationListQuerySchema = z.object({
  search: z.preprocess(
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z
      .string()
      .trim()
      .max(LOCATION_SEARCH_MAX, { error: `must be at most ${LOCATION_SEARCH_MAX} characters` })
      .optional(),
  ),
  includeRetired: z.preprocess(
    (value) => (value === undefined || value === '' ? 'false' : value),
    z.enum(['true', 'false'], { error: 'must be true or false' }).transform((v) => v === 'true'),
  ),
});

/** `POST /api/locations/:id/labels`: queue a location label on the server-side print queue. */
export const createLocationLabelRequestSchema = z.strictObject({
  printerId: z
    .string()
    .regex(/^[a-z0-9][a-z0-9-]{0,39}$/, { error: 'Unknown printer' })
    .optional(),
  /**
   * Staff member printing at a shared LAB station. Required for LAB: a location has no receipt
   * whose receiver could be credited. Attribution only; it grants nothing.
   */
  receiverUserId: z.uuid().optional(),
});
export type CreateLocationLabelRequest = z.input<typeof createLocationLabelRequestSchema>;

export const locationSchema = z.object({
  id: z.string(),
  code: z.string(),
  name: z.string(),
  kind: z.enum(LOCATION_KINDS),
  area: z.string().nullable(),
  active: z.boolean(),
  /** Receiving lab: may be renamed, never retired (D03). */
  isSystem: z.boolean(),
  retiredAt: z.string().nullable(),
  retiredReason: z.string().nullable(),
  /** A label has been requested, so the code (and its LOC- payload) can't change any more. */
  codeLocked: z.boolean(),
  /** First time a person confirmed a location label physically came out; null until then. */
  labelPrintedAt: z.string().nullable(),
  /** Units whose saved location this is and that aren't disposed (Current stock). */
  inStockCount: z.number(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number(),
});
export type StorageLocation = z.infer<typeof locationSchema>;

export const locationListSchema = z.array(locationSchema);

const auditPerson = z.object({ initials: z.string().nullable(), name: z.string().nullable() });

export const locationEventSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  actor: auditPerson,
  /** Staff member credited at a LAB station, as they were at the time. */
  receiver: auditPerson.nullable(),
  reason: z.string().nullable(),
  before: z.record(z.string(), z.unknown()).nullable(),
  after: z.record(z.string(), z.unknown()).nullable(),
});
export type LocationEvent = z.infer<typeof locationEventSchema>;

/** `GET /api/locations/:id`: the location, its change history and its label print history. */
export const locationDetailSchema = z.object({
  location: locationSchema,
  events: z.array(locationEventSchema),
  printJobs: z.array(printJobSchema),
});
export type LocationDetail = z.infer<typeof locationDetailSchema>;

/** `GET /api/locations/:id/label/preview`: real-size SVG; never a print job or a code lock. */
export const locationLabelPreviewSchema = z.object({
  locationId: z.string(),
  svg: z.string(),
  /** What both symbols carry, e.g. LOC-WH-C1. */
  payload: z.string(),
  templateVersion: z.string(),
  warnings: z.array(z.string()),
});
export type LocationLabelPreview = z.infer<typeof locationLabelPreviewSchema>;

/** 409 when someone else changed the location since it was loaded. */
export const locationVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  message: z.string(),
  current: locationSchema,
});

/** 409 when a location still holds units. */
export const locationOccupiedResponseSchema = z.object({
  code: z.literal('location_occupied'),
  message: z.string(),
  inStockCount: z.number(),
});

/** `GET /api/scan/resolve?payload=`: what a scanned label is, for T28 and the scan screens. */
export const scanResolveResponseSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('location'),
    location: z.object({
      id: z.string(),
      code: z.string(),
      name: z.string(),
      kind: z.enum(LOCATION_KINDS),
      area: z.string().nullable(),
      /** False for a retired location: it resolves, but can't be chosen for a new move. */
      active: z.boolean(),
    }),
  }),
  z.object({
    type: z.literal('storage_unit'),
    storageUnit: z.object({ id: z.string(), readableId: z.string() }),
  }),
  z.object({
    type: z.literal('unknown'),
    reason: z.enum(['not_recognised', 'location_not_found', 'storage_unit_not_found']),
  }),
]);
export type ScanResolveResponse = z.infer<typeof scanResolveResponseSchema>;

export const scanResolveQuerySchema = z.object({
  payload: z
    .string({ error: 'payload is required' })
    .min(1, { error: 'payload is required' })
    .max(200, { error: 'must be at most 200 characters' }),
});
