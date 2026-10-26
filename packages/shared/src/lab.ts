import { z } from 'zod';

// Operational shared receiving account LAB (MM-T06, App Idea §8).

/** The LAB account's username. Matched case-insensitively. */
export const LAB_USERNAME = 'LAB';

export const LAB_PASSWORD_MIN_LENGTH = 12;
/** Upper bound so a huge body can't make hashing expensive. */
export const LAB_PASSWORD_MAX_LENGTH = 256;

/** Body of `POST /api/auth/lab/sign-in`. */
export const labSignInRequestSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(LAB_PASSWORD_MAX_LENGTH),
});

export type LabSignInRequest = z.infer<typeof labSignInRequestSchema>;

// Messages never echo the value: the password must not reach logs or error responses.
/** Body of `POST /api/admin/lab/password`. */
export const labPasswordResetRequestSchema = z.object({
  newPassword: z
    .string({ error: 'A new password is required.' })
    .min(LAB_PASSWORD_MIN_LENGTH, {
      error: `The password must be at least ${LAB_PASSWORD_MIN_LENGTH} characters.`,
    })
    .max(LAB_PASSWORD_MAX_LENGTH, {
      error: `The password must be at most ${LAB_PASSWORD_MAX_LENGTH} characters.`,
    })
    .refine((value) => value.trim().length >= LAB_PASSWORD_MIN_LENGTH, {
      error: `The password must be at least ${LAB_PASSWORD_MIN_LENGTH} characters.`,
    }),
});

export type LabPasswordResetRequest = z.infer<typeof labPasswordResetRequestSchema>;

/** Response of `GET /api/admin/lab`: the LAB account's state for the admin screen. */
export const labAccountResponseSchema = z.object({
  userId: z.string(),
  passwordSet: z.boolean(),
  passwordUpdatedAt: z.string().nullable(),
  activeSessions: z.number().int(),
  lockedUntil: z.string().nullable(),
});

export type LabAccountResponse = z.infer<typeof labAccountResponseSchema>;

/** Error body when sign-in is temporarily refused after repeated failures. */
export const signInLockedResponseSchema = z.object({
  code: z.literal('locked_out'),
  retryAfterSeconds: z.number().int(),
});
