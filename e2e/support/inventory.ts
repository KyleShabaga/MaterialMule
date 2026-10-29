import { randomInt } from 'node:crypto';
import { withDatabase } from './db';

// Fictional inventory for MM-T12 E2E. Each call makes its own two projects, location and units
// (tagged with a random code) so parallel runs and viewports never see each other's rows.

const PE_ID = '00000000-0000-4000-8000-000000000101';
const AT_ID = '00000000-0000-4000-8000-000000000102';

export interface InventoryFixture {
  tag: string;
  projectA: string;
  projectB: string;
  warehouse: string;
  /** TH26-01 G1–S12, project A, in the warehouse, received 2026-10-01. */
  a1: string;
  /** TH26-01, project B, in the warehouse, received 2026-10-23. */
  b1: string;
  /** TH26-01, project A, still at Receiving lab. */
  aReceiving: string;
  /** TH26-02, project A, in the warehouse. */
  aOtherHole: string;
  /** TH26-01, project A, in the warehouse, disposed. */
  aDisposed: string;
}

export async function insertInventoryFixture(): Promise<InventoryFixture> {
  // Nine digits: with five, two of the run's many fixtures drew the same tag and the warehouse
  // code (WH-<tag>, at most 20 characters) collided on CI.
  const tag = `Q${randomInt(100_000_000, 1_000_000_000)}`;
  // 2024 numbers below 100000 are reserved for the dev seed (apps/api/seed/dev.sql).
  const base = randomInt(100_000, 990_000);
  let next = 0;
  const readableId = () => `BKT-2024-${String(base + ++next).padStart(6, '0')}`;

  return withDatabase(async (client) => {
    await client.query('BEGIN');
    try {
      const location = await client.query<{ id: string }>(
        `INSERT INTO location (code, name, kind) VALUES ($1, $2, 'warehouse') RETURNING id`,
        [`WH-${tag}`, `Warehouse ${tag}`],
      );
      const receiving = await client.query<{ id: string }>(
        `SELECT id FROM location WHERE code_normalized = 'RECEIVING'`,
      );
      const projectIds: Record<'A' | 'B', string> = { A: '', B: '' };
      const holeIds: Record<string, string> = {};
      for (const key of ['A', 'B'] as const) {
        const project = await client.query<{ id: string }>(
          `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
           VALUES ($1, $2, 'Example Client', $3) RETURNING id`,
          [`E2E-${tag}-${key}`, `Inventory demo ${key}`, PE_ID],
        );
        projectIds[key] = project.rows[0]!.id;
        for (const hole of ['TH26-01', 'TH26-02']) {
          const inserted = await client.query<{ id: string }>(
            'INSERT INTO test_hole (project_id, name) VALUES ($1, $2) RETURNING id',
            [projectIds[key], hole],
          );
          holeIds[`${key}:${hole}`] = inserted.rows[0]!.id;
        }
      }

      async function unit(
        key: 'A' | 'B',
        hole: string,
        options: { atReceiving?: boolean; receivedDate?: string; disposed?: boolean } = {},
      ) {
        const id = readableId();
        const receivedDate = options.receivedDate ?? '2026-10-12';
        const receipt = await client.query<{ id: string }>(
          `INSERT INTO receipt (project_id, received_date, receiver_user_id,
                                receiver_initials_snapshot, receiver_name_snapshot,
                                account_user_id, quantity, idempotency_key, request_hash)
           VALUES ($1, $2, $3, 'AT', 'Alex Tester', $3, 1, gen_random_uuid(), 'e2e')
           RETURNING id`,
          [projectIds[key], receivedDate, AT_ID],
        );
        const inserted = await client.query<{ id: string }>(
          `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                     receipt_id, project_id, unit_type, holder_kind,
                                     current_location_id, received_date, status)
           VALUES ($1, 'BKT', 2024, 'bucket', $2, $3, 'bucket', 'bucket', $4, $5, $6)
           RETURNING id`,
          [
            id,
            receipt.rows[0]!.id,
            projectIds[key],
            options.atReceiving ? receiving.rows[0]!.id : location.rows[0]!.id,
            receivedDate,
            options.disposed ? 'disposed' : 'in_stock',
          ],
        );
        await client.query(
          `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                  summary_type, sample_from, sample_to)
           VALUES ($1, $2, $3, 'sample_range', 'G1', 'S12')`,
          [inserted.rows[0]!.id, projectIds[key], holeIds[`${key}:${hole}`]],
        );
        return id;
      }

      const fixture: InventoryFixture = {
        tag,
        projectA: `E2E-${tag}-A`,
        projectB: `E2E-${tag}-B`,
        warehouse: `Warehouse ${tag}`,
        a1: await unit('A', 'TH26-01', { receivedDate: '2026-10-01' }),
        b1: await unit('B', 'TH26-01', { receivedDate: '2026-10-23' }),
        aReceiving: await unit('A', 'TH26-01', { atReceiving: true }),
        aOtherHole: await unit('A', 'TH26-02'),
        aDisposed: await unit('A', 'TH26-01', { disposed: true }),
      };
      await client.query('COMMIT');
      return fixture;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}
