import type { Printer, putPrintersRequestSchema } from '@trapezoid/shared';
import type { Pool } from 'pg';
import type { z } from 'zod';
import { recordAudit } from '../audit/audit.js';
import { actorFor } from '../auth/auth.controller.js';
import type { AuthUser } from '../auth/policy.js';
import type { AppConfig } from '../config/env.js';
import { withTransaction } from '../db/transaction.js';

// Printer configuration (TRP-T15). Server-side only: print requests name a printer key, never an
// address. Printers are never deleted (jobs reference them); turn one off with `enabled`.

export const CONFIG_PRINTER_KEY = 'receiving';

interface PrinterRow {
  key: string;
  name: string;
  host: string;
  port: number;
  enabled: boolean;
  is_default: boolean;
  check_status: boolean;
}

function toPrinter(row: PrinterRow): Printer {
  return {
    id: row.key,
    name: row.name,
    host: row.host,
    port: row.port,
    enabled: row.enabled,
    isDefault: row.is_default,
    checkStatus: row.check_status,
  };
}

export async function listPrinters(pool: Pool): Promise<Printer[]> {
  const { rows } = await pool.query<PrinterRow>(
    `SELECT key, name, host, port, enabled, is_default, check_status
     FROM printer ORDER BY is_default DESC, name, key`,
  );
  return rows.map(toPrinter);
}

/** Adds or updates each printer in one transaction, auditing every change. */
export async function putPrinters(
  pool: Pool,
  user: AuthUser,
  request: z.output<typeof putPrintersRequestSchema>,
  requestId: string | null,
): Promise<Printer[]> {
  await withTransaction(pool, async (client) => {
    const newDefault = request.printers.find((printer) => printer.isDefault);
    if (newDefault) {
      const { rows: cleared } = await client.query<PrinterRow>(
        `UPDATE printer SET is_default = false, updated_at = now()
         WHERE is_default AND key <> $1
         RETURNING key, name, host, port, enabled, is_default, check_status`,
        [newDefault.id],
      );
      for (const row of cleared) {
        const after = toPrinter(row);
        await recordAudit(client, {
          action: 'printer.configured',
          entityType: 'printer',
          entityId: null,
          actor: actorFor(user),
          before: { ...after, isDefault: true },
          after,
          requestId,
        });
      }
    }
    for (const printer of request.printers) {
      const { rows: before } = await client.query<PrinterRow>(
        `SELECT key, name, host, port, enabled, is_default, check_status
         FROM printer WHERE key = $1 FOR UPDATE`,
        [printer.id],
      );
      const { rows: after } = await client.query<PrinterRow>(
        `INSERT INTO printer (key, name, host, port, enabled, is_default, check_status)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (key) DO UPDATE SET
           name = EXCLUDED.name, host = EXCLUDED.host, port = EXCLUDED.port,
           enabled = EXCLUDED.enabled, is_default = EXCLUDED.is_default,
           check_status = EXCLUDED.check_status, updated_at = now()
         RETURNING key, name, host, port, enabled, is_default, check_status`,
        [
          printer.id,
          printer.name,
          printer.host,
          printer.port,
          printer.enabled,
          printer.isDefault,
          printer.checkStatus,
        ],
      );
      const previous = before[0] ? toPrinter(before[0]) : null;
      const next = toPrinter(after[0]!);
      if (JSON.stringify(previous) === JSON.stringify(next)) continue;
      await recordAudit(client, {
        action: 'printer.configured',
        entityType: 'printer',
        entityId: null,
        actor: actorFor(user),
        before: previous,
        after: next,
        requestId,
      });
    }
  });
  return listPrinters(pool);
}

/**
 * Creates the receiving printer from LABEL_PRINTER_HOST the first time the API starts with it
 * set. Later changes are made by an admin, so an existing printer is never overwritten.
 */
export async function ensureConfiguredPrinter(pool: Pool, config: AppConfig): Promise<boolean> {
  if (!config.LABEL_PRINTER_HOST) return false;
  const { rowCount } = await pool.query(
    `INSERT INTO printer (key, name, host, port, is_default)
     VALUES ($1, $2, $3, $4, NOT EXISTS (SELECT 1 FROM printer WHERE is_default))
     ON CONFLICT (key) DO NOTHING`,
    [
      CONFIG_PRINTER_KEY,
      config.LABEL_PRINTER_NAME,
      config.LABEL_PRINTER_HOST,
      config.LABEL_PRINTER_PORT,
    ],
  );
  return (rowCount ?? 0) > 0;
}
