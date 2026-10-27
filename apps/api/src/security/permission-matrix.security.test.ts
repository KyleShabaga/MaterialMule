import { readFileSync } from 'node:fs';
import { RequestMethod, type INestApplication } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { DiscoveryService, MetadataScanner, Reflector } from '@nestjs/core';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ROUTE_POLICY, type RoutePolicy } from '../auth/auth.decorators.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { can, type AuthUser, type Permission } from '../auth/policy.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { runSeed } from '../db/seed.js';
import { enqueuePrintJob } from '../printing/print-queue.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { FakeZebraPrinter } from '../test-support/fake-zebra.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  receivingLabId,
} from '../test-support/fixtures.js';

// TRP-T18 security sweep (card test T2, AC4). Every route the API serves is called as five kinds
// of caller — nobody, a pending account, a disabled account, the shared LAB account and an
// ordinary Technician — and the outcome is compared with the permission matrix in
// docs/permissions.md (TRP-T04), not with policy.ts, so the code and the agreed matrix can't
// drift apart unnoticed. Every refused call must leave every table exactly as it was.
// Run on its own with `npm run test:security`. Fictional data only.

const LAB_ID = '00000000-0000-4000-8000-000000000001';

type MatrixColumn = 'lab' | 'internal' | 'labManager' | 'admin' | 'pmPe' | 'delegate';
const COLUMNS: MatrixColumn[] = ['lab', 'internal', 'labManager', 'admin', 'pmPe', 'delegate'];

/** The "Matrix" table of docs/permissions.md: permission → columns ticked. */
function readDocumentedMatrix(): Map<string, Set<MatrixColumn>> {
  const markdown = readFileSync(
    new URL('../../../../docs/permissions.md', import.meta.url),
    'utf8',
  );
  const section = markdown.split(/^## Matrix\s*$/m)[1]?.split(/^## /m)[0];
  if (!section) throw new Error('docs/permissions.md has no "## Matrix" section');
  const matrix = new Map<string, Set<MatrixColumn>>();
  for (const line of section.split(/\r?\n/)) {
    if (!line.startsWith('|') || /^\|\s*(Permission|-)/.test(line)) continue;
    const cells = line.split('|').slice(1, -1);
    if (cells.length !== COLUMNS.length + 1) {
      throw new Error(`Unexpected matrix row in docs/permissions.md: ${line}`);
    }
    const ticked = new Set(COLUMNS.filter((_, i) => cells[i + 1]!.includes('✓')));
    const names = cells[0]!.replace(/\([^)]*\)/g, '').split('/');
    for (const name of names.map((n) => n.trim()).filter(Boolean)) {
      matrix.set(name, ticked);
    }
  }
  return matrix;
}

/**
 * Routes whose policy is "any active user" and whose handler checks a project-scoped permission
 * itself (TRP-T35). `null` means any active session, LAB included.
 */
const ACTIVE_ROUTE_PERMISSION: Record<string, Permission | null> = {
  'GET /api/staff/receivers': null,
  // MM-T45: every station reads the draft auto-delete setting; only PUT is restricted.
  'GET /api/settings/drafts': null,
  'PATCH /api/projects/:projectId': 'project.edit',
};

/** Sign-out is open to every session; calling it would end the caller's session mid-sweep. */
const NOT_SWEPT = new Set(['POST /api/auth/sign-out']);

type Caller = 'anonymous' | 'pending' | 'disabled' | 'lab' | 'technician';
const CALLERS: Caller[] = ['anonymous', 'pending', 'disabled', 'lab', 'technician'];

interface Route {
  method: string;
  /** Template as declared, e.g. /api/projects/:projectId. */
  template: string;
  policy: RoutePolicy;
}

type Expected =
  | { allowed: true }
  | { allowed: false; status: 401 | 403; code: 'unauthenticated' | 'access_pending' | 'forbidden' };

describe.runIf(testDatabaseUrl)('security: permission matrix sweep (TRP-T18 T2)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  const matrix = readDocumentedMatrix();
  const cookies: Partial<Record<Caller, string>> = {};
  const ids: Record<string, string> = {};
  let projectVersion = 1;

  async function addUser(
    name: string,
    initials: string,
    status: 'pending' | 'active' | 'disabled',
    roles: string[] = [],
  ): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, 'personal', $3) RETURNING id`,
      [name, initials, status],
    );
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    return rows[0]!.id;
  }

  async function cookieFor(userId: string, accountType: 'personal' | 'shared_lab') {
    const session = await sessions.create(userId, accountType);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  /**
   * One digest per table of everything a request could change. Sessions are compared on identity,
   * expiry and revocation only: last_seen_at is a throttled hint that any authenticated request
   * may refresh.
   */
  async function fingerprint(): Promise<Record<string, string>> {
    const { rows: tables } = await db.pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const parts = tables.map(({ table_name: name }) => {
      const source =
        name === 'session'
          ? '(SELECT id, user_id, expires_at, revoked_at FROM session)'
          : `"${name}"`;
      return `SELECT '${name}' AS name,
                     md5(coalesce(string_agg(x::text, '|' ORDER BY x::text), '')) AS digest
              FROM ${source} x`;
    });
    const { rows } = await db.pool.query<{ name: string; digest: string }>(
      parts.join(' UNION ALL '),
    );
    return Object.fromEntries(rows.map((r) => [r.name, r.digest]));
  }

  function listRoutes(): Route[] {
    const discovery = app.get(DiscoveryService);
    const scanner = app.get(MetadataScanner);
    const reflector = app.get(Reflector);
    const routes: Route[] = [];
    for (const wrapper of discovery.getControllers()) {
      const { instance, metatype } = wrapper;
      if (!instance || !metatype) continue;
      const base = String(Reflect.getMetadata(PATH_METADATA, metatype) ?? '');
      const prototype = Object.getPrototypeOf(instance) as Record<string, unknown>;
      for (const name of scanner.getAllMethodNames(prototype)) {
        const handler = prototype[name] as (...args: unknown[]) => unknown;
        const path = Reflect.getMetadata(PATH_METADATA, handler) as string | undefined;
        if (path === undefined) continue;
        const policy = reflector.getAllAndOverride<RoutePolicy>(ROUTE_POLICY, [handler, metatype]);
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as number]!;
        const template = `/api/${[base, path].filter((p) => p && p !== '/').join('/')}`.replace(
          /\/+/g,
          '/',
        );
        routes.push({ method, template, policy });
      }
    }
    return routes;
  }

  /** Real IDs, so a refusal is proven against data that exists and could have been changed. */
  function urlFor(template: string): string {
    const idParam = template.startsWith('/api/staff')
      ? ids.victim!
      : template.startsWith('/api/print-jobs')
        ? ids.job!
        : ids.unit!;
    return template
      .replace(':userId', ids.victim!)
      .replace(':projectId', ids.project!)
      .replace(':suNumber', ids.readableId!)
      .replace(':id', idParam);
  }

  /** What the matrix says `caller` gets from `route`. */
  function expectedFor(route: Route, caller: Caller): Expected {
    const { policy } = route;
    if (caller === 'anonymous' || caller === 'disabled') {
      // Disabled accounts' sessions stop authenticating (TRP-T04/T07).
      return { allowed: false, status: 401, code: 'unauthenticated' };
    }
    if (policy.kind === 'session') return { allowed: true };
    if (caller === 'pending') return { allowed: false, status: 403, code: 'access_pending' };
    let permission: Permission | null;
    if (policy.kind === 'active') {
      const key = `${route.method} ${route.template}`;
      if (!(key in ACTIVE_ROUTE_PERMISSION)) {
        throw new Error(`${key} checks permissions in its handler: classify it in this test`);
      }
      permission = ACTIVE_ROUTE_PERMISSION[key]!;
    } else if (policy.kind === 'permission') {
      permission = policy.permission;
    } else {
      throw new Error(`unexpected policy ${policy.kind}`);
    }
    if (permission === null) return { allowed: true };
    const columns = matrix.get(permission);
    if (!columns) throw new Error(`${permission} is missing from docs/permissions.md`);
    // The Technician is an ordinary internal user: not the project's PM/PE, no roles.
    const allowed = columns.has(caller === 'lab' ? 'lab' : 'internal');
    return allowed ? { allowed } : { allowed: false, status: 403, code: 'forbidden' };
  }

  function call(route: Route, caller: Caller, body: object) {
    const verb = route.method.toLowerCase() as 'get' | 'post' | 'put' | 'patch' | 'delete';
    // The CSRF header is always sent, so what is tested is the session and permission check.
    let test = request(app.getHttpServer())[verb](urlFor(route.template)).set(CSRF_HEADER, '1');
    const cookie = cookies[caller];
    if (cookie) test = test.set('Cookie', cookie);
    return verb === 'get' ? test : test.send(body);
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    const admin = await addUser('Admin Example', 'ADM', 'active', ['admin']);
    const pe = await addUser('Pat Example', 'PE', 'active');
    const technician = await addUser('Alex Tester', 'AT', 'active');
    const pending = await addUser('New Starter', 'NS', 'pending');
    const disabled = await addUser('Former Staff', 'FS', 'active');
    ids.victim = await addUser('Victim Example', 'VE', 'active');

    ids.project = await insertProject(db.pool, 'DEMO-2601', pe);
    const hole = await insertTestHole(db.pool, ids.project, 'TH26-01');
    const locationId = await receivingLabId(db.pool);
    const receiptId = await insertReceipt(db.pool, ids.project, technician, 1);
    ids.readableId = 'BKT-2026-000014';
    ids.unit = await insertStorageUnit(
      db.pool,
      { projectId: ids.project, receiptId, locationId },
      { readableId: ids.readableId },
    );
    await insertSummary(
      db.pool,
      { storageUnitId: ids.unit, projectId: ids.project, testHoleId: hole },
      { type: 'all' },
    );
    const { rows } = await db.pool.query<{ version: number }>(
      'SELECT version FROM project WHERE id = $1',
      [ids.project],
    );
    projectVersion = rows[0]!.version;

    // A queued job on a printer that is then turned off, so the print worker leaves it alone and
    // the sweep sees a stable database.
    const port = await FakeZebraPrinter.unusedPort();
    await db.pool.query(
      `INSERT INTO printer (key, name, host, port, is_default) VALUES
         ('receiving', 'Receiving ZD621', '127.0.0.1', $1, true)`,
      [port],
    );
    const adminUser: AuthUser = {
      userId: admin,
      sessionId: 'setup',
      accountType: 'personal',
      status: 'active',
      roles: ['admin'],
      displayName: 'Admin Example',
      initials: 'ADM',
    };
    ids.job = (
      await enqueuePrintJob(
        db.pool,
        adminUser,
        { storageUnitIds: [ids.unit], kind: 'initial' },
        null,
      )
    ).id;
    await db.pool.query(`UPDATE printer SET enabled = false`);

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    sessions = app.get(SessionService);

    cookies.pending = await cookieFor(pending, 'personal');
    cookies.technician = await cookieFor(technician, 'personal');
    cookies.lab = await cookieFor(LAB_ID, 'shared_lab');
    // Signed in while active, then disabled behind the session's back (no revocation): the
    // session must still stop working.
    cookies.disabled = await cookieFor(disabled, 'personal');
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [disabled]);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('docs/permissions.md and policy.ts grant exactly the same permissions', () => {
    const base = {
      sessionId: 's',
      status: 'active' as const,
      displayName: 'Someone',
      initials: 'SO',
    };
    const project = { pmPeUserId: 'pm-pe', acceptanceDelegateUserIds: ['delegate'] };
    const principals: Record<MatrixColumn, [AuthUser, boolean]> = {
      lab: [{ ...base, userId: 'lab', accountType: 'shared_lab', roles: [] }, false],
      internal: [{ ...base, userId: 'tech', accountType: 'personal', roles: [] }, false],
      labManager: [
        { ...base, userId: 'lm', accountType: 'personal', roles: ['lab_manager'] },
        false,
      ],
      admin: [{ ...base, userId: 'admin', accountType: 'personal', roles: ['admin'] }, false],
      pmPe: [{ ...base, userId: 'pm-pe', accountType: 'personal', roles: [] }, true],
      delegate: [{ ...base, userId: 'delegate', accountType: 'personal', roles: [] }, true],
    };
    expect(matrix.size).toBeGreaterThan(20);
    const mismatches: string[] = [];
    for (const [permission, columns] of matrix) {
      for (const column of COLUMNS) {
        const [user, withProject] = principals[column];
        const granted = can(user, permission as Permission, withProject ? project : undefined);
        // "Any internal user" is also true for every role column; the doc ticks them all.
        if (granted !== columns.has(column)) {
          mismatches.push(`${permission} / ${column}: doc ${columns.has(column)}, code ${granted}`);
        }
      }
    }
    expect(mismatches).toEqual([]);
  });

  it('every route is classified, and every protected route has a matrix row', () => {
    const routes = listRoutes();
    expect(routes.length).toBeGreaterThan(30);
    for (const route of routes) {
      if (route.policy.kind === 'public') continue;
      for (const caller of CALLERS) expectedFor(route, caller); // throws when unclassified
    }
  });

  it.each(CALLERS)(
    'AC4: as %s, every protected route answers as the matrix says; refusals change nothing',
    async (caller) => {
      const routes = listRoutes().filter(
        (r) => r.policy.kind !== 'public' && !NOT_SWEPT.has(`${r.method} ${r.template}`),
      );
      // A body that would do damage if a handler ever ran: rename, re-role, reset, print, correct.
      const hostileBody = {
        version: projectVersion,
        name: 'Renamed by an unauthorised caller',
        reason: 'unauthorised change attempt',
        roles: ['admin'],
        newPassword: 'unauthorised-password-123',
        storageUnitIds: [ids.unit],
        kind: 'reprint',
        changes: { note: 'unauthorised note' },
        officialInitials: 'XX',
        printers: [],
      };
      const problems: string[] = [];
      let refusals = 0;
      for (const route of routes) {
        const expected = expectedFor(route, caller);
        const label = `${route.method} ${route.template}`;
        if (expected.allowed) {
          // Allowed callers get past the guard (any other answer, e.g. 400 for an empty body).
          const response = await call(route, caller, {});
          const code = (response.body as { code?: string } | undefined)?.code;
          if (
            response.status === 401 ||
            ['forbidden', 'access_pending', 'unauthenticated'].includes(code ?? '')
          ) {
            problems.push(`${label}: expected access, got ${response.status} ${code}`);
          }
          continue;
        }
        refusals += 1;
        const before = await fingerprint();
        const response = await call(route, caller, hostileBody);
        const after = await fingerprint();
        if (response.status !== expected.status) {
          problems.push(`${label}: expected ${expected.status}, got ${response.status}`);
        } else if ((response.body as { code?: string }).code !== expected.code) {
          problems.push(
            `${label}: expected code ${expected.code}, got ${JSON.stringify(response.body)}`,
          );
        }
        const changed = Object.keys(before).filter((table) => before[table] !== after[table]);
        if (changed.length > 0) problems.push(`${label}: changed ${changed.join(', ')}`);
        // A refusal never carries data back.
        const keys = Object.keys((response.body as object | undefined) ?? {});
        if (keys.some((k) => !['code', 'message', 'statusCode', 'error'].includes(k))) {
          problems.push(`${label}: refusal body has ${keys.join(', ')}`);
        }
      }
      expect(problems).toEqual([]);
      expect(refusals).toBeGreaterThan(0);
    },
  );
});
