import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  DEFAULT_STATION_ROWS,
  normalizeStationRows,
  type StationConfig,
  type UpdateStationConfig,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { actorFor } from '../auth/auth.controller.js';
import { can, type AuthUser } from '../auth/policy.js';
import { asLocked, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';

// A station's "At this station" rows (migration 0045). Every active session reads them; only a
// Lab Manager with their own account saves (`station.configure`, Kyle 2026-11-12/13, STRATA-36).
// There is no way for the LAB session to save, whoever it picks.

interface ConfigRow {
  station_id: string;
  rows: { row: string; visible: boolean }[];
  version: number;
  updated_by_user_id: string;
  updated_by_name: string;
  updated_at: Date;
}

const SELECT = `SELECT c.station_id, c.rows, c.version, c.updated_by_user_id,
                       u.display_name AS updated_by_name, c.updated_at
                FROM station_config c JOIN app_user u ON u.id = c.updated_by_user_id
                WHERE c.station_id = $1`;

function toConfig(stationId: string, row: ConfigRow | undefined): StationConfig {
  if (!row) {
    return {
      stationId,
      rows: DEFAULT_STATION_ROWS.map((r) => ({ ...r })),
      version: 0,
      updatedBy: null,
      updatedAt: null,
    };
  }
  return {
    stationId,
    rows: normalizeStationRows(Array.isArray(row.rows) ? row.rows : []),
    version: row.version,
    updatedBy: { userId: row.updated_by_user_id, name: row.updated_by_name },
    updatedAt: row.updated_at.toISOString(),
  };
}

async function readConfig(
  db: Pool | PoolClient,
  stationId: string,
  forUpdate = false,
): Promise<StationConfig> {
  const { rows } = await db.query<ConfigRow>(`${SELECT}${forUpdate ? ' FOR UPDATE OF c' : ''}`, [
    stationId,
  ]);
  return toConfig(stationId, rows[0]);
}

@Injectable()
export class StationConfigService {
  constructor(private readonly database: DatabaseService) {}

  get(stationId: string): Promise<StationConfig> {
    return readConfig(this.database.pool, stationId);
  }

  /**
   * Saves when `version` is current: 409 `version_conflict` with the current configuration
   * otherwise, and nothing is written. The Lab Manager role is checked again on the account as it
   * stands in this transaction. A first save that races another first save loses with 409 too.
   */
  save(
    user: AuthUser,
    stationId: string,
    input: UpdateStationConfig,
    requestId: string | null,
  ): Promise<StationConfig> {
    return withTransaction(this.database.pool, async (client) => {
      // A first save has no row to lock: serialize on the station ID.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 45))`, [stationId]);
      const actor = asLocked(user, await lockStanding(client, [user.userId]));
      if (!can(actor, 'station.configure')) throw new ForbiddenException({ code: 'forbidden' });
      const current = await readConfig(client, stationId, true);
      if (input.version !== current.version) {
        throw new ConflictException({ code: 'version_conflict', current });
      }
      const rows = normalizeStationRows(input.rows);
      const params = [stationId, JSON.stringify(rows), user.userId];
      if (current.version === 0) {
        await client.query(
          `INSERT INTO station_config (station_id, rows, version, updated_by_user_id)
           VALUES ($1, $2::jsonb, 1, $3)`,
          params,
        );
      } else {
        await client.query(
          `UPDATE station_config
           SET rows = $2::jsonb, version = version + 1, updated_by_user_id = $3, updated_at = now()
           WHERE station_id = $1`,
          params,
        );
      }
      await recordAudit(client, {
        action: 'station_config.saved',
        entityType: 'station_config',
        entityId: null,
        actor: actorFor(user),
        before: { stationId, rows: current.rows, version: current.version },
        after: { stationId, rows, version: current.version + 1 },
        requestId,
      });
      return readConfig(client, stationId);
    });
  }
}
