// Server-side permission model (TRP-T04). Source: App Idea §1 "Confirmed permissions" and §8
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

/** Project facts a project-scoped permission needs. Delegates arrive with TRP-T25. */
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
  // Personal accounts only
  | 'storage_unit.correct'
  | 'lab_program.manage'
  | 'test.progress'
  | 'test.review'
  | 'storage_unit.dispose_scan'
  // Lab Manager (and PM/PE of the project where marked project-scoped)
  | 'test_catalog.manage'
  | 'program.priority.set'
  | 'program.reopen'
  | 'test.cancel'
  | 'retention.manage'
  | 'disposal.approve'
  // Project PM/PE (and delegates) only
  | 'test.accept'
  | 'program.close'
  | 'acceptance_delegation.manage'
  // Project PM/PE or admin (TRP-T35, owner decision 2026-10-25)
  | 'project.edit'
  // Administration
  | 'staff.manage'
  | 'session.revoke'
  | 'printer.manage'
  | 'project.pm_pe.change'
  // Operations (TRP-T21): Settings → System status
  | 'system.status.read';

/** What the shared LAB account may do (App Idea §8, owner decision #21 for moves). */
export const LAB_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'receipt.confirm',
  'receipt.draft',
  'project.create',
  'test_hole.create',
  'inventory.read',
  'label.print',
  'storage_unit.move',
]);

/** Any active personal (or test) account. */
const ANY_INTERNAL_USER: ReadonlySet<Permission> = new Set<Permission>([
  ...LAB_PERMISSIONS,
  'storage_unit.correct',
  'lab_program.manage',
  'test.progress',
  'test.review',
  'storage_unit.dispose_scan',
]);

/** Granted by the lab_manager role regardless of project. */
const LAB_MANAGER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'test_catalog.manage',
  'program.priority.set',
  'program.reopen',
  'test.cancel',
  'retention.manage',
  'disposal.approve',
]);

/** Granted by the admin role. Admin never implies project authority or Lab Manager rights. */
const ADMIN_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'staff.manage',
  'session.revoke',
  'test_catalog.manage',
  'printer.manage',
  // Projects (TRP-T35): admins edit any project's fields and are the only ones who change its PM/PE.
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
