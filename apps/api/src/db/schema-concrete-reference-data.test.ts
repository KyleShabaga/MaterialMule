import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C37 (migration 0028): concrete suppliers, the company holiday calendar and mix draft
// discard, proven in the database. Fictional data only (DEMO- projects, invented suppliers).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };
const FOREIGN = { code: PG.foreignKeyViolation };

const COMPLETE = `specified_strength_mpa = 32, slump_target_mm = 80, slump_tolerance_mm = 30,
  air_min_percent = 5, air_max_percent = 8, max_aggregate_size_mm = 20, cement_type = 'GU'`;

describe.runIf(testDatabaseUrl)('concrete reference data (MM-V2-C37, migration 0028)', () => {
  let db: TestSchema;
  let user: string;
  let project: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    await runSeed(db.pool, 'reference', 'test');
    user = await insertUser(db.pool, 'PE');
    project = await insertProject(db.pool, 'DEMO-2601', user);
  });

  afterAll(async () => {
    await db?.drop();
  });

  async function tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  async function supplier(name = `Supplier ${randomUUID().slice(0, 8)}`) {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO concrete_supplier (name, created_by_user_id, created_by_name_snapshot)
       VALUES ($1, $2, 'Test PE') RETURNING id`,
      [name, user],
    );
    return rows[0]!.id;
  }

  /** An approved mix (revision 1) with an open draft revision 2, committed. */
  async function mixWithDraft() {
    const mixId = randomUUID();
    const r1 = randomUUID();
    const r2 = randomUUID();
    const name = `Supplier ${randomUUID().slice(0, 8)}`;
    await tx(async (client) => {
      await client.query(
        `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                   created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, $3, '0042', $4, $5, 'Test PE')`,
        [mixId, project, name, r1, user],
      );
      await client.query(
        `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id,
                                            created_by_name_snapshot)
         VALUES ($1, $2, $3, 1, $4, '0042', $5, 'Test PE')`,
        [r1, mixId, project, name, user],
      );
    });
    await tx(async (client) => {
      await client.query(
        `UPDATE concrete_mix_revision SET ${COMPLETE}, state = 'approved', approved_at = now(),
                approved_by_user_id = $2, approved_by_name_snapshot = 'Test PE' WHERE id = $1`,
        [r1, user],
      );
      await client.query(
        `UPDATE concrete_mix SET effective_revision_id = $2, draft_revision_id = NULL,
                version = version + 1 WHERE id = $1`,
        [mixId, r1],
      );
    });
    await tx(async (client) => {
      await client.query(
        `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id,
                                            created_by_name_snapshot)
         VALUES ($1, $2, $3, 2, $4, '0042', $5, 'Test PE')`,
        [r2, mixId, project, name, user],
      );
      await client.query(
        'UPDATE concrete_mix SET draft_revision_id = $2, version = version + 1 WHERE id = $1',
        [mixId, r2],
      );
    });
    return { mixId, r1, r2 };
  }

  const discard = (client: PoolClient, revisionId: string) =>
    client.query(
      `UPDATE concrete_mix_revision SET state = 'discarded', discarded_at = now(),
              discarded_by_user_id = $2, discarded_by_name_snapshot = 'Test PE' WHERE id = $1`,
      [revisionId, user],
    );

  // ---------------------------------------------------------------------------------------------

  it('suppliers: unique names ignoring case, never deleted or truncated, versions step by one', async () => {
    const id = await supplier('Example Ready-Mix');
    await expect(supplier('example ready-mix')).rejects.toMatchObject({
      ...UNIQUE,
      constraint: 'concrete_supplier_name_key',
    });
    await expect(supplier(' Padded ')).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_supplier_name_check',
    });
    await expect(
      db.pool.query(`UPDATE concrete_supplier SET name = 'X' WHERE id = $1`, [id]),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_supplier_version_step' });
    await db.pool.query(
      `UPDATE concrete_supplier SET active = false, version = version + 1 WHERE id = $1`,
      [id],
    );
    await expect(
      db.pool.query(
        `UPDATE concrete_supplier SET created_by_user_id = $2, version = version + 1 WHERE id = $1`,
        [id, randomUUID()],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_supplier_fixed' });
    await expect(
      db.pool.query('DELETE FROM concrete_supplier WHERE id = $1', [id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_supplier_no_delete' });
    await expect(db.pool.query('TRUNCATE concrete_supplier CASCADE')).rejects.toMatchObject({
      ...RESTRICT,
    });
  });

  it('a mix may link a listed supplier; an unknown supplier id is refused', async () => {
    const { mixId } = await mixWithDraft();
    const id = await supplier();
    await db.pool.query(
      'UPDATE concrete_mix SET supplier_id = $2, version = version + 1 WHERE id = $1',
      [mixId, id],
    );
    await expect(
      db.pool.query(
        'UPDATE concrete_mix SET supplier_id = $2, version = version + 1 WHERE id = $1',
        [mixId, randomUUID()],
      ),
    ).rejects.toMatchObject(FOREIGN);
  });

  it('the reference seed holds the Alberta general holidays for 2026–2028 and re-runs cleanly', async () => {
    const { rows } = await db.pool.query<{ d: string; name: string }>(
      `SELECT holiday_on::text AS d, name FROM company_holiday
       WHERE source = 'alberta_general' ORDER BY holiday_on`,
    );
    expect(rows).toHaveLength(27);
    expect(rows.filter((r) => r.d.startsWith('2026'))).toEqual([
      { d: '2026-01-01', name: "New Year's Day" },
      { d: '2026-02-16', name: 'Alberta Family Day' },
      { d: '2026-04-03', name: 'Good Friday' },
      { d: '2026-05-18', name: 'Victoria Day' },
      { d: '2026-07-01', name: 'Canada Day' },
      { d: '2026-09-07', name: 'Labour Day' },
      { d: '2026-10-12', name: 'Thanksgiving Day' },
      { d: '2026-11-11', name: 'Remembrance Day' },
      { d: '2026-12-25', name: 'Christmas Day' },
    ]);
    // Rule checks, independent of the literal list: Family Day is the 3rd Monday of February,
    // Victoria Day the Monday before 25 May, Labour Day the 1st Monday of September, Thanksgiving
    // the 2nd Monday of October, Good Friday two days before Easter Sunday.
    const easter: Record<string, string> = {
      '2026': '2026-04-05',
      '2027': '2027-03-28',
      '2028': '2028-04-16',
    };
    const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();
    for (const year of ['2026', '2027', '2028']) {
      const of = (name: string) => rows.find((r) => r.d.startsWith(year) && r.name === name)!.d;
      const day = (name: string) => Number(of(name).slice(8));
      expect(weekday(of('Alberta Family Day'))).toBe(1);
      expect(day('Alberta Family Day')).toBeGreaterThanOrEqual(15);
      expect(day('Alberta Family Day')).toBeLessThanOrEqual(21);
      expect(weekday(of('Victoria Day'))).toBe(1);
      expect(day('Victoria Day')).toBeGreaterThanOrEqual(18);
      expect(day('Victoria Day')).toBeLessThanOrEqual(24);
      expect(weekday(of('Labour Day'))).toBe(1);
      expect(day('Labour Day')).toBeLessThanOrEqual(7);
      expect(weekday(of('Thanksgiving Day'))).toBe(1);
      expect(day('Thanksgiving Day')).toBeGreaterThanOrEqual(8);
      expect(day('Thanksgiving Day')).toBeLessThanOrEqual(14);
      const gf = new Date(`${easter[year]}T00:00:00Z`);
      gf.setUTCDate(gf.getUTCDate() - 2);
      expect(of('Good Friday')).toBe(gf.toISOString().slice(0, 10));
      for (const [name, md] of [
        ["New Year's Day", '01-01'],
        ['Canada Day', '07-01'],
        ['Remembrance Day', '11-11'],
        ['Christmas Day', '12-25'],
      ] as const) {
        expect(of(name)).toBe(`${year}-${md}`);
      }
    }
    await runSeed(db.pool, 'reference', 'test');
    const { rows: again } = await db.pool.query('SELECT count(*)::int AS n FROM company_holiday');
    expect(again[0]).toEqual({ n: 27 });
  });

  it('holidays: one per date in effect; date and source fixed; removal is final and needs a reason', async () => {
    const { rows } = await db.pool.query<{ id: string }>(
      `INSERT INTO company_holiday (holiday_on, name, source, created_by_user_id,
                                    created_by_name_snapshot)
       VALUES ('2030-08-05', 'Heritage Day', 'company', $1, 'Test PE') RETURNING id`,
      [user],
    );
    const id = rows[0]!.id;
    await expect(
      db.pool.query(
        `INSERT INTO company_holiday (holiday_on, name, source, created_by_user_id,
                                      created_by_name_snapshot)
         VALUES ('2030-08-05', 'Again', 'company', $1, 'Test PE')`,
        [user],
      ),
    ).rejects.toMatchObject({ ...UNIQUE, constraint: 'company_holiday_date_key' });
    // A company holiday names its creator; a seeded one has none.
    await expect(
      db.pool.query(
        `INSERT INTO company_holiday (holiday_on, name, source) VALUES ('2030-01-02', 'X', 'company')`,
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'company_holiday_creator_check' });
    await expect(
      db.pool.query(
        `UPDATE company_holiday SET holiday_on = '2030-08-06', version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'company_holiday_fixed' });
    await expect(
      db.pool.query(
        `UPDATE company_holiday SET removed_at = now(), version = version + 1
                     WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'company_holiday_removal_check' });
    await db.pool.query(
      `UPDATE company_holiday SET removed_at = now(), removed_by_user_id = $2,
              removed_by_name_snapshot = 'Test PE', removal_reason = 'Office open',
              version = version + 1
       WHERE id = $1`,
      [id, user],
    );
    await expect(
      db.pool.query(
        `UPDATE company_holiday SET name = 'Back', version = version + 1 WHERE id = $1`,
        [id],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'company_holiday_removed_final' });
    // The date is free again once the earlier entry is removed.
    await db.pool.query(
      `INSERT INTO company_holiday (holiday_on, name, source, created_by_user_id,
                                    created_by_name_snapshot)
       VALUES ('2030-08-05', 'Heritage Day', 'company', $1, 'Test PE')`,
      [user],
    );
    await expect(
      db.pool.query('DELETE FROM company_holiday WHERE id = $1', [id]),
    ).rejects.toMatchObject({ ...RESTRICT, constraint: 'company_holiday_no_delete' });
    await expect(db.pool.query('TRUNCATE company_holiday')).rejects.toMatchObject({
      ...RESTRICT,
      constraint: 'concrete_reference_no_truncate',
    });
  });

  it('discard: a draft of an approved mix becomes discarded, the approved revision stays', async () => {
    const { mixId, r1, r2 } = await mixWithDraft();
    const { rows: before } = await db.pool.query(
      'SELECT row_to_json(r)::text AS row FROM concrete_mix_revision r WHERE id = $1',
      [r1],
    );
    await tx(async (client) => {
      await discard(client, r2);
      await client.query(
        'UPDATE concrete_mix SET draft_revision_id = NULL, version = version + 1 WHERE id = $1',
        [mixId],
      );
    });
    const { rows } = await db.pool.query(
      `SELECT m.effective_revision_id, m.draft_revision_id, r.state
       FROM concrete_mix m JOIN concrete_mix_revision r ON r.id = $2 WHERE m.id = $1`,
      [mixId, r2],
    );
    expect(rows[0]).toEqual({
      effective_revision_id: r1,
      draft_revision_id: null,
      state: 'discarded',
    });
    const { rows: after } = await db.pool.query(
      'SELECT row_to_json(r)::text AS row FROM concrete_mix_revision r WHERE id = $1',
      [r1],
    );
    expect(after).toEqual(before);
    // Discarded is final: no edit, no approval, no return to draft.
    for (const change of [
      `state = 'draft', discarded_at = NULL, discarded_by_user_id = NULL,
       discarded_by_name_snapshot = NULL`,
      `cement_type = 'HE'`,
    ]) {
      await expect(
        db.pool.query(`UPDATE concrete_mix_revision SET ${change} WHERE id = $1`, [r2]),
      ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_discarded_final' });
    }
    // The next revision is number 3.
    await expect(
      db.pool.query(
        `INSERT INTO concrete_mix_revision (mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id,
                                            created_by_name_snapshot)
         SELECT $1, project_id, 2, supplier_name, mix_number, $2, 'Test PE'
         FROM concrete_mix WHERE id = $1`,
        [mixId, user],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_sequence' });
  });

  it('discard is refused when it would leave a mix without a revision, edit the draft, or skip who', async () => {
    const { r1, r2 } = await mixWithDraft();
    // Approved revisions can't be discarded.
    await expect(tx((client) => discard(client, r1))).rejects.toMatchObject(REJECT);
    // Who and when are required.
    await expect(
      db.pool.query(
        `UPDATE concrete_mix_revision SET state = 'discarded', discarded_at = now() WHERE id = $1`,
        [r2],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_discard_check' });
    // The draft's specification stays as last saved.
    await expect(
      db.pool.query(
        `UPDATE concrete_mix_revision SET state = 'discarded', discarded_at = now(),
                discarded_by_user_id = $2, discarded_by_name_snapshot = 'Test PE',
                cement_type = 'HE'
         WHERE id = $1`,
        [r2, user],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_revision_discard_unchanged' });
    // Discarding without clearing the draft pointer fails at commit.
    await expect(tx((client) => discard(client, r2))).rejects.toMatchObject({
      ...REJECT,
      constraint: 'concrete_mix_pointers',
    });

    // An Unapproved mix's only draft can't be discarded (it would leave no revision).
    const lone = randomUUID();
    const rev = randomUUID();
    await tx(async (client) => {
      await client.query(
        `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                   created_by_user_id, created_by_name_snapshot)
         VALUES ($1, $2, 'Lone Supplier', '1', $3, $4, 'Test PE')`,
        [lone, project, rev, user],
      );
      await client.query(
        `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                            mix_number, created_by_user_id,
                                            created_by_name_snapshot)
         VALUES ($1, $2, $3, 1, 'Lone Supplier', '1', $4, 'Test PE')`,
        [rev, lone, project, user],
      );
    });
    await expect(
      tx(async (client) => {
        await discard(client, rev);
        await client.query(
          'UPDATE concrete_mix SET draft_revision_id = NULL, version = version + 1 WHERE id = $1',
          [lone],
        );
      }),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_has_revision_check' });
  });

  it('the command ledger accepts the discard kind', async () => {
    const { mixId } = await mixWithDraft();
    await db.pool.query(
      `INSERT INTO concrete_mix_command (idempotency_key, mix_id, kind, request_hash, user_id)
       VALUES ($1, $2, 'discard', 'h', $3)`,
      [randomUUID(), mixId, user],
    );
    await expect(
      db.pool.query(
        `INSERT INTO concrete_mix_command (idempotency_key, mix_id, kind, request_hash, user_id)
         VALUES ($1, $2, 'retire', 'h', $3)`,
        [randomUUID(), mixId, user],
      ),
    ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_mix_command_kind_check' });
  });
});

describe.runIf(testDatabaseUrl)('migration 0028 on a populated database (MM-V2-C37)', () => {
  let db: TestSchema;

  afterAll(async () => {
    await db?.drop();
  });

  it('adds empty tables and a null supplier link, and changes no existing mix or revision', async () => {
    db = await createTestSchema();
    const all = await readMigrations();
    await migrate(
      db.pool,
      all.filter((m) => m.version < '0028'),
    );
    const user = await insertUser(db.pool, 'PE');
    const project = await insertProject(db.pool, 'DEMO-2601', user);
    const mixId = randomUUID();
    const rev = randomUUID();
    const client = await db.pool.connect();
    await client.query('BEGIN');
    await client.query(
      `INSERT INTO concrete_mix (id, project_id, supplier_name, mix_number, draft_revision_id,
                                 created_by_user_id, created_by_name_snapshot)
       VALUES ($1, $2, 'Old Supplier', '7', $3, $4, 'Test PE')`,
      [mixId, project, rev, user],
    );
    await client.query(
      `INSERT INTO concrete_mix_revision (id, mix_id, project_id, revision_number, supplier_name,
                                          mix_number, created_by_user_id, created_by_name_snapshot)
       VALUES ($1, $2, $3, 1, 'Old Supplier', '7', $4, 'Test PE')`,
      [rev, mixId, project, user],
    );
    await client.query('COMMIT');
    client.release();
    const snapshot = async () =>
      (
        await db.pool.query(
          `SELECT (SELECT row_to_json(m)::jsonb - 'supplier_id' FROM concrete_mix m) AS mix,
                  (SELECT row_to_json(r)::jsonb - 'discarded_at' - 'discarded_by_user_id'
                     - 'discarded_by_initials_snapshot' - 'discarded_by_name_snapshot'
                   FROM concrete_mix_revision r) AS revision`,
        )
      ).rows[0];
    const before = await snapshot();
    const result = await migrate(
      db.pool,
      all.filter((m) => m.version <= '0028'),
    );
    expect(result.applied).toContain('0028_concrete_reference_data');
    expect(await snapshot()).toEqual(before);
    const { rows } = await db.pool.query(
      `SELECT (SELECT supplier_id FROM concrete_mix) AS link,
              (SELECT count(*)::int FROM concrete_supplier) AS suppliers,
              (SELECT count(*)::int FROM company_holiday) AS holidays`,
    );
    expect(rows[0]).toEqual({ link: null, suppliers: 0, holidays: 0 });
  }, 60_000);
});
