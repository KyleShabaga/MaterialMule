import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  createMigratedSchema,
  createTestSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import { PG, insertProject, insertUser } from '../test-support/fixtures.js';
import { migrate, readMigrations } from './migrator.js';

// MM-V2-C06 (migration 0026): specimen pickup and initial curing, the curing-range reference, the
// Pick up window, lab receipt with one unmoulded mass, mass corrections, permanent-marker
// confirmation, receiving exceptions and the receiving command ledger, each rule proven in the
// database. Fictional data only (DEMO- projects, Test initials).

const REJECT = { code: PG.checkViolation };
const RESTRICT = { code: PG.restrictViolation };
const UNIQUE = { code: PG.uniqueViolation };

const CAST_AT = '2026-11-02T09:15:00-07:00';
const SNAPSHOT = {
  default_ages: ['7', '28', '28', 'HOLD'],
  default_ages_source: 'lab_default',
  hold_duration_days: 56,
  hold_duration_source: 'lab_default',
};

async function insert(
  pool: Pool | PoolClient,
  table: string,
  row: Record<string, unknown>,
): Promise<string> {
  const columns = Object.keys(row);
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO ${table} (${columns.join(', ')})
     VALUES (${columns.map((_, i) => `$${i + 1}`).join(', ')}) RETURNING id`,
    Object.values(row),
  );
  return rows[0]!.id;
}

interface Fixture {
  reportId: string;
  setId: string;
  specimens: string[];
}

/** A field report with a casting time, one set and specimens A–C (7, 28, HOLD). */
async function castSet(pool: Pool, project: string, tech: string): Promise<Fixture> {
  const reportId = await insert(pool, 'concrete_field_report', {
    project_id: project,
    created_by_user_id: tech,
    technician_user_id: tech,
    cast_at: CAST_AT,
  });
  const setId = await insert(pool, 'concrete_specimen_set', {
    project_id: project,
    field_report_id: reportId,
    created_by_user_id: tech,
    technician_user_id: tech,
    ...SNAPSHOT,
  });
  const specimens: string[] = [];
  for (const [letter, age] of [
    ['A', '7'],
    ['B', '28'],
    ['C', 'HOLD'],
  ] as const) {
    specimens.push(
      await insert(pool, 'concrete_specimen', {
        project_id: project,
        set_id: setId,
        letter,
        assigned_age: age,
      }),
    );
  }
  return { reportId, setId, specimens };
}

describe.runIf(testDatabaseUrl)(
  'concrete pickup and receiving (MM-V2-C06, migration 0026)',
  { timeout: 30_000 },
  () => {
    let db: TestSchema;
    let tech: string;
    let receiver: string;
    let lab: string;
    let disabled: string;
    let projectA: string;
    let projectB: string;

    beforeAll(async () => {
      db = await createMigratedSchema();
      tech = await insertUser(db.pool, 'AT');
      receiver = await insertUser(db.pool, 'RC');
      complete.collected_by_user_id = tech;
      lab = await insert(db.pool, 'app_user', {
        display_name: 'LAB',
        account_type: 'shared_lab',
        status: 'active',
      });
      disabled = await insert(db.pool, 'app_user', {
        display_name: 'Test DX',
        official_initials: 'DX',
        account_type: 'personal',
        status: 'disabled',
      });
      projectA = await insertProject(db.pool, 'DEMO-2601', tech);
      projectB = await insertProject(db.pool, 'DEMO-2602', tech);
    });

    afterAll(async () => {
      await db?.drop();
    });

    const numbers = new Map<string, number>();
    async function numberSet(setId: string, project = projectA) {
      const next = (numbers.get(project) ?? 0) + 1;
      numbers.set(project, next);
      await db.pool.query(
        `UPDATE concrete_specimen_set SET permanent_number = $2, permanent_id = $3 WHERE id = $1`,
        [setId, next, `26-${String(next).padStart(2, '0')}`],
      );
    }

    const fixture = (project = projectA) => castSet(db.pool, project, tech);

    const pickup = (specimenId: string, values: Record<string, unknown> = {}, project = projectA) =>
      insert(db.pool, 'concrete_specimen_pickup', {
        project_id: project,
        specimen_id: specimenId,
        recorded_by_user_id: lab,
        ...values,
      });

    // A completed pickup by the technician (filled once the users exist).
    const complete: Record<string, unknown> = {
      completed: true,
      collected_at: '2026-11-03T10:00:00-07:00',
      curing_min_c: '17.0',
      curing_max_c: '24.0',
    };

    const receipt = (
      specimenId: string,
      values: Record<string, unknown> = {},
      project = projectA,
    ) =>
      insert(db.pool, 'concrete_specimen_receipt', {
        project_id: project,
        specimen_id: specimenId,
        received_at: '2026-11-03T14:00:00-07:00',
        received_by_user_id: receiver,
        mass_g: '3812.4',
        recorded_by_user_id: lab,
        ...values,
      });

    let standardId: string | undefined;
    /** The one current curing range, 16.0–27.0 °C (created once). */
    async function currentStandard() {
      standardId ??= await insert(db.pool, 'concrete_curing_standard', {
        specification: 'Fictional curing specification',
        edition: '2026',
        min_c: '16.0',
        max_c: '27.0',
        created_by_user_id: tech,
      });
      return standardId;
    }

    // -------------------------------------------------------------------------------------------
    describe('pickup and initial curing', () => {
      it('a completed pickup needs collector, date/time, minimum and maximum', async () => {
        const f = await fixture();
        for (const missing of [
          'collected_by_user_id',
          'collected_at',
          'curing_min_c',
          'curing_max_c',
        ]) {
          await expect(
            pickup(f.specimens[0]!, { ...complete, [missing]: null }),
            missing,
          ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_complete' });
        }
        // An incomplete pickup saves with blanks.
        await pickup(f.specimens[0]!, { collected_at: '2026-11-03T10:00:00-07:00' });
        await pickup(f.specimens[1]!, complete);
      });

      it('minimum never above maximum; readings keep one decimal exactly', async () => {
        const f = await fixture();
        await expect(
          pickup(f.specimens[0]!, { ...complete, curing_min_c: '25.0', curing_max_c: '24.0' }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_min_max' });
        const id = await pickup(f.specimens[0]!, {
          ...complete,
          curing_min_c: '21.5',
          curing_max_c: '21.5',
        });
        const { rows } = await db.pool.query<{ min: string; max: string }>(
          `SELECT curing_min_c::text AS min, curing_max_c::text AS max
           FROM concrete_specimen_pickup WHERE id = $1`,
          [id],
        );
        expect(rows[0]).toEqual({ min: '21.5', max: '21.5' });
      });

      it('the collector is an active personal or test account, never LAB or disabled', async () => {
        const f = await fixture();
        for (const person of [lab, disabled]) {
          await expect(
            pickup(f.specimens[0]!, { ...complete, collected_by_user_id: person }),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_pickup_person_check',
          });
        }
        const id = await pickup(f.specimens[0]!, { collected_at: CAST_AT });
        await expect(
          db.pool.query(
            'UPDATE concrete_specimen_pickup SET collected_by_user_id = $2 WHERE id = $1',
            [id, lab],
          ),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_person_check' });
        // Recorded from the shared LAB account, credited to a person.
        await db.pool.query(
          'UPDATE concrete_specimen_pickup SET collected_by_user_id = $2 WHERE id = $1',
          [id, tech],
        );
      });

      it('a checked reading names the range, copies its bounds and flags exactly what is out', async () => {
        const standard = await currentStandard();
        const f = await fixture();
        const range = {
          curing_standard_id: standard,
          curing_range_min_c: '16.0',
          curing_range_max_c: '27.0',
        };
        // A range reference without its copied bounds (the copy trigger refuses it first), a
        // checked range without flags, or flags without a range.
        await expect(
          pickup(f.specimens[0]!, { ...complete, curing_standard_id: standard, curing_flags: [] }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_range_copy' });
        await expect(pickup(f.specimens[0]!, { ...complete, ...range })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_specimen_pickup_check_shape',
        });
        await expect(
          pickup(f.specimens[0]!, { ...complete, curing_flags: [] }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_check_shape' });
        // An unknown flag.
        await expect(
          pickup(f.specimens[0]!, {
            ...complete,
            ...range,
            curing_min_c: '15.0',
            curing_flags: ['too_cold'],
          }),
        ).rejects.toMatchObject(REJECT);
        // Min 15.0 vs range 16.0 must say so; missing, wrong, extra or doubled flags are refused.
        for (const flags of [
          [],
          ['max_above_range'],
          ['min_below_range', 'max_above_range'],
          ['min_below_range', 'min_below_range'],
        ]) {
          await expect(
            pickup(f.specimens[0]!, {
              ...complete,
              ...range,
              curing_min_c: '15.0',
              curing_flags: flags,
            }),
            JSON.stringify(flags),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_pickup_flags_match',
          });
        }
        await pickup(f.specimens[0]!, {
          ...complete,
          ...range,
          curing_min_c: '15.0',
          curing_flags: ['min_below_range'],
        });
        // The copied bounds are the referenced range's own.
        for (const [min, max] of [
          ['10.0', '30.0'],
          ['16.0', '28.0'],
          ['15.0', '27.0'],
        ] as const) {
          await expect(
            pickup(f.specimens[1]!, {
              ...complete,
              curing_standard_id: standard,
              curing_range_min_c: min,
              curing_range_max_c: max,
              curing_flags: [],
            }),
            `${min}-${max}`,
          ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_range_copy' });
        }
        // In range: no flags. Both out: both flags. Boundaries are in range.
        await pickup(f.specimens[1]!, {
          ...complete,
          ...range,
          curing_min_c: '16.0',
          curing_max_c: '27.0',
          curing_flags: [],
        });
        await pickup(f.specimens[2]!, {
          ...complete,
          ...range,
          curing_min_c: '12.5',
          curing_max_c: '29.0',
          curing_flags: ['min_below_range', 'max_above_range'],
        });
      });

      it('a resolution needs flags and records who, when and why together', async () => {
        const standard = await currentStandard();
        const f = await fixture();
        const flagged = {
          ...complete,
          curing_standard_id: standard,
          curing_range_min_c: '16.0',
          curing_range_max_c: '27.0',
          curing_min_c: '15.0',
          curing_flags: ['min_below_range'],
        };
        const resolution = {
          curing_resolved_at: '2026-11-04T09:00:00-07:00',
          curing_resolved_by_user_id: tech,
          curing_resolution_note: 'Box thermometer verified; reading accepted',
        };
        for (const missing of Object.keys(resolution)) {
          await expect(
            pickup(f.specimens[0]!, { ...flagged, ...resolution, [missing]: null }),
            missing,
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_pickup_resolution_shape',
          });
        }
        // Nothing to resolve: no flags, or an unchecked reading.
        await expect(
          pickup(f.specimens[0]!, {
            ...complete,
            curing_standard_id: standard,
            curing_range_min_c: '16.0',
            curing_range_max_c: '27.0',
            curing_flags: [],
            ...resolution,
          }),
        ).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_specimen_pickup_resolution_shape',
        });
        // An unchecked reading (no range, no flags) has nothing to resolve.
        await expect(pickup(f.specimens[0]!, { ...complete, ...resolution })).rejects.toMatchObject(
          { ...REJECT, constraint: 'concrete_specimen_pickup_resolution_shape' },
        );
        // The resolver is a person on an active personal account, never LAB or disabled.
        for (const person of [lab, disabled]) {
          await expect(
            pickup(f.specimens[0]!, {
              ...flagged,
              ...resolution,
              curing_resolved_by_user_id: person,
            }),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_pickup_person_check',
          });
        }
        const id = await pickup(f.specimens[0]!, flagged);
        await db.pool.query(
          `UPDATE concrete_specimen_pickup SET curing_resolved_at = $2,
             curing_resolved_by_user_id = $3, curing_resolution_note = $4 WHERE id = $1`,
          [
            id,
            resolution.curing_resolved_at,
            resolution.curing_resolved_by_user_id,
            resolution.curing_resolution_note,
          ],
        );
        await expect(
          db.pool.query(
            'UPDATE concrete_specimen_pickup SET curing_resolved_by_user_id = $2 WHERE id = $1',
            [id, lab],
          ),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_specimen_pickup_person_check' });
        // The resolution stays while the readings it resolved are unchanged.
        await expect(
          db.pool.query(
            `UPDATE concrete_specimen_pickup SET curing_resolved_at = NULL,
               curing_resolved_by_user_id = NULL, curing_resolution_note = NULL WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_pickup_kept' });
        // Corrected readings back in range clear the flag and its resolution together.
        await db.pool.query(
          `UPDATE concrete_specimen_pickup SET curing_min_c = 16.5, curing_flags = '{}',
             curing_resolved_at = NULL, curing_resolved_by_user_id = NULL,
             curing_resolution_note = NULL WHERE id = $1`,
          [id],
        );
      });

      it('one pickup per specimen; it keeps its specimen and recording account', async () => {
        const f = await fixture();
        const id = await pickup(f.specimens[0]!);
        await expect(pickup(f.specimens[0]!)).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_specimen_pickup_specimen_key',
        });
        await expect(
          db.pool.query('UPDATE concrete_specimen_pickup SET specimen_id = $2 WHERE id = $1', [
            id,
            f.specimens[1],
          ]),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_pickup_kept' });
        await expect(
          db.pool.query(
            'UPDATE concrete_specimen_pickup SET recorded_by_user_id = $2 WHERE id = $1',
            [id, tech],
          ),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_pickup_kept' });
        // A specimen of another project can't be named.
        await expect(pickup(f.specimens[1]!, {}, projectB)).rejects.toMatchObject({
          code: PG.foreignKeyViolation,
        });
      });

      it('pickup records are never deleted or truncated', async () => {
        const f = await fixture();
        const id = await pickup(f.specimens[0]!);
        await expect(
          db.pool.query('DELETE FROM concrete_specimen_pickup WHERE id = $1', [id]),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_pickup_kept' });
        await expect(db.pool.query('TRUNCATE concrete_specimen_pickup')).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_pickup_kept',
        });
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('curing-range reference', () => {
      it('a range has minimum below maximum, never changes and is retired once', async () => {
        // A fresh schema of its own so the one-current rule is observable without side effects.
        const local = await createMigratedSchema();
        try {
          const person = await insertUser(local.pool, 'LM');
          const range = (min: string, max: string) =>
            insert(local.pool, 'concrete_curing_standard', {
              specification: 'Fictional curing specification',
              edition: '2026',
              min_c: min,
              max_c: max,
              created_by_user_id: person,
            });
          for (const [min, max] of [
            ['20.0', '20.0'],
            ['25.0', '20.0'],
          ] as const) {
            await expect(range(min, max)).rejects.toMatchObject({
              ...REJECT,
              constraint: 'concrete_curing_standard_range',
            });
          }
          const first = await range('16.0', '27.0');
          // Only one range applies at a time.
          await expect(range('15.0', '25.0')).rejects.toMatchObject({
            ...UNIQUE,
            constraint: 'concrete_curing_standard_one_current',
          });
          await expect(
            local.pool.query(`UPDATE concrete_curing_standard SET min_c = 15.0 WHERE id = $1`, [
              first,
            ]),
          ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_curing_standard_fixed' });
          // Retiring changes the values too: refused.
          await expect(
            local.pool.query(
              `UPDATE concrete_curing_standard SET retired_at = now(), retired_by_user_id = $2,
                 note = 'changed' WHERE id = $1`,
              [first, person],
            ),
          ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_curing_standard_fixed' });
          // Retired by whom and when, together.
          await expect(
            local.pool.query(
              `UPDATE concrete_curing_standard SET retired_at = now() WHERE id = $1`,
              [first],
            ),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_curing_standard_retired_shape',
          });
          await local.pool.query(
            `UPDATE concrete_curing_standard SET retired_at = now(), retired_by_user_id = $2
             WHERE id = $1`,
            [first, person],
          );
          await expect(
            local.pool.query(
              `UPDATE concrete_curing_standard SET retired_at = now() + interval '1 day'
               WHERE id = $1`,
              [first],
            ),
          ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_curing_standard_fixed' });
          // A new current range after the old one retired.
          await range('15.0', '25.0');
          await expect(
            local.pool.query('DELETE FROM concrete_curing_standard WHERE id = $1', [first]),
          ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_curing_standard_fixed' });
          // Truncated together with the pickups that may reference it: still refused.
          await expect(
            local.pool.query('TRUNCATE concrete_curing_standard, concrete_specimen_pickup'),
          ).rejects.toMatchObject(RESTRICT);
        } finally {
          await local.drop();
        }
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('Pick up window', () => {
      it('hours are 1 to 336', async () => {
        const f = await fixture();
        const window = (hours: number) =>
          db.pool.query(
            `INSERT INTO concrete_set_pickup_window (set_id, project_id, hours, updated_by_user_id)
             VALUES ($1, $2, $3, $4)`,
            [f.setId, projectA, hours, lab],
          );
        for (const hours of [0, -1, 337]) {
          await expect(window(hours), String(hours)).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_set_pickup_window_hours_check',
          });
        }
        await window(1);
        await db.pool.query(
          'UPDATE concrete_set_pickup_window SET hours = 336, version = 2 WHERE set_id = $1',
          [f.setId],
        );
        await expect(
          db.pool.query('UPDATE concrete_set_pickup_window SET hours = 337 WHERE set_id = $1', [
            f.setId,
          ]),
        ).rejects.toMatchObject(REJECT);
        // The window belongs to a set of its project.
        await expect(
          db.pool.query(
            `INSERT INTO concrete_set_pickup_window (set_id, project_id, hours, updated_by_user_id)
             VALUES ($1, $2, 24, $3)`,
            [(await fixture()).setId, projectB, lab],
          ),
        ).rejects.toMatchObject({ code: PG.foreignKeyViolation });
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('lab receipt and mass corrections', () => {
      it('the mass is kept to the exact tenth of a gram and is positive', async () => {
        const f = await fixture();
        const id = await receipt(f.specimens[0]!, { mass_g: '12345.6' });
        const { rows } = await db.pool.query<{ mass: string }>(
          'SELECT mass_g::text AS mass FROM concrete_specimen_receipt WHERE id = $1',
          [id],
        );
        expect(rows[0]!.mass).toBe('12345.6');
        for (const mass of ['0', '-1.0']) {
          await expect(receipt(f.specimens[1]!, { mass_g: mass }), mass).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_receipt_mass_check',
          });
        }
        // numeric(7, 1): at most 999999.9 g.
        await expect(receipt(f.specimens[1]!, { mass_g: '1000000.0' })).rejects.toMatchObject({
          code: '22003',
        });
      });

      it('one receipt per specimen, received by an active personal account', async () => {
        const f = await fixture();
        for (const person of [lab, disabled]) {
          await expect(
            receipt(f.specimens[0]!, { received_by_user_id: person }),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_receipt_person_check',
          });
        }
        await receipt(f.specimens[0]!);
        await expect(receipt(f.specimens[0]!)).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_specimen_receipt_specimen_key',
        });
        await expect(receipt(f.specimens[1]!, {}, projectB)).rejects.toMatchObject({
          code: PG.foreignKeyViolation,
        });
      });

      it('receipt facts never change and the receipt is never deleted', async () => {
        const f = await fixture();
        const id = await receipt(f.specimens[0]!);
        const other = await insertUser(db.pool, 'RD');
        for (const [column, value] of [
          ['received_at', '2026-11-04T08:00:00-07:00'],
          ['received_by_user_id', other],
          ['recorded_by_user_id', tech],
          ['specimen_id', f.specimens[1]],
        ] as const) {
          await expect(
            db.pool.query(`UPDATE concrete_specimen_receipt SET ${column} = $2 WHERE id = $1`, [
              id,
              value,
            ]),
            column,
          ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_receipt_kept' });
        }
        await expect(
          db.pool.query('DELETE FROM concrete_specimen_receipt WHERE id = $1', [id]),
        ).rejects.toMatchObject({ ...RESTRICT, constraint: 'concrete_specimen_receipt_kept' });
      });

      it('the mass changes only with a matching correction in the same transaction', async () => {
        const f = await fixture();
        const id = await receipt(f.specimens[0]!, { mass_g: '3812.4' });
        const correction = (client: Pool | PoolClient, previous: string, next: string) =>
          insert(client, 'concrete_specimen_mass_correction', {
            project_id: projectA,
            specimen_id: f.specimens[0],
            receipt_id: id,
            previous_mass_g: previous,
            new_mass_g: next,
            reason: 'Scale reading transposed on entry',
            corrected_by_user_id: tech,
            idempotency_key: randomUUID(),
            request_hash: 'h',
          });
        const setMass = (client: Pool | PoolClient, mass: string) =>
          client.query('UPDATE concrete_specimen_receipt SET mass_g = $2 WHERE id = $1', [
            id,
            mass,
          ]);

        await expect(setMass(db.pool, '3821.4')).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_mass_correction_required',
        });
        // A correction committed in an earlier transaction doesn't authorise a later change.
        await correction(db.pool, '3812.4', '3821.4');
        await expect(setMass(db.pool, '3821.4')).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_mass_correction_required',
        });

        const client = await db.pool.connect();
        try {
          // A correction for other values doesn't match.
          await client.query('BEGIN');
          await correction(client, '3812.4', '3900.0');
          await expect(setMass(client, '3821.4')).rejects.toMatchObject({
            ...RESTRICT,
            constraint: 'concrete_specimen_mass_correction_required',
          });
          await client.query('ROLLBACK');

          await client.query('BEGIN');
          await correction(client, '3812.4', '3821.4');
          await setMass(client, '3821.4');
          await client.query('COMMIT');
        } finally {
          client.release();
        }
        const { rows } = await db.pool.query<{ mass: string }>(
          'SELECT mass_g::text AS mass FROM concrete_specimen_receipt WHERE id = $1',
          [id],
        );
        expect(rows[0]!.mass).toBe('3821.4');
        // A correction always changes the value and has a reason.
        await expect(correction(db.pool, '3821.4', '3821.4')).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_specimen_mass_correction_changes',
        });
      });

      it('a correction is made from a personal account, for that specimen receipt', async () => {
        const f = await fixture();
        const receiptId = await receipt(f.specimens[0]!);
        await receipt(f.specimens[1]!);
        const correction = (values: Record<string, unknown>) =>
          insert(db.pool, 'concrete_specimen_mass_correction', {
            project_id: projectA,
            specimen_id: f.specimens[0],
            receipt_id: receiptId,
            previous_mass_g: '3812.4',
            new_mass_g: '3812.8',
            reason: 'Scale reading transposed on entry',
            corrected_by_user_id: tech,
            idempotency_key: randomUUID(),
            request_hash: 'h',
            ...values,
          });
        for (const person of [lab, disabled]) {
          await expect(correction({ corrected_by_user_id: person })).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_specimen_mass_correction_person_check',
          });
        }
        // Another specimen's id against this receipt.
        await expect(correction({ specimen_id: f.specimens[1] })).rejects.toMatchObject({
          code: PG.foreignKeyViolation,
          constraint: 'concrete_specimen_mass_correction_receipt_fkey',
        });
        await correction({});
      });

      it('mass corrections are append-only', async () => {
        const f = await fixture();
        const receiptId = await receipt(f.specimens[0]!);
        const id = await insert(db.pool, 'concrete_specimen_mass_correction', {
          project_id: projectA,
          specimen_id: f.specimens[0],
          receipt_id: receiptId,
          previous_mass_g: '3812.4',
          new_mass_g: '3812.5',
          reason: 'Rounded on entry',
          corrected_by_user_id: tech,
          idempotency_key: randomUUID(),
          request_hash: 'h',
        });
        await expect(
          db.pool.query(
            `UPDATE concrete_specimen_mass_correction SET reason = 'changed' WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_mass_correction_append_only',
        });
        await expect(
          db.pool.query('DELETE FROM concrete_specimen_mass_correction WHERE id = $1', [id]),
        ).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_mass_correction_append_only',
        });
        await expect(
          db.pool.query('TRUNCATE concrete_specimen_mass_correction'),
        ).rejects.toMatchObject({
          ...RESTRICT,
          constraint: 'concrete_specimen_mass_correction_append_only',
        });
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('permanent-marker confirmation', () => {
      const confirm = (setId: string, values: Record<string, unknown> = {}) =>
        insert(db.pool, 'concrete_set_marker_confirmation', {
          project_id: projectA,
          set_id: setId,
          confirmed_at: '2026-11-03T15:00:00-07:00',
          confirmed_by_user_id: receiver,
          recorded_by_user_id: lab,
          ...values,
        });
      const cover = (confirmationId: string, setId: string, specimenId: string) =>
        db.pool.query(
          `INSERT INTO concrete_set_marker_confirmation_specimen
             (confirmation_id, set_id, specimen_id) VALUES ($1, $2, $3)`,
          [confirmationId, setId, specimenId],
        );

      it('only a numbered set is confirmed, by an active personal account', async () => {
        const f = await fixture();
        await expect(confirm(f.setId)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_set_marker_confirmation_numbered',
        });
        await numberSet(f.setId);
        for (const person of [lab, disabled]) {
          await expect(confirm(f.setId, { confirmed_by_user_id: person })).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_set_marker_confirmation_person_check',
          });
        }
        await confirm(f.setId);
      });

      it('covers received specimens of its own set, each specimen once', async () => {
        const f = await fixture();
        const g = await fixture();
        await numberSet(f.setId);
        await numberSet(g.setId);
        await receipt(f.specimens[0]!);
        await receipt(f.specimens[1]!);
        await receipt(g.specimens[0]!);
        const first = await confirm(f.setId);
        // Not yet received.
        await expect(cover(first, f.setId, f.specimens[2]!)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_set_marker_confirmation_specimen_received',
        });
        // Received, but of another set.
        await expect(cover(first, f.setId, g.specimens[0]!)).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_set_marker_confirmation_specimen_received',
        });
        // Naming the other set doesn't move the confirmation.
        await expect(cover(first, g.setId, g.specimens[0]!)).rejects.toMatchObject({
          code: PG.foreignKeyViolation,
        });
        await cover(first, f.setId, f.specimens[0]!);
        await cover(first, f.setId, f.specimens[1]!);
        // A later confirmation covers what arrived since, never a specimen already covered.
        await receipt(f.specimens[2]!);
        const second = await confirm(f.setId, { confirmed_at: '2026-11-04T09:00:00-07:00' });
        await expect(cover(second, f.setId, f.specimens[0]!)).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_set_marker_confirmation_specimen_once',
        });
        await cover(second, f.setId, f.specimens[2]!);
      });

      it('confirmations and their coverage are append-only', async () => {
        const f = await fixture();
        await numberSet(f.setId);
        await receipt(f.specimens[0]!);
        const id = await confirm(f.setId);
        await cover(id, f.setId, f.specimens[0]!);
        const APPEND_ONLY = {
          ...RESTRICT,
          constraint: 'concrete_set_marker_confirmation_append_only',
        };
        await expect(
          db.pool.query(
            `UPDATE concrete_set_marker_confirmation SET confirmed_at = now() WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject(APPEND_ONLY);
        await expect(
          db.pool.query(
            'DELETE FROM concrete_set_marker_confirmation_specimen WHERE confirmation_id = $1',
            [id],
          ),
        ).rejects.toMatchObject(APPEND_ONLY);
        await expect(
          db.pool.query('DELETE FROM concrete_set_marker_confirmation WHERE id = $1', [id]),
        ).rejects.toMatchObject(APPEND_ONLY);
        await expect(
          db.pool.query('TRUNCATE concrete_set_marker_confirmation_specimen'),
        ).rejects.toMatchObject(APPEND_ONLY);
      });
    });

    // -------------------------------------------------------------------------------------------
    describe('receiving exceptions', () => {
      const exception = (values: Record<string, unknown>) =>
        insert(db.pool, 'concrete_receiving_exception', {
          project_id: projectA,
          reported_by_user_id: receiver,
          recorded_by_user_id: lab,
          ...values,
        });
      const resolution = (values: Record<string, unknown> = {}) => ({
        resolved_at: '2026-11-05T09:00:00-07:00',
        resolved_by_user_id: tech,
        resolution_source: 'lead_project_engineer',
        disposition: 'Accepted as noted',
        resolution_reason: 'Confirmed with the field technician',
        ...values,
      });
      const resolve = (id: string, values: Record<string, unknown> = {}) => {
        const row = resolution(values);
        const columns = Object.keys(row);
        return db.pool.query(
          `UPDATE concrete_receiving_exception
           SET ${columns.map((c, i) => `${c} = $${i + 2}`).join(', ')} WHERE id = $1`,
          [id, ...Object.values(row)],
        );
      };
      const SHAPE = { ...REJECT, constraint: 'concrete_receiving_exception_kind_shape' };
      const SCOPE = { ...REJECT, constraint: 'concrete_receiving_exception_scope_check' };
      const KEPT = { ...RESTRICT, constraint: 'concrete_receiving_exception_kept' };

      it('each kind has its shape', async () => {
        const f = await fixture();
        // missing: names the specimen and its set, and no receipt.
        await expect(exception({ kind: 'missing', set_id: f.setId })).rejects.toMatchObject(SHAPE);
        await expect(
          exception({ kind: 'missing', specimen_id: f.specimens[0] }),
        ).rejects.toMatchObject(SHAPE);
        await expect(
          exception({
            kind: 'missing',
            set_id: f.setId,
            specimen_id: f.specimens[0],
            received_at: CAST_AT,
            received_by_user_id: receiver,
          }),
        ).rejects.toMatchObject(SHAPE);
        await expect(
          exception({
            kind: 'missing',
            set_id: f.setId,
            specimen_id: f.specimens[0],
            mass_g: '3800.0',
          }),
        ).rejects.toMatchObject(SHAPE);
        await exception({ kind: 'missing', set_id: f.setId, specimen_id: f.specimens[0] });
        await expect(exception({ kind: 'lost' })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_receiving_exception_kind_check',
        });
        for (const kind of ['extra', 'unmatched']) {
          // Never names one of the set's specimens.
          await expect(
            exception({ kind, set_id: f.setId, specimen_id: f.specimens[1] }),
            kind,
          ).rejects.toMatchObject(SHAPE);
          // Receipt: when and by whom together; a mass only with them.
          await expect(exception({ kind, received_at: CAST_AT }), kind).rejects.toMatchObject(
            SHAPE,
          );
          await expect(
            exception({ kind, received_by_user_id: receiver }),
            kind,
          ).rejects.toMatchObject(SHAPE);
          await expect(exception({ kind, mass_g: '3800.0' }), kind).rejects.toMatchObject(SHAPE);
          await exception({ kind, observed_marking: '26-0?B' });
          await exception({
            kind,
            set_id: f.setId,
            observed_marking: 'smudged',
            received_at: CAST_AT,
            received_by_user_id: receiver,
            mass_g: '3790.2',
          });
        }
      });

      it('the set and specimen belong to its project, the specimen to the set', async () => {
        const f = await fixture();
        const g = await fixture();
        const other = await fixture(projectB);
        await expect(
          exception({ kind: 'missing', set_id: f.setId, specimen_id: g.specimens[0] }),
        ).rejects.toMatchObject(SCOPE);
        await expect(
          exception({ kind: 'missing', set_id: other.setId, specimen_id: other.specimens[0] }),
        ).rejects.toMatchObject(SCOPE);
        await expect(exception({ kind: 'extra', set_id: other.setId })).rejects.toMatchObject(
          SCOPE,
        );
      });

      it('people are active personal accounts', async () => {
        for (const person of [lab, disabled]) {
          await expect(
            exception({ kind: 'extra', reported_by_user_id: person }),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_receiving_exception_person_check',
          });
          await expect(
            exception({ kind: 'extra', received_at: CAST_AT, received_by_user_id: person }),
          ).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_receiving_exception_person_check',
          });
        }
      });

      it('starts open and is resolved once, all or none, from a personal account', async () => {
        const f = await fixture();
        await expect(
          exception({
            kind: 'missing',
            set_id: f.setId,
            specimen_id: f.specimens[0],
            ...resolution(),
          }),
        ).rejects.toMatchObject({ ...REJECT, constraint: 'concrete_receiving_exception_kept' });
        const id = await exception({
          kind: 'missing',
          set_id: f.setId,
          specimen_id: f.specimens[0],
        });
        for (const missing of [
          'resolved_by_user_id',
          'resolution_source',
          'disposition',
          'resolution_reason',
        ]) {
          // A blank resolver fails the person check first; the rest fail the shape.
          await expect(resolve(id, { [missing]: null }), missing).rejects.toMatchObject({
            ...REJECT,
            constraint:
              missing === 'resolved_by_user_id'
                ? 'concrete_receiving_exception_person_check'
                : 'concrete_receiving_exception_resolution_shape',
          });
        }
        // Resolution facts without the resolution time.
        await expect(resolve(id, { resolved_at: null })).rejects.toMatchObject(KEPT);
        await expect(resolve(id, { resolution_source: 'shared_lab' })).rejects.toMatchObject({
          ...REJECT,
          constraint: 'concrete_receiving_exception_source_check',
        });
        for (const person of [lab, disabled]) {
          await expect(resolve(id, { resolved_by_user_id: person })).rejects.toMatchObject({
            ...REJECT,
            constraint: 'concrete_receiving_exception_person_check',
          });
        }
        // A missing record never matches a specimen.
        await expect(resolve(id, { matched_specimen_id: f.specimens[1] })).rejects.toMatchObject(
          SCOPE,
        );
        // Resolving never edits what was reported.
        await expect(
          db.pool.query(
            `UPDATE concrete_receiving_exception SET note = 'added later', resolved_at = now(),
               resolved_by_user_id = $2, resolution_source = 'lead_project_engineer',
               disposition = 'Accepted', resolution_reason = 'Checked' WHERE id = $1`,
            [id, tech],
          ),
        ).rejects.toMatchObject(KEPT);
        await resolve(id);
        // Then final.
        await expect(resolve(id, { disposition: 'Changed my mind' })).rejects.toMatchObject(KEPT);
        await expect(
          db.pool.query(
            `UPDATE concrete_receiving_exception SET resolved_at = NULL, resolved_by_user_id = NULL,
               resolution_source = NULL, disposition = NULL, resolution_reason = NULL
             WHERE id = $1`,
            [id],
          ),
        ).rejects.toMatchObject(KEPT);
        await expect(
          db.pool.query(`UPDATE concrete_receiving_exception SET note = 'edited' WHERE id = $1`, [
            id,
          ]),
        ).rejects.toMatchObject(KEPT);
      });

      it('an extra or unmatched record matches a specimen of its own project', async () => {
        const f = await fixture();
        const other = await fixture(projectB);
        const extra = await exception({ kind: 'extra', set_id: f.setId });
        await expect(
          resolve(extra, { matched_specimen_id: other.specimens[0] }),
        ).rejects.toMatchObject(SCOPE);
        await resolve(extra, { matched_specimen_id: f.specimens[2] });
        const unmatched = await exception({ kind: 'unmatched', observed_marking: '26-?' });
        await resolve(unmatched, {
          matched_specimen_id: f.specimens[1],
          resolution_source: 'concrete_lab_manager',
        });
        // A receipt made from the resolved record links back to it.
        await receipt(f.specimens[1]!, { from_exception_id: unmatched });
      });

      it('a linked receipt comes from a resolved record matched to exactly that specimen', async () => {
        const f = await fixture();
        const other = await fixture(projectB);
        const LINK = { ...REJECT, constraint: 'concrete_specimen_receipt_exception_check' };
        // Still open.
        const open = await exception({ kind: 'extra', set_id: f.setId });
        await expect(receipt(f.specimens[0]!, { from_exception_id: open })).rejects.toMatchObject(
          LINK,
        );
        // Resolved without a match.
        const unmatchedResolution = await exception({ kind: 'unmatched' });
        await resolve(unmatchedResolution);
        await expect(
          receipt(f.specimens[0]!, { from_exception_id: unmatchedResolution }),
        ).rejects.toMatchObject(LINK);
        // Matched to another specimen.
        const matched = await exception({ kind: 'extra', set_id: f.setId });
        await resolve(matched, { matched_specimen_id: f.specimens[1] });
        await expect(
          receipt(f.specimens[0]!, { from_exception_id: matched }),
        ).rejects.toMatchObject(LINK);
        // Of another project.
        const elsewhere = await insert(db.pool, 'concrete_receiving_exception', {
          project_id: projectB,
          kind: 'extra',
          reported_by_user_id: receiver,
          recorded_by_user_id: lab,
        });
        await resolve(elsewhere, { matched_specimen_id: other.specimens[0] });
        await expect(
          receipt(f.specimens[0]!, { from_exception_id: elsewhere }),
        ).rejects.toMatchObject(LINK);
        await receipt(f.specimens[1]!, { from_exception_id: matched });
      });

      it('one open missing record per specimen', async () => {
        const f = await fixture();
        const missing = () =>
          exception({ kind: 'missing', set_id: f.setId, specimen_id: f.specimens[0] });
        const first = await missing();
        await expect(missing()).rejects.toMatchObject({
          ...UNIQUE,
          constraint: 'concrete_receiving_exception_one_open_missing',
        });
        await resolve(first);
        await missing();
      });

      it('a received specimen is never recorded missing', async () => {
        const f = await fixture();
        await receipt(f.specimens[0]!);
        await expect(
          exception({ kind: 'missing', set_id: f.setId, specimen_id: f.specimens[0] }),
        ).rejects.toMatchObject(SCOPE);
        await exception({ kind: 'missing', set_id: f.setId, specimen_id: f.specimens[1] });
      });

      it('records are never deleted or truncated', async () => {
        const id = await exception({ kind: 'extra' });
        await expect(
          db.pool.query('DELETE FROM concrete_receiving_exception WHERE id = $1', [id]),
        ).rejects.toMatchObject(KEPT);
      });
    });

    // -------------------------------------------------------------------------------------------
    it('the receiving command ledger is append-only', async () => {
      const key = randomUUID();
      const command = (kind: string, k = randomUUID()) =>
        db.pool.query(
          `INSERT INTO concrete_receiving_command (idempotency_key, kind, target_id, request_hash,
             user_id) VALUES ($1, $2, gen_random_uuid(), 'h', $3)`,
          [k, kind, lab],
        );
      await expect(command('mass_correction')).rejects.toMatchObject({
        ...REJECT,
        constraint: 'concrete_receiving_command_kind_check',
      });
      for (const kind of [
        'pickup',
        'pickup_window',
        'receipt',
        'marker',
        'exception',
        'resolve',
        'curing_resolve',
      ]) {
        await command(kind, kind === 'pickup' ? key : undefined);
      }
      await expect(command('receipt', key)).rejects.toMatchObject(UNIQUE);
      const APPEND_ONLY = { ...RESTRICT, constraint: 'concrete_receiving_command_append_only' };
      await expect(
        db.pool.query(
          `UPDATE concrete_receiving_command SET request_hash = 'x' WHERE idempotency_key = $1`,
          [key],
        ),
      ).rejects.toMatchObject(APPEND_ONLY);
      await expect(
        db.pool.query('DELETE FROM concrete_receiving_command WHERE idempotency_key = $1', [key]),
      ).rejects.toMatchObject(APPEND_ONLY);
      await expect(db.pool.query('TRUNCATE concrete_receiving_command')).rejects.toMatchObject(
        APPEND_ONLY,
      );
    });

    // -------------------------------------------------------------------------------------------
    it('applies to a populated database and changes no existing row', async () => {
      const fresh = await createTestSchema();
      try {
        const all = await readMigrations();
        await migrate(
          fresh.pool,
          all.filter((m) => m.version < '0026'),
        );
        const person = await insertUser(fresh.pool, 'AT');
        const project = await insertProject(fresh.pool, 'DEMO-2601', person);
        const f = await castSet(fresh.pool, project, person);
        await castSet(fresh.pool, project, person);
        await fresh.pool.query(
          `UPDATE concrete_specimen_set SET permanent_number = 1, permanent_id = '26-01'
           WHERE id = $1`,
          [f.setId],
        );
        const snapshot = async () => {
          const out: Record<string, unknown[]> = {};
          for (const table of [
            'app_user',
            'project',
            'concrete_field_report',
            'concrete_specimen_set',
            'concrete_specimen',
          ]) {
            out[table] = (
              await fresh.pool.query(`SELECT to_jsonb(t) AS row FROM ${table} t ORDER BY id`)
            ).rows;
          }
          return out;
        };
        const before = await snapshot();
        const result = await migrate(
          fresh.pool,
          all.filter((m) => m.version <= '0026'),
        );
        expect(result.applied).toContain('0026_concrete_pickup_receiving');
        expect(await snapshot()).toEqual(before);
        // The existing specimens can now be picked up and received.
        await insert(fresh.pool, 'concrete_specimen_pickup', {
          project_id: project,
          specimen_id: f.specimens[0],
          recorded_by_user_id: person,
          ...complete,
          collected_by_user_id: person,
        });
        await insert(fresh.pool, 'concrete_specimen_receipt', {
          project_id: project,
          specimen_id: f.specimens[0],
          received_at: '2026-11-03T14:00:00-07:00',
          received_by_user_id: person,
          mass_g: '3812.4',
          recorded_by_user_id: person,
        });
      } finally {
        await fresh.drop();
      }
    });
  },
);
