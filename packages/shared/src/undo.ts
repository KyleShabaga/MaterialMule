import { z } from 'zod';

// STRATA-123: server support for Undo of reversible actions. Undo is a new, audited compensating
// action bound to the original event; it never deletes history, rolls back the database or
// accepts previous values from the browser. A toast's five seconds is not authorization: the
// server rechecks the person, their permission and the record's current state when Undo runs.
//
// Never undoable (they keep a named confirmation): confirming a receipt or issuing IDs, recording
// a disposal, issuing a report, destructive or physical tests, revoking an approval.
//
// Routes:
//   GET  /api/undo/:action/:sourceId     can this still be undone, and if not, why
//   POST /api/undo                       undo it (idempotent on `idempotencyKey`)
// Dismissing a notification keeps its own undo, `POST /api/notifications/:id/restore` (it stays
// read and never reopens or resolves a request); it is listed here so screens share one model.

/**
 * Actions with an Undo. `move`: a guarded compensating move back to where the unit was, through
 * the normal move rules (permission, lock, retired location, open conflicts).
 */
export const UNDO_ACTIONS = ['move', 'notification_dismiss'] as const;
export type UndoAction = (typeof UNDO_ACTIONS)[number];
export const undoActionSchema = z.enum(UNDO_ACTIONS);

/**
 * Planned with the screens that create them, and not undoable until their own card builds the
 * model: removing a unit from the pending disposal list (STRATA-90) and correcting a test
 * completion entry (lab programs). Until then their Undo is never offered.
 */
export const UNDO_ACTIONS_PLANNED = ['disposal_list_add', 'test_completion'] as const;

/** How long after the original action the server still offers Undo of a move. */
export const UNDO_MOVE_WINDOW_MINUTES = 15;

export const UNDO_BLOCKED_REASONS = [
  /** No such action, or it isn't the signed-in account's (another person's is never revealed). */
  'not_found',
  /** Already undone; the result is the earlier undo. */
  'already_undone',
  /** The record changed after the action (a later move, a correction): undoing would overwrite it. */
  'changed_since',
  /** Past the undo window; make a new move instead. */
  'expired',
  /** The person can no longer do this (role removed, account disabled). */
  'not_permitted',
  /** The unit was disposed, approved for disposal or has an open location conflict. */
  'record_locked',
  /** The place it came from is retired. */
  'location_unavailable',
] as const;
export type UndoBlockedReason = (typeof UNDO_BLOCKED_REASONS)[number];

export const UNDO_BLOCKED_MESSAGES: Record<UndoBlockedReason, string> = {
  not_found: 'This action can no longer be undone.',
  already_undone: 'This was already undone.',
  changed_since: 'It changed after this action, so undoing would overwrite newer work.',
  expired: 'Undo is no longer available. Make a new move instead.',
  not_permitted: 'You can no longer do this.',
  record_locked: 'The unit is locked (disposed, approved for disposal or in a location conflict).',
  location_unavailable: 'The place it came from is retired.',
};

export const undoSourceParamsSchema = z.strictObject({
  action: undoActionSchema,
  sourceId: z.uuid({ error: 'must be an ID' }),
});

/** `GET /api/undo/:action/:sourceId`. */
export const undoEligibilitySchema = z.object({
  action: undoActionSchema,
  sourceId: z.string(),
  eligible: z.boolean(),
  blockedReason: z.enum(UNDO_BLOCKED_REASONS).nullable(),
  /** When Undo stops being offered (moves); null when there is no window. */
  availableUntil: z.string().nullable(),
});
export type UndoEligibility = z.infer<typeof undoEligibilitySchema>;

/**
 * `POST /api/undo`. `sourceId` is the original event (a move's `movementEventId`, a notification's
 * ID). A retry with the same `idempotencyKey` returns the first result and changes nothing more.
 * On a LAB station `moverUserId` must be the person the original move was credited to
 * (attribution only; it grants nothing).
 */
export const undoRequestSchema = z.strictObject({
  action: undoActionSchema,
  sourceId: z.uuid({ error: 'must be an ID' }),
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
  moverUserId: z.uuid({ error: 'must be a UUID' }).optional(),
});
export type UndoRequest = z.output<typeof undoRequestSchema>;

/**
 * 200: undone. 409 `undo_blocked` carries `blockedReason`. The response carries the authoritative
 * facts so lists, peeks and counts refresh from them; a failed or uncertain undo leaves the
 * original result in place (screens never hide it optimistically).
 */
export const undoResultSchema = z.object({
  action: undoActionSchema,
  sourceId: z.string(),
  /** The new audited event that reversed it (a movement event for moves). */
  reversalEventId: z.string(),
  undoneAt: z.string(),
  replayed: z.boolean(),
  /** Moves: where the unit is now saved, and its new version. */
  storageUnit: z
    .object({ id: z.string(), locationId: z.string(), version: z.number().int() })
    .nullable(),
  /** Moves: "Put the holder back on SH-A-01 too." The record moved; the holder must follow. */
  physicalReminder: z.string().nullable(),
});
export type UndoResult = z.infer<typeof undoResultSchema>;

export const undoBlockedResponseSchema = z.object({
  code: z.literal('undo_blocked'),
  blockedReason: z.enum(UNDO_BLOCKED_REASONS),
  message: z.string(),
});
export type UndoBlockedResponse = z.infer<typeof undoBlockedResponseSchema>;
