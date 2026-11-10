import { describe, expect, it } from 'vitest';
import {
  can,
  permissionSources,
  possibleSources,
  PENDING_OWNER_DECISION,
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

  it('MISC-04: Settings Locations, Tests and Templates management is admin and Lab Manager only', () => {
    const lab = user({ accountType: 'shared_lab', roles: ['admin', 'lab_manager'] });
    const matrix: [string, AuthUser, boolean][] = [
      ['admin', user({ roles: ['admin'] }), true],
      ['lab_manager', user({ roles: ['lab_manager'] }), true],
      ['technician', user(), false],
      ['LAB', lab, false],
    ];
    for (const [who, u, manages] of matrix) {
      expect(can(u, 'location.manage'), who).toBe(manages);
      expect(can(u, 'test_catalog.manage'), who).toBe(manages);
      // Reads used elsewhere (location pickers, the lab-program catalogue) and label printing
      // (the print-only Locations view, Kyle 2026-10-30) stay open to everyone.
      expect(can(u, 'inventory.read'), who).toBe(true);
      expect(can(u, 'label.print'), who).toBe(true);
      expect(can(u, 'lab_program.read'), who).toBe(true);
    }
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

describe('MM-AO08 concrete permission contract (planned; no route checks these yet)', () => {
  const lead = user({ userId: 'u-pe' });
  const admin = user({ userId: 'u-admin', roles: ['admin'] });
  const lm = user({ userId: 'u-lm', roles: ['lab_manager'] });
  const reviewer = user({ userId: 'u-rv' });
  const delegate = user({ userId: 'u-de' });
  const issuer = user({ userId: 'u-is' });
  const everyone: ProjectContext = {
    leadProjectEngineerUserId: 'u-pe',
    acceptanceDelegateUserIds: ['u-de'],
    reportIssuerUserIds: ['u-is'],
    designatedReviewerUserIds: ['u-rv'],
    concreteLabManagerUserIds: ['u-lm'],
  };
  const otherLead: ProjectContext = { ...everyone, leadProjectEngineerUserId: 'u-other' };
  const lab = user({ userId: 'u-pe', accountType: 'shared_lab', roles: ['admin', 'lab_manager'] });

  it('AC2: mixes are the destination lead’s alone: no admin, Lab Manager, reviewer, delegate or issuer', () => {
    for (const permission of ['concrete_mix.manage', 'concrete_mix.approve'] as const) {
      expect(permissionSources(lead, permission, everyone)).toEqual(['lead_project_engineer']);
      expect(can(lead, permission, otherLead)).toBe(false);
      expect(can(lead, permission)).toBe(false);
      for (const other of [admin, lm, reviewer, delegate, issuer, lab]) {
        expect(can(other, permission, everyone)).toBe(false);
      }
      expect(possibleSources(permission)).toEqual(['lead_project_engineer']);
    }
  });

  it('Q3: the lead always reviews concrete on their project; otherwise only a designated reviewer', () => {
    expect(permissionSources(lead, 'concrete.review', everyone)).toEqual(['lead_project_engineer']);
    expect(permissionSources(reviewer, 'concrete.review', everyone)).toEqual([
      'designated_reviewer',
    ]);
    // The reviewer list is for the scope the loader evaluated; elsewhere it confers nothing.
    expect(can(reviewer, 'concrete.review', { leadProjectEngineerUserId: 'u-pe' })).toBe(false);
    expect(can(reviewer, 'concrete.review')).toBe(false);
    for (const other of [admin, lm, delegate, issuer, lab, user()]) {
      expect(can(other, 'concrete.review', everyone)).toBe(false);
    }
    // Generic lab review is unchanged: any internal user, never LAB.
    expect(can(user(), 'test.review')).toBe(true);
    expect(possibleSources('concrete.review')).toEqual([
      'lead_project_engineer',
      'designated_reviewer',
    ]);
  });

  it('AC3: a failed-specimen schedule change is approved by the lead or a designated reviewer alone', () => {
    expect(can(lead, 'concrete_failure_schedule.approve', everyone)).toBe(true);
    expect(can(reviewer, 'concrete_failure_schedule.approve', everyone)).toBe(true);
    for (const other of [admin, lm, delegate, issuer, lab]) {
      expect(can(other, 'concrete_failure_schedule.approve', everyone)).toBe(false);
    }
    expect(possibleSources('concrete_failure_schedule.approve')).toEqual([
      'lead_project_engineer',
      'designated_reviewer',
    ]);
  });

  it('D13: a failed-specimen HOLD needs the lead, or the Lab Manager role AND the project’s concrete grant', () => {
    expect(permissionSources(lm, 'concrete_hold.manage', everyone)).toEqual([
      'concrete_lab_manager',
    ]);
    expect(can(lead, 'concrete_hold.manage', everyone)).toBe(true);
    // The role alone, or the grant alone, is not enough.
    expect(
      can(user({ userId: 'u-lm2', roles: ['lab_manager'] }), 'concrete_hold.manage', everyone),
    ).toBe(false);
    expect(can(user({ userId: 'u-lm' }), 'concrete_hold.manage', everyone)).toBe(false);
    for (const other of [admin, reviewer, delegate, issuer, lab]) {
      expect(can(other, 'concrete_hold.manage', everyone)).toBe(false);
    }
    // Separate from retention holds and tested-unit removal: the grant adds neither.
    expect(can(user({ userId: 'u-lm' }), 'retention.manage', everyone)).toBe(false);
    expect(
      permissionSources(
        user({ userId: 'u-lm', roles: ['lab_manager'] }),
        'retention.manage',
        everyone,
      ),
    ).toEqual(['lab_manager']);
  });

  it('AC2: delegates accept only and issuers issue only; neither gains concrete authority', () => {
    expect(can(delegate, 'test.accept', everyone)).toBe(true);
    expect(can(delegate, 'report.issue', everyone)).toBe(false);
    expect(can(issuer, 'report.issue', everyone)).toBe(true);
    expect(can(reviewer, 'report.issue', everyone)).toBe(false);
    expect(can(reviewer, 'test.accept', everyone)).toBe(false);
    // A designated reviewer gains nothing beyond review and the schedule approval.
    for (const permission of ['project.edit', 'program.close', 'concrete_mix.approve'] as const) {
      expect(can(reviewer, permission, everyone)).toBe(false);
    }
  });

  it('Q4: concrete settings use project.edit (lead or admin); admin still holds no mix authority', () => {
    expect(permissionSources(admin, 'project.edit', everyone)).toEqual(['admin']);
    expect(permissionSources(lead, 'project.edit', everyone)).toEqual(['lead_project_engineer']);
    expect(can(admin, 'concrete_mix.manage', everyone)).toBe(false);
  });

  it('T1 matrix: every concrete action for every kind of caller', () => {
    const callers = { lead, admin, lm, reviewer, delegate, issuer, lab, tech: user() };
    const expected: Record<string, (keyof typeof callers)[]> = {
      'concrete_mix.manage': ['lead'],
      'concrete_mix.approve': ['lead'],
      'concrete.review': ['lead', 'reviewer'],
      'concrete_failure_schedule.approve': ['lead', 'reviewer'],
      'concrete_hold.manage': ['lead', 'lm'],
      // Settings and the concrete Lab Manager grant (C02) reuse project.edit.
      'project.edit': ['lead', 'admin'],
    };
    for (const [permission, allowed] of Object.entries(expected)) {
      const actual = Object.entries(callers)
        .filter(([, caller]) => can(caller, permission as Permission, everyone))
        .map(([name]) => name);
      expect(actual, permission).toEqual(allowed);
    }
    // Inactive accounts hold none of it, whatever the project says.
    for (const status of ['pending', 'disabled'] as const) {
      for (const permission of Object.keys(expected)) {
        expect(can({ ...lead, status }, permission as Permission, everyone)).toBe(false);
      }
    }
  });
});

describe('MM-V2-C10 concrete contract extension (planned; no route checks these yet)', () => {
  const lead = user({ userId: 'u-pe' });
  const admin = user({ userId: 'u-admin', roles: ['admin'] });
  const lm = user({ userId: 'u-lm2', roles: ['lab_manager'] });
  const grantLm = user({ userId: 'u-lm', roles: ['lab_manager'] });
  const grantOnly = user({ userId: 'u-lm' });
  const reviewer = user({ userId: 'u-rv' });
  const delegate = user({ userId: 'u-de' });
  const issuer = user({ userId: 'u-is' });
  const technician = user({ userId: 'u-tc' });
  const internal = user({ userId: 'u-other' });
  // MM-V2-C36: the Lab Technician role alone.
  const labTech = user({ userId: 'u-lt', roles: ['lab_technician'] });
  // LAB with a selected staff member: its id may even equal the technician's, and a role may be
  // assigned by mistake. Selection is attribution only.
  const lab = user({ userId: 'u-tc', accountType: 'shared_lab', roles: ['admin', 'lab_manager'] });
  const ctx: ProjectContext = {
    leadProjectEngineerUserId: 'u-pe',
    acceptanceDelegateUserIds: ['u-de'],
    reportIssuerUserIds: ['u-is'],
    designatedReviewerUserIds: ['u-rv'],
    concreteLabManagerUserIds: ['u-lm'],
    recordTechnicianUserId: 'u-tc',
  };
  const callers = {
    lead,
    admin,
    lm,
    grantLm,
    grantOnly,
    reviewer,
    delegate,
    issuer,
    technician,
    internal,
    labTech,
    lab,
  };
  type Caller = keyof typeof callers;

  // The documented rule per row (docs/permissions.md "Concrete contract extension (MM-V2-C10)").
  const rows: Record<string, { allowed: Caller[]; sources: string[] }> = {
    'concrete_report.draft': {
      allowed: Object.keys(callers) as Caller[],
      sources: ['lab', 'internal'],
    },
    'concrete_report.recall': { allowed: ['technician'], sources: ['record_technician'] },
    'concrete_receiving_exception.resolve': {
      allowed: ['lead', 'grantLm', 'reviewer', 'technician'],
      sources: [
        'lead_project_engineer',
        'designated_reviewer',
        'concrete_lab_manager',
        'record_technician',
      ],
    },
    'concrete_sync_conflict.resolve_field': {
      allowed: ['technician'],
      sources: ['record_technician'],
    },
    // MM-V2-C36 (Kyle 2026-11-08): also any Lab Manager by role alone, no project grant.
    'concrete_sync_conflict.resolve_lab': {
      allowed: ['lead', 'reviewer', 'lm', 'grantLm'],
      sources: ['lab_manager', 'lead_project_engineer', 'designated_reviewer'],
    },
    'concrete_recovery.import': {
      allowed: ['lm', 'grantLm', 'technician'],
      sources: ['lab_manager', 'record_technician'],
    },
    'concrete_ordinary_hold.manage': {
      allowed: ['lead', 'lm', 'grantLm'],
      sources: ['lab_manager', 'lead_project_engineer'],
    },
    'concrete_set.void': {
      allowed: ['lead', 'grantLm', 'reviewer'],
      sources: ['lead_project_engineer', 'designated_reviewer', 'concrete_lab_manager'],
    },
    'concrete_specimen.reschedule': {
      allowed: ['lead', 'grantLm', 'reviewer'],
      sources: ['lead_project_engineer', 'designated_reviewer', 'concrete_lab_manager'],
    },
    'concrete_settings.curing_standard.manage': {
      allowed: ['admin', 'lm', 'grantLm'],
      sources: ['lab_manager', 'admin'],
    },
    'concrete_settings.testing_machine.manage': {
      allowed: ['lm', 'grantLm'],
      sources: ['lab_manager'],
    },
    'concrete_settings.attachment_limit.manage': { allowed: ['admin'], sources: ['admin'] },
    // MM-V2-C27, confirmed by MM-V2-C36: Lab Managers and Lab Technicians by role.
    'concrete_settings.air_meter.manage': {
      allowed: ['lm', 'grantLm', 'labTech'],
      sources: ['lab_manager', 'lab_technician'],
    },
    // MM-V2-C37 (Kyle 2026-11-08): suppliers by Lab Managers and admins; holidays by admins.
    'concrete_settings.supplier.manage': {
      allowed: ['admin', 'lm', 'grantLm'],
      sources: ['lab_manager', 'admin'],
    },
    'concrete_settings.holiday.manage': { allowed: ['admin'], sources: ['admin'] },
    // MM-V2-C32 (proposal): the report header by admins.
    'concrete_settings.report_header.manage': { allowed: ['admin'], sources: ['admin'] },
  };

  it('T1/AC1: every new row matches the documented rule for every kind of caller', () => {
    for (const [permission, { allowed, sources }] of Object.entries(rows)) {
      const actual = (Object.entries(callers) as [Caller, AuthUser][])
        .filter(([, caller]) => can(caller, permission as Permission, ctx))
        .map(([name]) => name);
      expect(actual.sort(), permission).toEqual([...allowed].sort());
      expect(possibleSources(permission as Permission), permission).toEqual(sources);
      // Inactive accounts hold none of it.
      for (const status of ['pending', 'disabled'] as const) {
        for (const caller of Object.values(callers)) {
          expect(can({ ...caller, status }, permission as Permission, ctx)).toBe(false);
        }
      }
    }
  });

  it('reports the exact source for each caller', () => {
    expect(permissionSources(technician, 'concrete_receiving_exception.resolve', ctx)).toEqual([
      'record_technician',
    ]);
    expect(permissionSources(grantLm, 'concrete_set.void', ctx)).toEqual(['concrete_lab_manager']);
    expect(permissionSources(grantLm, 'concrete_recovery.import', ctx)).toEqual(['lab_manager']);
    expect(permissionSources(lm, 'concrete_ordinary_hold.manage', ctx)).toEqual(['lab_manager']);
    expect(permissionSources(lab, 'concrete_report.draft', ctx)).toEqual(['lab']);
    const both = user({ userId: 'u-pe', roles: ['lab_manager'] });
    expect(permissionSources(both, 'concrete_ordinary_hold.manage', ctx)).toEqual([
      'lab_manager',
      'lead_project_engineer',
    ]);
  });

  it('AC2: a casting technician resolves only specimens they cast', () => {
    const otherSpecimen: ProjectContext = { ...ctx, recordTechnicianUserId: 'u-someone' };
    expect(can(technician, 'concrete_receiving_exception.resolve', ctx)).toBe(true);
    expect(can(technician, 'concrete_receiving_exception.resolve', otherSpecimen)).toBe(false);
    expect(
      can(technician, 'concrete_receiving_exception.resolve', {
        ...ctx,
        recordTechnicianUserId: null,
      }),
    ).toBe(false);
    // Without the record's facts, nothing record-scoped.
    for (const permission of [
      'concrete_report.recall',
      'concrete_receiving_exception.resolve',
      'concrete_sync_conflict.resolve_field',
      'concrete_recovery.import',
    ] as const) {
      expect(can(technician, permission), permission).toBe(false);
      expect(can(technician, permission, otherSpecimen), permission).toBe(false);
    }
  });

  it('AC2: being a record’s technician confers nothing else', () => {
    for (const permission of [
      'concrete_set.void',
      'concrete_specimen.reschedule',
      'concrete_sync_conflict.resolve_lab',
      'concrete_ordinary_hold.manage',
      'concrete_hold.manage',
      'concrete.review',
      'project.edit',
      'test.accept',
    ] as const) {
      expect(can(technician, permission, ctx), permission).toBe(false);
    }
  });

  it('AC3: LAB with a selected staff member is denied every personal-account action', () => {
    // LAB's id equals the record technician's here; a lead, reviewer or grant id must not help.
    const stations = [
      lab,
      user({ userId: 'u-pe', accountType: 'shared_lab', roles: ['admin', 'lab_manager'] }),
      user({ userId: 'u-rv', accountType: 'shared_lab' }),
      user({ userId: 'u-lm', accountType: 'shared_lab', roles: ['lab_manager'] }),
    ];
    for (const station of stations) {
      for (const permission of Object.keys(rows) as Permission[]) {
        expect(can(station, permission, ctx), `${station.userId} ${permission}`).toBe(
          permission === 'concrete_report.draft',
        );
      }
    }
  });

  it('project-scoped rows need that project: another lead, reviewer list or grant gives nothing', () => {
    const elsewhere: ProjectContext = { leadProjectEngineerUserId: 'u-other-lead' };
    for (const permission of [
      'concrete_receiving_exception.resolve',
      'concrete_set.void',
      'concrete_specimen.reschedule',
    ] as const) {
      for (const caller of [lead, reviewer, grantLm]) {
        expect(can(caller, permission, elsewhere), permission).toBe(false);
        expect(can(caller, permission), permission).toBe(false);
      }
    }
    // Lab-data sync conflicts: the lead and reviewer only on their project; a Lab Manager by role
    // anywhere (MM-V2-C36).
    for (const caller of [lead, reviewer]) {
      expect(can(caller, 'concrete_sync_conflict.resolve_lab', elsewhere)).toBe(false);
      expect(can(caller, 'concrete_sync_conflict.resolve_lab')).toBe(false);
    }
    expect(can(lm, 'concrete_sync_conflict.resolve_lab', elsewhere)).toBe(true);
    expect(can(lm, 'concrete_sync_conflict.resolve_lab')).toBe(true);
    // Ordinary HOLD: Lab Managers by role anywhere; the lead only on their project.
    expect(can(lm, 'concrete_ordinary_hold.manage')).toBe(true);
    expect(can(lead, 'concrete_ordinary_hold.manage', elsewhere)).toBe(false);
  });

  it('ordinary HOLD (role alone) stays separate from the failed-specimen HOLD (role + grant)', () => {
    expect(can(lm, 'concrete_ordinary_hold.manage', ctx)).toBe(true);
    expect(can(lm, 'concrete_hold.manage', ctx)).toBe(false);
    expect(can(grantLm, 'concrete_hold.manage', ctx)).toBe(true);
    // The grant without the role still gives nothing.
    expect(can(grantOnly, 'concrete_ordinary_hold.manage', ctx)).toBe(false);
    expect(can(grantOnly, 'concrete_set.void', ctx)).toBe(false);
    // Admin never holds concrete workflow authority.
    for (const permission of [
      'concrete_ordinary_hold.manage',
      'concrete_set.void',
      'concrete_recovery.import',
    ] as const) {
      expect(can(admin, permission, ctx), permission).toBe(false);
    }
  });

  it('no permission is still waiting for an owner decision (MM-V2-C36)', () => {
    expect([...PENDING_OWNER_DECISION]).toEqual([]);
    for (const permission of PENDING_OWNER_DECISION) {
      expect(possibleSources(permission), permission).toEqual([]);
    }
  });

  it('T2/AC4: AO08 rows are unchanged by the extension', () => {
    expect(possibleSources('concrete_hold.manage')).toEqual([
      'lead_project_engineer',
      'concrete_lab_manager',
    ]);
    expect(possibleSources('concrete.review')).toEqual([
      'lead_project_engineer',
      'designated_reviewer',
    ]);
    expect(possibleSources('concrete_mix.manage')).toEqual(['lead_project_engineer']);
    expect(possibleSources('project.create')).toEqual(['lab', 'internal']);
    expect(can(technician, 'concrete.review', ctx)).toBe(false);
  });
});

describe('MM-V2-C36 Lab Technician role and lab-staff permissions', () => {
  const LAB_STAFF: Permission[] = [
    'concrete_specimen.receive',
    'concrete_specimen.mass_correct',
    'concrete_test.enter',
    'concrete_specimen.dispose_record',
  ];
  const ctx: ProjectContext = {
    leadProjectEngineerUserId: 'u-pe',
    acceptanceDelegateUserIds: ['u-de'],
    reportIssuerUserIds: ['u-is'],
    designatedReviewerUserIds: ['u-rv'],
    concreteLabManagerUserIds: ['u-lm', 'u-lt'],
    recordTechnicianUserId: 'u-tc',
  };
  const labTech = user({ userId: 'u-lt', roles: ['lab_technician'] });
  const lm = user({ userId: 'u-lm2', roles: ['lab_manager'] });
  const internal = user({ userId: 'u-other' });
  const lab = user({ userId: 'u-lab', accountType: 'shared_lab' });

  it('every lab-staff row comes from LAB, the Lab Manager role and the Lab Technician role only', () => {
    for (const permission of LAB_STAFF) {
      expect(possibleSources(permission), permission).toEqual(
        permission === 'concrete_specimen.mass_correct'
          ? ['lab_manager', 'lab_technician']
          : ['lab', 'lab_manager', 'lab_technician'],
      );
    }
  });

  it('AC1: a Lab Technician holds the four lab actions; review and issue are refused', () => {
    for (const permission of LAB_STAFF) {
      expect(permissionSources(labTech, permission), permission).toEqual(['lab_technician']);
      expect(can(labTech, permission, ctx), permission).toBe(true);
    }
    for (const permission of [
      'concrete.review',
      'report.issue',
      'test.accept',
      'test.correction_done',
      'concrete_failure_schedule.approve',
      'concrete_hold.manage',
    ] as const) {
      expect(can(labTech, permission, ctx), permission).toBe(false);
    }
  });

  it('a Lab Technician is never treated as a Lab Manager, even if named in a concrete grant', () => {
    const lmOnly: Permission[] = [
      'test_catalog.manage',
      'program.priority.set',
      'program.reopen',
      'test.cancel',
      'retention.manage',
      'disposal.approve',
      'settings.drafts.manage',
      'location.manage',
      'action_item.reassign',
      'concrete_recovery.import',
      'concrete_ordinary_hold.manage',
      'concrete_settings.curing_standard.manage',
      'concrete_settings.testing_machine.manage',
      'concrete_sync_conflict.resolve_lab',
      'concrete_receiving_exception.resolve',
      'concrete_set.void',
      'concrete_specimen.reschedule',
      'staff.manage',
    ];
    for (const permission of lmOnly) {
      expect(can(labTech, permission, ctx), permission).toBe(false);
    }
    // The one Lab Manager-style setting the owner gave Lab Technicians.
    expect(permissionSources(labTech, 'concrete_settings.air_meter.manage')).toEqual([
      'lab_technician',
    ]);
    // Everything an ordinary internal user holds, the Lab Technician holds too.
    expect(can(labTech, 'test.review')).toBe(true);
    expect(can(labTech, 'concrete_report.draft')).toBe(true);
  });

  it('AC2: LAB holds the lab actions; attributing the selected person is the handler job', () => {
    for (const permission of LAB_STAFF.filter((p) => p !== 'concrete_specimen.mass_correct')) {
      expect(permissionSources(lab, permission), permission).toEqual(['lab']);
    }
    // CD-46: a mass correction needs a personal account, so LAB never holds (or advertises) it,
    // whoever the station selects. Receipt with its initial mass stays on LAB.
    expect(can(lab, 'concrete_specimen.mass_correct', ctx)).toBe(false);
    expect(can(lab, 'concrete_specimen.receive', ctx)).toBe(true);
    expect(can(labTech, 'concrete_specimen.mass_correct', ctx)).toBe(true);
    expect(can(lm, 'concrete_specimen.mass_correct', ctx)).toBe(true);
    // A role assigned to LAB by mistake still adds nothing.
    const labWithRole = user({
      userId: 'u-lt',
      accountType: 'shared_lab',
      roles: ['lab_technician', 'lab_manager'],
    });
    expect(can(labWithRole, 'concrete_settings.air_meter.manage')).toBe(false);
    expect(can(labWithRole, 'concrete_sync_conflict.resolve_lab', ctx)).toBe(false);
  });

  it('AC3: a Lab Manager without the project concrete grant resolves lab-data sync conflicts', () => {
    expect(permissionSources(lm, 'concrete_sync_conflict.resolve_lab', ctx)).toEqual([
      'lab_manager',
    ]);
    expect(can(lm, 'concrete_sync_conflict.resolve_lab')).toBe(true);
    for (const permission of LAB_STAFF) {
      expect(permissionSources(lm, permission), permission).toEqual(['lab_manager']);
    }
  });

  it('AC4: a plain internal user (any position) is refused the lab actions', () => {
    for (const permission of [...LAB_STAFF, 'concrete_settings.air_meter.manage'] as const) {
      expect(can(internal, permission, ctx), permission).toBe(false);
      expect(can(internal, permission), permission).toBe(false);
    }
    // The project's lead and an admin get nothing from their authority either.
    for (const caller of [user({ userId: 'u-pe' }), user({ userId: 'u-a', roles: ['admin'] })]) {
      for (const permission of LAB_STAFF) {
        expect(can(caller, permission, ctx), permission).toBe(false);
      }
    }
  });

  it('inactive Lab Technicians hold nothing', () => {
    for (const status of ['pending', 'disabled'] as const) {
      for (const permission of LAB_STAFF) {
        expect(can({ ...labTech, status }, permission)).toBe(false);
      }
    }
  });
});
