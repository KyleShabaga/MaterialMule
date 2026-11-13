import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';

// Strata lane A (migration 0049): a receiving draft's close (confirmed, or deleted by the
// browser's automatic clean-up) is recorded on the registry once and never changed or cleared,
// is not a deletion, and leaves 0044's rules on every other column in place. Fictional people.

const REJECT = { code: PG.checkViolation };

describe.runIf(testDatabaseUrl)('receipt draft close (0049)', () => {
  let db: TestSchema;
  let lab: string;
  let pat: string;
  let jordan: string;

  async function addUser(name: string, accountType: 'personal' | 'shared_lab') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [name, accountType === 'shared_lab' ? null : name.slice(0, 2).toUpperCase(), accountType],
    );
    return rows[0]!.id;
  }

  async function register(account: string, starter: string) {
    const id = randomUUID();
    await db.pool.query(
      `INSERT INTO receipt_draft_registry (draft_id, account_user_id, starter_user_id)
       VALUES ($1, $2, $3)`,
      [id, account, starter],
    );
    return id;
  }

  const set = (id: string, sql: string, ...params: unknown[]) =>
    db.pool.query(`UPDATE receipt_draft_registry SET ${sql} WHERE draft_id = $1`, [id, ...params]);
  const close = (id: string, reason: string) =>
    set(id, 'closed_at = now(), closed_reason = $2', reason);
  const markDeleted = (id: string, account: string, person: string) =>
    set(
      id,
      'deleted_at = now(), deleted_by_account_user_id = $2, deleted_by_user_id = $3',
      account,
      person,
    );

  async function row(id: string) {
    const { rows } = await db.pool.query(
      `SELECT closed_at, closed_reason, deleted_at FROM receipt_draft_registry WHERE draft_id = $1`,
      [id],
    );
    return rows[0] as {
      closed_at: Date | null;
      closed_reason: string | null;
      deleted_at: Date | null;
    };
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    lab = await addUser('LAB', 'shared_lab');
    pat = await addUser('Pat Example', 'personal');
    jordan = await addUser('Jordan Lab', 'personal');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a draft is registered open; closing records a time and a reason together', async () => {
    const id = await register(lab, jordan);
    expect(await row(id)).toMatchObject({ closed_at: null, closed_reason: null });
    await expect(set(id, 'closed_at = now()')).rejects.toMatchObject(REJECT);
    await expect(set(id, `closed_reason = 'confirmed'`)).rejects.toMatchObject(REJECT);
    await expect(close(id, 'confirmed')).resolves.toBeDefined();
    expect(await row(id)).toMatchObject({ closed_reason: 'confirmed', deleted_at: null });
  });

  it("accepts only 'confirmed' and 'expired'", async () => {
    const id = await register(pat, pat);
    await expect(close(id, 'deleted')).rejects.toMatchObject(REJECT);
    await expect(close(id, 'Confirmed')).rejects.toMatchObject(REJECT);
    await expect(close(id, 'expired')).resolves.toBeDefined();
  });

  it('records a close once: never changed, re-dated or cleared', async () => {
    const id = await register(pat, pat);
    await close(id, 'expired');
    const first = await row(id);
    await expect(close(id, 'confirmed')).rejects.toMatchObject(REJECT);
    await expect(set(id, `closed_at = closed_at + interval '1 minute'`)).rejects.toMatchObject(
      REJECT,
    );
    await expect(set(id, 'closed_at = NULL, closed_reason = NULL')).rejects.toMatchObject(REJECT);
    expect(await row(id)).toEqual(first);
  });

  it('a draft is never registered already closed, nor closed before it was started', async () => {
    await expect(
      db.pool.query(
        `INSERT INTO receipt_draft_registry
           (draft_id, account_user_id, starter_user_id, closed_at, closed_reason)
         VALUES ($1, $2, $2, now(), 'confirmed')`,
        [randomUUID(), pat],
      ),
    ).rejects.toMatchObject(REJECT);
    const id = await register(pat, pat);
    await expect(
      set(id, `closed_at = created_at - interval '1 day', closed_reason = 'confirmed'`),
    ).rejects.toMatchObject(REJECT);
  });

  it('a close is not a deletion; a deleted draft is never closed afterwards', async () => {
    const closed = await register(lab, jordan);
    await close(closed, 'confirmed');
    expect((await row(closed)).deleted_at).toBeNull();
    // 0044's deletion stays its own fact.
    await expect(markDeleted(closed, lab, jordan)).resolves.toBeDefined();
    const deleted = await register(pat, pat);
    await markDeleted(deleted, pat, pat);
    await expect(close(deleted, 'expired')).rejects.toMatchObject(REJECT);
    expect(await row(deleted)).toMatchObject({ closed_at: null, closed_reason: null });
  });

  it("keeps 0044's rules on a closed row: who started it never changes, rows never deleted", async () => {
    const id = await register(lab, jordan);
    await close(id, 'confirmed');
    await expect(set(id, 'starter_user_id = $2', pat)).rejects.toMatchObject(REJECT);
    await expect(set(id, 'account_user_id = $2', pat)).rejects.toMatchObject(REJECT);
    await expect(set(id, `created_at = created_at - interval '1 day'`)).rejects.toMatchObject(
      REJECT,
    );
    await expect(set(id, 'legacy = true')).rejects.toMatchObject(REJECT);
    await expect(
      db.pool.query('DELETE FROM receipt_draft_registry WHERE draft_id = $1', [id]),
    ).rejects.toMatchObject(REJECT);
  });
});
