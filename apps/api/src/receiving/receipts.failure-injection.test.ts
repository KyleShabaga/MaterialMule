import type { ConfirmReceiptResponse } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { bootReceivingHarness, type ReceivingHarness } from '../test-support/receiving-harness.js';

// MM-T18 card test T4 / AC3: a database failure at any point of a receipt confirmation leaves
// no partial receipt, burns no storage unit ID, and the same request (same idempotency key)
// succeeds once the database is healthy again. Failures are injected with temporary triggers in
// this test's own schema, so no failure hook exists in the application. Fictional data only.

interface InjectionPoint {
  name: string;
  table: string;
  timing: 'BEFORE INSERT' | 'BEFORE UPDATE' | 'BEFORE INSERT OR UPDATE';
  /** Optional trigger WHEN condition. */
  when?: string;
  /** Optional condition checked inside the trigger (may use subqueries, unlike WHEN). */
  guard?: string;
}

const POINTS: InjectionPoint[] = [
  { name: 'the receipt header insert', table: 'receipt', timing: 'BEFORE INSERT' },
  {
    name: 'the ID counter update',
    table: 'storage_unit_annual_counter',
    timing: 'BEFORE INSERT OR UPDATE',
  },
  {
    name: 'the receipt audit event',
    table: 'audit_event',
    timing: 'BEFORE INSERT',
    when: `NEW.action = 'receipt.confirmed'`,
  },
  {
    name: 'the first storage unit insert',
    table: 'storage_unit',
    timing: 'BEFORE INSERT',
    when: 'NEW.receipt_line = 1',
  },
  {
    name: 'the last storage unit insert',
    table: 'storage_unit',
    timing: 'BEFORE INSERT',
    when: 'NEW.receipt_line = 3',
  },
  {
    name: 'a test-hole summary of the last unit',
    table: 'storage_unit_hole_summary',
    timing: 'BEFORE INSERT',
    when: `NEW.sample_from = 'G21'`,
  },
  {
    name: 'the last storage unit audit event',
    table: 'audit_event',
    timing: 'BEFORE INSERT',
    when: `NEW.action = 'storage_unit.created'`,
    guard: `EXISTS (SELECT 1 FROM storage_unit su WHERE su.id = NEW.entity_id AND su.receipt_line = 3)`,
  },
];

describe.runIf(testDatabaseUrl)('receipt failure injection (MM-T18 T4, AC3)', () => {
  let h: ReceivingHarness;

  beforeAll(async () => {
    h = await bootReceivingHarness();
    // The harness schema is new, so no counter exists yet and "no ID burned" is easy to read: the
    // next IDs are …001–003. (Counters can't be deleted or lowered, MM-T47.)
    const { rows } = await h.db.pool.query('SELECT 1 FROM storage_unit_annual_counter');
    expect(rows).toHaveLength(0);
  });

  afterAll(async () => {
    await h?.close();
  });

  async function inject(point: InjectionPoint, body: string): Promise<() => Promise<void>> {
    await h.db.pool.query(`
      CREATE FUNCTION t18_injected_failure() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF ${point.guard ?? 'true'} THEN ${body} END IF; RETURN NEW; END; $$;
      CREATE TRIGGER t18_injected_failure ${point.timing} ON ${point.table}
        FOR EACH ROW ${point.when ? `WHEN (${point.when})` : ''}
        EXECUTE FUNCTION t18_injected_failure();`);
    return async () => {
      await h.db.pool.query(
        `DROP TRIGGER t18_injected_failure ON ${point.table}; DROP FUNCTION t18_injected_failure();`,
      );
    };
  }

  async function nextBucketSequence(): Promise<number> {
    const { rows } = await h.db.pool.query<{ last_value: number }>(
      `SELECT last_value FROM storage_unit_annual_counter WHERE prefix = 'BKT'`,
    );
    return (rows[0]?.last_value ?? 0) + 1;
  }

  async function expectRecoveredWithoutGaps(
    body: ReturnType<ReceivingHarness['receipt']>,
    cookie: string,
    firstSequence: number,
  ) {
    const retry = await h.postReceipt(body, cookie);
    expect(retry.status).toBe(201);
    const ids = (retry.body as ConfirmReceiptResponse).units.map((u) => u.suNumber);
    expect(ids.map((id) => Number(id.slice(-6)))).toEqual([
      firstSequence,
      firstSequence + 1,
      firstSequence + 2,
    ]);
  }

  it.each(POINTS)(
    'an error at $name leaves nothing behind and the retry succeeds',
    async (point) => {
      // Three units, the third with a G21–S29 summary (the injection points above rely on it).
      const body = h.receipt(3);
      expect(body.units[2]!.holeSummaries[0]).toMatchObject({ sampleFrom: 'G21' });
      const cookie = await h.cookieFor('lab');
      const firstSequence = await nextBucketSequence();
      const before = await h.snapshot();

      const remove = await inject(
        point,
        `RAISE EXCEPTION 'T18 injected failure at ${point.name}';`,
      );
      try {
        const failed = await h.postReceipt(body, cookie);
        expect(failed.status).toBe(500);
        // No internals (SQL, trigger text) reach the client.
        expect(JSON.stringify(failed.body)).not.toMatch(/injected|trigger|INSERT|storage_unit/i);
        expect(await h.snapshot()).toEqual(before);
      } finally {
        await remove();
      }
      await expectRecoveredWithoutGaps(body, cookie, firstSequence);
    },
  );

  it('a database connection lost mid-receipt leaves nothing behind; the API keeps working', async () => {
    const body = h.receipt(3);
    const cookie = await h.cookieFor('lab');
    const firstSequence = await nextBucketSequence();
    const before = await h.snapshot();

    // The server process ends this connection while the second unit is being inserted, as a
    // database restart or network cut would.
    const remove = await inject(
      {
        name: 'connection loss',
        table: 'storage_unit',
        timing: 'BEFORE INSERT',
        when: 'NEW.receipt_line = 2',
      },
      'PERFORM pg_terminate_backend(pg_backend_pid());',
    );
    try {
      const failed = await h.postReceipt(body, cookie);
      expect(failed.status).toBeGreaterThanOrEqual(500);
      expect(await h.snapshot()).toEqual(before);
    } finally {
      await remove();
    }
    // Other requests still work, and the same draft confirms with the IDs it would have had.
    const health = await h.postReceipt(h.receipt(1, { units: [] }), cookie);
    expect(health.status).toBe(400);
    await expectRecoveredWithoutGaps(body, cookie, firstSequence);
  });
});
