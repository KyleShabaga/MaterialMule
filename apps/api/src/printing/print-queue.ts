import {
  locationPayload,
  type CreateLocationLabelRequest,
  type CreatePrintJobRequest,
  type PrintHistoryResponse,
  type PrintJob,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditReceiver } from '../audit/audit.js';
import { actorFor } from '../auth/auth.controller.js';
import type { AuthUser } from '../auth/policy.js';
import { withTransaction } from '../db/transaction.js';
import { LOCATION_TEMPLATE_VERSION } from '../labels/location-template-v1.js';
import { TEMPLATE_VERSION } from '../labels/template-v1.js';
import { auditReceiver, findActiveStaff } from '../staff-directory/staff-directory.js';

// Print queue data access (MM-T15). Requests only create jobs; the worker sends them. Nothing
// here ever changes a receipt, storage unit or location: printing is separate from inventory.
// A job prints storage-unit stickers or location labels (MM-T37), never both; a location job
// names its locations directly, never through a stand-in storage unit or receipt.

export type PrintErrorCode =
  | 'unknown_printer'
  | 'no_printer_configured'
  | 'unknown_storage_unit'
  | 'unknown_location'
  | 'location_retired'
  | 'receiver_required'
  | 'unknown_receiver'
  | 'not_found'
  | 'not_confirmable';

export class PrintRequestError extends Error {
  override name = 'PrintRequestError';
  constructor(
    readonly code: PrintErrorCode,
    message: string,
  ) {
    super(message);
  }
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface JobRow {
  id: string;
  kind: PrintJob['kind'];
  target_type: PrintJob['target'];
  printer_key: string;
  printer_name: string;
  template_version: string;
  status: PrintJob['status'];
  attempts: number;
  last_error: string | null;
  printer_message: string | null;
  created_at: Date;
  updated_at: Date;
  sent_at: Date | null;
  physically_confirmed_at: Date | null;
  requested_by_user_id: string;
  requested_by_name: string;
  requested_by_initials: string | null;
  receiver_user_id: string | null;
  receiver_name: string | null;
  receiver_initials: string | null;
  confirmed_by_user_id: string | null;
  confirmed_by_name: string | null;
  confirmed_by_initials: string | null;
}

const SELECT_JOBS = `
  SELECT j.id, j.kind, j.target_type, j.printer_key, p.name AS printer_name, j.template_version, j.status,
         j.attempts, j.last_error, j.printer_message, j.created_at, j.updated_at, j.sent_at,
         j.physically_confirmed_at,
         -- MM-T65: each person as they were at the time (requester and receiver at the request,
         -- confirmer at the confirmation); for older jobs without a snapshot (none in history
         -- either), the person as they are now. Initials and name always come from one source.
         j.requested_by_user_id,
         CASE WHEN j.requested_by_name_snapshot IS NOT NULL THEN j.requested_by_name_snapshot
              ELSE rq.display_name END AS requested_by_name,
         CASE WHEN j.requested_by_name_snapshot IS NOT NULL THEN j.requested_by_initials_snapshot
              ELSE rq.official_initials END AS requested_by_initials,
         j.receiver_user_id,
         CASE WHEN j.receiver_name_snapshot IS NOT NULL THEN j.receiver_name_snapshot
              ELSE rc.display_name END AS receiver_name,
         CASE WHEN j.receiver_name_snapshot IS NOT NULL THEN j.receiver_initials_snapshot
              ELSE rc.official_initials END AS receiver_initials,
         j.physically_confirmed_by_user_id AS confirmed_by_user_id,
         CASE WHEN j.confirmed_by_name_snapshot IS NOT NULL THEN j.confirmed_by_name_snapshot
              ELSE cf.display_name END AS confirmed_by_name,
         CASE WHEN j.confirmed_by_name_snapshot IS NOT NULL THEN j.confirmed_by_initials_snapshot
              ELSE cf.official_initials END AS confirmed_by_initials
  FROM print_job j
  JOIN printer p ON p.key = j.printer_key
  JOIN app_user rq ON rq.id = j.requested_by_user_id
  LEFT JOIN app_user rc ON rc.id = j.receiver_user_id
  LEFT JOIN app_user cf ON cf.id = j.physically_confirmed_by_user_id`;

type Queryable = Pool | PoolClient;

async function loadJobs(db: Queryable, where: string, params: unknown[]): Promise<PrintJob[]> {
  const { rows } = await db.query<JobRow>(`${SELECT_JOBS} ${where}`, params);
  if (rows.length === 0) return [];
  const jobIds = rows.map((row) => row.id);
  const items = await db.query<{
    print_job_id: string;
    storage_unit_id: string;
    readable_id: string;
    position: number;
  }>(
    `SELECT i.print_job_id, i.storage_unit_id, su.readable_id, i.position
     FROM print_job_item i JOIN storage_unit su ON su.id = i.storage_unit_id
     WHERE i.print_job_id = ANY($1::uuid[])
     ORDER BY i.print_job_id, i.position`,
    [jobIds],
  );
  const itemsByJob = new Map<string, PrintJob['items']>();
  for (const item of items.rows) {
    const list = itemsByJob.get(item.print_job_id) ?? [];
    list.push({
      storageUnitId: item.storage_unit_id,
      readableId: item.readable_id,
      position: item.position,
    });
    itemsByJob.set(item.print_job_id, list);
  }
  // Location labels as they were requested (code and name snapshots, MM-T37).
  const locationItems = await db.query<{
    print_job_id: string;
    location_id: string;
    code_snapshot: string;
    name_snapshot: string;
    position: number;
  }>(
    `SELECT print_job_id, location_id, code_snapshot, name_snapshot, position
     FROM print_job_location_item
     WHERE print_job_id = ANY($1::uuid[])
     ORDER BY print_job_id, position`,
    [jobIds],
  );
  const locationsByJob = new Map<string, PrintJob['locations']>();
  for (const item of locationItems.rows) {
    const list = locationsByJob.get(item.print_job_id) ?? [];
    list.push({
      locationId: item.location_id,
      code: item.code_snapshot,
      name: item.name_snapshot,
      payload: locationPayload(item.code_snapshot),
      position: item.position,
    });
    locationsByJob.set(item.print_job_id, list);
  }
  return rows.map((row) =>
    toPrintJob(row, itemsByJob.get(row.id) ?? [], locationsByJob.get(row.id) ?? []),
  );
}

function person(userId: string | null, name: string | null, initials: string | null) {
  return userId ? { userId, name: name ?? '', initials } : null;
}

function toPrintJob(
  row: JobRow,
  items: PrintJob['items'],
  locations: PrintJob['locations'],
): PrintJob {
  return {
    id: row.id,
    kind: row.kind,
    printerId: row.printer_key,
    printerName: row.printer_name,
    templateVersion: row.template_version,
    status: row.status,
    attempts: row.attempts,
    lastError: row.last_error,
    printerMessage: row.printer_message,
    requestedBy: {
      userId: row.requested_by_user_id,
      name: row.requested_by_name,
      initials: row.requested_by_initials,
    },
    receiver: person(row.receiver_user_id, row.receiver_name, row.receiver_initials),
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    sentAt: row.sent_at?.toISOString() ?? null,
    physicallyConfirmedAt: row.physically_confirmed_at?.toISOString() ?? null,
    physicallyConfirmedBy: person(
      row.confirmed_by_user_id,
      row.confirmed_by_name,
      row.confirmed_by_initials,
    ),
    target: row.target_type,
    items,
    locations,
  };
}

export async function getPrintJob(db: Queryable, jobId: string): Promise<PrintJob | null> {
  if (!UUID_PATTERN.test(jobId)) return null;
  const [job] = await loadJobs(db, 'WHERE j.id = $1', [jobId]);
  return job ?? null;
}

async function resolvePrinter(client: PoolClient, printerId: string | undefined) {
  const { rows } = await client.query<{ key: string; name: string }>(
    printerId
      ? 'SELECT key, name FROM printer WHERE key = $1 AND enabled'
      : 'SELECT key, name FROM printer WHERE is_default AND enabled',
    printerId ? [printerId] : [],
  );
  const printer = rows[0];
  if (!printer) {
    throw printerId
      ? new PrintRequestError('unknown_printer', 'That printer is not configured or is turned off.')
      : new PrintRequestError(
          'no_printer_configured',
          'No label printer is set up yet. Ask an administrator to add one.',
        );
  }
  return printer;
}

/**
 * The staff member credited at a shared LAB station: given, or the receipt's receiver when the
 * job's units share exactly one. Location labels pass no receipt receivers, so LAB must choose.
 */
async function resolveReceiver(
  client: PoolClient,
  user: AuthUser,
  requested: string | undefined,
  receiptReceivers: string[],
): Promise<AuditReceiver | null> {
  if (user.accountType !== 'shared_lab') return null;
  const receiverId =
    requested ?? (receiptReceivers.length === 1 ? receiptReceivers[0]! : undefined);
  if (!receiverId) {
    throw new PrintRequestError('receiver_required', 'Choose who is printing these labels.');
  }
  const staff = await findActiveStaff(client, receiverId);
  if (!staff) {
    throw new PrintRequestError('unknown_receiver', 'That staff member was not found.');
  }
  return auditReceiver(staff);
}

/**
 * Queues one job for the given storage units, in the order given. A reprint is a new job for the
 * same issued IDs; it never creates, renumbers or moves a storage unit.
 */
export async function enqueuePrintJob(
  pool: Pool,
  user: AuthUser,
  request: CreatePrintJobRequest,
  requestId: string | null,
): Promise<PrintJob> {
  return withTransaction(pool, async (client) => {
    const printer = await resolvePrinter(client, request.printerId);

    const { rows: units } = await client.query<{
      id: string;
      readable_id: string;
      project_number: string;
      receiver_user_id: string;
    }>(
      `SELECT su.id, su.readable_id, p.project_number, r.receiver_user_id
       FROM storage_unit su
       JOIN project p ON p.id = su.project_id
       JOIN receipt r ON r.id = su.receipt_id
       WHERE su.id = ANY($1::uuid[])`,
      [request.storageUnitIds],
    );
    if (units.length !== request.storageUnitIds.length) {
      throw new PrintRequestError('unknown_storage_unit', 'A storage unit was not found.');
    }
    const byId = new Map(units.map((unit) => [unit.id, unit]));
    const ordered = request.storageUnitIds.map((id) => byId.get(id)!);

    const receiver = await resolveReceiver(client, user, request.receiverUserId, [
      ...new Set(ordered.map((unit) => unit.receiver_user_id)),
    ]);

    const actor = actorFor(user);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO print_job (kind, printer_key, template_version, requested_by_user_id,
                              requested_by_initials_snapshot, requested_by_name_snapshot,
                              receiver_user_id, receiver_initials_snapshot, receiver_name_snapshot)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        request.kind,
        printer.key,
        TEMPLATE_VERSION,
        user.userId,
        actor.initials,
        actor.name,
        receiver?.userId ?? null,
        receiver?.initials ?? null,
        receiver?.name ?? null,
      ],
    );
    const jobId = rows[0]!.id;
    await client.query(
      `INSERT INTO print_job_item (print_job_id, storage_unit_id, position)
       SELECT $1, unit_id, position::int
       FROM unnest($2::uuid[]) WITH ORDINALITY AS t(unit_id, position)`,
      [jobId, request.storageUnitIds],
    );

    const readableIds = ordered.map((unit) => unit.readable_id);
    const projectNumbers = [...new Set(ordered.map((unit) => unit.project_number))];
    await recordAudit(client, {
      action: request.kind === 'reprint' ? 'label.reprint_requested' : 'label.print_requested',
      entityType: 'print_job',
      entityId: jobId,
      actor,
      receiver,
      after: {
        kind: request.kind,
        printerId: printer.key,
        templateVersion: TEMPLATE_VERSION,
        readableIds,
        ...(readableIds.length === 1 ? { readableId: readableIds[0] } : {}),
        unitCount: readableIds.length,
        ...(projectNumbers.length === 1 ? { projectNumber: projectNumbers[0] } : {}),
      },
      requestId,
    });

    return (await getPrintJob(client, jobId))!;
  });
}

/**
 * Queues one location label (MM-T37) through the same queue and worker as stickers.
 *
 * Code-lock boundary: the location row is locked FOR UPDATE, the job and its item (with the code
 * and name snapshot) are written, and `code_locked_at` is set, all in this transaction. A code
 * edit locks the same row first, so it either commits before this request (and the label carries
 * the new code) or waits and then finds the code locked. From the first request on, the
 * LOC-<CODE> payload can never change, whether the job is queued, sending, sent, failed or
 * uncertain. `label_printed_at` is NOT set here: only a person's physical confirmation sets it.
 *
 * A LAB station must name the staff member printing: a location has no receipt receiver to fall
 * back on. The kind (initial or reprint) follows the location's own print history.
 */
export async function enqueueLocationLabelJob(
  pool: Pool,
  user: AuthUser,
  locationId: string,
  request: CreateLocationLabelRequest,
  requestId: string | null,
): Promise<PrintJob> {
  if (!UUID_PATTERN.test(locationId)) {
    throw new PrintRequestError('unknown_location', 'Location not found.');
  }
  return withTransaction(pool, async (client) => {
    const { rows: locations } = await client.query<{
      id: string;
      code_normalized: string;
      name: string;
      active: boolean;
      code_locked_at: Date | null;
    }>(
      `SELECT id, code_normalized, name, active, code_locked_at
       FROM location WHERE id = $1 FOR UPDATE`,
      [locationId],
    );
    const location = locations[0];
    if (!location) throw new PrintRequestError('unknown_location', 'Location not found.');
    if (!location.active) {
      throw new PrintRequestError(
        'location_retired',
        'This location is retired. Labels can only be printed for active locations.',
      );
    }
    const printer = await resolvePrinter(client, request.printerId);
    const receiver = await resolveReceiver(client, user, request.receiverUserId, []);

    const { rows: earlier } = await client.query(
      'SELECT 1 FROM print_job_location_item WHERE location_id = $1 LIMIT 1',
      [locationId],
    );
    const kind: PrintJob['kind'] = earlier.length > 0 ? 'reprint' : 'initial';

    if (location.code_locked_at === null) {
      await client.query('UPDATE location SET code_locked_at = now() WHERE id = $1', [locationId]);
    }

    const actor = actorFor(user);
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO print_job (kind, target_type, printer_key, template_version, requested_by_user_id,
                              requested_by_initials_snapshot, requested_by_name_snapshot,
                              receiver_user_id, receiver_initials_snapshot, receiver_name_snapshot)
       VALUES ($1, 'location', $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [
        kind,
        printer.key,
        LOCATION_TEMPLATE_VERSION,
        user.userId,
        actor.initials,
        actor.name,
        receiver?.userId ?? null,
        receiver?.initials ?? null,
        receiver?.name ?? null,
      ],
    );
    const jobId = rows[0]!.id;
    await client.query(
      `INSERT INTO print_job_location_item (print_job_id, location_id, position, code_snapshot,
                                            name_snapshot)
       VALUES ($1, $2, 1, $3, $4)`,
      [jobId, locationId, location.code_normalized, location.name],
    );

    await recordAudit(client, {
      action: kind === 'reprint' ? 'label.reprint_requested' : 'label.print_requested',
      entityType: 'print_job',
      entityId: jobId,
      actor,
      receiver,
      after: {
        kind,
        target: 'location',
        printerId: printer.key,
        templateVersion: LOCATION_TEMPLATE_VERSION,
        locationId,
        locationCode: location.code_normalized,
        payload: locationPayload(location.code_normalized),
        ...(location.code_locked_at === null ? { codeLocked: true } : {}),
      },
      requestId,
    });

    return (await getPrintJob(client, jobId))!;
  });
}

/** Every label job for the location, newest first (MM-T37). */
export async function getLocationPrintJobs(db: Queryable, locationId: string): Promise<PrintJob[]> {
  return loadJobs(
    db,
    `WHERE j.id IN (SELECT print_job_id FROM print_job_location_item WHERE location_id = $1)
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT 100`,
    [locationId],
  );
}

/** Every print job that included the storage unit (UUID or readable ID), newest first. */
export async function getPrintHistory(
  pool: Pool,
  storageUnit: string,
): Promise<PrintHistoryResponse | null> {
  const byUuid = UUID_PATTERN.test(storageUnit);
  const { rows } = await pool.query<{ id: string; readable_id: string }>(
    byUuid
      ? 'SELECT id, readable_id FROM storage_unit WHERE id = $1'
      : 'SELECT id, readable_id FROM storage_unit WHERE readable_id = upper($1)',
    [storageUnit],
  );
  const unit = rows[0];
  if (!unit) return null;
  const jobs = await loadJobs(
    pool,
    `WHERE j.id IN (SELECT print_job_id FROM print_job_item WHERE storage_unit_id = $1)
     ORDER BY j.created_at DESC, j.id DESC
     LIMIT 100`,
    [unit.id],
  );
  return { storageUnit: { id: unit.id, readableId: unit.readable_id }, jobs };
}

/**
 * Records a person's "Labels came out OK". Only then may the UI say the labels physically
 * printed. Allowed for sent and uncertain jobs; confirming twice changes nothing.
 */
export async function confirmPhysicalPrint(
  pool: Pool,
  user: AuthUser,
  jobId: string,
  requestId: string | null,
): Promise<PrintJob> {
  if (!UUID_PATTERN.test(jobId)) {
    throw new PrintRequestError('not_found', 'Print job not found.');
  }
  return withTransaction(pool, async (client) => {
    const { rows } = await client.query<{
      status: PrintJob['status'];
      target_type: PrintJob['target'];
      physically_confirmed_at: Date | null;
    }>(
      'SELECT status, target_type, physically_confirmed_at FROM print_job WHERE id = $1 FOR UPDATE',
      [jobId],
    );
    const job = rows[0];
    if (!job) throw new PrintRequestError('not_found', 'Print job not found.');
    if (job.physically_confirmed_at === null) {
      if (job.status !== 'sent' && job.status !== 'uncertain') {
        throw new PrintRequestError(
          'not_confirmable',
          'Only labels that were sent to the printer can be marked as printed.',
        );
      }
      await client.query(
        `UPDATE print_job
         SET physically_confirmed_at = now(), physically_confirmed_by_user_id = $2,
             confirmed_by_initials_snapshot = $3, confirmed_by_name_snapshot = $4,
             updated_at = now()
         WHERE id = $1`,
        [jobId, user.userId, user.initials, user.displayName],
      );
      if (job.target_type === 'location') {
        await confirmLocationLabels(client, user, jobId, job.status, requestId);
        return (await getPrintJob(client, jobId))!;
      }
      const { rows: items } = await client.query<{ readable_id: string }>(
        `SELECT su.readable_id FROM print_job_item i
         JOIN storage_unit su ON su.id = i.storage_unit_id
         WHERE i.print_job_id = $1 ORDER BY i.position`,
        [jobId],
      );
      const readableIds = items.map((item) => item.readable_id);
      await recordAudit(client, {
        action: 'label.physically_confirmed',
        entityType: 'print_job',
        entityId: jobId,
        actor: actorFor(user),
        before: { status: job.status },
        after: {
          readableIds,
          ...(readableIds.length === 1 ? { readableId: readableIds[0] } : {}),
          unitCount: readableIds.length,
        },
        requestId,
      });
    }
    return (await getPrintJob(client, jobId))!;
  });
}

/**
 * Physical confirmation of a location label job (MM-T37): the job's `label.physically_confirmed`
 * event, and for each location the first confirmation is recorded on the location
 * (`label_printed_at`) with a `location.label_printed` event. Only this path writes either.
 */
async function confirmLocationLabels(
  client: PoolClient,
  user: AuthUser,
  jobId: string,
  status: PrintJob['status'],
  requestId: string | null,
): Promise<void> {
  const actor = actorFor(user);
  const { rows: items } = await client.query<{ location_id: string; code_snapshot: string }>(
    `SELECT location_id, code_snapshot FROM print_job_location_item
     WHERE print_job_id = $1 ORDER BY position`,
    [jobId],
  );
  const locationCodes = items.map((item) => item.code_snapshot);
  await recordAudit(client, {
    action: 'label.physically_confirmed',
    entityType: 'print_job',
    entityId: jobId,
    actor,
    before: { status },
    after: {
      target: 'location',
      locationCodes,
      ...(locationCodes.length === 1 ? { locationCode: locationCodes[0] } : {}),
    },
    requestId,
  });
  for (const item of items) {
    const { rowCount } = await client.query(
      `UPDATE location SET label_printed_at = now()
       WHERE id = $1 AND label_printed_at IS NULL`,
      [item.location_id],
    );
    await recordAudit(client, {
      action: 'location.label_printed',
      entityType: 'location',
      entityId: item.location_id,
      actor,
      after: {
        printJobId: jobId,
        locationCode: item.code_snapshot,
        payload: locationPayload(item.code_snapshot),
        firstConfirmation: rowCount === 1,
      },
      requestId,
    });
  }
}
