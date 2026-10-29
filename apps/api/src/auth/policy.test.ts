import { describe, expect, it } from 'vitest';
import {
  can,
  permissionSources,
  possibleSources,
  type AuthUser,
  type Permission,
  type ProjectContext,
} from './policy.js';

function user(overrides: Partial<AuthUser> = {}): AuthUser {
  return {
    userId: 'u-tech',
    sessionId: 's-1',
    accountType: 'personal',
    status: 'active',
    roles: [],
    displayName: 'Alex Tester',
    initials: 'AT',
    ...overrides,
  };
}

const project: ProjectContext = {
  leadProjectEngineerUserId: 'u-pe',
  acceptanceDelegateUserIds: ['u-de'],
};

const LAB_ALLOWED: Permission[] = [
  'receipt.confirm',
  'receipt.draft',
  'project.create',
  'test_hole.create',
  'inventory.read',
  'label.print',
  'storage_unit.move',
  // MM-T23: LAB enters programs with a required Requested by person per action.
  'lab_program.read',
  'lab_program.manage',
  // MM-T24: progress and comments with a required per-action person.
  'test.progress',
  'lab_comment.write',
];

describe('can', () => {
  it('denies everything to pending and disabled accounts', () => {
    for (const status of ['pending', 'disabled'] as const) {
      const u = user({ status, roles: ['admin', 'lab_manager'] });
      expect(can(u, 'inventory.read')).toBe(false);
      expect(can(u, 'staff.manage')).toBe(false);
    }
  });

  it('limits LAB to receiving, inventory, printing and moves', () => {
    const lab = user({ userId: 'u-lab', accountType: 'shared_lab' });
    for (const permission of LAB_ALLOWED) {
      expect(can(lab, permission), permission).toBe(true);
    }
    for (const permission of [
      'storage_unit.correct',
      'test_catalog.manage',
      'storage_unit.dispose_scan',
      // MM-T28: LAB moves units but only a personal account settles a location conflict.
      'location_conflict.resolve',
      // MM-T36: removal after testing is personal-only, whoever the station selects.
      'storage_unit.tested_removal',
      'staff.manage',
      'disposal.approve',
      'printer.manage',
      'system.status.read',
    ] as Permission[]) {
      expect(can(lab, permission), permission).toBe(false);
    }
  });

  it('gives LAB no extra authority even if it was assigned a role or made Lead Project Engineer', () => {
    const lab = user({
      userId: 'u-lab',
      accountType: 'shared_lab',
      roles: ['admin', 'lab_manager'],
    });
    expect(can(lab, 'staff.manage')).toBe(false);
    expect(can(lab, 'program.close', { leadProjectEngineerUserId: 'u-lab' })).toBe(false);
  });

  it('lets any internal personal account correct, review and work lab programs', () => {
    const tech = user();
    for (const permission of [
      'storage_unit.correct',
      'lab_program.manage',
      'test.progress',
      'test.review',
      ...LAB_ALLOWED,
    ] as Permission[]) {
      expect(can(tech, permission), permission).toBe(true);
    }
    expect(can(tech, 'test.cancel')).toBe(false);
    expect(can(tech, 'system.status.read')).toBe(false);
    expect(can(tech, 'program.priority.set')).toBe(false);
  });

  it('gives Lab Manager its role permissions but never acceptance or closure', () => {
    const lm = user({ userId: 'u-lm', roles: ['lab_manager'] });
    for (const permission of [
      'program.priority.set',
      'program.reopen',
      'test.cancel',
      'retention.manage',
      'disposal.approve',
      'test_catalog.manage',
    ] as Permission[]) {
      expect(can(lm, permission), permission).toBe(true);
    }
    expect(can(lm, 'test.accept', project)).toBe(false);
    expect(can(lm, 'program.close', project)).toBe(false);
  });

  it('AC4: admin manages staff and sessions but has no project authority', () => {
    const admin = user({ userId: 'u-admin', roles: ['admin'] });
    expect(can(admin, 'staff.manage')).toBe(true);
    expect(can(admin, 'session.revoke')).toBe(true);
    expect(can(admin, 'printer.manage')).toBe(true);
    expect(can(admin, 'system.status.read')).toBe(true);
    expect(can(admin, 'program.close', project)).toBe(false);
    expect(can(admin, 'test.accept', project)).toBe(false);
    expect(can(admin, 'disposal.approve', project)).toBe(false);
  });

  it('grants project authority only to that project’s Lead Project Engineer', () => {
    const pe = user({ userId: 'u-pe' });
    expect(can(pe, 'program.close', project)).toBe(true);
    expect(can(pe, 'test.accept', project)).toBe(true);
    expect(can(pe, 'disposal.approve', project)).toBe(true);
    // Without project context, or on another project, nothing project-scoped.
    expect(can(pe, 'program.close')).toBe(false);
    expect(can(pe, 'program.close', { leadProjectEngineerUserId: 'someone-else' })).toBe(false);
  });

  it('D04: a delegate may accept but not close, cancel or set priority', () => {
    const delegate = user({ userId: 'u-de' });
    expect(can(delegate, 'test.accept', project)).toBe(true);
    expect(can(delegate, 'program.close', project)).toBe(false);
    expect(can(delegate, 'test.cancel', project)).toBe(false);
    expect(can(delegate, 'program.priority.set', project)).toBe(false);
  });

  it('MM-T35: admins and the Lead Project Engineer edit a project; only admins change the Lead Project Engineer', () => {
    const admin = user({ userId: 'u-admin', roles: ['admin'] });
    const pe = user({ userId: 'u-pe' });
    const lm = user({ userId: 'u-lm', roles: ['lab_manager'] });
    const lab = user({ userId: 'u-pe', accountType: 'shared_lab', roles: ['admin'] });
    expect(can(admin, 'project.edit', project)).toBe(true);
    expect(can(admin, 'project.lead_project_engineer.change')).toBe(true);
    expect(can(pe, 'project.edit', project)).toBe(true);
    expect(can(pe, 'project.edit', { leadProjectEngineerUserId: 'someone-else' })).toBe(false);
    expect(can(pe, 'project.lead_project_engineer.change', project)).toBe(false);
    expect(can(user(), 'project.edit', project)).toBe(false);
    expect(can(user({ userId: 'u-de' }), 'project.edit', project)).toBe(false);
    expect(can(lm, 'project.edit', project)).toBe(false);
    expect(can(lab, 'project.edit', project)).toBe(false);
    expect(can(lab, 'project.lead_project_engineer.change')).toBe(false);
  });

  it('MM-T45: only Lab Managers and admins change the draft auto-delete setting', () => {
    expect(can(user({ roles: ['lab_manager'] }), 'settings.drafts.manage')).toBe(true);
    expect(can(user({ roles: ['admin'] }), 'settings.drafts.manage')).toBe(true);
    expect(can(user(), 'settings.drafts.manage')).toBe(false);
    expect(can(user({ userId: 'u-pe' }), 'settings.drafts.manage', project)).toBe(false);
    const lab = user({ accountType: 'shared_lab', roles: ['admin', 'lab_manager'] });
    expect(can(lab, 'settings.drafts.manage')).toBe(false);
  });

  it('MM-T37 T5: only admins and Lab Managers manage locations; everyone reads and prints', () => {
    expect(can(user({ roles: ['lab_manager'] }), 'location.manage')).toBe(true);
    expect(can(user({ roles: ['admin'] }), 'location.manage')).toBe(true);
    expect(can(user(), 'location.manage')).toBe(false);
    expect(can(user({ userId: 'u-pe' }), 'location.manage', project)).toBe(false);
    expect(can(user({ status: 'pending', roles: ['admin'] }), 'location.manage')).toBe(false);
    // LAB never manages locations, even with roles assigned by mistake.
    const lab = user({ accountType: 'shared_lab', roles: ['admin', 'lab_manager'] });
    expect(can(lab, 'location.manage')).toBe(false);
    expect(can(lab, 'inventory.read')).toBe(true);
    expect(can(lab, 'label.print')).toBe(true);
  });
});

describe('MM-AO03 assignments, scoped grants and effective sources', () => {
  const admin = user({ userId: 'u-admin', roles: ['admin'] });
  const lm = user({ userId: 'u-lm', roles: ['lab_manager'] });
  const lead = user({ userId: 'u-pe' });
  const issuer = user({ userId: 'u-is' });
  const withIssuer: ProjectContext = { ...project, reportIssuerUserIds: ['u-is'] };

  it('D04/D05: the lead or an admin manage team and reviewers; nobody else, never LAB', () => {
    for (const permission of ['project_team.manage', 'project_reviewer.manage'] as const) {
      expect(can(lead, permission, project)).toBe(true);
      expect(can(lead, permission, { leadProjectEngineerUserId: 'someone-else' })).toBe(false);
      expect(can(admin, permission)).toBe(true);
      expect(can(lm, permission, project)).toBe(false);
      expect(can(user({ userId: 'u-de' }), permission, project)).toBe(false);
      expect(can(user(), permission, project)).toBe(false);
      const lab = user({ userId: 'u-pe', accountType: 'shared_lab', roles: ['admin'] });
      expect(can(lab, permission, project)).toBe(false);
    }
  });

  it('D06/D07: only the lead grants issuers; the lead and a grant holder issue; admin never', () => {
    expect(can(lead, 'report_issuer.manage', project)).toBe(true);
    expect(can(admin, 'report_issuer.manage', project)).toBe(false);
    expect(can(issuer, 'report_issuer.manage', withIssuer)).toBe(false);
    expect(can(lead, 'report.issue', project)).toBe(true);
    expect(can(issuer, 'report.issue', withIssuer)).toBe(true);
    // AC2: the grant is for the project (and scope) the loader evaluated, nowhere else.
    expect(can(issuer, 'report.issue', project)).toBe(false);
    expect(can(issuer, 'report.issue')).toBe(false);
    expect(can(admin, 'report.issue', withIssuer)).toBe(false);
    expect(can(user({ userId: 'u-is', status: 'disabled' }), 'report.issue', withIssuer)).toBe(
      false,
    );
    // An issuer grant confers nothing else.
    for (const permission of ['test.accept', 'program.close', 'project.edit'] as const) {
      expect(can(issuer, permission, withIssuer)).toBe(false);
    }
  });

  it('D01/D05: reviewer eligibility and the create-and-lead capability are admin-only', () => {
    for (const permission of ['reviewer_eligibility.manage', 'staff_capability.manage'] as const) {
      expect(can(admin, permission)).toBe(true);
      expect(can(lm, permission)).toBe(false);
      expect(can(lead, permission, project)).toBe(false);
    }
  });

  it('reports every source, and can() is exactly "some source"', () => {
    const both = user({ userId: 'u-pe', roles: ['lab_manager', 'admin'] });
    expect(permissionSources(both, 'program.reopen', project)).toEqual([
      'lab_manager',
      'lead_project_engineer',
    ]);
    expect(permissionSources(both, 'project.edit', project)).toEqual([
      'admin',
      'lead_project_engineer',
    ]);
    expect(permissionSources(user({ userId: 'u-de' }), 'test.accept', project)).toEqual([
      'acceptance_delegate',
    ]);
    expect(permissionSources(user({ accountType: 'shared_lab' }), 'inventory.read')).toEqual([
      'lab',
    ]);
    expect(permissionSources(user({ status: 'pending' }), 'inventory.read')).toEqual([]);
    expect(possibleSources('test.accept')).toEqual([
      'lead_project_engineer',
      'acceptance_delegate',
    ]);
    expect(possibleSources('report.issue')).toEqual(['lead_project_engineer', 'report_issuer']);
    expect(possibleSources('report_issuer.manage')).toEqual(['lead_project_engineer']);
  });
});
