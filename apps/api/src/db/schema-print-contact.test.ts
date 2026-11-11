import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// Review fixes #119/#124 (migration 0036): a print job keeps its latest printer contact apart
// from how the job ended. Each rule proven in the database. Fictional data only.

const REJECT = { code: PG.checkViolation };

async function addPrinter(db: TestSchema): Promise<string> {
  await db.pool.query(
    `INSERT INTO printer (key, name, host, port, is_default)
     VALUES ('bench', 'Bench (fictional)', '127.0.0.1', 9194, true)`,
  );
  return insertUser(db.pool, 'PC');
}

describe.runIf(testDatabaseUrl)('print job printer contact (0036)', () => {
  let db: TestSchema;
  let fresh: TestSchema | undefined;
  let user: string;

  const insert = (columns: Record<string, unknown>) => {
    const names = Object.keys(columns);
    return db.pool.query(
      `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                              requested_by_name_snapshot, status, attempts, ${names.join(', ')})
       VALUES ('reprint', 'bench', 'v1', $1, 'Tech', 'queued', 1,
               ${names.map((_, i) => `$${i + 2}`).join(', ')})`,
      [user, ...Object.values(columns)],
    );
  };

  beforeAll(async () => {
    db = await createMigratedSchema();
    user = await addPrinter(db);
  });

  afterAll(async () => {
    await db?.drop();
    await fresh?.drop();
  });

  it('accepts a failed contact with its error, message and first failure', async () => {
    await expect(
      insert({
        last_contact_at: new Date(),
        last_contact_result: 'not_sent',
        last_contact_error: 'Printer refused the connection',
        last_contact_printer_message: 'Printer out of labels',
        first_failed_contact_at: new Date(Date.now() - 60_000),
      }),
    ).resolves.toBeDefined();
  });

  it('refuses a contact time without a result, or a result without a time', async () => {
    await expect(insert({ last_contact_at: new Date() })).rejects.toMatchObject(REJECT);
    await expect(insert({ last_contact_result: 'sent' })).rejects.toMatchObject(REJECT);
    await expect(
      insert({ last_contact_at: new Date(), last_contact_result: 'maybe' }),
    ).rejects.toMatchObject(REJECT);
  });

  it('refuses an error or printer message on a successful contact', async () => {
    const at = new Date();
    await expect(
      insert({ last_contact_at: at, last_contact_result: 'sent', last_contact_error: 'x' }),
    ).rejects.toMatchObject(REJECT);
    await expect(
      insert({
        last_contact_at: at,
        last_contact_result: 'sent',
        last_contact_printer_message: 'Printer out of labels',
      }),
    ).rejects.toMatchObject(REJECT);
  });

  it('refuses a first failed contact after the last contact, or with no contact at all', async () => {
    const at = new Date();
    await expect(
      insert({
        last_contact_at: at,
        last_contact_result: 'not_sent',
        first_failed_contact_at: new Date(at.getTime() + 60_000),
      }),
    ).rejects.toMatchObject(REJECT);
    await expect(insert({ first_failed_contact_at: at })).rejects.toMatchObject(REJECT);
  });

  it('backfills what the old summary counted as a printer attempt, and nothing else', async () => {
    fresh = await createTestSchema();
    const all = await readMigrations();
    await migrate(
      fresh.pool,
      all.filter((m) => m.version < '0036'),
    );
    const owner = await addPrinter(fresh);
    const job = async (status: string, attempts: number, error: string | null) =>
      (
        await fresh!.pool.query<{ id: string }>(
          `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                                  requested_by_name_snapshot, status, attempts, last_error,
                                  created_at, updated_at, sent_at)
           VALUES ('reprint', 'bench', 'v1', $1, 'Tech', $2, $3, $4,
                   now() - interval '1 hour', now() - interval '5 minutes',
                   CASE WHEN $2 = 'sent' THEN now() - interval '5 minutes' END)
           RETURNING id`,
          [owner, status, attempts, error],
        )
      ).rows[0]!.id;
    const failedWith = async (kind: string) => {
      const id = await job('failed', 1, 'Failed');
      await fresh!.pool.query(
        `INSERT INTO audit_event (action, entity_type, entity_id, actor_account_type,
                                  actor_name_snapshot, after_values)
         VALUES ('label.print_failed', 'print_job', $1, 'system', 'Print queue',
                 jsonb_build_object('failure', $2::text))`,
        [id, kind],
      );
      return id;
    };
    const sent = await job('sent', 1, null);
    const retrying = await job('queued', 1, 'Printer refused the connection');
    const untried = await job('queued', 0, null);
    const printerFailure = await failedWith('printer');
    const disposed = await failedWith('unit_disposed');

    expect(
      (
        await migrate(
          fresh.pool,
          all.filter((m) => m.version <= '0036'),
        )
      ).applied,
    ).toEqual(['0036_print_job_printer_contact']);

    const { rows } = await fresh.pool.query<{
      id: string;
      result: string | null;
      error: string | null;
      exact: boolean | null;
      first_is_updated: boolean | null;
    }>(
      `SELECT id, last_contact_result AS result, last_contact_error AS error,
              last_contact_at = coalesce(sent_at, updated_at) AS exact,
              first_failed_contact_at = updated_at AS first_is_updated
         FROM print_job`,
    );
    const by = new Map(rows.map((row) => [row.id, row]));
    expect(by.get(sent)).toMatchObject({ result: 'sent', error: null, exact: true });
    expect(by.get(sent)!.first_is_updated).toBeNull();
    expect(by.get(retrying)).toMatchObject({
      result: 'not_sent',
      error: 'Printer refused the connection',
      exact: true,
      first_is_updated: true,
    });
    expect(by.get(printerFailure)).toMatchObject({ result: 'not_sent', first_is_updated: true });
    expect(by.get(untried)).toMatchObject({ result: null, exact: null });
    expect(by.get(disposed)).toMatchObject({ result: null, exact: null });
  });
});
