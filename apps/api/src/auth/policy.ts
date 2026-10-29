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

/**
 * Project facts a project-scoped permission needs, loaded by the server from the project as it
 * stands (never from the browser). Delegates arrived with MM-T25; report issuers with MM-AO03.
 */
export interface ProjectContext {
  /** Null while the project waits for a lead (D02): lead-only actions are then blocked. */
  leadProjectEngineerUserId: string | null;
  acceptanceDelegateUserIds?: string[];
  /**
   * People holding a usable Authorized report issuer grant (D06: not revoked, not expired) for
   * the one report scope being checked. The loader filters by scope and expiry.
   */
  reportIssuerUserIds?: string[];
  /**
   * Effective designated reviewers (D05) for the one review scope being checked: assigned to
   * this project for that scope, active, and still eligible for it. The loader filters. Concrete
   * contract (MM-AO08); filled by the concrete workflow cards (C04/C07) that check it.
   */
  designatedReviewerUserIds?: string[];
  /**
   * Holders of this project's explicit concrete Lab Manager grant (D13; storage built by C02).
   * Counts only together with the global lab_manager role.
   */
  concreteLabManagerUserIds?: string[];
}

/**
 * Where a permission comes from (MM-AO03 effective capabilities). `internal` is every active
 * personal or test account; `lab` is the shared LAB account's own allow-list.
 */
export type PermissionSource =
  | 'lab'
  | 'internal'
  | 'lab_manager'
  | 'admin'
  | 'lead_project_engineer'
  | 'acceptance_delegate'
  | 'report_issuer'
  // MM-AO08 concrete contract: a designated reviewer for the scope being checked (D05), and the
  // per-project concrete Lab Manager grant together with the lab_manager role (D13).
  | 'designated_reviewer'
  | 'concrete_lab_manager';

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
  // Read a project's team, scoped reviewers, report issuers and one's capabilities (MM-AO03)
  | 'project_access.read'
  // Nominate a Lead Project Engineer on a project with none (MM-AO04, D01): grants nothing
  | 'project_lead.nominate'
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
  // MM-T29: ask the project's Lead Project Engineer or a Lab Manager for a hold or extension (never LAB)
  | 'retention.request'
  // Lab Manager (and Lead Project Engineer of the project where marked project-scoped)
  | 'test_catalog.manage'
  | 'program.priority.set'
  | 'program.reopen'
  | 'test.cancel'
  // Mark a returned correction done (MM-T25): Lab Manager only, never through Lead Project Engineer or admin
  | 'test.correction_done'
  | 'retention.manage'
  | 'disposal.approve'
  // Lab Manager and Admin (MM-T45, MM-T37)
  | 'settings.drafts.manage'
  | 'location.manage'
  // Reassign an open action request to another eligible person, with a reason (MM-T27)
  | 'action_item.reassign'
  // Lead Project Engineer (and delegates) only
  | 'test.accept'
  | 'program.close'
  | 'acceptance_delegation.manage'
  // Lead Project Engineer or admin (MM-T35, owner decision 2026-10-25)
  | 'project.edit'
  // Project team and scoped reviewers (MM-AO03, D04/D05): Lead Project Engineer or admin
  | 'project_team.manage'
  | 'project_reviewer.manage'
  // Authorized report issuers (MM-AO03, D06/D07): granted by the project's Lead Project Engineer
  // only; issuing is the lead's own or an active grant's. No report route uses it yet.
  | 'report_issuer.manage'
  | 'report.issue'
  // Concrete permission contract (MM-AO08). Planned: no route checks these yet; each owning card
  // (C03 mixes, C04/C07 review and failure schedules, the HOLD card) enforces its own.
  // Mixes: the destination project's Lead Project Engineer only, no admin, Lab Manager, reviewer
  // or delegate fallback (C03; D14 revisions stay drafts until the lead approves).
  | 'concrete_mix.manage'
  | 'concrete_mix.approve'
  // Concrete review: the project's Lead Project Engineer (Kyle 2026-10-29, AO08 Q3) or a
  // designated reviewer for the scope (D05); one eligible review is enough.
  | 'concrete.review'
  // A specified failed-specimen schedule change: Lead Project Engineer OR designated reviewer
  // (strength scope); one approval is enough.
  | 'concrete_failure_schedule.approve'
  // Failed-specimen HOLD release/test/dispose: Lead Project Engineer, or a Lab Manager holding
  // the project's concrete grant (D13). Separate from retention.manage and tested-unit removal.
  | 'concrete_hold.manage'
  // Administration
  | 'staff.manage'
  | 'session.revoke'
  | 'printer.manage'
  | 'project.lead_project_engineer.change'
  // Reviewer eligibility (D05) and "Can create and lead projects" (D01), MM-AO03
  | 'reviewer_eligibility.manage'
  | 'staff_capability.manage'
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
  // MM-AO03: broad internal visibility of who is assigned; LAB reads none of it.
  'project_access.read',
  // MM-AO04: any staff member may suggest a lead; an admin confirms. LAB nominates only while
  // creating a project at receiving (for the selected person), never afterwards.
  'project_lead.nominate',
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
  // Projects (MM-T35): admins edit any project's fields and are the only ones who change its Lead Project Engineer.
  'project.edit',
  'project.lead_project_engineer.change',
  'system.status.read',
  // MM-AO03: recording team members and scoped reviewers (D04), reviewer eligibility (D05) and the
  // create-and-lead capability (D01). Never issuer authority (D06) or any technical decision.
  'project_team.manage',
  'project_reviewer.manage',
  'reviewer_eligibility.manage',
  'staff_capability.manage',
]);

/** Granted to the project's Lead Project Engineer (project-scoped). */
const LEAD_PROJECT_ENGINEER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'program.priority.set',
  'program.reopen',
  'test.cancel',
  'retention.manage',
  'disposal.approve',
  'test.accept',
  'program.close',
  'acceptance_delegation.manage',
  'project.edit',
  // MM-AO03 (D04, D06, D07)
  'project_team.manage',
  'project_reviewer.manage',
  'report_issuer.manage',
  'report.issue',
  // MM-AO08 concrete contract (planned; see the Permission comments).
  'concrete_mix.manage',
  'concrete_mix.approve',
  'concrete.review',
  'concrete_failure_schedule.approve',
  'concrete_hold.manage',
]);

/** Granted to a project acceptance delegate (D04): acceptance only, never closure. */
const DELEGATE_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['test.accept']);

/** Granted by an Authorized report issuer grant for its project and scope (D06): issuing only. */
const REPORT_ISSUER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>(['report.issue']);

/** Granted to a designated reviewer for the scope being checked (D05, MM-AO08). */
const DESIGNATED_REVIEWER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'concrete.review',
  'concrete_failure_schedule.approve',
]);

/** Granted by the project's concrete Lab Manager grant, with the lab_manager role (D13). */
const CONCRETE_LAB_MANAGER_PERMISSIONS: ReadonlySet<Permission> = new Set<Permission>([
  'concrete_hold.manage',
]);

/** Permissions that need a ProjectContext to be granted through project authority. */
export const PROJECT_SCOPED: ReadonlySet<Permission> = new Set<Permission>([
  ...LEAD_PROJECT_ENGINEER_PERMISSIONS,
]);

/** Every source that could ever grant `permission`, for a blocked reason (MM-AO03). */
export function possibleSources(permission: Permission): PermissionSource[] {
  const sources: PermissionSource[] = [];
  if (LAB_PERMISSIONS.has(permission)) sources.push('lab');
  if (ANY_INTERNAL_USER.has(permission)) sources.push('internal');
  if (LAB_MANAGER_PERMISSIONS.has(permission)) sources.push('lab_manager');
  if (ADMIN_PERMISSIONS.has(permission)) sources.push('admin');
  if (LEAD_PROJECT_ENGINEER_PERMISSIONS.has(permission)) sources.push('lead_project_engineer');
  if (DELEGATE_PERMISSIONS.has(permission)) sources.push('acceptance_delegate');
  if (REPORT_ISSUER_PERMISSIONS.has(permission)) sources.push('report_issuer');
  if (DESIGNATED_REVIEWER_PERMISSIONS.has(permission)) sources.push('designated_reviewer');
  if (CONCRETE_LAB_MANAGER_PERMISSIONS.has(permission)) sources.push('concrete_lab_manager');
  return sources;
}

/**
 * Every source through which `user` holds `permission` (empty: denied). `can()` is exactly
 * "this is not empty", so the capabilities the API reports never disagree with enforcement.
 */
export function permissionSources(
  user: AuthUser,
  permission: Permission,
  project?: ProjectContext,
): PermissionSource[] {
  if (user.status !== 'active') {
    return [];
  }
  if (user.accountType === 'shared_lab') {
    // LAB has no role or project authority even if one was assigned by mistake.
    return LAB_PERMISSIONS.has(permission) ? ['lab'] : [];
  }
  const sources: PermissionSource[] = [];
  if (ANY_INTERNAL_USER.has(permission)) sources.push('internal');
  if (user.roles.includes('lab_manager') && LAB_MANAGER_PERMISSIONS.has(permission)) {
    sources.push('lab_manager');
  }
  if (user.roles.includes('admin') && ADMIN_PERMISSIONS.has(permission)) {
    sources.push('admin');
  }
  if (project) {
    if (
      project.leadProjectEngineerUserId !== null &&
      project.leadProjectEngineerUserId === user.userId &&
      LEAD_PROJECT_ENGINEER_PERMISSIONS.has(permission)
    ) {
      sources.push('lead_project_engineer');
    }
    if (
      project.acceptanceDelegateUserIds?.includes(user.userId) &&
      DELEGATE_PERMISSIONS.has(permission)
    ) {
      sources.push('acceptance_delegate');
    }
    if (
      project.reportIssuerUserIds?.includes(user.userId) &&
      REPORT_ISSUER_PERMISSIONS.has(permission)
    ) {
      sources.push('report_issuer');
    }
    if (
      project.designatedReviewerUserIds?.includes(user.userId) &&
      DESIGNATED_REVIEWER_PERMISSIONS.has(permission)
    ) {
      sources.push('designated_reviewer');
    }
    // D13: the grant alone is not enough; the person must also hold the Lab Manager role.
    if (
      user.roles.includes('lab_manager') &&
      project.concreteLabManagerUserIds?.includes(user.userId) &&
      CONCRETE_LAB_MANAGER_PERMISSIONS.has(permission)
    ) {
      sources.push('concrete_lab_manager');
    }
  }
  return sources;
}

/**
 * True when `user` may perform `permission`. Project-scoped permissions are granted through the
 * project's Lead Project Engineer (or a delegate for acceptance, an issuer grant for issuing) only
 * when `project` is supplied.
 */
export function can(user: AuthUser, permission: Permission, project?: ProjectContext): boolean {
  return permissionSources(user, permission, project).length > 0;
}
