import { z } from 'zod';
import { effectiveJobTitleSchema, jobTitleOverrideSchema } from './job-title';
import { positionSchema } from './profile';

// Staff directory and receiver selector (MM-T07).

export const staffStatusSchema = z.enum(['pending', 'active', 'disabled']);
export type StaffStatus = z.infer<typeof staffStatusSchema>;

export const staffRoleSchema = z.enum(['admin', 'lab_manager']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const staffPositionSchema = positionSchema;
export type StaffPosition = z.infer<typeof staffPositionSchema>;

export const staffAccountTypeSchema = z.enum(['personal', 'shared_lab', 'test']);

export const ROLE_LABELS: Record<StaffRole, string> = {
  admin: 'Admin',
  lab_manager: 'Lab Manager',
};

/** Official initials: 1–5 capital letters (e.g. KCS). Not unique. Lower case is upper-cased. */
export const officialInitialsSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .pipe(z.string().regex(/^[A-Z]{1,5}$/, 'Use 1 to 5 letters, e.g. KCS.'));

const displayNameSchema = z.string().trim().min(1, 'Enter a name.').max(200);

/** A work email / UPN as typed by an admin; compared case-insensitively on first sign-in. */
export const expectedUpnSchema = z
  .string()
  .trim()
  .min(3)
  .max(320)
  .regex(/^[^@\s]+@[^@\s]+$/, 'Enter the work email they sign in with, e.g. jsmith@company.com.');

const reasonSchema = z.string().trim().min(1, 'Enter a reason.').max(2000);

/** MTR-12: one access status change of a staff member, from its audit event. */
export const staffStatusChangeSchema = z.object({
  change: z.enum(['approved', 'disabled', 'enabled']),
  /** Who made the change, as their name was then; null for a system change. */
  byName: z.string().nullable(),
  at: z.string(),
  /** Disabling needs a reason; approving and re-enabling take none (owner decision). */
  reason: z.string().nullable(),
});
export type StaffStatusChange = z.infer<typeof staffStatusChangeSchema>;

/** One row of `GET /api/staff`. */
export const staffMemberSchema = z.object({
  id: z.string(),
  displayName: z.string(),
  officialInitials: z.string().nullable(),
  /** True once an admin has assigned or confirmed the official initials (MM-T44). */
  initialsConfirmed: z.boolean(),
  position: staffPositionSchema.nullable(),
  accountType: staffAccountTypeSchema,
  status: staffStatusSchema,
  roles: z.array(staffRoleSchema),
  workEmail: z.string().nullable(),
  signInUsername: z.string().nullable(),
  expectedUpn: z.string().nullable(),
  /** True once a sign-in identity (Microsoft, LAB or test) is attached. */
  linked: z.boolean(),
  lastSignInAt: z.string().nullable(),
  approvedAt: z.string().nullable(),
  disabledReason: z.string().nullable(),
  /** Approvals, disables and re-enables, oldest first (MTR-12). */
  statusHistory: z.array(staffStatusChangeSchema),
  createdAt: z.string(),
  /** Microsoft Graph's job title, as last refreshed (D16). */
  jobTitle: z.string().nullable(),
  /** An administrator's override (D16), who set it and when. */
  jobTitleOverride: z.string().nullable(),
  jobTitleOverrideSetBy: z.string().nullable(),
  jobTitleOverrideSetAt: z.string().nullable(),
  effectiveJobTitle: effectiveJobTitleSchema,
});
export type StaffMember = z.infer<typeof staffMemberSchema>;
export const staffListResponseSchema = z.array(staffMemberSchema);
/** Rows per GET /api/staff; the true count is in LIST_TOTAL_HEADER (BUG-007). */
export const STAFF_LIST_LIMIT = 500;

/** Query of `GET /api/staff`. */
export const staffListQuerySchema = z.object({
  search: z.string().trim().max(100).optional(),
  status: staffStatusSchema.optional(),
});
export type StaffListQuery = z.infer<typeof staffListQuerySchema>;

/** Body of `POST /api/staff`: add someone before their first Microsoft sign-in. */
export const preprovisionStaffRequestSchema = z.object({
  displayName: displayNameSchema,
  officialInitials: officialInitialsSchema,
  expectedUpn: expectedUpnSchema,
  position: staffPositionSchema.nullable().optional(),
});
export type PreprovisionStaffRequest = z.input<typeof preprovisionStaffRequestSchema>;

/** Body of `POST /api/staff/:id/disable`. */
export const disableStaffRequestSchema = z.object({ reason: reasonSchema });
export type DisableStaffRequest = z.input<typeof disableStaffRequestSchema>;

/** Body of `PUT /api/staff/:id/roles`: the complete role set and the reason (D15, MM-AO03). */
export const setStaffRolesRequestSchema = z.object({
  roles: z.array(staffRoleSchema).max(2),
  reason: reasonSchema,
});
export type SetStaffRolesRequest = z.input<typeof setStaffRolesRequestSchema>;

/** Body of `PATCH /api/staff/:id`. */
export const updateStaffRequestSchema = z
  .object({
    officialInitials: officialInitialsSchema.optional(),
    position: staffPositionSchema.nullable().optional(),
    displayName: displayNameSchema.optional(),
  })
  .refine((body) => Object.values(body).some((value) => value !== undefined), {
    message: 'Change at least one field.',
  });
export type UpdateStaffRequest = z.input<typeof updateStaffRequestSchema>;

/**
 * Body of `PUT /api/staff/:id/job-title-override` (D16, MM-AO06): set (text) or clear (null) the
 * override. A reason is required either way (owner decision 2026-10-29). It changes no grant.
 */
export const setJobTitleOverrideRequestSchema = z.strictObject({
  jobTitleOverride: jobTitleOverrideSchema.nullable(),
  reason: reasonSchema,
});
export type SetJobTitleOverrideRequest = z.input<typeof setJobTitleOverrideRequestSchema>;

/** One option of `GET /api/staff/receivers`: minimal fields, active staff only. */
export const receiverOptionSchema = z.object({
  id: z.string(),
  initials: z.string(),
  displayName: z.string(),
});
export type ReceiverOption = z.infer<typeof receiverOptionSchema>;
export const receiverListResponseSchema = z.array(receiverOptionSchema);

/**
 * A person as the app writes them everywhere (MM-T61): "JS · Jordan Smith", so people who share
 * initials are told apart; just one part when the other is missing or the same.
 */
export function formatPerson(initials: string | null, name: string | null): string {
  if (initials && name && initials !== name) return `${initials} · ${name}`;
  return name ?? initials ?? 'Unknown';
}

/** How a receiver is shown everywhere. Positions are never shown outside Settings (MISC-06). */
export function formatReceiver(option: Pick<ReceiverOption, 'initials' | 'displayName'>) {
  return formatPerson(option.initials, option.displayName);
}

/** Error codes the staff API returns in `{ code }` bodies. */
export type StaffErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'last_admin'
  | 'invalid_transition'
  | 'upn_taken'
  | 'roles_not_allowed';
