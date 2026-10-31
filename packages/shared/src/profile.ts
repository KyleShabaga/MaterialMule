import { z } from 'zod';
import { effectiveJobTitleSchema } from './job-title';

// Microsoft sign-in and profile onboarding (MM-T05).

/**
 * Staff positions (MISC-06), in their canonical order. An Admin sets them in Settings → Staff &
 * access; null is "Not set", not a fifth position. A position describes the work and grants
 * nothing: no app role, project leadership or review authority comes from it.
 */
export const POSITIONS = ['technician', 'technologist', 'engineer', 'lab_manager'] as const;
export const positionSchema = z.enum(POSITIONS);
export type Position = z.infer<typeof positionSchema>;

/** How a position reads in the Admin's selectors; there are no position descriptions (MISC-06). */
export const POSITION_LABELS: Record<Position, string> = {
  technician: 'Technician',
  technologist: 'Technologist',
  engineer: 'Engineer',
  lab_manager: 'Lab Manager',
};

/** Where the stored profile fields last came from. */
export const profileSourceSchema = z.enum(['microsoft_graph', 'microsoft_id_token', 'seed']);
export type ProfileSource = z.infer<typeof profileSourceSchema>;

/** Response of `GET /api/me/profile`. */
export const profileResponseSchema = z.object({
  displayName: z.string(),
  givenName: z.string().nullable(),
  surname: z.string().nullable(),
  /** Deliverable work email from Microsoft (`mail`); may be absent. */
  workEmail: z.string().nullable(),
  /** The sign-in name (UPN). Not necessarily an email address that receives mail. */
  signInUsername: z.string().nullable(),
  /** Microsoft Graph's job title. */
  jobTitle: z.string().nullable(),
  /** An administrator's override (D16, MM-AO06); shown instead of Microsoft's when set. */
  jobTitleOverride: z.string().nullable(),
  effectiveJobTitle: effectiveJobTitleSchema,
  department: z.string().nullable(),
  officeLocation: z.string().nullable(),
  officialInitials: z.string().nullable(),
  initialsConfirmed: z.boolean(),
  source: profileSourceSchema.nullable(),
  refreshedAt: z.string().nullable(),
  /** Set when the latest refresh failed; the fields above are the last known values. */
  refreshFailedAt: z.string().nullable(),
  /** True for Microsoft-linked accounts, which can retry a profile refresh. */
  canRefresh: z.boolean(),
});
export type ProfileResponse = z.infer<typeof profileResponseSchema>;

/** Body of `POST /api/auth/microsoft/callback`: the query the Microsoft redirect brought back. */
export const microsoftCallbackRequestSchema = z.object({
  state: z.string().min(1).max(200),
  code: z.string().min(1).max(4000).optional(),
  error: z.string().max(200).optional(),
  errorDescription: z.string().max(2000).optional(),
  errorSubcode: z.string().max(200).optional(),
});
export type MicrosoftCallbackRequest = z.infer<typeof microsoftCallbackRequestSchema>;

/** Successful callback: where the browser goes next. */
export const microsoftCallbackResponseSchema = z.object({ next: z.string() });

/** Why a Microsoft sign-in was refused; each has its own message on the sign-in error page. */
export const MICROSOFT_SIGN_IN_ERRORS = [
  'wrong_tenant',
  'guest_account',
  'account_disabled',
  'cancelled',
  'consent_denied',
  'expired_attempt',
  'not_configured',
  'sign_in_failed',
  /** Too many sign-in requests from this address (HTTP 429, MM-T48). */
  'rate_limited',
] as const;
export type MicrosoftSignInError = (typeof MICROSOFT_SIGN_IN_ERRORS)[number];
