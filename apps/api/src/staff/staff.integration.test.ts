import type { INestApplication } from '@nestjs/common';
import {
  profileResponseSchema,
  receiverListResponseSchema,
  staffListResponseSchema,
  staffMemberSchema,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import { withTransaction } from '../db/transaction.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { insertProject } from '../test-support/fixtures.js';
import { StaffService } from './staff.service.js';

type AccountType = 'personal' | 'shared_lab' | 'test';

describe.runIf(testDatabaseUrl)('staff directory and receiver selector (MM-T07)', () => {
  let db: TestSchema;
  let app: INestApplication;
  let sessions: SessionService;
  const ids: Record<string, string> = {};
  const types: Record<string, AccountType> = {};

  async function addUser(
    key: string,
    options: {
      name: string;
      initials: string | null;
      accountType?: AccountType;
      status?: 'pending' | 'active' | 'disabled';
      position?: string | null;
      roles?: string[];
    },
  ) {
    const accountType = options.accountType ?? 'personal';
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status, position)
       VALUES ($1, $2, $3, $4, $5) RETURNING id`,
      [
        options.name,
        options.initials,
        accountType,
        options.status ?? 'active',
        options.position ?? null,
      ],
    );
    ids[key] = rows[0]!.id;
    types[key] = accountType;
    for (const role of options.roles ?? []) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        ids[key],
        role,
      ]);
    }
  }

  async function cookieFor(key: string) {
    const session = await sessions.create(ids[key]!, types[key]!);
    return `${SESSION_COOKIE}=${session.token}`;
  }

  const http = () => request(app.getHttpServer());
  const post = (path: string, cookie: string) =>
    http().post(path).set('Cookie', cookie).set(CSRF_HEADER, '1');

  beforeAll(async () => {
    db = await createMigratedSchema();
    await addUser('admin', { name: 'Avery Admin', initials: 'AA', roles: ['admin'] });
    await addUser('lm', { name: 'Lee Manager', initials: 'LM', roles: ['lab_manager'] });
    await addUser('tech', { name: 'Toni Tech', initials: 'TT', position: 'technician' });
    await addUser('lab', { name: 'LAB', initials: 'LAB', accountType: 'shared_lab' });
    await addUser('pend', { name: 'Pending Person', initials: 'PP', status: 'pending' });
    await addUser('jordan', { name: 'Jordan Smith', initials: 'JS', position: 'technician' });
    await addUser('jamie', { name: 'Jamie Song', initials: 'JS', position: 'engineer' });

    const config = loadConfig({
      APP_ENV: 'test',
      DATABASE_URL: databaseUrlForSchema(db.schema),
      SESSION_SECRET: 'test-session-secret-0123456789abcdef',
      LOG_LEVEL: 'silent',
    });
    app = await createApp(config);
    await app.init();
    sessions = app.get(SessionService);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  describe('T2 / AC5: staff management is admin only', () => {
    const someId = '00000000-0000-4000-8000-000000000999';
    const endpoints: [string, string, object?][] = [
      ['get', '/api/staff'],
      ['post', '/api/staff', { displayName: 'X', officialInitials: 'X', expectedUpn: 'x@x.x' }],
      ['post', `/api/staff/${someId}/approve`],
      ['post', `/api/staff/${someId}/disable`, { reason: 'test' }],
      ['post', `/api/staff/${someId}/enable`],
      ['put', `/api/staff/${someId}/roles`, { roles: [] }],
      ['patch', `/api/staff/${someId}`, { position: 'engineer' }],
    ];

    async function call(method: string, path: string, cookie: string | null, body?: object) {
      const agent = http() as unknown as Record<string, (p: string) => request.Test>;
      let req = agent[method]!(path).set(CSRF_HEADER, '1');
      if (cookie) req = req.set('Cookie', cookie);
      return body ? req.send(body) : req;
    }

    it.each(['lm', 'tech', 'lab'])('refuses %s with 403 on every endpoint', async (key) => {
      const cookie = await cookieFor(key);
      for (const [method, path, body] of endpoints) {
        const response = await call(method, path, cookie, body);
        expect(response.status, `${method} ${path}`).toBe(403);
        expect(response.body).toMatchObject({ code: 'forbidden' });
      }
    });

    it('refuses pending users (403) and anonymous callers (401)', async () => {
      const cookie = await cookieFor('pend');
      for (const [method, path, body] of endpoints) {
        expect((await call(method, path, cookie, body)).status).toBe(403);
        expect((await call(method, path, null, body)).status).toBe(401);
      }
    });

    it('lets an admin list staff', async () => {
      const response = await http()
        .get('/api/staff')
        .set('Cookie', await cookieFor('admin'));
      expect(response.status).toBe(200);
      const list = staffListResponseSchema.parse(response.body);
      expect(list[0]).toMatchObject({ displayName: 'Pending Person', status: 'pending' });
      expect(list.find((m) => m.id === ids.admin)).toMatchObject({
        roles: ['admin'],
        officialInitials: 'AA',
      });
    });

    it('receiver search is open to every active session, LAB included', async () => {
      for (const key of ['lab', 'tech', 'lm', 'admin']) {
        const response = await http()
          .get('/api/staff/receivers?search=JS')
          .set('Cookie', await cookieFor(key));
        expect(response.status, key).toBe(200);
      }
      expect((await http().get('/api/staff/receivers')).status).toBe(401);
      const pending = await http()
        .get('/api/staff/receivers')
        .set('Cookie', await cookieFor('pend'));
      expect(pending.status).toBe(403);
    });
  });

  it('filters the staff list by status and search', async () => {
    const cookie = await cookieFor('admin');
    const pending = staffListResponseSchema.parse(
      (await http().get('/api/staff?status=pending').set('Cookie', cookie)).body,
    );
    expect(pending.map((m) => m.id)).toEqual([ids.pend]);
    const js = staffListResponseSchema.parse(
      (await http().get('/api/staff?search=js').set('Cookie', cookie)).body,
    );
    expect(js.map((m) => m.displayName)).toEqual(['Jamie Song', 'Jordan Smith']);
    const bad = await http().get('/api/staff?status=nonsense').set('Cookie', cookie);
    expect(bad.status).toBe(400);
  });

  it('AC1: an approved pending user can use the app on their next request', async () => {
    const pendCookie = await cookieFor('pend');
    const before = await http().get('/api/activity/recent').set('Cookie', pendCookie);
    expect(before.status).toBe(403);
    expect(before.body).toMatchObject({ code: 'access_pending' });

    const admin = await cookieFor('admin');
    const approved = await post(`/api/staff/${ids.pend}/approve`, admin);
    expect(approved.status).toBe(200);
    expect(staffMemberSchema.parse(approved.body)).toMatchObject({ status: 'active' });
    expect(approved.body.approvedAt).not.toBeNull();

    const after = await http().get('/api/activity/recent').set('Cookie', pendCookie);
    expect(after.status).toBe(200);

    const again = await post(`/api/staff/${ids.pend}/approve`, admin);
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ code: 'invalid_transition' });

    const history = await listAuditForEntity(db.pool, 'app_user', ids.pend!);
    expect(history[0]).toMatchObject({
      action: 'staff.approved',
      actorUserId: ids.admin,
      before: { status: 'pending' },
      after: { status: 'active' },
    });
  });

  it('AC3 / T4: duplicate initials are two people, both offered with full names', async () => {
    const cookie = await cookieFor('lab');
    const response = await http().get('/api/staff/receivers?search=js').set('Cookie', cookie);
    const options = receiverListResponseSchema.parse(response.body);
    expect(options).toEqual([
      { id: ids.jamie, initials: 'JS', displayName: 'Jamie Song', position: 'engineer' },
      { id: ids.jordan, initials: 'JS', displayName: 'Jordan Smith', position: 'technician' },
    ]);
    expect(new Set(options.map((o) => o.id)).size).toBe(2);

    // Name search works too, and only minimal fields come back.
    const byName = await http().get('/api/staff/receivers?search=jordan').set('Cookie', cookie);
    expect(byName.body).toEqual([options[1]]);
    expect(Object.keys(byName.body[0]).sort()).toEqual([
      'displayName',
      'id',
      'initials',
      'position',
    ]);

    // The LAB station is not a person; wildcards are literal.
    const lab = await http().get('/api/staff/receivers?search=LAB').set('Cookie', cookie);
    expect(lab.body).toEqual([]);
    const wildcard = await http().get('/api/staff/receivers?search=%25').set('Cookie', cookie);
    expect(wildcard.body).toEqual([]);

    // Selecting one stores that person's ID (T10 uses receiverSnapshot when confirming).
    const snapshot = await withTransaction(db.pool, (client) =>
      app.get(StaffService).receiverSnapshot(client, ids.jordan!),
    );
    expect(snapshot).toEqual({ userId: ids.jordan, initials: 'JS', name: 'Jordan Smith' });
  });

  it('AC2 / T3: disabling revokes sessions and removes them from receiver search', async () => {
    const jamieCookie = await cookieFor('jamie');
    expect((await http().get('/api/me').set('Cookie', jamieCookie)).status).toBe(200);
    const admin = await cookieFor('admin');

    const noReason = await post(`/api/staff/${ids.jamie}/disable`, admin).send({ reason: ' ' });
    expect(noReason.status).toBe(400);

    const disabled = await post(`/api/staff/${ids.jamie}/disable`, admin).send({
      reason: 'Left the company',
    });
    expect(disabled.status).toBe(200);
    expect(disabled.body).toMatchObject({ status: 'disabled', disabledReason: 'Left the company' });

    expect((await http().get('/api/me').set('Cookie', jamieCookie)).status).toBe(401);
    const search = await http().get('/api/staff/receivers?search=JS').set('Cookie', admin);
    expect(search.body.map((o: { id: string }) => o.id)).toEqual([ids.jordan]);
    await expect(
      withTransaction(db.pool, (client) =>
        app.get(StaffService).receiverSnapshot(client, ids.jamie!),
      ),
    ).rejects.toMatchObject({ response: { code: 'receiver_not_available' } });

    const history = await listAuditForEntity(db.pool, 'app_user', ids.jamie!);
    expect(history[0]).toMatchObject({ action: 'staff.disabled', reason: 'Left the company' });

    const enabled = await post(`/api/staff/${ids.jamie}/enable`, admin);
    expect(enabled.status).toBe(200);
    expect(enabled.body).toMatchObject({ status: 'active', disabledReason: null });
    const back = await http().get('/api/staff/receivers?search=JS').set('Cookie', admin);
    expect(back.body).toHaveLength(2);
    expect((await listAuditForEntity(db.pool, 'app_user', ids.jamie!))[0]).toMatchObject({
      action: 'staff.enabled',
    });
    // Old sessions stay revoked after re-enabling.
    expect((await http().get('/api/me').set('Cookie', jamieCookie)).status).toBe(401);
  });

  it('AC4: renaming or disabling the receiver never changes a receipt', async () => {
    const projectId = await insertProject(db.pool, 'DEMO-2601', ids.admin!);
    const receiptId = await withTransaction(db.pool, async (client) => {
      const receiver = await app.get(StaffService).receiverSnapshot(client, ids.jordan!);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO receipt (project_id, received_date, receiver_user_id,
                              receiver_initials_snapshot, receiver_name_snapshot, account_user_id,
                              quantity, idempotency_key, request_hash)
         VALUES ($1, '2026-10-26', $2, $3, $4, $5, 1, gen_random_uuid(), 'hash') RETURNING id`,
        [projectId, receiver.userId, receiver.initials, receiver.name, ids.lab],
      );
      return rows[0]!.id;
    });

    const admin = await cookieFor('admin');
    const renamed = await http()
      .patch(`/api/staff/${ids.jordan}`)
      .set('Cookie', admin)
      .set(CSRF_HEADER, '1')
      .send({ displayName: 'Jordan Smith-Lee', officialInitials: 'jsl' });
    expect(renamed.status).toBe(200);
    expect(renamed.body).toMatchObject({
      displayName: 'Jordan Smith-Lee',
      officialInitials: 'JSL',
    });
    const disabled = await post(`/api/staff/${ids.jordan}/disable`, admin).send({
      reason: 'Contract ended',
    });
    expect(disabled.status).toBe(200);

    const { rows } = await db.pool.query(
      `SELECT receiver_user_id, receiver_initials_snapshot, receiver_name_snapshot
       FROM receipt WHERE id = $1`,
      [receiptId],
    );
    expect(rows[0]).toEqual({
      receiver_user_id: ids.jordan,
      receiver_initials_snapshot: 'JS',
      receiver_name_snapshot: 'Jordan Smith',
    });
    const actions = (await listAuditForEntity(db.pool, 'app_user', ids.jordan!)).map(
      (e) => e.action,
    );
    expect(actions).toEqual(
      expect.arrayContaining(['staff.initials_changed', 'staff.profile_changed']),
    );
  });

  it('validates staff edits', async () => {
    const admin = await cookieFor('admin');
    const patch = (body: object) =>
      http().patch(`/api/staff/${ids.tech}`).set('Cookie', admin).set(CSRF_HEADER, '1').send(body);
    expect((await patch({ officialInitials: 'K1' })).status).toBe(400);
    expect((await patch({})).status).toBe(400);
    expect((await patch({ position: 'wizard' })).status).toBe(400);
    expect((await patch({ position: 'engineer' })).body).toMatchObject({ position: 'engineer' });
    const missing = await http()
      .patch('/api/staff/00000000-0000-4000-8000-000000000999')
      .set('Cookie', admin)
      .set(CSRF_HEADER, '1')
      .send({ position: 'engineer' });
    expect(missing.status).toBe(404);
  });

  it('never gives the shared LAB account a role', async () => {
    const response = await http()
      .put(`/api/staff/${ids.lab}/roles`)
      .set('Cookie', await cookieFor('admin'))
      .set(CSRF_HEADER, '1')
      .send({ roles: ['admin'] });
    expect(response.status).toBe(422);
    expect(response.body).toMatchObject({ code: 'roles_not_allowed' });
  });

  describe('pre-provisioned staff and first sign-in (AC6)', () => {
    it('adds an approved entry that waits for its exact UPN', async () => {
      const admin = await cookieFor('admin');
      const created = await post('/api/staff', admin).send({
        displayName: 'Jesse Stone',
        officialInitials: 'js',
        expectedUpn: 'jstone@company.example',
        position: 'technician',
      });
      expect(created.status).toBe(201);
      expect(staffMemberSchema.parse(created.body)).toMatchObject({
        officialInitials: 'JS',
        status: 'active',
        linked: false,
        expectedUpn: 'jstone@company.example',
      });
      ids.jesse = created.body.id;

      const duplicate = await post('/api/staff', admin).send({
        displayName: 'Someone Else',
        officialInitials: 'SE',
        expectedUpn: 'JSTONE@company.example',
      });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body).toMatchObject({ code: 'upn_taken' });

      const invalid = await post('/api/staff', admin).send({
        displayName: 'No Email',
        officialInitials: 'NE',
        expectedUpn: 'not-an-email',
      });
      expect(invalid.status).toBe(400);
      expect(JSON.stringify(invalid.body)).not.toContain('not-an-email');

      const history = await listAuditForEntity(db.pool, 'app_user', ids.jesse!);
      expect(history[0]).toMatchObject({ action: 'staff.preprovisioned' });
    });

    it('links only on the exact UPN, never by initials or name', async () => {
      const staff = app.get(StaffService);
      const signIn = (subject: string, upn: string, displayName: string) =>
        withTransaction(db.pool, (client) =>
          staff.resolveMicrosoftSignIn(client, {
            tenantId: '00000000-0000-4000-8000-00000000f001',
            subject,
            upn,
            displayName,
          }),
        );

      // Same initials and even the same name, different UPN: a separate pending user.
      const other = await signIn(
        '00000000-0000-4000-8000-00000000a001',
        'jsong2@company.example',
        'Jesse Stone',
      );
      expect(other.outcome).toBe('created');
      expect(other.userId).not.toBe(ids.jesse);
      const { rows: otherRow } = await db.pool.query(
        'SELECT status, official_initials FROM app_user WHERE id = $1',
        [other.userId],
      );
      expect(otherRow[0]).toEqual({ status: 'pending', official_initials: null });

      const linked = await signIn(
        '00000000-0000-4000-8000-00000000a002',
        'JStone@Company.example',
        'Jesse Stone',
      );
      expect(linked).toEqual({ userId: ids.jesse, outcome: 'linked' });
      expect((await listAuditForEntity(db.pool, 'app_user', ids.jesse!))[0]).toMatchObject({
        action: 'staff.linked_on_first_sign_in',
      });

      expect(
        await signIn(
          '00000000-0000-4000-8000-00000000a002',
          'jstone@company.example',
          'Jesse Stone',
        ),
      ).toEqual({
        userId: ids.jesse,
        outcome: 'existing',
      });
      // The entry is linked now, so a new identity with the same UPN can't take it over.
      const takeover = await signIn(
        '00000000-0000-4000-8000-00000000a003',
        'jstone@company.example',
        'Jesse Stone',
      );
      expect(takeover.outcome).toBe('created');
      expect(takeover.userId).not.toBe(ids.jesse);
    });
  });

  describe('MM-T43: clearing a position after onboarding', () => {
    const patchAs = (cookie: string, id: string, body: object) =>
      http().patch(`/api/staff/${id}`).set('Cookie', cookie).set(CSRF_HEADER, '1').send(body);
    const positionOf = async (id: string) =>
      (
        await db.pool.query<{ position: string | null; position_set_at: Date | null }>(
          'SELECT position, position_set_at FROM app_user WHERE id = $1',
          [id],
        )
      ).rows[0]!;

    /** A fictional person who finished first-login position setup. */
    async function onboarded(key: string, name: string, initials: string) {
      await addUser(key, { name, initials, position: 'engineer' });
      await db.pool.query('UPDATE app_user SET position_set_at = now() WHERE id = $1', [ids[key]]);
    }

    it('AC1 / AC2: Not set clears position and onboarding, then the person chooses again', async () => {
      await onboarded('olive', 'Olive Onboarded', 'OO');
      const before = await positionOf(ids.olive!);
      expect(before.position_set_at).not.toBeNull();
      const oliveCookie = await cookieFor('olive');
      const meBefore = await http().get('/api/me').set('Cookie', oliveCookie);
      expect(meBefore.body).toMatchObject({ position: 'engineer', positionSetupRequired: false });

      // Review reproduction: this used to fail the CHECK app_user_position_set_has_position (500).
      const cleared = await patchAs(await cookieFor('admin'), ids.olive!, { position: null });
      expect(cleared.status).toBe(200);
      expect(staffMemberSchema.parse(cleared.body)).toMatchObject({
        position: null,
        status: 'active',
        roles: [],
        officialInitials: 'OO',
      });
      expect(await positionOf(ids.olive!)).toEqual({ position: null, position_set_at: null });
      expect((await listAuditForEntity(db.pool, 'app_user', ids.olive!))[0]).toMatchObject({
        action: 'staff.profile_changed',
        actorUserId: ids.admin,
        before: { position: 'engineer', positionSetAt: before.position_set_at!.toISOString() },
        after: { position: null, positionSetAt: null },
      });

      // Their session stays valid; the next page load asks for a position again.
      const meAfter = await http().get('/api/me').set('Cookie', oliveCookie);
      expect(meAfter.status).toBe(200);
      expect(meAfter.body).toMatchObject({ position: null, positionSetupRequired: true });
      const chosen = await post('/api/me/position', oliveCookie).send({ position: 'technician' });
      expect(chosen.status).toBeLessThan(300);
      expect((await http().get('/api/me').set('Cookie', oliveCookie)).body).toMatchObject({
        position: 'technician',
        positionSetupRequired: false,
      });
      // Saved once again: a second choice is refused as before.
      expect(
        (await post('/api/me/position', oliveCookie).send({ position: 'engineer' })).status,
      ).toBe(409);
    });

    it('AC3: an edit that omits position leaves position and its metadata unchanged', async () => {
      await onboarded('owen', 'Owen Onboarded', 'OW');
      const before = await positionOf(ids.owen!);
      const renamed = await patchAs(await cookieFor('admin'), ids.owen!, {
        displayName: 'Owen Renamed',
      });
      expect(renamed.status).toBe(200);
      expect(await positionOf(ids.owen!)).toEqual(before);
    });

    it('AC4: a non-null position edit keeps onboarding, other fields and roles', async () => {
      await onboarded('opal', 'Opal Onboarded', 'OP');
      await db.pool.query(
        `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
        [ids.opal],
      );
      const before = await positionOf(ids.opal!);
      const changed = await patchAs(await cookieFor('admin'), ids.opal!, {
        position: 'project_engineer',
      });
      expect(changed.status).toBe(200);
      expect(changed.body).toMatchObject({
        position: 'project_engineer',
        displayName: 'Opal Onboarded',
        officialInitials: 'OP',
        roles: ['lab_manager'],
        status: 'active',
      });
      expect(await positionOf(ids.opal!)).toEqual({
        position: 'project_engineer',
        position_set_at: before.position_set_at,
      });
    });

    it('AC5: only admins may clear a position', async () => {
      await onboarded('otto', 'Otto Onboarded', 'OT');
      const before = await positionOf(ids.otto!);
      for (const key of ['lm', 'lab', 'otto']) {
        const refused = await patchAs(await cookieFor(key), ids.otto!, { position: null });
        expect(refused.status).toBe(403);
      }
      expect(await positionOf(ids.otto!)).toEqual(before);
    });
  });

  describe('MM-T44: admin-assigned initials are confirmed', () => {
    const patchAs = (cookie: string, id: string, body: object) =>
      http().patch(`/api/staff/${id}`).set('Cookie', cookie).set(CSRF_HEADER, '1').send(body);
    const confirmationOf = async (id: string) =>
      (
        await db.pool.query<{
          official_initials: string | null;
          initials_confirmed_by_user_id: string | null;
          initials_confirmed_at: Date | null;
        }>(
          `SELECT official_initials, initials_confirmed_by_user_id, initials_confirmed_at
           FROM app_user WHERE id = $1`,
          [id],
        )
      ).rows[0]!;
    const profileOf = async (key: string) =>
      profileResponseSchema.parse(
        (
          await http()
            .get('/api/me/profile')
            .set('Cookie', await cookieFor(key))
        ).body,
      );

    it('AC1: pre-provisioning records the admin and time as the confirmation', async () => {
      const started = new Date();
      const created = await post('/api/staff', await cookieFor('admin')).send({
        displayName: 'Review New Staff',
        officialInitials: 'rs',
        expectedUpn: 'rnewstaff@company.example',
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({ officialInitials: 'RS', initialsConfirmed: true });
      ids.review = created.body.id;
      types.review = 'personal';
      const row = await confirmationOf(ids.review!);
      expect(row.initials_confirmed_by_user_id).toBe(ids.admin);
      expect(row.initials_confirmed_at!.getTime()).toBeGreaterThanOrEqual(started.getTime() - 1000);
      // Review reproduction: this used to read officialInitials=RS; initialsConfirmed=false.
      expect(await profileOf('review')).toMatchObject({
        officialInitials: 'RS',
        initialsConfirmed: true,
      });
      expect((await listAuditForEntity(db.pool, 'app_user', ids.review!))[0]).toMatchObject({
        action: 'staff.preprovisioned',
        actorUserId: ids.admin,
      });
    });

    it('AC2: assigning or changing initials updates the confirmation pair together', async () => {
      await addUser('nina', { name: 'Nina Noinitials', initials: null });
      expect(await profileOf('nina')).toMatchObject({
        officialInitials: null,
        initialsConfirmed: false,
      });
      const admin = await cookieFor('admin');

      const assigned = await patchAs(admin, ids.nina!, { officialInitials: 'nn' });
      expect(assigned.body).toMatchObject({ officialInitials: 'NN', initialsConfirmed: true });
      const first = await confirmationOf(ids.nina!);
      expect(first).toMatchObject({
        official_initials: 'NN',
        initials_confirmed_by_user_id: ids.admin,
      });
      expect(await profileOf('nina')).toMatchObject({
        officialInitials: 'NN',
        initialsConfirmed: true,
      });

      const changed = await patchAs(admin, ids.nina!, { officialInitials: 'NX' });
      expect(changed.status).toBe(200);
      const second = await confirmationOf(ids.nina!);
      expect(second.official_initials).toBe('NX');
      expect(second.initials_confirmed_by_user_id).toBe(ids.admin);
      expect(second.initials_confirmed_at!.getTime()).toBeGreaterThanOrEqual(
        first.initials_confirmed_at!.getTime(),
      );
      const actions = (await listAuditForEntity(db.pool, 'app_user', ids.nina!)).map(
        (e) => e.action,
      );
      expect(actions.filter((a) => a === 'staff.initials_changed')).toHaveLength(2);
    });

    it('AC3: an admin can explicitly confirm the same, unconfirmed value', async () => {
      await addUser('uma', { name: 'Uma Unconfirmed', initials: 'UC' });
      expect(await profileOf('uma')).toMatchObject({
        officialInitials: 'UC',
        initialsConfirmed: false,
      });
      const admin = await cookieFor('admin');
      const confirmed = await patchAs(admin, ids.uma!, { officialInitials: 'uc' });
      expect(confirmed.body).toMatchObject({ officialInitials: 'UC', initialsConfirmed: true });
      expect(await profileOf('uma')).toMatchObject({
        officialInitials: 'UC',
        initialsConfirmed: true,
      });
      const history = await listAuditForEntity(db.pool, 'app_user', ids.uma!);
      expect(history[0]).toMatchObject({
        action: 'staff.initials_confirmed',
        actorUserId: ids.admin,
        after: { officialInitials: 'UC', initialsConfirmed: true },
      });

      // Submitting already-confirmed initials again keeps the original confirmation.
      const kept = await confirmationOf(ids.uma!);
      await patchAs(admin, ids.uma!, { officialInitials: 'UC' });
      expect(await confirmationOf(ids.uma!)).toEqual(kept);
      expect(await listAuditForEntity(db.pool, 'app_user', ids.uma!)).toHaveLength(history.length);
    });

    it('AC4: unrelated edits never rewrite initials or their confirmation', async () => {
      await addUser('una', { name: 'Una Unrelated', initials: 'UN' });
      const admin = await cookieFor('admin');
      await patchAs(admin, ids.una!, { displayName: 'Una Renamed', position: 'technician' });
      expect(await confirmationOf(ids.una!)).toEqual({
        official_initials: 'UN',
        initials_confirmed_by_user_id: null,
        initials_confirmed_at: null,
      });
      await patchAs(admin, ids.una!, { officialInitials: 'UN' });
      const confirmed = await confirmationOf(ids.una!);
      await patchAs(admin, ids.una!, { displayName: 'Una Again', position: null });
      expect(await confirmationOf(ids.una!)).toEqual(confirmed);
    });

    it('AC5: only admins assign initials, and duplicates stay allowed', async () => {
      await addUser('dee', { name: 'Dee Duplicate', initials: 'DD' });
      for (const key of ['lm', 'lab', 'dee']) {
        const refused = await patchAs(await cookieFor(key), ids.dee!, { officialInitials: 'XY' });
        expect(refused.status).toBe(403);
      }
      expect(await confirmationOf(ids.dee!)).toMatchObject({
        official_initials: 'DD',
        initials_confirmed_at: null,
      });
      const duplicate = await patchAs(await cookieFor('admin'), ids.dee!, {
        officialInitials: 'JS',
      });
      expect(duplicate.status).toBe(200);
      expect(duplicate.body).toMatchObject({ officialInitials: 'JS', initialsConfirmed: true });
    });
  });

  describe('T5 / AC7: last-admin protection', () => {
    it('refuses to let the last active admin drop their admin role or be disabled', async () => {
      const admin = await cookieFor('admin');
      const drop = await http()
        .put(`/api/staff/${ids.admin}/roles`)
        .set('Cookie', admin)
        .set(CSRF_HEADER, '1')
        .send({ roles: [], reason: 'Stepping down' });
      expect(drop.status).toBe(422);
      expect(drop.body).toMatchObject({ code: 'last_admin' });

      const disable = await post(`/api/staff/${ids.admin}/disable`, admin).send({
        reason: 'Stepping down',
      });
      expect(disable.status).toBe(422);
      expect(disable.body).toMatchObject({ code: 'last_admin' });

      const { rows } = await db.pool.query(`SELECT status FROM app_user WHERE id = $1`, [
        ids.admin,
      ]);
      expect(rows[0]).toEqual({ status: 'active' });
    });

    it('allows it once another active admin exists', async () => {
      const admin = await cookieFor('admin');
      const grant = await http()
        .put(`/api/staff/${ids.tech}/roles`)
        .set('Cookie', admin)
        .set(CSRF_HEADER, '1')
        .send({ roles: ['admin', 'lab_manager'] });
      expect(grant.status).toBe(200);
      expect(grant.body.roles).toEqual(['admin', 'lab_manager']);

      const drop = await http()
        .put(`/api/staff/${ids.admin}/roles`)
        .set('Cookie', admin)
        .set(CSRF_HEADER, '1')
        .send({ roles: [], reason: 'Handing over' });
      expect(drop.status).toBe(200);
      expect(drop.body.roles).toEqual([]);
      expect((await listAuditForEntity(db.pool, 'app_user', ids.admin!))[0]).toMatchObject({
        action: 'staff.roles_changed',
        reason: 'Handing over',
        before: { roles: ['admin'] },
        after: { roles: [] },
      });

      // The former admin's very next request is no longer allowed to manage staff.
      expect((await http().get('/api/staff').set('Cookie', admin)).status).toBe(403);
    });
  });

  // MM-T48: permissions are read from role_assignment on every request (SessionService
  // .authenticate), so a role change applies to existing sessions with no revocation needed.
  describe('MM-T48: role changes reach existing sessions on their next request', () => {
    const setRoles = (key: string, roles: string[], cookie: string) =>
      http()
        .put(`/api/staff/${ids[key]}/roles`)
        .set('Cookie', cookie)
        .set(CSRF_HEADER, '1')
        .send({ roles, reason: 'MM-T48 test' });

    it('AC1: removing Admin from a signed-in user makes their next admin-only request 403', async () => {
      await addUser('riley', { name: 'Riley Admin', initials: 'RAD', roles: ['admin'] });
      await addUser('sam', { name: 'Sam Admin', initials: 'SAD', roles: ['admin'] });
      const riley = await cookieFor('riley'); // signed in before the change
      expect((await http().get('/api/staff').set('Cookie', riley)).status).toBe(200);

      const removed = await setRoles('riley', [], await cookieFor('sam'));
      expect(removed.status).toBe(200);

      const denied = await http().get('/api/staff').set('Cookie', riley);
      expect(denied.status).toBe(403);
      expect(denied.body).toMatchObject({ code: 'forbidden' });
      // Still signed in, with the new roles.
      const me = await http().get('/api/me').set('Cookie', riley);
      expect(me.status).toBe(200);
      expect(me.body.roles).toEqual([]);
    });

    it('a granted role also applies on the next request of an existing session', async () => {
      await addUser('casey', { name: 'Casey Tech', initials: 'CT' });
      const casey = await cookieFor('casey');
      expect((await http().get('/api/staff').set('Cookie', casey)).status).toBe(403);
      expect((await setRoles('casey', ['admin'], await cookieFor('sam'))).status).toBe(200);
      expect((await http().get('/api/staff').set('Cookie', casey)).status).toBe(200);
    });

    it('disabling ends existing sessions; re-enabling does not bring them back', async () => {
      await addUser('drew', { name: 'Drew Field', initials: 'DF' });
      const drew = await cookieFor('drew');
      const sam = await cookieFor('sam');
      expect(
        (await post(`/api/staff/${ids.drew}/disable`, sam).send({ reason: 'Leave' })).status,
      ).toBe(200);
      expect((await http().get('/api/me').set('Cookie', drew)).status).toBe(401);
      expect((await post(`/api/staff/${ids.drew}/enable`, sam)).status).toBe(200);
      expect((await http().get('/api/me').set('Cookie', drew)).status).toBe(401);
      expect(
        (
          await http()
            .get('/api/me')
            .set('Cookie', await cookieFor('drew'))
        ).status,
      ).toBe(200);
    });
  });
});
