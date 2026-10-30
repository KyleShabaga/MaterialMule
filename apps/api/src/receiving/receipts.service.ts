import {
  BadRequestException,
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  BulkGroupSummary,
  ConfirmReceiptRequest,
  ConfirmReceiptResponse,
  FieldError,
  NewBulkGroupInput,
  ReceiptUnitInput,
  SampleIdentity,
  ShelbySampleInput,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor, type AuditReceiver } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import {
  allocateStorageUnitIds,
  PREFIX_BY_HOLDER,
  StorageUnitIdOverflowError,
  type HolderKind,
} from '../numbering/storage-unit-id.js';
import { findBulkGroup } from '../storage-units/sample-identity.js';
import { receiptPayloadHash } from './payload-hash.js';

export interface ConfirmReceiptResult {
  response: ConfirmReceiptResponse;
  /** False when this was a retry and the original result was returned unchanged. */
  created: boolean;
}

/** Physical holder (and so ID prefix) for each receivable unit type at confirmation. */
const HOLDER_BY_UNIT_TYPE: Readonly<Record<ReceiptUnitInput['unitType'], HolderKind>> = {
  bucket: 'bucket',
  shelby_tube: 'shelby_tube',
};

/**
 * Stored unit type: a bucket holding a bulk soil sample is `bulk_container` (MM-T36), still a
 * physical bucket with a BKT- ID; the holder, not the contents, decides the prefix.
 */
function storedUnitType(unit: ReceiptUnitInput): 'bucket' | 'shelby_tube' | 'bulk_container' {
  if (unit.unitType === 'shelby_tube') return 'shelby_tube';
  return unit.bulkGroup ? 'bulk_container' : 'bucket';
}

/** Source and sample fields as an identity, for audit events. */
function identityOf(
  input: ShelbySampleInput | NewBulkGroupInput,
  holeNames: ReadonlyMap<string, string>,
): SampleIdentity {
  return {
    source:
      input.sourceType === 'test_hole'
        ? {
            type: 'test_hole',
            testHoleId: input.testHoleId!,
            testHoleName: holeNames.get(input.testHoleId!)!,
          }
        : { type: 'standalone_location', locationReference: input.sourceLocationReference! },
    sampleReference: input.sampleReference,
    depthFrom: input.depthFrom,
    depthTo: input.depthTo,
    depthUnit: input.depthUnit,
  };
}

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
 * Online receipt confirmation (MM-T09): turns a completed receiving draft into a receipt and its
 * storage units in one transaction, safe to retry with the same idempotency key.
 *
 * Isolation: READ COMMITTED is enough. ID allocation serialises on the counter row lock
 * (storage_unit_annual_counter, held until commit), the idempotency key is a unique constraint,
 * and every validation read either targets rows that receipts never modify (project, test hole,
 * user) or is backed by a foreign key that the inserts re-check. A joined bulk group (MM-T36) is
 * read FOR SHARE, so an identity correction waits for this receipt (or this receipt for it) and
 * the version check sees the identity the bucket really joins. A concurrent request with the
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

      const { projectNumber, receiver, holeNames, joinedGroups } = await this.validate(
        client,
        request,
        now,
      );
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
      const receiverSnapshot: AuditReceiver = {
        userId: receiver.id,
        initials: receiver.initials,
        name: receiver.name,
      };

      await recordAudit(client, {
        action: 'receipt.confirmed',
        entityType: 'receipt',
        entityId: receiptId,
        actor,
        receiver: receiverSnapshot,
        after: {
          projectNumber,
          receivedDate: request.receivedDate,
          receiverInitials: receiver.initials,
          unitCount: request.units.length,
          readableIds,
        },
      });

      // New bulk groups first (MM-T36): one row per declared group, however many buckets use it.
      // The internal ID is a random UUID; the receiver's sample reference is never a key.
      const createdGroups = new Map<string, string>();
      for (const group of request.bulkGroups ?? []) {
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO bulk_group (project_id, source_type, test_hole_id, source_location_reference,
                                   sample_reference, depth_from, depth_to, depth_unit, description,
                                   created_by_user_id, created_receipt_id, receipt_group_key)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
           RETURNING id`,
          [
            request.projectId,
            group.sourceType,
            group.testHoleId,
            group.sourceLocationReference,
            group.sampleReference,
            group.depthFrom,
            group.depthTo,
            group.depthUnit,
            group.description,
            account.userId,
            receiptId,
            group.key,
          ],
        );
        const groupId = rows[0]!.id;
        createdGroups.set(group.key, groupId);
        await recordAudit(client, {
          action: 'bulk_group.created',
          entityType: 'bulk_group',
          entityId: groupId,
          actor,
          receiver: receiverSnapshot,
          after: {
            projectNumber,
            receiptId,
            ...identityOf(group, holeNames),
            description: group.description,
          },
        });
      }

      const units: ConfirmReceiptResponse['units'] = [];
      for (const [index, unit] of request.units.entries()) {
        const readableId = readableIds[index]!;
        const [prefix, year] = readableId.split('-');
        const holderKind = HOLDER_BY_UNIT_TYPE[unit.unitType];
        const unitType = storedUnitType(unit);
        const sample = unit.unitType === 'shelby_tube' ? unit.sample! : null;
        const bulkGroupId = unit.bulkGroup
          ? unit.bulkGroup.newGroupKey !== undefined
            ? createdGroups.get(unit.bulkGroup.newGroupKey)!
            : unit.bulkGroup.existingId!
          : null;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO storage_unit (readable_id, id_prefix, issued_year, issued_holder_kind,
                                     receipt_id, project_id, unit_type, holder_kind, note,
                                     current_location_id, status, received_date, receipt_line,
                                     source_type, source_test_hole_id, source_location_reference,
                                     sample_reference, sample_depth_from, sample_depth_to,
                                     sample_depth_unit, bulk_group_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'in_stock', $11, $12,
                   $13, $14, $15, $16, $17, $18, $19, $20)
           RETURNING id`,
          [
            readableId,
            prefix,
            Number(year),
            holderKind,
            receiptId,
            request.projectId,
            unitType,
            holderKind,
            unit.note,
            locationId,
            request.receivedDate,
            index + 1,
            sample?.sourceType ?? null,
            sample?.testHoleId ?? null,
            sample?.sourceLocationReference ?? null,
            sample?.sampleReference ?? null,
            sample?.depthFrom ?? null,
            sample?.depthTo ?? null,
            sample?.depthUnit ?? null,
            bulkGroupId,
          ],
        );
        const storageUnitId = rows[0]!.id;

        for (const summary of unit.holeSummaries ?? []) {
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
          receiver: receiverSnapshot,
          after: {
            readableId,
            receiptId,
            projectNumber,
            unitType,
            status: 'in_stock',
            location: 'Receiving lab',
            testHoleCount: unit.holeSummaries?.length ?? 0,
            ...(sample ? { sample: identityOf(sample, holeNames) } : {}),
            ...(bulkGroupId
              ? {
                  bulkGroupId,
                  bulkGroupJoined: unit.bulkGroup?.existingId !== undefined,
                  sample: unit.bulkGroup?.existingId
                    ? joinedGroups.get(unit.bulkGroup.existingId)!.identity
                    : identityOf(
                        request.bulkGroups!.find((g) => g.key === unit.bulkGroup!.newGroupKey)!,
                        holeNames,
                      ),
                }
              : {}),
          },
        });
        units.push({
          clientRowId: unit.clientRowId,
          storageUnitId,
          suNumber: readableId,
          ...(bulkGroupId ? { bulkGroupId } : {}),
        });
      }

      const bulkGroups = [...createdGroups].map(([key, bulkGroupId]) => ({ key, bulkGroupId }));
      return {
        response: { receiptId, units, ...(bulkGroups.length > 0 ? { bulkGroups } : {}) },
        created: true,
      };
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
    const { rows } = await client.query<{
      id: string;
      readable_id: string;
      receipt_line: number;
      bulk_group_id: string | null;
    }>(
      `SELECT id, readable_id, receipt_line, bulk_group_id FROM storage_unit
       WHERE receipt_id = $1 ORDER BY receipt_line`,
      [existing.id],
    );
    // Same hash means the same units in the same order, so line N is request unit N. A bucket's
    // group is reported as it is now: a later membership correction is part of its history.
    const units = rows.map((row) => ({
      clientRowId: request.units[row.receipt_line - 1]!.clientRowId,
      storageUnitId: row.id,
      suNumber: row.readable_id,
      ...(row.bulk_group_id ? { bulkGroupId: row.bulk_group_id } : {}),
    }));
    const { rows: groups } = await client.query<{ key: string; id: string }>(
      `SELECT receipt_group_key AS key, id FROM bulk_group
       WHERE created_receipt_id = $1 ORDER BY receipt_group_key`,
      [existing.id],
    );
    const bulkGroups = groups.map((group) => ({ key: group.key, bulkGroupId: group.id }));
    return {
      response: {
        receiptId: existing.id,
        units,
        ...(bulkGroups.length > 0 ? { bulkGroups } : {}),
      },
      created: false,
    };
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

    // Every test hole (summary, Shelby source or bulk source) must belong to the receipt's
    // project (one project per unit, D12).
    const holeRefs: { field: string; testHoleId: string }[] = [];
    request.units.forEach((unit, u) => {
      unit.holeSummaries?.forEach((summary, s) =>
        holeRefs.push({
          field: `units.${u}.holeSummaries.${s}.testHoleId`,
          testHoleId: summary.testHoleId,
        }),
      );
      if (unit.sample?.testHoleId) {
        holeRefs.push({
          field: `units.${u}.sample.testHoleId`,
          testHoleId: unit.sample.testHoleId,
        });
      }
    });
    request.bulkGroups?.forEach((group, g) => {
      if (group.testHoleId) {
        holeRefs.push({ field: `bulkGroups.${g}.testHoleId`, testHoleId: group.testHoleId });
      }
    });
    const { rows: holes } = await client.query<{ id: string; name: string }>(
      'SELECT id, name FROM test_hole WHERE project_id = $1 AND id = ANY($2::uuid[])',
      [request.projectId, [...new Set(holeRefs.map((ref) => ref.testHoleId))]],
    );
    const holeNames = new Map(holes.map((h) => [h.id, h.name]));
    const referenceErrors: FieldError[] = holeRefs
      .filter((ref) => !holeNames.has(ref.testHoleId))
      .map((ref) => ({
        field: ref.field,
        code: 'test_hole_not_in_project',
        message: 'test hole is not part of this project',
      }));

    // A bucket joining an existing group (MM-T36): the group must be in this project and still
    // have the identity the receiver chose. FOR SHARE holds off an identity correction until this
    // receipt commits; joins by other receipts don't block each other.
    const joinedGroups = new Map<string, BulkGroupSummary>();
    for (const [u, unit] of request.units.entries()) {
      const existingId = unit.bulkGroup?.existingId;
      if (existingId === undefined) continue;
      const group =
        joinedGroups.get(existingId) ?? (await findBulkGroup(client, existingId, 'FOR SHARE OF g'));
      if (!group || group.projectId !== request.projectId) {
        referenceErrors.push({
          field: `units.${u}.bulkGroup.existingId`,
          code: 'bulk_group_not_in_project',
          message: 'bulk sample is not part of this project',
        });
        continue;
      }
      joinedGroups.set(existingId, group);
      if (group.version !== unit.bulkGroup!.version) {
        referenceErrors.push({
          field: `units.${u}.bulkGroup.version`,
          code: 'bulk_group_changed',
          message: 'bulk sample was corrected since it was chosen; choose it again',
        });
      }
    }
    if (referenceErrors.length > 0) {
      throw new UnprocessableEntityException({
        code: referenceErrors[0]!.code,
        errors: referenceErrors,
      });
    }

    return {
      holeNames,
      joinedGroups,
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
   * prefix/year counter, inside this transaction, so a rollback returns every number. Counters
   * are locked in prefix order, never row order: two receipts listing a tube and a bucket in
   * opposite orders would otherwise each hold one counter and wait for the other (deadlock).
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
    const lockOrder = [...counts].sort(([a], [b]) =>
      PREFIX_BY_HOLDER[a].localeCompare(PREFIX_BY_HOLDER[b]),
    );
    const blocks = new Map<HolderKind, string[]>();
    for (const [kind, count] of lockOrder) {
      try {
        const allocated = await allocateStorageUnitIds(client, kind, count, {
          issuedAt: now,
          timeZone: this.config.BUSINESS_TIME_ZONE,
        });
        blocks.set(kind, allocated.ids);
      } catch (error) {
        // BUG-008: a full counter is a clear 409, not a 500. The transaction rolls back, so
        // nothing of the receipt is saved and no number is used.
        if (error instanceof StorageUnitIdOverflowError) {
          throw new ConflictException({
            code: 'storage_unit_ids_exhausted',
            prefix: error.prefix,
            year: error.year,
            message:
              `No ${error.prefix}- storage unit IDs are left for ${error.year} ` +
              `(the last is ${error.prefix}-${error.year}-999999). Nothing was saved. ` +
              'Tell an administrator.',
          });
        }
        throw error;
      }
    }
    return units.map((unit) => blocks.get(HOLDER_BY_UNIT_TYPE[unit.unitType])!.shift()!);
  }
}
