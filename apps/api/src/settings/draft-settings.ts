import { ConflictException } from '@nestjs/common';
import type {
  DraftSettings,
  DraftSettingsVersionConflictResponse,
  putDraftSettingsRequestSchema,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { actorFor } from '../auth/auth.controller.js';
import type { AuthUser } from '../auth/policy.js';
import { withTransaction } from '../db/transaction.js';

// Draft auto-delete setting (MM-T45). One row (migration 0019); browsers read it and delete
// their own stale receiving drafts when it is on. The server never sees or deletes drafts.

interface SettingRow {
  enabled: boolean;
  after_days: number;
  version: number;
}

const COLUMNS = 'enabled, after_days, version';

function toSettings(row: SettingRow): DraftSettings {
  return {
    draftAutoDelete: { enabled: row.enabled, afterDays: row.after_days },
    version: row.version,
  };
}

/** The row, recreated with the defaults (off, 90 days) if it was ever removed. */
async function readRow(db: Pool | PoolClient, forUpdate = false): Promise<SettingRow> {
  const select = `SELECT ${COLUMNS} FROM draft_auto_delete_setting${forUpdate ? ' FOR UPDATE' : ''}`;
  const { rows } = await db.query<SettingRow>(select);
  if (rows[0]) return rows[0];
  await db.query('INSERT INTO draft_auto_delete_setting DEFAULT VALUES ON CONFLICT DO NOTHING');
  return (await db.query<SettingRow>(select)).rows[0]!;
}

export async function getDraftSettings(pool: Pool): Promise<DraftSettings> {
  return toSettings(await readRow(pool));
}

/**
 * Changes the setting when `version` is current (409 `version_conflict` with the current value
 * otherwise) and audits `settings.drafts_changed` with before/after in the same transaction.
 * Saving the same values again changes nothing and records nothing.
 */
export async function putDraftSettings(
  pool: Pool,
  user: AuthUser,
  input: z.output<typeof putDraftSettingsRequestSchema>,
  requestId: string | null,
): Promise<DraftSettings> {
  return withTransaction(pool, async (client) => {
    const row = await readRow(client, true);
    if (input.version !== row.version) {
      throw new ConflictException({
        code: 'version_conflict',
        current: toSettings(row),
      } satisfies DraftSettingsVersionConflictResponse);
    }
    const before = toSettings(row).draftAutoDelete;
    const after = input.draftAutoDelete;
    if (before.enabled === after.enabled && before.afterDays === after.afterDays) {
      return toSettings(row);
    }
    const { rows } = await client.query<SettingRow>(
      `UPDATE draft_auto_delete_setting
       SET enabled = $1, after_days = $2, version = version + 1, updated_at = now(),
           updated_by_user_id = $3
       RETURNING ${COLUMNS}`,
      [after.enabled, after.afterDays, user.userId],
    );
    await recordAudit(client, {
      action: 'settings.drafts_changed',
      entityType: 'app_setting',
      entityId: null,
      actor: actorFor(user),
      before: { draftAutoDelete: before },
      after: { draftAutoDelete: after },
      requestId,
    });
    return toSettings(rows[0]!);
  });
}
