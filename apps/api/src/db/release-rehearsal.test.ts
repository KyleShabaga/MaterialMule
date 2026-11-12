import { readFile } from 'node:fs/promises';
import type { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  permissionSources,
  type AccountStatus,
  type AccountType,
  type AuthUser,
  type Permission,
  type ProjectContext,
  type Role,
} from '../auth/policy.js';
import { projectContext } from '../project-access/project-access.service.js';
import { createTestSchema, testDatabaseUrl, type TestSchema } from '../test-support/database.js';
import { migrate, readMigrations, type MigrationFile } from './migrator.js';
import { runSeed } from './seed.js';

// MM-AO09 migration rehearsal. A database built at the 0001 baseline is loaded with fictional
// access data of every kind the overhaul touches (roles, a disabled admin, the retired review
// engineer field, a delegation granted before reasons were required, reviewer eligibility and
// assignment, live and expired report issuer grants, a team member, a staff capability, and open
// action items, one assigned to someone who has since lost the role). Every effective permission
// and every inbox route is recorded, the remaining migrations are applied, and both are recorded
// again. The comparison must match the documented exceptions exactly: nobody gains or loses a
// permission, and only the lapsed assignment changes inbox (D10, 0004). Results are written up in
// docs/operations/accounts-overhaul-release.md.

const U = {
  lab: '00000000-0000-4000-8000-000000000001',
  pat: '00000000-0000-4000-8000-000000000101',
  admin: '00000000-0000-4000-8000-000000000103',
  labManager: '00000000-0000-4000-8000-000000000104',
  dana: '00000000-0000-4000-8000-000000000105',
  jordan: '00000000-0000-4000-8000-000000000106',
  jamie: '00000000-0000-4000-8000-000000000107',
  former: '00000000-0000-4000-8000-000000000910',
};
const DEMO_2601 = '00000000-0000-4000-8000-000000000201';
const DEMO_2602 = '00000000-0000-4000-8000-000000000202';
const LAPSED_ITEM = '00000000-0000-4000-8000-000000000921';
const LEAD_ITEM = '00000000-0000-4000-8000-000000000922';
const LEGACY_DELEGATION = '00000000-0000-4000-8000-000000000931';

/** Every Permission, read from the union in policy.ts so a new permission is covered unasked. */
async function allPermissions(): Promise<Permission[]> {
  const source = (await readFile(new URL('../auth/policy.ts', import.meta.url), 'utf8')).replace(
    /\/\/.*$/gm,
    '',
  );
  const union = /export type Permission =([^;]+);/.exec(source)![1]!;
  return [...union.matchAll(/'([a-z_.]+)'/g)].map((match) => match[1] as Permission);
}

/** Fictional access data, written against the 0001 baseline schema. */
const LEGACY_ACCESS_FIXTURES = `
INSERT INTO app_user (id, display_name, given_name, surname, official_initials, account_type,
                      status, disabled_reason)
VALUES ('${U.former}', 'Morgan Former', 'Morgan', 'Former', 'MF', 'test', 'disabled',
        'Left the firm (fictional)');
INSERT INTO role_assignment (user_id, role)
VALUES ('${U.former}', 'admin'), ('${U.jordan}', 'lab_manager');

-- The retired single review engineer field (0002 drops it; it never granted anything).
UPDATE project SET review_engineer_user_id = '${U.dana}' WHERE id = '${DEMO_2601}';

-- Granted before reasons were required (D15): kept without one.
INSERT INTO acceptance_delegation (id, project_id, delegate_user_id, delegate_name_snapshot,
  granted_by_user_id, granted_by_name_snapshot, grant_idempotency_key, grant_request_hash)
VALUES ('${LEGACY_DELEGATION}', '${DEMO_2601}', '${U.dana}', 'Dana Example', '${U.pat}',
        'Pat Example', gen_random_uuid(), 'rehearsal');

INSERT INTO reviewer_eligibility (user_id, user_name_snapshot, scope_code, granted_by_user_id,
  granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
VALUES ('${U.dana}', 'Dana Example', 'concrete_field', '${U.admin}', 'Admin (test)',
        'Rehearsal: field review experience', gen_random_uuid(), 'rehearsal');
INSERT INTO project_reviewer_assignment (project_id, reviewer_user_id, reviewer_name_snapshot,
  scope_code, assigned_by_user_id, assigned_by_name_snapshot, assign_reason,
  assign_idempotency_key, assign_request_hash)
VALUES ('${DEMO_2601}', '${U.dana}', 'Dana Example', 'concrete_field', '${U.pat}', 'Pat Example',
        'Rehearsal: reviews field reports', gen_random_uuid(), 'rehearsal');

INSERT INTO project_report_issuer_grant (project_id, issuer_user_id, issuer_name_snapshot,
  report_scope_code, granted_by_user_id, granted_by_name_snapshot, granted_at, grant_reason,
  expires_at, grant_idempotency_key, grant_request_hash)
VALUES
  ('${DEMO_2601}', '${U.dana}', 'Dana Example', 'concrete_field', '${U.admin}', 'Admin (test)',
   now(), 'Rehearsal: issues field reports', NULL, gen_random_uuid(), 'rehearsal'),
  ('${DEMO_2601}', '${U.jamie}', 'Jamie Song', 'concrete_strength', '${U.admin}', 'Admin (test)',
   '2026-01-01', 'Rehearsal: expired grant', '2026-02-01', gen_random_uuid(), 'rehearsal');

INSERT INTO project_team_member (project_id, user_id, user_name_snapshot, added_by_user_id,
  added_by_name_snapshot, add_reason, add_idempotency_key, add_request_hash)
VALUES ('${DEMO_2602}', '${U.jamie}', 'Jamie Song', '${U.pat}', 'Pat Example',
        'Rehearsal: supporting engineer', gen_random_uuid(), 'rehearsal');
INSERT INTO staff_capability_grant (user_id, user_name_snapshot, capability, granted_by_user_id,
  granted_by_name_snapshot, grant_reason, grant_idempotency_key, grant_request_hash)
VALUES ('${U.jamie}', 'Jamie Song', 'project.create_and_lead', '${U.admin}', 'Admin (test)',
        'Rehearsal: may create and lead projects', gen_random_uuid(), 'rehearsal');

-- Open retention requests: one assigned to Jordan while a Lab Manager, one on its ordinary route.
INSERT INTO action_item (id, kind, target_role, entity_type, entity_id, project_id,
  created_by_user_id, reason, created_by_name_snapshot, idempotency_key, request_hash,
  assigned_user_id, assigned_at)
VALUES
  ('${LAPSED_ITEM}', 'retention_request', 'lab_manager', 'retention_request', gen_random_uuid(),
   '${DEMO_2601}', '${U.pat}', 'Rehearsal: keep TH26-01 longer', 'Pat Example', gen_random_uuid(),
   'rehearsal', '${U.jordan}', now()),
  ('${LEAD_ITEM}', 'retention_request', 'lab_manager', 'retention_request', gen_random_uuid(),
   '${DEMO_2602}', '${U.pat}', 'Rehearsal: keep bridge material', 'Pat Example',
   gen_random_uuid(), 'rehearsal', NULL, NULL);
INSERT INTO action_item_assignment (action_item_id, to_user_id, to_name_snapshot, reason,
  assigned_by_user_id, assigned_by_name_snapshot, idempotency_key, request_hash)
VALUES ('${LAPSED_ITEM}', '${U.jordan}', 'Jordan Smith', 'Rehearsal: Jordan handles this one',
        '${U.labManager}', 'Lab (test)', gen_random_uuid(), 'rehearsal');

-- Jordan later stops being a Lab Manager; the assignment still names them.
DELETE FROM role_assignment WHERE user_id = '${U.jordan}' AND role = 'lab_manager';
`;

// Review fix #97: the before/after comparison uses the same policy code for both snapshots, so
// a wrong grant in the policy itself shows up in both and still compares equal. This reviewed,
// frozen matrix is the independent expectation for the fixture: every grant, written out by
// person, source, project context and permission. Both snapshots must equal it exactly. When the
// policy deliberately changes (a new permission, a role gains or loses one), update this list in
// the same change and have it reviewed; the test failure lists the lines that differ.
const ALL_CONTEXTS = [
  '-',
  'DEMO-2601',
  'DEMO-2601/concrete_field',
  'DEMO-2601/concrete_strength',
  'DEMO-2602',
  'DEMO-2602/concrete_field',
  'DEMO-2602/concrete_strength',
];
const PROJECT_CONTEXTS = ALL_CONTEXTS.filter((context) => context !== '-');
const ALEX = '00000000-0000-4000-8000-000000000102';
const TAYLOR = '00000000-0000-4000-8000-000000000110';

/** Every signed-in staff account (source `internal`), whatever its role, in every context. */
const INTERNAL_PERMISSIONS = [
  'acceptance_delegation.read',
  'action_item.read',
  'concrete_report.draft',
  'inventory.read',
  'lab_comment.write',
  'lab_program.amend',
  'lab_program.manage',
  'lab_program.read',
  'label.print',
  'location_conflict.resolve',
  'notification.read',
  // Strata 1C: one's own sidebar layout, pins, recents, preferences and columns.
  'personal_settings.manage',
  'program.close_request',
  'project.create',
  'project_access.read',
  'project_lead.nominate',
  'receipt.confirm',
  'receipt.draft',
  'retention.request',
  'storage_unit.correct',
  'storage_unit.dispose_scan',
  'storage_unit.move',
  'storage_unit.tested_removal',
  'test.cancel_request',
  'test.progress',
  'test.review',
  'test_hole.create',
];

interface ExpectedGrant {
  users: string[];
  source: string;
  contexts: string[];
  permissions: string[];
}

const EXPECTED_GRANTS: ExpectedGrant[] = [
  {
    // The shared LAB account: lab work only.
    users: [U.lab],
    source: 'lab',
    contexts: ALL_CONTEXTS,
    permissions: [
      'concrete_report.draft',
      'concrete_specimen.dispose_record',
      'concrete_specimen.receive',
      'concrete_test.enter',
      'inventory.read',
      'lab_comment.write',
      'lab_program.manage',
      'lab_program.read',
      'label.print',
      'project.create',
      'receipt.confirm',
      'receipt.draft',
      'storage_unit.move',
      'test.progress',
      'test_hole.create',
    ],
  },
  {
    // Every active staff account. Not the disabled former admin (U.former): nothing at all.
    users: [U.pat, ALEX, U.admin, U.labManager, U.dana, U.jordan, U.jamie, TAYLOR],
    source: 'internal',
    contexts: ALL_CONTEXTS,
    permissions: INTERNAL_PERMISSIONS,
  },
  {
    // Pat leads DEMO-2601 and DEMO-2602: project authority there, never outside a project.
    users: [U.pat],
    source: 'lead_project_engineer',
    contexts: PROJECT_CONTEXTS,
    permissions: [
      'acceptance_delegation.manage',
      'concrete.review',
      'concrete_failure_schedule.approve',
      'concrete_hold.manage',
      'concrete_mix.approve',
      'concrete_mix.manage',
      'concrete_ordinary_hold.manage',
      'concrete_receiving_exception.resolve',
      'concrete_set.void',
      'concrete_specimen.reschedule',
      'concrete_sync_conflict.resolve_lab',
      'disposal.approve',
      'program.close',
      'program.priority.set',
      'program.reopen',
      'project.edit',
      'project_review.approve',
      'project_reviewer.manage',
      'project_team.manage',
      'report.issue',
      'report_issuer.manage',
      'retention.manage',
      'test.accept',
      'test.cancel',
    ],
  },
  {
    // The admin role: administration, and no concrete project authority (docs/permissions.md).
    users: [U.admin],
    source: 'admin',
    contexts: ALL_CONTEXTS,
    permissions: [
      'action_item.reassign',
      'concrete_settings.attachment_limit.manage',
      'concrete_settings.curing_standard.manage',
      'concrete_settings.holiday.manage',
      'concrete_settings.report_header.manage',
      'concrete_settings.supplier.manage',
      'location.manage',
      'printer.manage',
      'project.edit',
      'project.lead_project_engineer.change',
      'project_reviewer.manage',
      'project_team.manage',
      'reviewer_eligibility.manage',
      'session.revoke',
      'settings.drafts.manage',
      'staff.manage',
      'staff_capability.manage',
      'system.status.read',
      'test_catalog.manage',
    ],
  },
  {
    // The Lab Manager role (Lab (test)); Jordan lost it, so Jordan has none of these.
    users: [U.labManager],
    source: 'lab_manager',
    contexts: ALL_CONTEXTS,
    permissions: [
      'action_item.reassign',
      'concrete_ordinary_hold.manage',
      'concrete_recovery.import',
      'concrete_settings.air_meter.manage',
      'concrete_settings.curing_standard.manage',
      'concrete_settings.supplier.manage',
      'concrete_settings.testing_machine.manage',
      'concrete_specimen.dispose_record',
      'concrete_specimen.mass_correct',
      'concrete_specimen.receive',
      'concrete_sync_conflict.resolve_lab',
      'concrete_test.enter',
      'disposal.approve',
      'location.manage',
      'program.priority.set',
      'program.reopen',
      'retention.manage',
      'settings.drafts.manage',
      'test.cancel',
      'test.correction_done',
      'test_catalog.manage',
    ],
  },
  {
    // Dana's pre-reason delegation on DEMO-2601 only.
    users: [U.dana],
    source: 'acceptance_delegate',
    contexts: ['DEMO-2601', 'DEMO-2601/concrete_field', 'DEMO-2601/concrete_strength'],
    permissions: ['test.accept'],
  },
  {
    // Dana's live issuer grant: field reports on DEMO-2601 only. Jamie's expired grant: nothing.
    users: [U.dana],
    source: 'report_issuer',
    contexts: ['DEMO-2601/concrete_field'],
    permissions: ['report.issue'],
  },
];

/** The frozen matrix as effectiveRights lines (sources of one grant joined), sorted. */
function expectedRights(grants: ExpectedGrant[] = EXPECTED_GRANTS): string[] {
  const sources = new Map<string, string[]>();
  for (const grant of grants) {
    for (const user of grant.users) {
      for (const permission of grant.permissions) {
        for (const context of grant.contexts) {
          const key = `${user} ${permission} ${context}`;
          sources.set(key, [...(sources.get(key) ?? []), grant.source]);
        }
      }
    }
  }
  return [...sources].map(([key, list]) => `${key} ${list.sort().join(',')}`).sort();
}

/** What the release gate rejects: lines granted but not expected, and expected but missing. */
function matrixDifferences(actual: string[], expected: string[]) {
  return {
    unexpected: actual.filter((line) => !expected.includes(line)).sort(),
    missing: expected.filter((line) => !actual.includes(line)).sort(),
  };
}

/** One line per granted (person, permission, project, report scope) with its sources. */
async function effectiveRights(pool: Pool, permissions: Permission[]): Promise<string[]> {
  const { rows: users } = await pool.query<{
    id: string;
    account_type: AccountType;
    status: AccountStatus;
    roles: Role[];
  }>(
    `SELECT u.id, u.account_type, u.status,
            coalesce(array_agg(r.role ORDER BY r.role) FILTER (WHERE r.role IS NOT NULL), '{}')
              AS roles
     FROM app_user u LEFT JOIN role_assignment r ON r.user_id = u.id
     GROUP BY u.id ORDER BY u.id`,
  );
  const { rows: projects } = await pool.query<{
    id: string;
    lead_project_engineer_user_id: string | null;
    project_number: string;
  }>('SELECT id, lead_project_engineer_user_id, project_number FROM project ORDER BY id');
  const { rows: scopes } = await pool.query<{ code: string }>(
    'SELECT code FROM review_scope ORDER BY code',
  );
  const contexts: { label: string; context?: ProjectContext }[] = [{ label: '-' }];
  for (const project of projects) {
    for (const scope of [undefined, ...scopes.map((row) => row.code)]) {
      contexts.push({
        label: `${project.project_number}${scope ? `/${scope}` : ''}`,
        context: await projectContext(pool, project, scope),
      });
    }
  }
  const lines: string[] = [];
  for (const row of users) {
    const user: AuthUser = {
      userId: row.id,
      sessionId: 'rehearsal',
      accountType: row.account_type,
      status: row.status,
      roles: row.roles,
      displayName: row.id,
      initials: null,
    };
    for (const permission of permissions) {
      for (const { label, context } of contexts) {
        const sources = permissionSources(user, permission, context);
        if (sources.length > 0) {
          lines.push(`${row.id} ${permission} ${label} ${[...sources].sort().join(',')}`);
        }
      }
    }
  }
  return lines;
}

/** Who has each open item in their inbox: active personal and test accounts only (D10). */
async function inboxRoutes(pool: Pool): Promise<string[]> {
  const { rows } = await pool.query<{ route: string }>(
    `SELECT a.id || ' ' || u.id AS route
     FROM action_item a CROSS JOIN app_user u
     WHERE a.status = 'open' AND u.status = 'active' AND u.account_type IN ('personal', 'test')
       AND action_item_routed_to(a.id, u.id)
     ORDER BY 1`,
  );
  return rows.map((row) => row.route);
}

/** Row counts of the tables whose history the upgrade must keep. */
async function historyCounts(pool: Pool): Promise<Record<string, number>> {
  const tables = [
    'app_user',
    'role_assignment',
    'audit_event',
    'project',
    'storage_unit',
    'acceptance_delegation',
    'reviewer_eligibility',
    'project_reviewer_assignment',
    'project_report_issuer_grant',
    'project_team_member',
    'staff_capability_grant',
    'action_item',
    'action_item_assignment',
  ];
  const counts: Record<string, number> = {};
  for (const table of tables) {
    const { rows } = await pool.query<{ n: number }>(`SELECT count(*)::int AS n FROM ${table}`);
    counts[table] = rows[0]!.n;
  }
  return counts;
}

describe.runIf(testDatabaseUrl)('release rehearsal: 0001 baseline to latest (MM-AO09)', () => {
  let db: TestSchema;
  let files: MigrationFile[];
  let permissions: Permission[];
  let before: { rights: string[]; routes: string[]; counts: Record<string, number> };
  let after: typeof before;
  let storageUnitIds: string[];
  let applied: string[];

  beforeAll(async () => {
    files = await readMigrations();
    permissions = await allPermissions();
    db = await createTestSchema();
    await migrate(
      db.pool,
      files.filter((file) => file.version === '0001'),
    );
    await runSeed(db.pool, 'reference', 'test');
    // The dev seed follows the latest schema. The 0001 baseline has no Technologist position
    // (MISC-06, migration 0012), so the one Technologist fixture starts there as a Technician.
    const devSeed = await readFile(new URL('../../seed/dev.sql', import.meta.url), 'utf8');
    await db.pool.query(devSeed.replaceAll("'technologist'", "'technician'"));
    await db.pool.query(LEGACY_ACCESS_FIXTURES);
    before = {
      rights: await effectiveRights(db.pool, permissions),
      routes: await inboxRoutes(db.pool),
      counts: await historyCounts(db.pool),
    };
    storageUnitIds = (
      await db.pool.query<{ readable_id: string }>(
        'SELECT readable_id FROM storage_unit ORDER BY id',
      )
    ).rows.map((row) => row.readable_id);

    applied = (await migrate(db.pool, files)).applied;
    after = {
      rights: await effectiveRights(db.pool, permissions),
      routes: await inboxRoutes(db.pool),
      counts: await historyCounts(db.pool),
    };
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('applies every later migration in order', () => {
    expect(permissions.length).toBeGreaterThan(50);
    expect(applied).toEqual(
      files.filter((file) => file.version !== '0001').map((f) => `${f.version}_${f.name}`),
    );
  });

  it('exercises every kind of access the overhaul touches', () => {
    const has = (user: string, permission: string, label: string, source: string) =>
      before.rights.some((line) => line === `${user} ${permission} ${label} ${source}`);
    expect(has(U.pat, 'project.edit', 'DEMO-2601', 'lead_project_engineer')).toBe(true);
    expect(has(U.dana, 'test.accept', 'DEMO-2601', 'acceptance_delegate')).toBe(true);
    expect(has(U.dana, 'report.issue', 'DEMO-2601/concrete_field', 'report_issuer')).toBe(true);
    expect(has(U.labManager, 'retention.manage', '-', 'lab_manager')).toBe(true);
    expect(has(U.admin, 'staff.manage', '-', 'admin')).toBe(true);
    expect(before.rights.some((line) => line.startsWith(`${U.lab} receipt.confirm - lab`))).toBe(
      true,
    );
  });

  it('gives nobody a permission they did not have and takes none away', () => {
    // Guarantee: the SQL migrations change no one's access (both snapshots use the same policy).
    expect(after.rights).toEqual(before.rights);
  });

  it('#97: matches the reviewed, frozen access matrix before and after the upgrade', () => {
    // Guarantee: the access itself is what was reviewed, independent of the policy code under
    // test. Each list names the lines that differ; nothing may be unexpected or missing.
    const expected = expectedRights();
    expect(matrixDifferences(before.rights, expected)).toEqual({ unexpected: [], missing: [] });
    expect(matrixDifferences(after.rights, expected)).toEqual({ unexpected: [], missing: [] });
  });

  it('#97: the gate rejects a grant that is wrong in both snapshots alike', () => {
    // An extra admin source for Pat's staff.manage, injected into both snapshots: before = after
    // still holds, so only the frozen matrix catches it.
    const injected = `${U.pat} staff.manage - admin`;
    const wrongBefore = [...before.rights, injected];
    const wrongAfter = [...after.rights, injected];
    expect(wrongAfter).toEqual(wrongBefore);
    expect(matrixDifferences(wrongAfter, expectedRights()).unexpected).toEqual([injected]);

    // An expected source lost in both: Dana's acceptance delegation.
    const lost = (rights: string[]) =>
      rights.filter((line) => !(line.startsWith(U.dana) && line.endsWith(' acceptance_delegate')));
    expect(lost(after.rights)).toEqual(lost(before.rights));
    expect(matrixDifferences(lost(after.rights), expectedRights()).missing).toEqual([
      `${U.dana} test.accept DEMO-2601 acceptance_delegate`,
      `${U.dana} test.accept DEMO-2601/concrete_field acceptance_delegate`,
      `${U.dana} test.accept DEMO-2601/concrete_strength acceptance_delegate`,
    ]);
  });

  it('grants nothing through the exceptions the upgrade accounts for', () => {
    const rightsOf = (user: string) => after.rights.filter((line) => line.startsWith(user));
    // Disabled admin: nothing, before and after.
    expect(rightsOf(U.former)).toEqual([]);
    // The retired review engineer field and reviewer assignment grant Dana nothing beyond the
    // delegation and issuer grant; the expired issuer grant gives Jamie no report.issue.
    expect(rightsOf(U.jamie).some((line) => line.includes(' report.issue '))).toBe(false);
    // Team membership and the staff capability are responsibilities, not project authority.
    expect(rightsOf(U.jamie).some((line) => line.includes('lead_project_engineer'))).toBe(false);
    // Jordan lost the Lab Manager role: no lab_manager source remains.
    expect(rightsOf(U.jordan).some((line) => line.endsWith('lab_manager'))).toBe(false);
  });

  it('changes inboxes only for the lapsed assignment (D10)', () => {
    const removed = before.routes.filter((route) => !after.routes.includes(route));
    const added = after.routes.filter((route) => !before.routes.includes(route));
    expect(removed).toEqual([`${LAPSED_ITEM} ${U.jordan}`]);
    // Ordinary routing for a retention request: every Lab Manager and the project's lead.
    expect(added.sort()).toEqual(
      [`${LAPSED_ITEM} ${U.pat}`, `${LAPSED_ITEM} ${U.labManager}`].sort(),
    );
    expect(after.routes).toContain(`${LEAD_ITEM} ${U.pat}`);
  });

  it('MM-T91 (0014): gives everyone an open item waits on one unread "opened" notification', async () => {
    const { rows } = await db.pool.query<{ route: string }>(
      `SELECT action_item_id || ' ' || recipient_user_id AS route FROM notification
       WHERE kind = 'action_request.opened' AND read_at IS NULL AND dismissed_at IS NULL
       ORDER BY 1`,
    );
    expect(rows.map((row) => row.route)).toEqual(after.routes);
    const { rows: others } = await db.pool.query(
      `SELECT 1 FROM notification WHERE kind <> 'action_request.opened'`,
    );
    expect(others).toEqual([]);
  });

  it('keeps history, stable IDs and the recorded assignment', async () => {
    // MISC-08 (owner decision): 0013 records the one eligible legacy reviewer assignment as the
    // lead's approval, with one migration audit event; nothing else is added.
    expect(after.counts).toEqual({ ...before.counts, audit_event: before.counts.audit_event! + 1 });
    const { rows: units } = await db.pool.query<{ readable_id: string }>(
      'SELECT readable_id FROM storage_unit ORDER BY id',
    );
    expect(units.map((row) => row.readable_id)).toEqual(storageUnitIds);
    const { rows: items } = await db.pool.query(
      `SELECT assigned_user_id, action_item_has_recipient(id) AS has_recipient
       FROM action_item WHERE id = $1`,
      [LAPSED_ITEM],
    );
    expect(items[0]).toEqual({ assigned_user_id: U.jordan, has_recipient: true });
  });

  it('keeps the pre-reason delegation, revocable only with a reason; new grants need one', async () => {
    const { rows } = await db.pool.query(
      'SELECT grant_reason FROM acceptance_delegation WHERE id = $1',
      [LEGACY_DELEGATION],
    );
    expect(rows[0]).toEqual({ grant_reason: null });
    await expect(
      db.pool.query(
        `INSERT INTO acceptance_delegation (project_id, delegate_user_id, delegate_name_snapshot,
           granted_by_user_id, granted_by_name_snapshot, grant_idempotency_key, grant_request_hash)
         VALUES ($1, $2, 'Jamie Song', $3, 'Pat Example', gen_random_uuid(), 'rehearsal')`,
        [DEMO_2601, U.jamie, U.pat],
      ),
    ).rejects.toMatchObject({ constraint: 'acceptance_delegation_grant_reason_required' });
    const revoke = `UPDATE acceptance_delegation
       SET revoked_at = now(), revoked_by_user_id = $2, revoked_by_name_snapshot = 'Pat Example',
           revoke_reason = $3
       WHERE id = $1`;
    await expect(db.pool.query(revoke, [LEGACY_DELEGATION, U.pat, null])).rejects.toMatchObject({
      constraint: 'acceptance_delegation_revoke_reason_required',
    });
    await db.pool.query(revoke, [LEGACY_DELEGATION, U.pat, 'Rehearsal: delegation ended']);
  });

  it('drops the retired review engineer field', async () => {
    const { rows } = await db.pool.query(
      `SELECT count(*)::int AS n FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'project'
         AND column_name = 'review_engineer_user_id'`,
    );
    expect(rows[0]).toEqual({ n: 0 });
  });
});
