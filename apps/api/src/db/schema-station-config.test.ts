import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG } from '../test-support/fixtures.js';

// Strata lane A (migration 0045): a LAB station's "At this station" rows, proven in the database.
// One row per station ID in the shared stationIdSchema format; a stored row starts at version 1
// and each save adds exactly one; the station ID never changes; and only an active Lab Manager
// with their own account is recorded as saving it, never the shared LAB account. Fictional people.
describe.runIf(testDatabaseUrl)('station configuration (Strata lane A, migration 0045)', () => {
  let db: TestSchema;
  let manager: string;
  let technician: string;
  let disabledManager: string;
  let lab: string;
  const ROWS = JSON.stringify([{ row: 'drafts', visible: true }]);

  async function person(
    name: string,
    accountType: string,
    status = 'active',
    roles: string[] = [],
  ) {
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
    for (const role of roles) {
      await db.pool.query('INSERT INTO role_assignment (user_id, role) VALUES ($1, $2)', [
        rows[0]!.id,
        role,
      ]);
    }
    return rows[0]!.id;
  }

  const insert = (stationId: string, by: string, version = 1, rows = ROWS) =>
    db.pool.query(
      `INSERT INTO station_config (station_id, rows, version, updated_by_user_id)
       VALUES ($1, $2::jsonb, $3, $4)`,
      [stationId, rows, version, by],
    );

  const failure = async (promise: Promise<unknown>) => {
    const error = (await promise.then(
      () => null,
      (e: unknown) => e,
    )) as { code?: string; constraint?: string } | null;
    expect(error, 'expected the database to refuse').not.toBeNull();
    return { code: error!.code, constraint: error!.constraint };
  };

  beforeAll(async () => {
    db = await createMigratedSchema();
    manager = await person('Lee Manager', 'personal', 'active', ['lab_manager']);
    technician = await person('Alex Tester', 'personal', 'active', ['lab_technician']);
    disabledManager = await person('Former Manager', 'personal', 'disabled', ['lab_manager']);
    lab = await person('LAB', 'shared_lab', 'active', []);
  });

  afterAll(async () => {
    await db?.drop();
  });

  it('accepts a Lab Manager saving a station for the first time at version 1', async () => {
    await insert('station-ok-0001', manager);
    const { rows } = await db.pool.query(
      `SELECT version, rows FROM station_config WHERE station_id = 'station-ok-0001'`,
    );
    expect(rows[0]).toMatchObject({ version: 1, rows: [{ row: 'drafts', visible: true }] });
  });

  it('checks the station ID against the shared format', async () => {
    for (const bad of ['short', 'has space-0001', 'x'.repeat(65), 'semi;colon-0001', '']) {
      expect(await failure(insert(bad, manager))).toEqual({
        code: PG.checkViolation,
        constraint: 'station_config_station_id_check',
      });
    }
    await insert('A_b-9'.padEnd(64, 'z'), manager);
  });

  it('keeps one row per station', async () => {
    await insert('station-one-0001', manager);
    expect((await failure(insert('station-one-0001', manager))).code).toBe(PG.uniqueViolation);
  });

  it('refuses a version below 1, a first save above 1 and rows that are not a list', async () => {
    // The trigger runs before the column check, so either may name the refusal.
    for (const version of [0, -1]) {
      const refused = await failure(insert('station-v0-0001', manager, version));
      expect(refused.code).toBe(PG.checkViolation);
      expect(refused.constraint).toMatch(/^station_config_version(_step)?_check$/);
    }
    expect(await failure(insert('station-v2-0001', manager, 2))).toMatchObject({
      constraint: 'station_config_version_step_check',
    });
    expect(
      await failure(insert('station-obj-0001', manager, 1, JSON.stringify({ row: 'drafts' }))),
    ).toMatchObject({ constraint: 'station_config_rows_check' });
  });

  it('adds exactly one per save and never changes the station ID', async () => {
    await insert('station-step-0001', manager);
    await db.pool.query(
      `UPDATE station_config SET version = 2 WHERE station_id = 'station-step-0001'`,
    );
    for (const version of [2, 4, 1]) {
      expect(
        await failure(
          db.pool.query(
            `UPDATE station_config SET version = $1 WHERE station_id = 'station-step-0001'`,
            [version],
          ),
        ),
      ).toMatchObject({ constraint: 'station_config_version_step_check' });
    }
    expect(
      await failure(
        db.pool.query(
          `UPDATE station_config SET station_id = 'station-new-0001', version = version + 1
           WHERE station_id = 'station-step-0001'`,
        ),
      ),
    ).toMatchObject({ constraint: 'station_config_station_id_fixed_check' });
  });

  it('records only an active Lab Manager with their own account as the one who saved', async () => {
    for (const who of [lab, technician, disabledManager]) {
      expect(await failure(insert('station-who-0001', who))).toEqual({
        code: PG.checkViolation,
        constraint: 'station_config_updater_check',
      });
    }
    await insert('station-who-0001', manager);
    expect(
      await failure(
        db.pool.query(
          `UPDATE station_config SET version = version + 1, updated_by_user_id = $1
           WHERE station_id = 'station-who-0001'`,
          [lab],
        ),
      ),
    ).toMatchObject({ constraint: 'station_config_updater_check' });
  });
});
