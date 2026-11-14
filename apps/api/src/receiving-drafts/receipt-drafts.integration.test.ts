import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import {
  receiptDraftClosedSchema,
  receiptDraftDeleteForbiddenSchema,
  receiptDraftDeletedSchema,
  receiptDraftOwnershipListSchema,
  receiptDraftOwnershipSchema,
} from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import type { AuthUser } from '../auth/policy.js';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { decideDraftDelete, type DraftRegistryRow } from './receipt-drafts.service.js';

// STRATA-108 at the API, against real PostgreSQL: only the person who started a receiving draft,
// or a verified Lab Manager, may delete it. Direct API calls, spoofed starter metadata, a LAB
// station picking someone else, Lab Manager verification under lock, repeated deletes, cancelling
// (nothing recorded) and legacy drafts. Draft contents never reach the server. Fictional people.

describe.runIf(testDatabaseUrl)('receipt draft registry routes (STRATA-108)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const users: Record<string, string> = {};
  const cookies: Record<string, string> = {};

  const http = () => request(app.getHttpServer());
  const get = (path: string, who: string) => http().get(path).set('Cookie', cookies[who]!);
  const post = (path: string, who: string, body?: object) =>
    http().post(path).set('Cookie', cookies[who]!).set(CSRF_HEADER, '1').send(body);

  async function addUser(
    key: string,
    name: string,
    accountType: 'personal' | 'shared_lab',
    roles: string[] = [],
  ) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [name, accountType === 'shared_lab' ? null : key.toUpperCase().slice(0, 4), accountType],
    );
    users[key] = rows[0]!.id;
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    const session = await app.get(SessionService).create(rows[0]!.id, accountType);
    cookies[key] = `${SESSION_COOKIE}=${session.token}`;
  }

  const register = (who: string, draftId: string, personUserId?: string) =>
    post('/api/receipt-drafts', who, { draftId, ...(personUserId ? { personUserId } : {}) });
  const remove = (who: string, draftId: string, personUserId?: string) =>
    post(`/api/receipt-drafts/${draftId}/delete`, who, personUserId ? { personUserId } : {});
  async function ownership(who: string, ids: string[], personUserId?: string) {
    const query = `ids=${ids.join(',')}${personUserId ? `&personUserId=${personUserId}` : ''}`;
    const response = await get(`/api/receipt-drafts?${query}`, who);
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    return receiptDraftOwnershipListSchema.parse(response.body).items;
  }

  /** Registry and audit rows: what a refused or cancelled delete must leave unchanged. */
  async function fingerprint() {
    const { rows } = await db.pool.query<{ snapshot: string }>(
      `SELECT concat_ws('|', (SELECT count(*) FROM audit_event),
         (SELECT string_agg(concat_ws(':', draft_id, legacy, starter_user_id, deleted_at,
                                      deleted_by_user_id), ',' ORDER BY draft_id)
          FROM receipt_draft_registry)) AS snapshot`,
    );
    return rows[0]!.snapshot;
  }

  async function expectForbidden(response: request.Response, reason: string) {
    expect(response.status, JSON.stringify(response.body)).toBe(403);
    expect(receiptDraftDeleteForbiddenSchema.parse(response.body).reason).toBe(reason);
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    await addUser('lab', 'LAB', 'shared_lab');
    await addUser('pat', 'Pat Example', 'personal');
    await addUser('jordan', 'Jordan Lab', 'personal');
    await addUser('sam', 'Sam Sample', 'personal');
    await addUser('morgan', 'Morgan Manager', 'personal', ['lab_manager']);
    await addUser('ada', 'Ada Admin', 'personal', ['admin']);
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  it('registers a personal draft as its own starter, once, and never stores its contents', async () => {
    const draftId = randomUUID();
    const first = await register('pat', draftId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(receiptDraftOwnershipSchema.parse(first.body)).toMatchObject({
      registered: true,
      starter: { userId: users.pat, name: 'Pat Example' },
      startedOnStation: false,
      canDelete: true,
      reason: 'starter',
    });
    const before = await fingerprint();
    expect((await register('pat', draftId)).status).toBe(200);
    expect(await fingerprint()).toBe(before);
    // Only metadata columns exist: nothing a draft's payload could be written to.
    const { rows } = await db.pool.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
       WHERE table_schema = current_schema() AND table_name = 'receipt_draft_registry'
       ORDER BY column_name`,
    );
    expect(rows.map((r) => r.column_name)).toEqual([
      'account_user_id',
      'closed_at',
      'closed_reason',
      'created_at',
      'deleted_at',
      'deleted_by_account_user_id',
      'deleted_by_user_id',
      'draft_id',
      'legacy',
      'starter_user_id',
    ]);
  });

  it('refuses another account registering the same draft (409) and spoofed starter metadata', async () => {
    const draftId = randomUUID();
    await register('pat', draftId);
    const other = await register('jordan', draftId);
    expect(other.status).toBe(409);
    expect(other.body).toMatchObject({ code: 'draft_registered_elsewhere' });
    // A personal account can't name someone else as the starter.
    const spoofed = await register('sam', randomUUID(), users.jordan);
    expect(spoofed.status).toBe(400);
    // Nor send any other starter field: the body is strict.
    const extra = await post('/api/receipt-drafts', 'sam', {
      draftId: randomUUID(),
      starterUserId: users.jordan,
    });
    expect(extra.status).toBe(400);
    // Draft contents are never accepted.
    const payload = await post('/api/receipt-drafts', 'sam', {
      draftId: randomUUID(),
      data: { units: [] },
    });
    expect(payload.status).toBe(400);
  });

  it('LAB registers for the picked person; a later pick never changes the starter', async () => {
    const draftId = randomUUID();
    expect((await register('lab', draftId)).status).toBe(400);
    const first = await register('lab', draftId, users.jordan);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    expect(first.body).toMatchObject({
      starter: { userId: users.jordan },
      startedOnStation: true,
    });
    const again = await register('lab', draftId, users.pat);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({
      starter: { userId: users.jordan },
      canDelete: false,
      reason: 'not_starter',
    });
    const { rows } = await db.pool.query(
      `SELECT action, receiver_user_id FROM audit_event
       WHERE entity_type = 'receipt_draft' AND entity_id = $1`,
      [draftId],
    );
    expect(rows).toEqual([{ action: 'receipt_draft.registered', receiver_user_id: users.jordan }]);
  });

  it('refuses a direct delete by anyone but the starter, and changes nothing', async () => {
    const draftId = randomUUID();
    await register('pat', draftId);
    const before = await fingerprint();
    await expectForbidden(await remove('jordan', draftId), 'not_starter');
    // Admin is not Lab Manager.
    await expectForbidden(await remove('ada', draftId), 'not_starter');
    // LAB can't delete a personal draft, whoever it picks.
    await expectForbidden(await remove('lab', draftId, users.pat), 'other_account');
    expect(await fingerprint()).toBe(before);
    const refused = await remove('jordan', draftId);
    expect(refused.body).toMatchObject({ starter: { name: 'Pat Example' } });
  });

  it('lets the starter delete; a repeat is idempotent and records nothing more', async () => {
    const draftId = randomUUID();
    await register('pat', draftId);
    const first = await remove('pat', draftId);
    expect(first.status, JSON.stringify(first.body)).toBe(200);
    const deleted = receiptDraftDeletedSchema.parse(first.body);
    expect(deleted.reason).toBe('starter');
    const before = await fingerprint();
    const again = await remove('pat', draftId);
    expect(again.status).toBe(200);
    expect(receiptDraftDeletedSchema.parse(again.body).deletedAt).toBe(deleted.deletedAt);
    expect(await fingerprint()).toBe(before);
    // A deleted draft can't be registered again.
    expect((await register('pat', draftId)).status).toBe(409);
  });

  it('on LAB, deletes only with the starter picked, and records the pick', async () => {
    const draftId = randomUUID();
    await register('lab', draftId, users.jordan);
    const before = await fingerprint();
    // No pick: LAB must say who is deleting.
    expect((await remove('lab', draftId)).status).toBe(400);
    // Picking someone else.
    await expectForbidden(await remove('lab', draftId, users.pat), 'not_starter');
    // The starter on their own account is not the LAB station that started it.
    await expectForbidden(await remove('jordan', draftId), 'other_account');
    expect(await fingerprint()).toBe(before);
    expect(
      (await ownership('lab', [draftId], users.pat))[0],
      'ownership read with another pick',
    ).toMatchObject({ canDelete: false, reason: 'not_starter' });
    expect((await ownership('lab', [draftId]))[0]).toMatchObject({ reason: 'pick_person' });

    const done = await remove('lab', draftId, users.jordan);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const { rows } = await db.pool.query(
      `SELECT actor_user_id, receiver_user_id, after_values FROM audit_event
       WHERE entity_type = 'receipt_draft' AND entity_id = $1 AND action = 'receipt_draft.deleted'`,
      [draftId],
    );
    expect(rows).toEqual([
      {
        actor_user_id: users.lab,
        receiver_user_id: users.jordan,
        after_values: { reason: 'starter', registered: true, starterUserId: users.jordan },
      },
    ]);
    const registry = await db.pool.query(
      `SELECT deleted_by_account_user_id, deleted_by_user_id FROM receipt_draft_registry
       WHERE draft_id = $1`,
      [draftId],
    );
    expect(registry.rows[0]).toEqual({
      deleted_by_account_user_id: users.lab,
      deleted_by_user_id: users.jordan,
    });
  });

  it('a Lab Manager may delete any draft, verified as the account stands now', async () => {
    const draftId = randomUUID();
    await register('lab', draftId, users.pat);
    expect((await ownership('morgan', [draftId]))[0]).toMatchObject({
      canDelete: true,
      reason: 'lab_manager',
    });
    // The role is removed: the session's old roles never count.
    await db.pool.query(`DELETE FROM role_assignment WHERE user_id = $1 AND role = 'lab_manager'`, [
      users.morgan,
    ]);
    await expectForbidden(await remove('morgan', draftId), 'other_account');
    await db.pool.query(`INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`, [
      users.morgan,
    ]);
    const done = await remove('morgan', draftId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body).toMatchObject({ reason: 'lab_manager' });
    // Picking a Lab Manager at the LAB station never borrows the role.
    const other = randomUUID();
    await register('lab', other, users.pat);
    await expectForbidden(await remove('lab', other, users.morgan), 'not_starter');
  });

  describe('closing a draft the browser cleaned up (migration 0049)', () => {
    const close = (who: string, draftId: string, body: object = { reason: 'expired' }) =>
      post(`/api/receipt-drafts/${draftId}/close`, who, body);
    async function closed(response: request.Response) {
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return receiptDraftClosedSchema.parse(response.body);
    }
    async function closeColumns(draftId: string) {
      const { rows } = await db.pool.query(
        `SELECT closed_at, closed_reason FROM receipt_draft_registry WHERE draft_id = $1`,
        [draftId],
      );
      return rows[0] as { closed_at: Date | null; closed_reason: string | null } | undefined;
    }
    const nothing = (draftId: string) => ({ draftId, closed: false, closedAt: null, reason: null });

    it("closes the account's own draft as expired, once; a repeat answers the first close", async () => {
      const draftId = randomUUID();
      await register('lab', draftId, users.jordan);
      // LAB closes without picking anyone: the clean-up is the browser's, not a person's.
      const first = await closed(await close('lab', draftId));
      expect(first).toMatchObject({ draftId, closed: true, reason: 'expired' });
      const before = await fingerprint();
      const columns = await closeColumns(draftId);
      const again = await closed(await close('lab', draftId));
      expect(again).toEqual(first);
      expect(await closeColumns(draftId)).toEqual(columns);
      expect(await fingerprint()).toBe(before);
      const { rows } = await db.pool.query(
        `SELECT actor_user_id, after_values FROM audit_event
         WHERE entity_type = 'receipt_draft' AND entity_id = $1 AND action = 'receipt_draft.closed'`,
        [draftId],
      );
      expect(rows).toEqual([{ actor_user_id: users.lab, after_values: { reason: 'expired' } }]);
      // Closing is not deleting.
      expect((await ownership('lab', [draftId], users.jordan))[0]).toMatchObject({
        deletedAt: null,
      });
    });

    it('a confirmed draft keeps its first reason', async () => {
      const draftId = randomUUID();
      await register('pat', draftId);
      await db.pool.query(
        `UPDATE receipt_draft_registry SET closed_at = now(), closed_reason = 'confirmed'
         WHERE draft_id = $1`,
        [draftId],
      );
      const before = await fingerprint();
      expect(await closed(await close('pat', draftId))).toMatchObject({
        closed: true,
        reason: 'confirmed',
      });
      expect(await fingerprint()).toBe(before);
    });

    it("never closes another account's, a deleted or an unknown draft, and answers each the same", async () => {
      const personal = randomUUID();
      const station = randomUUID();
      const deleted = randomUUID();
      await register('pat', personal);
      await register('lab', station, users.pat);
      await register('sam', deleted);
      expect((await remove('sam', deleted)).status).toBe(200);
      const before = await fingerprint();
      // Another person, a Lab Manager, LAB on a personal draft, the starter on LAB's draft.
      expect(await closed(await close('jordan', personal))).toEqual(nothing(personal));
      expect(await closed(await close('morgan', personal))).toEqual(nothing(personal));
      expect(await closed(await close('lab', personal))).toEqual(nothing(personal));
      expect(await closed(await close('pat', station))).toEqual(nothing(station));
      expect(await closed(await close('sam', deleted))).toEqual(nothing(deleted));
      const unknown = randomUUID();
      expect(await closed(await close('pat', unknown))).toEqual(nothing(unknown));
      expect(await fingerprint()).toBe(before);
      expect((await closeColumns(personal))?.closed_reason).toBeNull();
      expect((await closeColumns(station))?.closed_reason).toBeNull();
      expect(await closeColumns(unknown)).toBeUndefined();
    });

    it("accepts only reason 'expired' and nothing else in the body", async () => {
      const draftId = randomUUID();
      await register('pat', draftId);
      const before = await fingerprint();
      expect((await close('pat', draftId, { reason: 'confirmed' })).status).toBe(400);
      expect((await close('pat', draftId, {})).status).toBe(400);
      expect(
        (await close('pat', draftId, { reason: 'expired', personUserId: users.pat })).status,
      ).toBe(400);
      expect((await close('pat', 'not-a-uuid')).status).toBe(400);
      expect(await fingerprint()).toBe(before);
      expect((await closeColumns(draftId))?.closed_reason).toBeNull();
    });
  });

  it('cancelling records nothing: reading ownership writes no row and no audit', async () => {
    const draftId = randomUUID();
    await register('sam', draftId);
    const unknown = randomUUID();
    const before = await fingerprint();
    const items = await ownership('sam', [draftId, unknown, draftId]);
    expect(items.map((i) => i.draftId)).toEqual([draftId, unknown]);
    expect(await fingerprint()).toBe(before);
  });

  it('a legacy draft (never registered) is deleted only by a Lab Manager, with no owner invented', async () => {
    const draftId = randomUUID();
    expect((await ownership('pat', [draftId]))[0]).toMatchObject({
      registered: false,
      starter: null,
      canDelete: false,
      reason: 'unregistered',
    });
    const before = await fingerprint();
    await expectForbidden(await remove('pat', draftId), 'unregistered');
    await expectForbidden(await remove('lab', draftId, users.pat), 'unregistered');
    expect(await fingerprint()).toBe(before);

    const done = await remove('morgan', draftId);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    const { rows } = await db.pool.query(
      `SELECT legacy, account_user_id, starter_user_id, deleted_by_user_id
       FROM receipt_draft_registry WHERE draft_id = $1`,
      [draftId],
    );
    expect(rows[0]).toEqual({
      legacy: true,
      account_user_id: null,
      starter_user_id: null,
      deleted_by_user_id: users.morgan,
    });
    const repeat = await fingerprint();
    expect((await remove('morgan', draftId)).status).toBe(200);
    expect(await fingerprint()).toBe(repeat);
    // Registering it afterwards is refused: its ownership was never recorded.
    expect((await register('pat', draftId)).status).toBe(409);
  });

  it('needs a session and the CSRF header', async () => {
    const draftId = randomUUID();
    expect((await http().get(`/api/receipt-drafts?ids=${draftId}`)).status).toBe(401);
    const noCsrf = await http()
      .post('/api/receipt-drafts')
      .set('Cookie', cookies.pat!)
      .send({ draftId });
    expect(noCsrf.status).toBe(403);
  });
});

describe('decideDraftDelete', () => {
  const person = (userId: string) => ({ userId, initials: 'XX', name: userId });
  const user = (
    userId: string,
    accountType: AuthUser['accountType'],
    roles: AuthUser['roles'] = [],
  ): AuthUser => ({
    userId,
    sessionId: 's',
    accountType,
    status: 'active',
    roles,
    displayName: userId,
    initials: null,
  });
  const row = (account: string, starter: string, station = false): DraftRegistryRow => ({
    draftId: 'd',
    legacy: false,
    accountUserId: account,
    accountIsStation: station,
    starter: person(starter),
    createdAt: new Date(),
    deletedAt: null,
  });

  it('follows STRATA-108', () => {
    expect(decideDraftDelete(user('pat', 'personal'), null, row('pat', 'pat'))).toEqual({
      canDelete: true,
      reason: 'starter',
    });
    expect(decideDraftDelete(user('jo', 'personal'), null, row('pat', 'pat')).reason).toBe(
      'not_starter',
    );
    expect(decideDraftDelete(user('mm', 'personal', ['lab_manager']), null, null).reason).toBe(
      'lab_manager',
    );
    expect(decideDraftDelete(user('pat', 'personal'), null, null).reason).toBe('unregistered');
    // LAB roles never count, even if one was assigned by mistake.
    expect(
      decideDraftDelete(user('lab', 'shared_lab', ['lab_manager']), person('jo'), null).reason,
    ).toBe('unregistered');
    expect(
      decideDraftDelete(user('lab', 'shared_lab'), person('jo'), row('lab', 'jo', true)).canDelete,
    ).toBe(true);
    expect(
      decideDraftDelete(user('lab2', 'shared_lab'), person('jo'), row('lab', 'jo', true)).reason,
    ).toBe('other_account');
    expect(
      decideDraftDelete({ ...user('pat', 'personal'), status: 'disabled' }, null, row('pat', 'pat'))
        .canDelete,
    ).toBe(false);
  });
});
