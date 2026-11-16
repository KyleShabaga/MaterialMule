import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIDEBAR_RECORD_KINDS } from '@materialmule/shared';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertUser } from '../test-support/fixtures.js';

// Strata 1C (migration 0038): per-person settings, pins and recents. Each rule proven in the
// database. Fictional data only.

const CHECK = { code: PG.checkViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FK = { code: PG.foreignKeyViolation };
const RECORD = '00000000-0000-4000-8000-0000000000a1';
const MISSING_USER = '00000000-0000-4000-8000-0000000000ff';

describe.runIf(testDatabaseUrl)('person settings, pins and recents (0038)', () => {
  let db: TestSchema;
  let person: string;
  let other: string;
  let lab: string;

  const setting = (userId: string, area: string, value: unknown = {}, version = 1) =>
    db.pool.query(
      'INSERT INTO person_setting (user_id, area, value, version) VALUES ($1, $2, $3, $4)',
      [userId, area, JSON.stringify(value), version],
    );
  const pin = (userId: string, kind: string, id = RECORD) =>
    db.pool.query('INSERT INTO person_pin (user_id, record_kind, record_id) VALUES ($1, $2, $3)', [
      userId,
      kind,
      id,
    ]);
  const recent = (userId: string, kind: string, id = RECORD) =>
    db.pool.query(
      'INSERT INTO person_recent (user_id, record_kind, record_id) VALUES ($1, $2, $3)',
      [userId, kind, id],
    );

  beforeAll(async () => {
    db = await createMigratedSchema();
    person = await insertUser(db.pool, 'PE');
    other = await insertUser(db.pool, 'OE');
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO app_user (display_name, account_type, status)
       VALUES ('LAB (fictional)', 'shared_lab', 'active') RETURNING id`,
    );
    lab = rows[0]!.id;
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('keeps one setting per person per area, for the three known areas only', async () => {
    for (const area of ['sidebar_layout', 'preferences', 'table_columns']) {
      await expect(setting(person, area)).resolves.toBeDefined();
    }
    await expect(setting(person, 'preferences')).rejects.toMatchObject(UNIQUE);
    await expect(setting(other, 'preferences')).resolves.toBeDefined();
    await expect(setting(other, 'theme')).rejects.toMatchObject(CHECK);
  });

  it('stores a JSON object with a version of at least 1', async () => {
    await expect(setting(other, 'sidebar_layout', [])).rejects.toMatchObject(CHECK);
    await expect(setting(other, 'sidebar_layout', 'dark')).rejects.toMatchObject(CHECK);
    await expect(setting(other, 'sidebar_layout', {}, 0)).rejects.toMatchObject(CHECK);
  });

  it('pins and recents take the sidebar record kinds only, once per person and record', async () => {
    for (const kind of SIDEBAR_RECORD_KINDS) {
      await expect(pin(person, kind)).resolves.toBeDefined();
      await expect(recent(person, kind)).resolves.toBeDefined();
    }
    await expect(pin(person, 'storage_unit')).rejects.toMatchObject(UNIQUE);
    await expect(recent(person, 'project')).rejects.toMatchObject(UNIQUE);
    await expect(pin(other, 'storage_unit')).resolves.toBeDefined();
    await expect(pin(person, 'test_hole')).rejects.toMatchObject(CHECK);
    await expect(recent(person, 'concrete_report')).rejects.toMatchObject(CHECK);
  });

  it('belongs to an existing account', async () => {
    await expect(setting(MISSING_USER, 'preferences')).rejects.toMatchObject(FK);
    await expect(pin(MISSING_USER, 'project')).rejects.toMatchObject(FK);
    await expect(recent(MISSING_USER, 'project')).rejects.toMatchObject(FK);
  });

  it('never belongs to the shared LAB account, on insert or by moving a row to it', async () => {
    await expect(setting(lab, 'sidebar_layout')).rejects.toMatchObject(CHECK);
    await expect(pin(lab, 'project')).rejects.toMatchObject(CHECK);
    await expect(recent(lab, 'project')).rejects.toMatchObject(CHECK);
    await recent(other, 'project');
    for (const table of ['person_setting', 'person_pin', 'person_recent']) {
      await expect(
        db.pool.query(`UPDATE ${table} SET user_id = $1 WHERE user_id = $2`, [lab, other]),
      ).rejects.toMatchObject(CHECK);
    }
  });
});
