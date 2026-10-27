import { z } from 'zod';
import { positionSchema } from './profile';

// Staff directory and receiver selector (MM-T07).

export const staffStatusSchema = z.enum(['pending', 'active', 'disabled']);
export type StaffStatus = z.infer<typeof staffStatusSchema>;

export const staffRoleSchema = z.enum(['admin', 'lab_manager']);
export type StaffRole = z.infer<typeof staffRoleSchema>;

export const staffPositionSchema = positionSchema;
export type StaffPosition = z.infer<typeof staffPositionSchema>;

export const staffAccountTypeSchema = z.enum(['personal', 'shared_lab', 'test']);

/** Short labels used beside initials, e.g. "JS · Jordan Smith (Tech)". */
export const POSITION_SHORT_LABELS: Record<StaffPosition, string> = {
  technician: 'Tech',
  engineer: 'Eng',
  pm_pe: 'PM/PE',
  lab_manager: 'Lab Mgr',
};

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
  createdAt: z.string(),
});
export type StaffMember = z.infer<typeof staffMemberSchema>;
export const staffListResponseSchema = z.array(staffMemberSchema);

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

/** Body of `PUT /api/staff/:id/roles`: the complete role set. A reason is kept in the audit. */
export const setStaffRolesRequestSchema = z.object({
  roles: z.array(staffRoleSchema).max(2),
  reason: reasonSchema.optional(),
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

/** One option of `GET /api/staff/receivers`: minimal fields, active staff only. */
export const receiverOptionSchema = z.object({
  id: z.string(),
  initials: z.string(),
  displayName: z.string(),
  position: staffPositionSchema.nullable(),
});
export type ReceiverOption = z.infer<typeof receiverOptionSchema>;
export const receiverListResponseSchema = z.array(receiverOptionSchema);

/** "JS · Jordan Smith (Tech)": how a receiver is shown everywhere, so duplicates are told apart. */
export function formatReceiver(
  option: Pick<ReceiverOption, 'initials' | 'displayName' | 'position'>,
) {
  const base = `${option.initials} · ${option.displayName}`;
  return option.position ? `${base} (${POSITION_SHORT_LABELS[option.position]})` : base;
}

/** Error codes the staff API returns in `{ code }` bodies. */
export type StaffErrorCode =
  | 'invalid_request'
  | 'not_found'
  | 'last_admin'
  | 'invalid_transition'
  | 'upn_taken'
  | 'roles_not_allowed';
