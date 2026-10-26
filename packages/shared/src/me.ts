import { z } from 'zod';

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
});

export type MeResponse = z.infer<typeof meResponseSchema>;

/** Header every state-changing API request must carry (CSRF defence, TRP-T04). */
export const CSRF_HEADER_NAME = 'x-trapezoid-csrf';

/** Response body of `GET /api/auth/providers`: which sign-in options exist on this server. */
export const authProvidersResponseSchema = z.object({
  microsoft: z.boolean(),
  lab: z.boolean(),
  test: z.boolean(),
});

export type AuthProvidersResponse = z.infer<typeof authProvidersResponseSchema>;
