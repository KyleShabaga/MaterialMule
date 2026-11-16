import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertUser } from '../test-support/fixtures.js';

// STRATA-104 / STRATA-118 (migration 0042): feedback notices on the MM-T91 notification table,
// each rule proven in the database. Fictional people only.

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

describe.runIf(testDatabaseUrl)('feedback notifications (STRATA-104, migration 0042)', () => {
  let db: TestSchema;
  let admin: string;
  let manager: string;
  let sender: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    admin = await insertUser(db.pool, 'AD');
    manager = await insertUser(db.pool, 'LM');
    sender = await insertUser(db.pool, 'AT');
    await db.pool.query(
      `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'admin'), ($2, 'lab_manager')`,
      [admin, manager],
    );
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function event(action = 'feedback.submitted', submissionId?: string) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO audit_event (action, entity_type, actor_user_id, actor_account_type,
                                actor_name_snapshot, after_values)
       VALUES ($1, 'feedback', $2, 'test', 'Test AT', $3) RETURNING id`,
      [
        action,
        sender,
        {
          kind: 'idea',
          text: 'Fictional',
          page: '/help',
          ...(submissionId ? { submissionId } : {}),
        },
      ],
    );
    return rows[0]!.id;
  }

  const insert = (recipient: string, eventId: string, eventKey?: string, extra = {}) => {
    const values: Record<string, unknown> = {
      recipient_user_id: recipient,
      kind: 'feedback.submitted',
      feedback_event_id: eventId,
      event_key: eventKey ?? `audit_event:${eventId}:feedback`,
      ...extra,
    };
    const columns = Object.keys(values);
    return db.pool.query<{ id: string }>(
      `INSERT INTO notification (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
      Object.values(values),
    );
  };

  it('admits one notice per administrator per feedback event', async () => {
    const id = await event();
    await expect(insert(admin, id)).resolves.toBeTruthy();
    await expect(insert(admin, id)).rejects.toMatchObject(UNIQUE);
  });

  it('refuses a notice for anyone who is not an administrator', async () => {
    const id = await event();
    await expect(insert(manager, id)).rejects.toMatchObject(REJECT);
    await expect(insert(sender, id)).rejects.toMatchObject(REJECT);
  });

  it('refuses a notice that names no feedback event, another event or the wrong key', async () => {
    const other = await event('staff.approved');
    await expect(insert(admin, other)).rejects.toMatchObject(REJECT);
    const id = await event();
    await expect(insert(admin, id, `audit_event:${randomUUID()}:feedback`)).rejects.toMatchObject(
      REJECT,
    );
    await expect(
      db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, event_key)
         VALUES ($1, 'feedback.submitted', 'audit_event:x:feedback')`,
        [admin],
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('refuses a feedback event on any other kind', async () => {
    const id = await event();
    await expect(
      db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, feedback_event_id, event_key)
         VALUES ($1, 'concrete_test.failed', $2, 'concrete_test.failed:x')`,
        [admin, id],
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('freezes the feedback event: only the read state changes', async () => {
    const id = await event();
    const other = await event();
    const { rows } = await insert(admin, id);
    await expect(
      db.pool.query('UPDATE notification SET feedback_event_id = $2 WHERE id = $1', [
        rows[0]!.id,
        other,
      ]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query('UPDATE notification SET read_at = now() WHERE id = $1', [rows[0]!.id]),
    ).resolves.toBeTruthy();
  });

  it('keeps one person’s feedback unique on its submission id', async () => {
    const submissionId = randomUUID();
    await event('feedback.submitted', submissionId);
    await expect(event('feedback.submitted', submissionId)).rejects.toMatchObject(UNIQUE);
  });
});
