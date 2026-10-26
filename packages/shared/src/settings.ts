import { z } from 'zod';

// App settings (MM-T45). `draftAutoDelete`: whether each browser deletes its own receiving drafts
// (TRP-T11) that haven't been saved for `afterDays` days. Off by default; drafts that were being
// confirmed are never deleted. Read by every active session, changed by Admin and Lab Manager.

export const DRAFT_AUTO_DELETE_MIN_DAYS = 30;
export const DRAFT_AUTO_DELETE_MAX_DAYS = 365;
export const DRAFT_AUTO_DELETE_DEFAULT_DAYS = 90;

const AFTER_DAYS_MESSAGE = `Enter a whole number of days from ${DRAFT_AUTO_DELETE_MIN_DAYS} to ${DRAFT_AUTO_DELETE_MAX_DAYS}`;

const afterDays = z
  .number({ error: AFTER_DAYS_MESSAGE })
  .int({ error: AFTER_DAYS_MESSAGE })
  .min(DRAFT_AUTO_DELETE_MIN_DAYS, { error: AFTER_DAYS_MESSAGE })
  .max(DRAFT_AUTO_DELETE_MAX_DAYS, { error: AFTER_DAYS_MESSAGE });

/** `GET /api/settings/drafts` (and the answer to a successful PUT). */
export const draftSettingsSchema = z.object({
  draftAutoDelete: z.object({ enabled: z.boolean(), afterDays }),
  /** Optimistic concurrency: send it back with the change. */
  version: z.number().int().positive(),
});
export type DraftSettings = z.infer<typeof draftSettingsSchema>;

/** `PUT /api/settings/drafts`. */
export const putDraftSettingsRequestSchema = z.strictObject({
  draftAutoDelete: z.strictObject({
    enabled: z.boolean({ error: 'Choose on or off' }),
    afterDays,
  }),
  version: z.number({ error: 'Version is required' }).int().positive(),
});
export type PutDraftSettingsRequest = z.input<typeof putDraftSettingsRequestSchema>;

/** 409 body when someone else changed the setting since it was loaded. */
export const draftSettingsVersionConflictResponseSchema = z.object({
  code: z.literal('version_conflict'),
  current: draftSettingsSchema,
});
export type DraftSettingsVersionConflictResponse = z.infer<
  typeof draftSettingsVersionConflictResponseSchema
>;
