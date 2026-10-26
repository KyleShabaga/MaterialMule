import { z } from 'zod';

// Microsoft sign-in and profile onboarding (MM-T05).

/** App positions a person picks at first sign-in. They describe the work; they grant nothing. */
export const POSITIONS = ['technician', 'engineer', 'pm_pe', 'lab_manager'] as const;
export const positionSchema = z.enum(POSITIONS);
export type Position = z.infer<typeof positionSchema>;

export const POSITION_LABELS: Record<Position, { label: string; description: string }> = {
  technician: {
    label: 'Technician (Tech)',
    description: 'Receives, moves and tests samples in the lab or field.',
  },
  engineer: {
    label: 'Engineer (Eng)',
    description: 'Requests and reviews lab testing for projects.',
  },
  pm_pe: {
    label: 'Project Manager / Project Engineer (PM/PE)',
    description:
      'Leads projects. Project authority comes from project assignments, not this choice.',
  },
  lab_manager: {
    label: 'Lab Manager',
    description:
      'Runs the lab. Lab Manager rights are granted by an administrator, not this choice.',
  },
};

/** Body of `POST /api/me/position`. */
export const positionRequestSchema = z.object({ position: positionSchema });
export type PositionRequest = z.infer<typeof positionRequestSchema>;

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
  jobTitle: z.string().nullable(),
  department: z.string().nullable(),
  officeLocation: z.string().nullable(),
  officialInitials: z.string().nullable(),
  initialsConfirmed: z.boolean(),
  position: positionSchema.nullable(),
  positionSetAt: z.string().nullable(),
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
] as const;
export type MicrosoftSignInError = (typeof MICROSOFT_SIGN_IN_ERRORS)[number];
