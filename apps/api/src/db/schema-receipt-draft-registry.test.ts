import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';

// STRATA-108 (migration 0044): the receiving draft registry. Ownership metadata only: who started
// a draft never changes, and a deletion is recorded once. Every rule proven in the database with
// fictional people only.

const REJECT = { code: PG.checkViolation };

describe.runIf(testDatabaseUrl)('receipt draft registry (0044)', () => {
  let db: TestSchema;
  let lab: string;
  let pat: string;
  let jordan: string;
  let sam: string;

  async function addUser(name: string, accountType: 'personal' | 'shared_lab' | 'test') {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, official_initials, account_type, status)
       VALUES ($1, $2, $3, 'active') RETURNING id`,
      [name, accountType === 'shared_lab' ? null : name.slice(0, 2).toUpperCase(), accountType],
    );
    return rows[0]!.id;
  }

  const register = (draftId: string, account: string, starter: string) =>
    db.pool.query(
      `INSERT INTO receipt_draft_registry (draft_id, account_user_id, starter_user_id)
       VALUES ($1, $2, $3)`,
      [draftId, account, starter],
    );

  const markDeleted = (draftId: string, account: string, person: string) =>
    db.pool.query(
      `UPDATE receipt_draft_registry
       SET deleted_at = now(), deleted_by_account_user_id = $2, deleted_by_user_id = $3
       WHERE draft_id = $1`,
      [draftId, account, person],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    lab = await addUser('LAB', 'shared_lab');
    pat = await addUser('Pat Example', 'personal');
    jordan = await addUser('Jordan Lab', 'personal');
    sam = await addUser('Sam Sample', 'test');
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('a personal account starts drafts as itself; LAB names a person, never itself', async () => {
    await expect(register(randomUUID(), pat, pat)).resolves.toBeDefined();
    await expect(register(randomUUID(), sam, sam)).resolves.toBeDefined();
    await expect(register(randomUUID(), lab, jordan)).resolves.toBeDefined();
    await expect(register(randomUUID(), pat, jordan)).rejects.toMatchObject(REJECT);
    await expect(register(randomUUID(), lab, lab)).rejects.toMatchObject(REJECT);
  });

  it('keeps one row per draft ID', async () => {
    const id = randomUUID();
    await register(id, pat, pat);
    await expect(register(id, jordan, jordan)).rejects.toMatchObject({
      code: PG.uniqueViolation,
    });
  });

  it('never changes who started a draft, on which account, or when', async () => {
    const id = randomUUID();
    await register(id, lab, jordan);
    const change = (sql: string, ...params: unknown[]) =>
      db.pool.query(`UPDATE receipt_draft_registry SET ${sql} WHERE draft_id = $1`, [
        id,
        ...params,
      ]);
    await expect(change('starter_user_id = $2', pat)).rejects.toMatchObject(REJECT);
    await expect(change('account_user_id = $2', pat)).rejects.toMatchObject(REJECT);
    await expect(change(`created_at = created_at - interval '1 day'`)).rejects.toMatchObject(
      REJECT,
    );
    await expect(change('draft_id = $2', randomUUID())).rejects.toMatchObject(REJECT);
    await expect(change('legacy = true')).rejects.toMatchObject(REJECT);
    const { rows } = await db.pool.query(
      'SELECT account_user_id, starter_user_id FROM receipt_draft_registry WHERE draft_id = $1',
      [id],
    );
    expect(rows[0]).toEqual({ account_user_id: lab, starter_user_id: jordan });
  });

  it('records a deletion once, with the account and the person, and never rewrites it', async () => {
    const id = randomUUID();
    await register(id, lab, jordan);
    // All three deletion facts come together.
    await expect(
      db.pool.query(`UPDATE receipt_draft_registry SET deleted_at = now() WHERE draft_id = $1`, [
        id,
      ]),
    ).rejects.toMatchObject(REJECT);
    await expect(markDeleted(id, lab, jordan)).resolves.toBeDefined();
    await expect(markDeleted(id, lab, jordan)).rejects.toMatchObject(REJECT);
    await expect(
      db.pool.query(
        `UPDATE receipt_draft_registry
         SET deleted_at = NULL, deleted_by_account_user_id = NULL, deleted_by_user_id = NULL
         WHERE draft_id = $1`,
        [id],
      ),
    ).rejects.toMatchObject(REJECT);
  });

  it('credits a deletion to a person: the account itself, or the LAB station pick', async () => {
    const a = randomUUID();
    await register(a, pat, pat);
    await expect(markDeleted(a, pat, jordan)).rejects.toMatchObject(REJECT);
    await expect(markDeleted(a, lab, lab)).rejects.toMatchObject(REJECT);
    await expect(markDeleted(a, jordan, jordan)).resolves.toBeDefined();
  });

  it('never deletes a row', async () => {
    const id = randomUUID();
    await register(id, pat, pat);
    await expect(
      db.pool.query('DELETE FROM receipt_draft_registry WHERE draft_id = $1', [id]),
    ).rejects.toMatchObject(REJECT);
  });

  it('a legacy draft has no owner and exists only as a deletion record', async () => {
    const insert = (values: string, params: unknown[]) =>
      db.pool.query(
        `INSERT INTO receipt_draft_registry
           (draft_id, legacy, account_user_id, starter_user_id, deleted_at,
            deleted_by_account_user_id, deleted_by_user_id)
         VALUES ${values}`,
        params,
      );
    await expect(
      insert(`($1, true, NULL, NULL, now(), $2, $2)`, [randomUUID(), jordan]),
    ).resolves.toBeDefined();
    // Never an invented owner, and never an undeleted legacy row.
    await expect(
      insert(`($1, true, $2, $2, now(), $2, $2)`, [randomUUID(), jordan]),
    ).rejects.toMatchObject(REJECT);
    await expect(
      insert(`($1, true, NULL, NULL, NULL, NULL, NULL)`, [randomUUID()]),
    ).rejects.toMatchObject(REJECT);
    // An ordinary row always has its owner.
    await expect(
      insert(`($1, false, NULL, NULL, NULL, NULL, NULL)`, [randomUUID()]),
    ).rejects.toMatchObject(REJECT);
  });
});
