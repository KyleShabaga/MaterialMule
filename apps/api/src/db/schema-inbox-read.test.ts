import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject } from '../test-support/fixtures.js';

// STRATA-25 (migration 0039): each person's Inbox read state for action requests, proven in the
// database. One row per (person, request); only active personal or test accounts (never LAB or a
// disabled account); rows are never deleted or moved, only read or unread; and writing read state
// never changes the request. Fictional data only (DEMO-2601, invented people).
describe.runIf(testDatabaseUrl)('inbox request read state (STRATA-25, migration 0039)', () => {
  let db: TestSchema;
  let lead: string;
  let requester: string;
  let fixture: string;
  let disabled: string;
  let lab: string;
  let projectId: string;
  let itemId: string;

  async function person(name: string, accountType: string, status = 'active') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, $4) RETURNING id`,
      [
        name,
        accountType === 'shared_lab' ? null : name.slice(0, 2).toUpperCase(),
        accountType,
        status,
      ],
    );
    return rows[0]!.id;
  }

  async function retentionRequest(): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO action_item (kind, target_role, entity_type, entity_id, target_user_id,
                                project_id, created_by_user_id, created_by_name_snapshot, reason,
                                idempotency_key, request_hash)
       VALUES ('retention_request', 'lab_manager', 'retention_request', gen_random_uuid(), $3,
               $1, $2, 'Alex Tester', 'Fictional reason', gen_random_uuid(), 'hash')
       RETURNING id`,
      [projectId, requester, lead],
    );
    return rows[0]!.id;
  }

  const mark = (user: string, item: string, read: boolean) =>
    db.pool.query(
      `INSERT INTO inbox_request_read (user_id, action_item_id, read_at)
       VALUES ($1, $2, CASE WHEN $3 THEN now() END)
       ON CONFLICT (user_id, action_item_id)
       DO UPDATE SET read_at = EXCLUDED.read_at, updated_at = now()`,
      [user, item, read],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await person('Pat Example', 'personal');
    requester = await person('Alex Tester', 'personal');
    fixture = await person('Test Fixture', 'test');
    disabled = await person('Former Staff', 'personal', 'disabled');
    lab = await person('LAB', 'shared_lab');
    projectId = await insertProject(db.pool, 'DEMO-2601', lead);
    itemId = await retentionRequest();
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps one row per person and request', async () => {
    await mark(lead, itemId, true);
    await expect(
      db.pool.query(
        `INSERT INTO inbox_request_read (user_id, action_item_id, read_at) VALUES ($1, $2, now())`,
        [lead, itemId],
      ),
    ).rejects.toMatchObject({ code: PG.uniqueViolation });
    await mark(lead, itemId, false);
    const { rows } = await db.pool.query<{ read_at: Date | null }>(
      'SELECT read_at FROM inbox_request_read WHERE user_id = $1 AND action_item_id = $2',
      [lead, itemId],
    );
    expect(rows).toEqual([{ read_at: null }]);
  });

  it('only active personal or test accounts have read state (never LAB or disabled)', async () => {
    await mark(fixture, itemId, true);
    for (const who of [lab, disabled]) {
      await expect(mark(who, itemId, true)).rejects.toMatchObject({
        code: PG.checkViolation,
        constraint: 'inbox_request_read_reader_check',
      });
    }
  });

  it('names a real person and a real request', async () => {
    await expect(mark('00000000-0000-4000-8000-00000000ffff', itemId, true)).rejects.toMatchObject({
      code: expect.stringMatching(/^(23503|23514)$/),
    });
    await expect(mark(lead, '00000000-0000-4000-8000-00000000ffff', true)).rejects.toMatchObject({
      code: PG.foreignKeyViolation,
    });
  });

  it('is never deleted, truncated or moved to another person or request', async () => {
    const other = await retentionRequest();
    await mark(requester, itemId, true);
    await expect(
      db.pool.query('DELETE FROM inbox_request_read WHERE user_id = $1', [requester]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(db.pool.query('TRUNCATE inbox_request_read')).rejects.toMatchObject({
      code: PG.restrictViolation,
    });
    await expect(
      db.pool.query('UPDATE inbox_request_read SET user_id = $2 WHERE user_id = $1', [
        requester,
        fixture,
      ]),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
    await expect(
      db.pool.query(
        'UPDATE inbox_request_read SET action_item_id = $2 WHERE user_id = $1 AND action_item_id = $3',
        [requester, other, itemId],
      ),
    ).rejects.toMatchObject({ code: PG.restrictViolation });
  });

  it('reading or unreading never changes the request', async () => {
    const before = await db.pool.query('SELECT * FROM action_item WHERE id = $1', [itemId]);
    await mark(lead, itemId, true);
    await mark(lead, itemId, false);
    await mark(lead, itemId, true);
    const after = await db.pool.query('SELECT * FROM action_item WHERE id = $1', [itemId]);
    expect(after.rows).toEqual(before.rows);
  });
});
