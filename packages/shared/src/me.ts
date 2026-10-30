import { z } from 'zod';
import { positionSchema } from './profile';

/** Response body of `GET /api/me`: who is signed in and what the UI may offer them. */
export const meResponseSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  initials: z.string().nullable(),
  accountType: z.enum(['personal', 'shared_lab', 'test']),
  status: z.enum(['pending', 'active']),
  roles: z.array(z.enum(['admin', 'lab_manager'])),
  /** Global (not project-scoped) permissions, for showing or hiding UI. The server still checks. */
  permissions: z.array(z.string()),
  sessionExpiresAt: z.string(),
  /** The person's self-chosen position (MM-T05). Describes their work; grants nothing. */
  // Optional in the schema so older fixtures stay valid; the API always sends these three.
  position: positionSchema.nullable().optional(),
  /** True until a Microsoft-signed-in person saves their first-login position. */
  positionSetupRequired: z.boolean().optional(),
  /** True when the latest Microsoft profile refresh failed (offer Retry). */
  profileRefreshFailed: z.boolean().optional(),
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Header every state-changing API request must carry (CSRF defence, MM-T04). */
export const CSRF_HEADER_NAME = 'x-materialmule-csrf';

/**
 * Response header on capped lists (GET /api/staff, GET /api/locations): how many rows match in
 * all. More than the body holds means the list was cut and the search should be narrowed
 * (BUG-007).
 */
export const LIST_TOTAL_HEADER = 'x-total-count';

/** Response body of `GET /api/auth/providers`: which sign-in options exist on this server. */
export const authProvidersResponseSchema = z.object({
  microsoft: z.boolean(),
  lab: z.boolean(),
  test: z.boolean(),
});

export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
