import { z } from 'zod';

// Destination scans, queued moves and location conflicts (MM-T28). Shared by the API and the web
// app so both agree on the move intent a browser queues, its outcomes and the conflict views.

/**
 * Non-authorising context the browser captured with the scan. The saving account always comes
 * from the session; `accountId` only proves the queue is replayed by the account that scanned.
 */
export const moveCaptureContextSchema = z.strictObject({
  /** Random ID of this browser profile's move queue (not a session, token or device ID). */
  stationId: z.uuid({ error: 'must be a UUID' }),
  /** The account signed in when the scan was taken. Must equal the saving account. */
  accountId: z.uuid({ error: 'must be a UUID' }),
  /** Staff member credited at a shared LAB station ("Moved by"). Attribution only. */
  moverUserId: z.uuid({ error: 'must be a UUID' }).optional(),
});
export type MoveCaptureContext = z.infer<typeof moveCaptureContextSchema>;

/**
 * `POST /api/moves`: one physical scan intent, frozen when it was queued. Retrying sends exactly
 * this body again with the same `clientMoveId`; a correction or a new move gets a new ID.
 */
export const moveRequestSchema = z
  .strictObject({
    clientMoveId: z.uuid({ error: 'must be a UUID' }),
    storageUnitId: z.uuid({ error: 'must be a UUID' }),
    toLocationId: z.uuid({ error: 'must be a UUID' }),
    /** The unit version this station last saw from the server (the chain root's, if linked). */
    baseVersion: z.number({ error: 'is required' }).int().positive(),
    /** Device clock at the scan, with its offset. Reported only: it never orders or wins. */
    scannedAt: z.iso.datetime({ offset: true, error: 'must be an ISO date-time with offset' }),
    /** True when the scan was taken while the browser was offline (source "queued"). */
    capturedOffline: z.boolean({ error: 'is required' }),
    /** The earlier queued move of the same unit from this station that this one follows. */
    previousClientMoveId: z.uuid({ error: 'must be a UUID' }).optional(),
    captureContext: moveCaptureContextSchema,
  })
  .refine((move) => move.previousClientMoveId !== move.clientMoveId, {
    path: ['previousClientMoveId'],
    message: "can't be the move itself",
  });
export type MoveRequest = z.infer<typeof moveRequestSchema>;

/** 201 (first delivery) or 200 with `replayed: true` (a retry of a saved move). */
export const moveSavedResponseSchema = z.object({
  outcome: z.literal('saved'),
  clientMoveId: z.string(),
  movementEventId: z.string(),
  appliedToLocationId: z.string(),
  resultingVersion: z.number(),
  savedAt: z.string(),
  replayed: z.boolean(),
});
export type MoveSavedResponse = z.infer<typeof moveSavedResponseSchema>;

/**
 * 409 `location_conflict`: the unit changed after the scan's base version (or already has an open
 * conflict). The attempt and the conflict are committed; the saved location is unchanged. A retry
 * returns the same IDs with `replayed: true`, even after the conflict is resolved.
 */
export const moveConflictResponseSchema = z.object({
  code: z.literal('location_conflict'),
  outcome: z.literal('conflict'),
  message: z.string(),
  clientMoveId: z.string(),
  attemptEventId: z.string(),
  conflictId: z.string(),
  currentVersion: z.number(),
  replayed: z.boolean(),
});
export type MoveConflictResponse = z.infer<typeof moveConflictResponseSchema>;

/** Error codes `POST /api/moves` can answer with, besides `validation_failed`. */
export const MOVE_ERROR_CODES = [
  'storage_unit_not_found',
  'location_not_found',
  'idempotency_key_reused',
  'predecessor_not_applied',
  'predecessor_invalid',
  'capture_account_mismatch',
  'storage_unit_disposed',
  'location_retired',
  'mover_required',
  'mover_not_allowed',
  'unknown_mover',
] as const;
export type MoveErrorCode = (typeof MOVE_ERROR_CODES)[number];

export const moveErrorResponseSchema = z.object({
  code: z.enum(MOVE_ERROR_CODES),
  message: z.string().optional(),
});

const personSnapshot = z.object({ initials: z.string().nullable(), name: z.string() });
const locationRef = z.object({ id: z.string(), code: z.string(), name: z.string() });

/** One event in a conflict: a saved move, a contested attempt or the resolution. */
export const movementEventSchema = z.object({
  id: z.string(),
  kind: z.enum(['move', 'contested', 'resolution']),
  from: locationRef,
  to: locationRef,
  baseVersion: z.number().nullable(),
  resultingVersion: z.number().nullable(),
  actor: personSnapshot.extend({ accountType: z.enum(['personal', 'shared_lab', 'test']) }),
  /** Staff member credited at a LAB station, as they were when the move was saved. */
  mover: personSnapshot.nullable(),
  /** Device clock at the scan, as reported; null for a resolution. */
  scannedAt: z.string().nullable(),
  savedAt: z.string(),
  source: z.enum(['online', 'queued', 'resolution']),
  /** Short form of the browser station ID, to tell two LAB computers apart. */
  station: z.string().nullable(),
  note: z.string().nullable(),
});
export type MovementEvent = z.infer<typeof movementEventSchema>;

/** Open-conflict flag on storage unit detail (and the version a resolution must send). */
export const locationConflictSummarySchema = z.object({
  id: z.string(),
  version: z.number(),
  openedAt: z.string(),
});
export type LocationConflictSummary = z.infer<typeof locationConflictSummarySchema>;

/** `GET /api/location-conflicts/:id`. */
export const locationConflictDetailSchema = z.object({
  id: z.string(),
  status: z.enum(['open', 'resolved']),
  version: z.number(),
  openedAt: z.string(),
  storageUnit: z.object({
    id: z.string(),
    readableId: z.string(),
    status: z.enum(['in_stock', 'approved_for_disposal', 'disposed']),
    /** Last saved location: what the server knows, not a verified physical position. */
    savedLocation: locationRef,
    version: z.number(),
  }),
  /** The saved move that the contested scans compete with (null when a correction intervened). */
  savedEvent: movementEventSchema.nullable(),
  /** Every contested attempt, oldest first, and the resolution once there is one. */
  events: z.array(movementEventSchema),
  resolution: z
    .object({
      resolvedAt: z.string(),
      resolvedBy: personSnapshot,
      location: locationRef,
      note: z.string().nullable(),
    })
    .nullable(),
});
export type LocationConflictDetail = z.infer<typeof locationConflictDetailSchema>;

export const LOCATION_CONFLICT_NOTE_MAX = 500;

/**
 * `POST /api/location-conflicts/:id/resolve`: a personal account confirms where the unit actually
 * is after checking. Stale versions get 409; the same `clientResolutionId` replays.
 */
export const resolveLocationConflictRequestSchema = z.strictObject({
  clientResolutionId: z.uuid({ error: 'must be a UUID' }),
  locationId: z.uuid({ error: 'Choose the location' }),
  note: z
    .string()
    .trim()
    .max(LOCATION_CONFLICT_NOTE_MAX, {
      error: `Use at most ${LOCATION_CONFLICT_NOTE_MAX} characters`,
    })
    .nullable()
    .optional()
    .transform((value) => (value ? value : null)),
  expectedUnitVersion: z.number({ error: 'is required' }).int().positive(),
  expectedConflictVersion: z.number({ error: 'is required' }).int().positive(),
});
export type ResolveLocationConflictRequest = z.input<typeof resolveLocationConflictRequestSchema>;

export const resolveLocationConflictResponseSchema = z.object({
  conflict: locationConflictDetailSchema,
  replayed: z.boolean(),
});
export type ResolveLocationConflictResponse = z.infer<typeof resolveLocationConflictResponseSchema>;

/** Plain-language move status, the same on every screen. */
export function movementSourceLabel(source: MovementEvent['source']): string {
  switch (source) {
    case 'online':
      return 'Scanned online';
    case 'queued':
      return 'Scanned offline, synced later';
    case 'resolution':
      return 'Confirmed by a person';
  }
}
