import { z } from 'zod';

/** One row of the dashboard's "Recent activity" list (`GET /api/activity/recent`). */
export const activityItemSchema = z.object({
  id: z.string(),
  occurredAt: z.string(),
  action: z.string(),
  actorInitials: z.string().nullable(),
  actorName: z.string().nullable(),
  /** Human-readable, built on the server; never raw before/after JSON. */
  summary: z.string(),
  /** In-app link to the thing the event is about, when there is a page for it. */
  href: z.string().nullable(),
});

export const activityResponseSchema = z.array(activityItemSchema);

export type ActivityItem = z.infer<typeof activityItemSchema>;
