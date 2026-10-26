import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  ConfirmReceiptRequest,
  ConfirmReceiptResponse,
  FieldError,
  ReceiptUnitInput,
} from '@trapezoid/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { allocateStorageUnitIds, type HolderKind } from '../numbering/storage-unit-id.js';
import { receiptPayloadHash } from './payload-hash.js';

export interface ConfirmReceiptResult {
  response: ConfirmReceiptResponse;
  /** False when this was a retry and the original result was returned unchanged. */
  created: boolean;
}

/** Physical holder (and so ID prefix) for each receivable unit type at confirmation. */
const HOLDER_BY_UNIT_TYPE: Readonly<Record<ReceiptUnitInput['unitType'], HolderKind>> = {
  bucket: 'bucket',
};

/** Today's date (YYYY-MM-DD) in `timeZone`. */
export function businessToday(now: Date, timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

function validationFailed(errors: FieldError[]): never {
  throw new BadRequestException({ code: 'validation_failed', errors });
}

interface ExistingReceipt {
  id: string;
  request_hash: string;
}

/**
 * Online receipt confirmation (TRP-T09): turns a completed receiving draft into a receipt and its
 * storage units in one transaction, safe to retry with the same idempotency key.
 *
 * Isolation: READ COMMITTED is enough. ID allocation serialises on the counter row lock
 * (storage_unit_annual_counter, held until commit), the idempotency key is a unique constraint,
 * and every validation read either targets rows that receipts never modify (project, test hole,
 * user) or is backed by a foreign key that the inserts re-check. A concurrent request with the
 * same key blocks on the receipt insert until the first commits, then sees its row.
 */
@Injectable()
export class ReceiptsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  async confirm(
    request: ConfirmReceiptRequest,
    account: AuthUser,
    options: { now?: Date } = {},
  ): Promise<ConfirmReceiptResult> {
    const requestHash = receiptPayloadHash(request);
    const now = options.now ?? new Date();

    return withTransaction(this.database.pool, async (client) => {
      // A retry is answered before validation, so it returns the original result even if
      // something it depended on (e.g. the receiver's status) has changed since.
      const existing = await this.findByKey(client, request.idempotencyKey);
      if (existing) {
        return this.replay(client, existing, request, requestHash);
      }

      const { projectNumber, receiver } = await this.validate(client, request, now);
      const locationId = await this.receivingLabId(client);

      const { rows: inserted } = await client.query<{ id: string }>(
        `INSERT INTO receipt (project_id, received_date, receiver_user_id,
                              receiver_initials_snapshot, receiver_name_snapshot, account_user_id,
                              description, quantity, idempotency_key, request_hash, confirmed_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (idempotency_key) DO NOTHING
         RETURNING id`,
        [
          request.projectId,
          request.receivedDate,
          receiver.id,
          receiver.initials,
          receiver.name,
          account.userId,
          request.description,
          request.units.length,
          request.idempotencyKey,
          requestHash,
          now,
        ],
      );
      if (inserted.length === 0) {
        // A concurrent request with the same key committed first.
        const winner = await this.findByKey(client, request.idempotencyKey);
        return this.replay(client, winner!, request, requestHash);
      }
      const receiptId = inserted[0]!.id;

      const readableIds = await this.allocateIds(client, request.units, now);
      const actor: AuditActor = {
        userId: account.userId,
        accountType: account.accountType,
        initials: account.initials,
        name: account.displayName,
      };

      await recordAudit(client, {
        action: 'receipt.confirmed',
        entityType: 'receipt',
        entityId: receiptId,
        actor,
        receiverUserId: receiver.id,
        after: {
          projectNumber,
          receivedDate: request.receivedDate,
          receiverInitials: receiver.initials,
          unitCount: request.units.length,
          readableIds,
        },
      });

      const units: ConfirmReceiptResponse['units'] = [];
      for (const [index, unit] of request.units.entries()) {
        const readableId = readableIds[index]!;
        const [prefix, year] = readableId.split('-');
        const holderKind = HOLDER_BY_UNIT_TYPE[unit.unitType];
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                     receipt_id, project_id, unit_type, holder_kind, note,
                                     current_location_id, status, received_date, receipt_line)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_stock', $11, $12)
           RETURNING id`,
          [
            readableId,
            prefix,
            Number(year),
            holderKind,
            receiptId,
            request.projectId,
            unit.unitType,
            holderKind,
            unit.note,
            locationId,
            request.receivedDate,
            index + 1,
          ],
        );
        const storageUnitId = rows[0]!.id;

        for (const summary of unit.holeSummaries) {
          await client.query(
            `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                    summary_type, sample_from, sample_to,
                                                    depth_from, depth_to, depth_unit, custom_text,
                                                    note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              storageUnitId,
              request.projectId,
              summary.testHoleId,
              summary.type,
              summary.sampleFrom,
              summary.sampleTo,
              summary.depthFrom,
              summary.depthTo,
              summary.depthUnit,
              summary.customText,
              summary.note,
            ],
          );
        }

        await recordAudit(client, {
          action: 'storage_unit.created',
          entityType: 'storage_unit',
          entityId: storageUnitId,
          actor,
          receiverUserId: receiver.id,
          after: {
            readableId,
            receiptId,
            projectNumber,
            unitType: unit.unitType,
            status: 'in_stock',
            location: 'Receiving lab',
            testHoleCount: unit.holeSummaries.length,
          },
        });
        units.push({ clientRowId: unit.clientRowId, storageUnitId, suNumber: readableId });
      }

      return { response: { receiptId, units }, created: true };
    });
  }

  private async findByKey(client: PoolClient, key: string): Promise<ExistingReceipt | null> {
    const { rows } = await client.query<ExistingReceipt>(
      'SELECT id, request_hash FROM receipt WHERE idempotency_key = $1',
      [key],
    );
    return rows[0] ?? null;
  }

  /** The original response for a retry, or 409 if the key was reused for a different payload. */
  private async replay(
    client: PoolClient,
    existing: ExistingReceipt,
    request: ConfirmReceiptRequest,
    requestHash: string,
  ): Promise<ConfirmReceiptResult> {
    if (existing.request_hash !== requestHash) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    const { rows } = await client.query<{ id: string; readable_id: string; receipt_line: number }>(
      `SELECT id, readable_id, receipt_line FROM storage_unit
       WHERE receipt_id = $1 ORDER BY receipt_line`,
      [existing.id],
    );
    // Same hash means the same units in the same order, so line N is request unit N.
    const units = rows.map((row) => ({
      clientRowId: request.units[row.receipt_line - 1]!.clientRowId,
      storageUnitId: row.id,
      suNumber: row.readable_id,
    }));
    return { response: { receiptId: existing.id, units }, created: false };
  }

  /** Checks that need the database or the clock; shape rules ran in the shared schema. */
  private async validate(client: PoolClient, request: ConfirmReceiptRequest, now: Date) {
    const errors: FieldError[] = [];

    if (request.units.length > this.config.RECEIPT_MAX_UNITS) {
      errors.push({
        field: 'units',
        code: 'too_many_units',
        message: `can have at most ${this.config.RECEIPT_MAX_UNITS} storage units`,
      });
    }
    if (request.receivedDate > businessToday(now, this.config.BUSINESS_TIME_ZONE)) {
      errors.push({ field: 'receivedDate', code: 'in_future', message: "can't be in the future" });
    }

    const { rows: projects } = await client.query<{ project_number: string }>(
      'SELECT project_number FROM project WHERE id = $1',
      [request.projectId],
    );
    if (projects.length === 0) {
      errors.push({ field: 'projectId', code: 'not_found', message: 'project not found' });
    }

    const { rows: users } = await client.query<{
      id: string;
      display_name: string;
      official_initials: string | null;
      account_type: string;
      status: string;
    }>(
      `SELECT id, display_name, official_initials, account_type, status
       FROM app_user WHERE id = $1`,
      [request.receiverUserId],
    );
    const receiverRow = users[0];
    if (!receiverRow) {
      errors.push({
        field: 'receiverUserId',
        code: 'not_found',
        message: 'staff member not found',
      });
    } else if (receiverRow.status !== 'active' || receiverRow.account_type === 'shared_lab') {
      // The receiver is a person; the shared LAB account can confirm but never be the receiver.
      errors.push({
        field: 'receiverUserId',
        code: 'receiver_not_active',
        message: 'must be an active staff member',
      });
    } else if (!receiverRow.official_initials) {
      errors.push({
        field: 'receiverUserId',
        code: 'receiver_missing_initials',
        message: 'staff member has no confirmed initials yet',
      });
    }

    if (errors.length > 0) {
      validationFailed(errors);
    }

    // Every test hole must belong to the receipt's project (one project per unit, D12).
    const holeIds = [
      ...new Set(request.units.flatMap((u) => u.holeSummaries.map((s) => s.testHoleId))),
    ];
    const { rows: holes } = await client.query<{ id: string }>(
      'SELECT id FROM test_hole WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [request.projectId, holeIds],
    );
    const inProject = new Set(holes.map((h) => h.id));
    const holeErrors: FieldError[] = [];
    request.units.forEach((unit, u) =>
      unit.holeSummaries.forEach((summary, s) => {
        if (!inProject.has(summary.testHoleId)) {
          holeErrors.push({
            field: `units.${u}.holeSummaries.${s}.testHoleId`,
            code: 'test_hole_not_in_project',
            message: 'test hole is not part of this project',
          });
        }
      }),
    );
    if (holeErrors.length > 0) {
      throw new UnprocessableEntityException({
        code: 'test_hole_not_in_project',
        errors: holeErrors,
      });
    }

    return {
      projectNumber: projects[0]!.project_number,
      receiver: {
        id: receiverRow!.id,
        name: receiverRow!.display_name,
        initials: receiverRow!.official_initials!,
      },
    };
  }

  private async receivingLabId(client: PoolClient): Promise<string> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM location WHERE kind = 'receiving_lab' AND is_system AND active
       ORDER BY created_at LIMIT 1`,
    );
    if (!rows[0]) {
      throw new Error('Receiving lab location is missing; run npm run db:migrate.');
    }
    return rows[0].id;
  }

  /**
   * Readable IDs in submitted order. Each holder kind takes one contiguous block from its own
   * prefix/year counter, inside this transaction, so a rollback returns every number.
   */
  private async allocateIds(
    client: PoolClient,
    units: ConfirmReceiptRequest['units'],
    now: Date,
  ): Promise<string[]> {
    const counts = new Map<HolderKind, number>();
    for (const unit of units) {
      const kind = HOLDER_BY_UNIT_TYPE[unit.unitType];
      counts.set(kind, (counts.get(kind) ?? 0) + 1);
    }
    const blocks = new Map<HolderKind, string[]>();
    for (const [kind, count] of counts) {
      const allocated = await allocateStorageUnitIds(client, kind, count, {
        issuedAt: now,
        timeZone: this.config.BUSINESS_TIME_ZONE,
      });
      blocks.set(kind, allocated.ids);
    }
    return units.map((unit) => blocks.get(HOLDER_BY_UNIT_TYPE[unit.unitType])!.shift()!);
  }
}
