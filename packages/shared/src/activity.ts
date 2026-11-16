import { z } from 'zod';

/** One row of Today's ledger (`GET /api/activity/recent`). */
export const activityItemSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  actorInitials: z.string().nullable(),
  actorName: z.string().nullable(),
  /** Human-readable, built on the server; never raw before/after JSON. */
  summary: z.string(),
  /**
   * The record the event is about as people write it (a storage unit ID, a project number),
   * shown in mono under the summary; null when the event names no single record.
   */
  ref: z.string().nullable().default(null),
  /** In-app link to the thing the event is about, when there is a page for it. */
  href: z.string().nullable(),
});

export const activityResponseSchema = z.array(activityItemSchema);

export type ActivityItem = z.infer<typeof activityItemSchema>;

export const ACTIVITY_LIMIT_DEFAULT = 20;
export const ACTIVITY_LIMIT_MAX = 50;
/** Today's ledger covers the last 24 hours; the API accepts up to a week. */
export const ACTIVITY_HOURS_MAX = 168;

/** A whole number clamped into [min, max]; anything else (blank, text) is `fallback`. */
function clampedInt(min: number, max: number, fallback: number | undefined) {
  return (value: unknown) => {
    const parsed = typeof value === 'string' ? Number.parseInt(value, 10) : value;
    if (typeof parsed !== 'number' || !Number.isFinite(parsed)) return fallback;
    return Math.min(Math.max(Math.trunc(parsed), min), max);
  };
}

/**
 * `GET /api/activity/recent?limit=&hours=`: newest first, optionally only the last `hours`.
 * Lenient like the route always was: out-of-range values are bounded, not refused.
 */
export const activityQuerySchema = z.object({
  limit: z.preprocess(
    clampedInt(1, ACTIVITY_LIMIT_MAX, ACTIVITY_LIMIT_DEFAULT),
    z.number().int().min(1).max(ACTIVITY_LIMIT_MAX),
  ),
  hours: z.preprocess(
    clampedInt(1, ACTIVITY_HOURS_MAX, undefined),
    z.number().int().min(1).max(ACTIVITY_HOURS_MAX).optional(),
  ),
  /**
   * Strata Today (STRATA-23): `lab` (everything, the default), `projects` (projects I'm a member
   * of), `mine` (events I did). Narrowing only: it never shows more than `lab`.
   */
  scope: z.preprocess(
    (v) => (typeof v === 'string' && v.trim() !== '' ? v : undefined),
    z.enum(['lab', 'projects', 'mine']).default('lab'),
  ),
});
export type ActivityQuery = z.output<typeof activityQuerySchema>;
