import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';
import { runSeed } from './seed.js';

// MM-V2-C27 (migration 0018): the concrete equipment register and its calibration history, proven
// in the database. Fictional data only (invented people and equipment IDs such as AM-TEST-01).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

describe.runIf(testDatabaseUrl)(
  'concrete equipment (MM-V2-C27, migration 0018)',
  { timeout: 60_000 },
  () => {
    let db: TestSchema;
    let lm: string;
    let tech: string;
    let lab: string;
    let pending: string;
    let disabled: string;

    async function account(type: 'shared_lab' | 'personal', status: string, name: string) {
      return (
        await db.pool.query<{ id: string }>(
          `INSERT INTO app_user (display_name, account_type, status) VALUES ($1, $2, $3) RETURNING id`,
          [name, type, status],
        )
      ).rows[0]!.id;
    }

    beforeAll(async () => {
      db = await createMigratedSchema();
      lm = await insertUser(db.pool, 'LM');
      tech = await insertUser(db.pool, 'AT');
      lab = await account('shared_lab', 'active', 'LAB');
      pending = await account('personal', 'pending', 'Pending Person');
      disabled = await account('personal', 'disabled', 'Former Person');
    });

    afterAll(async () => {
      await db?.drop();
    });

    /** Inserts equipment; `values` override the defaults (an in-service air meter). */
    async function equipment(values: Record<string, unknown> = {}): Promise<string> {
      const row: Record<string, unknown> = {
        kind: 'air_meter',
        identifier: `AM-TEST-${randomUUID().slice(0, 8)}`,
        created_by_user_id: lm,
        created_by_name_snapshot: 'Test LM',
        create_idempotency_key: randomUUID(),
        create_request_hash: 'h',
        updated_by_user_id: lm,
        updated_by_name_snapshot: 'Test LM',
        ...values,
      };
      const columns = Object.keys(row);
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_equipment (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
      return rows[0]!.id;
    }

    async function calibration(
      equipmentId: string,
      entryNumber: number,
      values: Record<string, unknown> = {},
    ): Promise<string> {
      const row: Record<string, unknown> = {
        equipment_id: equipmentId,
        entry_number: entryNumber,
        calibrated_on: '2026-01-15',
        next_due_on: '2027-01-15',
        performed_by: 'Example Calibration Co.',
        recorded_by_user_id: lm,
        recorded_by_name_snapshot: 'Test LM',
        idempotency_key: randomUUID(),
        request_hash: 'h',
        ...values,
      };
      const columns = Object.keys(row);
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO concrete_equipment_calibration (${columns.join(', ')})
       VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
        Object.values(row),
      );
      return rows[0]!.id;
    }

    const bump = (id: string, set: string, params: unknown[] = []) =>
      db.pool.query(`UPDATE concrete_equipment SET ${set}, version = version + 1 WHERE id = $1`, [
        id,
        ...params,
      ]);

    describe('register', () => {
      it('knows only testing machines and air meters; an air meter needs its ID', async () => {
        await expect(equipment({ kind: 'scale' })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_kind_check',
        });
        await expect(equipment({ identifier: null })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_air_meter_identifier',
        });
        await expect(equipment({ identifier: '   ' })).rejects.toMatchObject(REJECT);
      });

      it('CD-44: one testing machine at a time; a retired one makes room for its replacement', async () => {
        const first = await equipment({
          kind: 'testing_machine',
          identifier: null,
          make: 'Example',
        });
        await expect(
          equipment({ kind: 'testing_machine', identifier: null }),
        ).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_equipment_one_testing_machine',
        });
        await bump(first, `status = 'retired', status_note = 'Replaced'`);
        const second = await equipment({ kind: 'testing_machine', identifier: null });
        expect(second).not.toBe(first);
        // Leave the replacement retired too, so other tests may register one.
        await bump(second, `status = 'retired', status_note = 'Test cleanup'`);
      });

      it('equipment IDs are unique ignoring case among equipment not retired', async () => {
        const first = await equipment({ identifier: 'AM-TEST-DUP' });
        await expect(equipment({ identifier: ' am-test-dup ' })).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_equipment_identifier_key',
        });
        await bump(first, `status = 'retired', status_note = 'Lost'`);
        await expect(equipment({ identifier: 'AM-TEST-DUP' })).resolves.toBeTruthy();
      });

      it('only an air meter is assigned, with a snapshot, to an active staff member', async () => {
        await expect(
          equipment({
            kind: 'testing_machine',
            identifier: null,
            assigned_user_id: tech,
            assigned_name_snapshot: 'Alex',
          }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_assignment_kind' });
        await expect(equipment({ assigned_user_id: tech })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_assignment_snapshot',
        });
        for (const person of [lab, pending, disabled]) {
          await expect(
            equipment({ assigned_user_id: person, assigned_name_snapshot: 'X' }),
          ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_assignee_active' });
        }
        const meter = await equipment({ assigned_user_id: tech, assigned_name_snapshot: 'Alex' });
        await expect(
          bump(meter, `assigned_user_id = $2, assigned_name_snapshot = 'LAB'`, [lab]),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_assignee_active' });

        // A later disable keeps the assignment as it was; other edits still save.
        const leaver = await insertUser(db.pool, 'LV');
        const kept = await equipment({
          assigned_user_id: leaver,
          assigned_name_snapshot: 'Leaver',
        });
        await db.pool.query(`UPDATE app_user SET status = 'disabled' WHERE id = $1`, [leaver]);
        await expect(bump(kept, `description = 'Still with the leaver'`)).resolves.toBeTruthy();
      });

      it('out of service and retired say why; retired is unassigned and final', async () => {
        const meter = await equipment({ assigned_user_id: tech, assigned_name_snapshot: 'Alex' });
        await expect(bump(meter, `status = 'out_of_service'`)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_status_note_required',
        });
        await bump(meter, `status = 'out_of_service', status_note = 'Gauge sticks'`);
        await expect(bump(meter, `status = 'retired'`)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_retired_unassigned',
        });
        await bump(
          meter,
          `status = 'retired', assigned_user_id = NULL, assigned_name_snapshot = NULL,
         status_note = 'Beyond repair'`,
        );
        await expect(
          bump(meter, `status = 'in_service', status_note = NULL`),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_retired_final' });
        await expect(bump(meter, `description = 'x'`)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_retired_final',
        });
      });

      it('is never deleted or truncated, keeps its kind and creation, and steps its version by one', async () => {
        const meter = await equipment();
        await expect(
          db.pool.query('DELETE FROM concrete_equipment WHERE id = $1', [meter]),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_equipment_no_delete' });
        await expect(db.pool.query('TRUNCATE concrete_equipment CASCADE')).rejects.toMatchObject(
          RESTRICT,
        );
        await expect(
          bump(meter, `kind = 'testing_machine', identifier = NULL`),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_fixed' });
        await expect(
          bump(meter, `created_at = created_at - interval '1 day'`),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_fixed' });
        await expect(
          bump(meter, `create_idempotency_key = $2`, [randomUUID()]),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_fixed' });
        await expect(
          db.pool.query(`UPDATE concrete_equipment SET description = 'x' WHERE id = $1`, [meter]),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_version_step' });
        await expect(
          db.pool.query(
            `UPDATE concrete_equipment SET description = 'x', version = version + 2 WHERE id = $1`,
            [meter],
          ),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_equipment_version_step' });
      });

      it('a create idempotency key is used once', async () => {
        const key = randomUUID();
        await equipment({ create_idempotency_key: key });
        await expect(equipment({ create_idempotency_key: key })).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_equipment_create_key',
        });
      });
    });

    describe('calibration history', () => {
      let meter: string;

      beforeAll(async () => {
        meter = await equipment();
      });

      it('next due is after the calibration date; who performed it is required', async () => {
        await expect(calibration(meter, 1, { next_due_on: '2026-01-15' })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_calibration_dates',
        });
        await expect(calibration(meter, 1, { performed_by: ' ' })).rejects.toMatchObject(REJECT);
        // No interval is stored or assumed: next due is required as recorded.
        await expect(calibration(meter, 1, { next_due_on: null })).rejects.toMatchObject({
          code: PG.notNullViolation,
        });
      });

      it('entries are numbered 1, 2, 3… per equipment', async () => {
        await expect(calibration(meter, 2)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_calibration_contiguous',
        });
        await calibration(meter, 1);
        await calibration(meter, 2, { calibrated_on: '2027-01-10', next_due_on: '2028-01-10' });
        await expect(calibration(meter, 2)).rejects.toMatchObject(REJECT);
        const other = await equipment();
        await expect(calibration(other, 1)).resolves.toBeTruthy();
      });

      it('AC2: history is never overwritten or deleted; voiding is the one change and is final', async () => {
        const target = await equipment();
        const entry = await calibration(target, 1);
        for (const set of [
          `next_due_on = '2030-01-01'`,
          `calibrated_on = '2026-01-01'`,
          `performed_by = 'Someone else'`,
          `result = 'Changed'`,
          `entry_number = 5`,
          `recorded_by_user_id = '${tech}'`,
        ]) {
          await expect(
            db.pool.query(`UPDATE concrete_equipment_calibration SET ${set} WHERE id = $1`, [
              entry,
            ]),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_equipment_calibration_history',
          });
        }
        await expect(
          db.pool.query('DELETE FROM concrete_equipment_calibration WHERE id = $1', [entry]),
        ).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_equipment_calibration_no_delete',
        });
        await expect(
          db.pool.query('TRUNCATE concrete_equipment_calibration'),
        ).rejects.toMatchObject(RESTRICT);

        // A void needs who and why, all at once.
        await expect(
          db.pool.query(
            `UPDATE concrete_equipment_calibration SET voided_at = now() WHERE id = $1`,
            [entry],
          ),
        ).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_calibration_voided_check',
        });
        await db.pool.query(
          `UPDATE concrete_equipment_calibration
         SET voided_at = now(), voided_by_user_id = $2, voided_by_name_snapshot = 'Test LM',
             void_reason = 'Wrong meter'
         WHERE id = $1`,
          [entry, lm],
        );
        await expect(
          db.pool.query(
            `UPDATE concrete_equipment_calibration SET void_reason = 'Other reason' WHERE id = $1`,
            [entry],
          ),
        ).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_calibration_history',
        });
        const { rows } = await db.pool.query(
          'SELECT count(*)::int AS n FROM concrete_equipment_calibration WHERE equipment_id = $1',
          [target],
        );
        expect(rows[0].n).toBe(1);
      });

      it('retired equipment takes no new calibration', async () => {
        const old = await equipment();
        await calibration(old, 1);
        await bump(old, `status = 'retired', status_note = 'Retired'`);
        await expect(calibration(old, 2)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_equipment_calibration_retired',
        });
      });

      it('a calibration idempotency key is used once', async () => {
        const key = randomUUID();
        const target = await equipment();
        await calibration(target, 1, { idempotency_key: key });
        await expect(calibration(target, 2, { idempotency_key: key })).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_equipment_calibration_key',
        });
      });
    });

    describe('migration 0018 on a populated database', () => {
      let fresh: TestSchema | undefined;
      afterEach(async () => {
        await fresh?.drop();
        fresh = undefined;
      });

      async function snapshot(pool: Pool) {
        const { rows: tables } = await pool.query<{ table_name: string }>(
          `SELECT table_name FROM information_schema.tables
         WHERE table_schema = current_schema() AND table_type = 'BASE TABLE'
           AND table_name <> 'schema_migration'
         ORDER BY table_name`,
        );
        const out: Record<string, unknown[]> = {};
        for (const { table_name } of tables) {
          const { rows } = await pool.query(
            `SELECT row_to_json(t)::text AS row FROM "${table_name}" t ORDER BY 1`,
          );
          out[table_name] = rows.map((r: { row: string }) => r.row);
        }
        return out;
      }

      it('adds empty tables and changes no existing row', async () => {
        fresh = await createTestSchema();
        const all = await readMigrations();
        await migrate(
          fresh.pool,
          all.filter((m) => m.version < '0018'),
        );
        await runSeed(fresh.pool, 'reference', 'test');
        await runSeed(fresh.pool, 'dev', 'test');
        const before = await snapshot(fresh.pool);

        expect(
          (
            await migrate(
              fresh.pool,
              all.filter((m) => m.version < '0019'),
            )
          ).applied,
        ).toEqual(['0018_concrete_equipment']);

        const after = await snapshot(fresh.pool);
        for (const table of ['concrete_equipment', 'concrete_equipment_calibration']) {
          expect(after[table]).toEqual([]);
          delete after[table];
        }
        expect(after).toEqual(before);
      });
    });
  },
);
