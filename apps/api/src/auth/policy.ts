// Server-side permission model (MM-T04). Source: App Idea §1 "Confirmed permissions" and §8
// "Confirmed shared receiving account". The matrix is documented in docs/permissions.md; keep both
// in step. Position (Technician, Engineer, …) and directory job title never grant anything.

export type AccountType = 'personal' | 'shared_lab' | 'test';
export type AccountStatus = 'pending' | 'active' | 'disabled';
export type Role = 'admin' | 'lab_manager';

/** The signed-in principal attached to each authenticated request. */
export interface AuthUser {
  userId: string;
  sessionId: string;
  accountType: AccountType;
  status: AccountStatus;
  roles: Role[];
  displayName: string;
  initials: string | null;
}

/** Project facts a project-scoped permission needs. Delegates arrive with MM-T25. */
export interface ProjectContext {
  pmPeUserId: string;
  acceptanceDelegateUserIds?: string[];
}

export type Permission =
  // Receiving and inventory (LAB may do these)
  | 'receipt.confirm'
  | 'receipt.draft'
  | 'project.create'
  | 'test_hole.create'
  | 'inventory.read'
  | 'label.print'
  | 'storage_unit.move'
  // Lab programs (MM-T23): LAB may enter them with a required Requested by person per draft
  | 'lab_program.read'
  | 'lab_program.manage'
  // Lab progress and comments (MM-T24): LAB too, with a required "Who is doing this?" per action
  | 'test.progress'
  | 'lab_comment.write'
  // Personal accounts only
  | 'storage_unit.correct'
  | 'test.review'
  // Read a project's acceptance delegates (MM-T25)
  | 'acceptance_delegation.read'
  // Change a submitted program (MM-T26): amendments, accepted-request changes and repeats
  | 'lab_program.amend'
  // Ask the people who decide to cancel a test or close a program (MM-T26)
  | 'test.cancel_request'
  | 'program.close_request'
  | 'storage_unit.dispose_scan'
  // Confirm a unit's actual location to settle a move conflict (MM-T28, D29)
  | 'location_conflict.resolve'
  // MM-T36: confirm a tested Shelby tube or bulk bucket was physically removed
  | 'storage_unit.tested_removal'
  // MM-T27: one's own Action requests inbox and notification preferences (never LAB)
  | 'action_item.read'
  // MM-T29: ask the project's PM/PE or a Lab Manager for a hold or extension (never LAB)
  | 'retention.request'
  // Lab Manager (and PM/PE of the project where marked project-scoped)
  | 'test_catalog.manage'
  | 'program.priority.set'
  | 'program.reopen'
  | 'test.cancel'
  // Mark a returned correction done (MM-T25): Lab Manager only, never through PM/PE or admin
  | 'test.correction_done'
  | 'retention.manage'
  | 'disposal.approve'
  // Lab Manager and Admin (MM-T45, MM-T37)
  | 'settings.drafts.manage'
  | 'location.manage'
  // Reassign an open action request to another eligible person, with a reason (MM-T27)
  | 'action_item.reassign'
  // Project PM/PE (and delegates) only
  | 'test.accept'
  | 'program.close'
  | 'acceptance_delegation.manage'
  // Project PM/PE or admin (MM-T35, owner decision 2026-10-25)
  | 'project.edit'
  // Administration
  | 'staff.manage'
  | 'session.revoke'
  | 'printer.manage'
  | 'project.pm_pe.change'
  // Operations (MM-T21): Settings → System status
  | 'system.status.read';

/**
 * What the shared LAB account may do (App Idea §8, owner decision #21 for moves). Lab programs
 * (MM-T23 wireframe decision, Kyle 2026-10-27): LAB creates, edits and submits programs, but the
 * handler requires a valid Requested by person on every such action. That person is attribution
 * only: LAB never gains their roles.
 */
export const LAB_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'receipt.confirm',
  'receipt.draft',
  'project.create',
  'test_hole.create',
  'inventory.read',
  'label.print',
  'storage_unit.move',
  'lab_program.read',
  'lab_program.manage',
  // MM-T24 wireframe decision: Start, Mark completed, Send to review and comments, each naming
  // the person doing it. Priority, review/acceptance, closure and removal stay personal-only.
  'test.progress',
  'lab_comment.write',
]);

/** Any active personal (or test) account. */
const ANY_INTERNAL_USER: ReadonlySet<Permission> = new Set<Permission>([
  ...LAB_PERMISSIONS,
  'storage_unit.correct',
  'test.review',
  'acceptance_delegation.read',
  // MM-T26: LAB's T23/T24 allow-list never covers these, whoever is selected at the station.
  'lab_program.amend',
  'test.cancel_request',
  'program.close_request',
  'storage_unit.dispose_scan',
  // LAB records moves but never settles a conflict, whoever is selected at the station (D29).
  'location_conflict.resolve',
  // MM-T36 post-testing removal: never LAB, whoever a station selects.
  'storage_unit.tested_removal',
  // MM-T27: a LAB station has no inbox or preferences of its own and never borrows the
  // selected person's.
  'action_item.read',
  // MM-T29: retention requests; LAB never asks or decides, whoever is selected.
  'retention.request',
]);

/** Granted by the lab_manager role regardless of project. */
const LAB_MANAGER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'test_catalog.manage',
  'program.priority.set',
  'program.reopen',
  'test.cancel',
  'test.correction_done',
  'retention.manage',
  'disposal.approve',
  // Draft auto-delete setting (MM-T45, owner request 2026-10-26).
  'settings.drafts.manage',
  // Storage locations: add, edit, retire (MM-T37, Kyle 2026-10-26).
  'location.manage',
  // Action request reassignment (MM-T27, Kyle 2026-10-26).
  'action_item.reassign',
]);

/** Granted by the admin role. Admin never implies project authority or Lab Manager rights. */
const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'staff.manage',
  'session.revoke',
  'test_catalog.manage',
  'printer.manage',
  // Draft auto-delete setting (MM-T45).
  'settings.drafts.manage',
  // Storage locations (MM-T37).
  'location.manage',
  // Action request reassignment (MM-T27).
  'action_item.reassign',
  // Projects (MM-T35): admins edit any project's fields and are the only ones who change its PM/PE.
  'project.edit',
  'project.pm_pe.change',
  'system.status.read',
]);

/** Granted to the project's PM/PE (project-scoped). */
const PM_PE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'program.priority.set',
  'program.reopen',
  'test.cancel',
  'retention.manage',
  'disposal.approve',
  'test.accept',
  'program.close',
  'acceptance_delegation.manage',
  'project.edit',
]);

/** Granted to a project acceptance delegate (D04): acceptance only, never closure. */
const DELEGATE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['test.accept']);

/** Permissions that need a ProjectContext to be granted through project authority. */
export const PROJECT_SCOPED: ReadonlySet<Permission> = new Set<Permission>([...PM_PE_PERMISSIONS]);

/**
 * True when `user` may perform `permission`. Project-scoped permissions are granted through the
 * project's PM/PE (or a delegate for acceptance) only when `project` is supplied.
 */
export function can(user: AuthUser, permission: Permission, project?: ProjectContext): boolean {
  if (user.status !== 'active') {
    return false;
  }
  if (user.accountType === 'shared_lab') {
    // LAB has no role or project authority even if one was assigned by mistake.
    return LAB_PERMISSIONS.has(permission);
  }
  if (ANY_INTERNAL_USER.has(permission)) {
    return true;
  }
  if (user.roles.includes('lab_manager') && LAB_MANAGER_PERMISSIONS.has(permission)) {
    return true;
  }
  if (user.roles.includes('admin') && ADMIN_PERMISSIONS.has(permission)) {
    return true;
  }
  if (project) {
    if (project.pmPeUserId === user.userId && PM_PE_PERMISSIONS.has(permission)) {
      return true;
    }
    if (
      project.acceptanceDelegateUserIds?.includes(user.userId) &&
      DELEGATE_PERMISSIONS.has(permission)
    ) {
      return true;
    }
  }
  return false;
}
