import { describe, expect, it } from 'vitest';
import { can, type AuthUser, type Permission, type ProjectContext } from './policy.js';

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

const project: ProjectContext = { pmPeUserId: 'u-pe', acceptanceDelegateUserIds: ['u-de'] };

const LAB_ALLOWED: Permission[] = [
  'receipt.confirm',
  'receipt.draft',
  'project.create',
  'test_hole.create',
  'inventory.read',
  'label.print',
  'storage_unit.move',
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
      'lab_program.manage',
      'storage_unit.dispose_scan',
      'staff.manage',
      'disposal.approve',
    ] as Permission[]) {
      expect(can(lab, permission), permission).toBe(false);
    }
  });

  it('gives LAB no extra authority even if it was assigned a role or made PM/PE', () => {
    const lab = user({
      userId: 'u-lab',
      accountType: 'shared_lab',
      roles: ['admin', 'lab_manager'],
    });
    expect(can(lab, 'staff.manage')).toBe(false);
    expect(can(lab, 'program.close', { pmPeUserId: 'u-lab' })).toBe(false);
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
    expect(can(admin, 'program.close', project)).toBe(false);
    expect(can(admin, 'test.accept', project)).toBe(false);
    expect(can(admin, 'disposal.approve', project)).toBe(false);
  });

  it('grants project authority only to that project’s PM/PE', () => {
    const pe = user({ userId: 'u-pe' });
    expect(can(pe, 'program.close', project)).toBe(true);
    expect(can(pe, 'test.accept', project)).toBe(true);
    expect(can(pe, 'disposal.approve', project)).toBe(true);
    // Without project context, or on another project, nothing project-scoped.
    expect(can(pe, 'program.close')).toBe(false);
    expect(can(pe, 'program.close', { pmPeUserId: 'someone-else' })).toBe(false);
  });

  it('D04: a delegate may accept but not close, cancel or set priority', () => {
    const delegate = user({ userId: 'u-de' });
    expect(can(delegate, 'test.accept', project)).toBe(true);
    expect(can(delegate, 'program.close', project)).toBe(false);
    expect(can(delegate, 'test.cancel', project)).toBe(false);
    expect(can(delegate, 'program.priority.set', project)).toBe(false);
  });
});
