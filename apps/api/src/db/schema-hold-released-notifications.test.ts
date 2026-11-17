import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';

// STRATA-133 (migration 0051): "hold released" notices on the MM-T91 notification table, each
// rule proven in the database. Fictional people and project (DEMO-2601) only.

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };

describe.runIf(testDatabaseUrl)('hold-released notifications (STRATA-133, migration 0051)', () => {
  let db: TestSchema;
  let lead: string;
  let manager: string;
  let asker: string;
  let project: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    lead = await insertUser(db.pool, 'PE');
    manager = await insertUser(db.pool, 'LM');
    asker = await insertUser(db.pool, 'AT');
    project = await insertProject(db.pool, 'DEMO-2601', lead);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function hold(placedBy: string, requestId: string | null = null): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO retention_hold (project_id, scope, reason, placed_by_user_id,
                                   placed_by_name_snapshot, idempotency_key, request_hash,
                                   request_id)
       VALUES ($1, 'project', 'Claim review', $2, 'Test placer', $3, 'hash', $4) RETURNING id`,
      [project, placedBy, randomUUID(), requestId],
    );
    return rows[0]!.id;
  }

  /** A hold that came from `asker`'s approved request, placed by `decider`. */
  async function requestedHold(requester: string, decider: string): Promise<string> {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO retention_request (project_id, kind, scope, reason, requested_by_user_id,
                                      requested_by_name_snapshot, idempotency_key, request_hash)
       VALUES ($1, 'hold', 'project', 'Asked', $2, 'Test asker', $3, 'hash') RETURNING id`,
      [project, requester, randomUUID()],
    );
    const requestId = rows[0]!.id;
    const holdId = await hold(decider, requestId);
    await db.pool.query(
      `UPDATE retention_request
       SET status = 'approved', decided_at = now(), decided_by_user_id = $2,
           decided_by_name_snapshot = 'Test decider', hold_id = $3, decision_idempotency_key = $4,
           decision_request_hash = 'hash'
       WHERE id = $1`,
      [requestId, decider, holdId, randomUUID()],
    );
    return holdId;
  }

  const release = (holdId: string, by: string) =>
    db.pool.query(
      `UPDATE retention_hold
       SET released_at = now(), released_by_user_id = $2, released_by_name_snapshot = 'Test releaser',
           release_reason = 'Claim settled', version = version + 1,
           release_idempotency_key = $3, release_request_hash = 'hash'
       WHERE id = $1`,
      [holdId, by, randomUUID()],
    );

  const notices = async (holdId: string) =>
    (
      await db.pool.query<{ recipient_user_id: string; event_key: string }>(
        `SELECT recipient_user_id, event_key FROM notification
         WHERE kind = 'retention_hold.released' AND retention_hold_id = $1`,
        [holdId],
      )
    ).rows;

  const insert = (recipient: string, holdId: string, extra: Record<string, unknown> = {}) => {
    const values: Record<string, unknown> = {
      recipient_user_id: recipient,
      kind: 'retention_hold.released',
      retention_hold_id: holdId,
      event_key: `retention_hold:${holdId}:released`,
      ...extra,
    };
    const columns = Object.keys(values);
    return db.pool.query(
      `INSERT INTO notification (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')})`,
      Object.values(values),
    );
  };

  it('notifies the placer once when someone else releases the hold', async () => {
    const id = await hold(lead);
    await release(id, manager);
    expect(await notices(id)).toEqual([
      { recipient_user_id: lead, event_key: `retention_hold:${id}:released` },
    ]);
  });

  it('notifies the requester, not the decider who placed it, for a requested hold', async () => {
    const id = await requestedHold(asker, lead);
    await release(id, manager);
    expect((await notices(id)).map((n) => n.recipient_user_id)).toEqual([asker]);
  });

  it('writes nothing when the recipient releases it themself', async () => {
    const placed = await hold(lead);
    await release(placed, lead);
    expect(await notices(placed)).toEqual([]);
    const requested = await requestedHold(asker, lead);
    await release(requested, asker);
    expect(await notices(requested)).toEqual([]);
  });

  it('skips a disabled recipient', async () => {
    const gone = await insertUser(db.pool, 'GN');
    const id = await hold(gone);
    await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [gone]);
    await release(id, manager);
    expect(await notices(id)).toEqual([]);
  });

  it('a hold is released once, so a second release writes no second notice', async () => {
    const id = await hold(lead);
    await release(id, manager);
    await expect(release(id, manager)).rejects.toMatchObject(RESTRICT);
    expect(await notices(id)).toHaveLength(1);
  });

  it('refuses a notice for anyone but the hold’s recipient, or for an unreleased hold', async () => {
    const open = await hold(lead);
    await expect(insert(lead, open)).rejects.toMatchObject(REJECT);
    const id = await requestedHold(asker, lead);
    await release(id, manager);
    await expect(insert(lead, id)).rejects.toMatchObject(REJECT);
    await expect(insert(manager, id)).rejects.toMatchObject(REJECT);
    const self = await hold(lead);
    await release(self, lead);
    await expect(insert(lead, self)).rejects.toMatchObject(REJECT);
  });

  it('refuses the wrong key, a missing hold, and a hold on any other kind', async () => {
    const id = await hold(lead);
    await release(id, manager);
    await expect(
      insert(lead, id, { event_key: `retention_hold:${randomUUID()}:released` }),
    ).rejects.toMatchObject(REJECT);
    await expect(
      db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, event_key)
         VALUES ($1, 'retention_hold.released', 'retention_hold:x:released')`,
        [lead],
      ),
    ).rejects.toMatchObject(REJECT);
    await expect(
      db.pool.query(
        `INSERT INTO notification (recipient_user_id, kind, retention_hold_id, event_key)
         VALUES ($1, 'concrete_test.failed', $2, 'concrete_test.failed:x')`,
        [lead, id],
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('freezes the hold: only the read state changes', async () => {
    const id = await hold(lead);
    await release(id, manager);
    const other = await hold(lead);
    await expect(
      db.pool.query(`UPDATE notification SET retention_hold_id = $2 WHERE retention_hold_id = $1`, [
        id,
        other,
      ]),
    ).rejects.toMatchObject(RESTRICT);
    await expect(
      db.pool.query(`UPDATE notification SET read_at = now() WHERE retention_hold_id = $1`, [id]),
    ).resolves.toBeTruthy();
  });
});
