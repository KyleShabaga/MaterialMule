import { z } from 'zod';
import { personSnapshotSchema } from './lab-programs';

// MM-T27: the Action requests inbox, reassignment and personal notification preferences.
// Requests are routed by workflow policy; resolving one always happens through the underlying
// workflow action (close, cancel, correction done, retention decision), never from the inbox.

export const ACTION_REQUEST_KINDS = [
  'correction',
  'cancellation_request',
  'closure_request',
] as const;
export type ActionRequestKind = (typeof ACTION_REQUEST_KINDS)[number];

export const ACTION_REQUEST_RESOLUTIONS = ['correction_done', 'cancelled', 'closed'] as const;
export type ActionRequestResolution = (typeof ACTION_REQUEST_RESOLUTIONS)[number];

/** Who an unassigned item goes to, as the inbox tags it. */
export const ACTION_REQUEST_ROUTE_LABEL: Record<ActionRequestKind, string> = {
  correction: 'Lab Managers',
  cancellation_request: 'Project PM/PE and Lab Managers',
  closure_request: 'Project PM/PE',
};

export const ACTION_REQUEST_RESOLUTION_LABEL: Record<ActionRequestResolution, string> = {
  correction_done: 'Correction done',
  cancelled: 'Test cancelled',
  closed: 'Program closed',
};

export const actionRequestSchema = z.object({
  id: z.string(),
  kind: z.enum(ACTION_REQUEST_KINDS),
  status: z.enum(['open', 'resolved']),
  resolution: z.enum(ACTION_REQUEST_RESOLUTIONS).nullable(),
  /** "Closure requested for LP-001", "Cancellation requested for LP-001 · MC". */
  title: z.string(),
  /** Short routing tag shown before the title: "PM/PE", "LM", "LM · PM/PE" or the assignee. */
  routeTag: z.string(),
  routedTo: z.string(),
  projectId: z.string(),
  projectNumber: z.string(),
  /** In-app link to the thing to act on. */
  href: z.string(),
  requestedBy: personSnapshotSchema,
  reason: z.string(),
  createdAt: z.string(),
  assignedTo: personSnapshotSchema.nullable(),
  resolvedBy: personSnapshotSchema.nullable(),
  resolvedAt: z.string().nullable(),
  /** True when the signed-in person may reassign it (Lab Manager or admin, not its own assignee). */
  canReassign: z.boolean(),
});
export type ActionRequest = z.infer<typeof actionRequestSchema>;

export const actionRequestListSchema = z.object({ items: z.array(actionRequestSchema) });
export type ActionRequestList = z.infer<typeof actionRequestListSchema>;

/** `GET /api/action-items/count` */
export const actionRequestCountSchema = z.object({ open: z.number().int().min(0) });
export type ActionRequestCount = z.infer<typeof actionRequestCountSchema>;

export const ACTION_REQUEST_STATUS_FILTERS = ['open', 'resolved'] as const;
export const actionRequestStatusFilterSchema = z.enum(ACTION_REQUEST_STATUS_FILTERS);

export const REASSIGN_REASON_MAX_LENGTH = 2000;

/** `POST /api/action-items/:id/reassign` (Lab Manager or admin). */
export const reassignActionRequestSchema = z.strictObject({
  toUserId: z.uuid({ error: 'Choose a person' }),
  reason: z
    .string({ error: 'is required' })
    .trim()
    .min(1, { error: 'A reason is required' })
    .max(REASSIGN_REASON_MAX_LENGTH, {
      error: `must be at most ${REASSIGN_REASON_MAX_LENGTH} characters`,
    }),
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
});
export type ReassignActionRequest = z.output<typeof reassignActionRequestSchema>;

/** `GET /api/action-items/:id/assignees`: people who can act on the item. */
export const actionRequestAssigneesSchema = z.object({
  people: z.array(personSnapshotSchema),
});
export type ActionRequestAssignees = z.infer<typeof actionRequestAssigneesSchema>;

/** `GET|PUT /api/me/notification-preferences` (personal accounts only). */
export const notificationPreferencesSchema = z.object({
  emailActionRequests: z.boolean(),
  /** False while email sending is switched off for everyone (pending IT approval). */
  emailSendingEnabled: z.boolean(),
  /** False when the account has no work email to send to. */
  hasWorkEmail: z.boolean(),
  version: z.number().int().min(0),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const updateNotificationPreferencesSchema = z.strictObject({
  emailActionRequests: z.boolean({ error: 'must be true or false' }),
  /** The version last read (0 when never saved); a stale version gets 409. */
  version: z.number({ error: 'is required' }).int().min(0),
});
export type UpdateNotificationPreferences = z.output<typeof updateNotificationPreferencesSchema>;
