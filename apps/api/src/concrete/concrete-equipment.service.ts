import { createHash } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_EQUIPMENT_HISTORY_LIMIT,
  concreteEquipmentFlags,
  createConcreteEquipmentRequestSchema,
  recordConcreteCalibrationRequestSchema,
  updateConcreteEquipmentRequestSchema,
  voidConcreteCalibrationRequestSchema,
  type AssignedAirMeter,
  type ConcreteCalibration,
  type ConcreteEquipment,
  type ConcreteEquipmentDetail,
  type ConcreteEquipmentKind,
  type ConcreteEquipmentList,
  type ConcreteEquipmentStatus,
  type ConcreteEquipmentUse,
  type ConcreteEquipmentVersionConflictResponse,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type Permission } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding, type Standing } from '../auth/standing.js';
import { APP_CONFIG } from '../config/config.constants.js';
import type { AppConfig } from '../config/env.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { businessToday } from '../receiving/receipts.service.js';
import { parseBody, validationError } from '../validation/parse-body.js';

type Db = Pool | PoolClient;

/** Who manages each kind (docs/permissions.md, MM-V2-C27). */
export const MANAGE_PERMISSION: Record<ConcreteEquipmentKind, Permission> = {
  testing_machine: 'concrete_settings.testing_machine.manage',
  air_meter: 'concrete_settings.air_meter.manage',
};

const ENTITY_TYPE = 'concrete_equipment';
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface EquipmentRow {
  id: string;
  kind: ConcreteEquipmentKind;
  identifier: string | null;
  description: string | null;
  make: string | null;
  model: string | null;
  assigned_user_id: string | null;
  assigned_initials_snapshot: string | null;
  assigned_name_snapshot: string | null;
  status: ConcreteEquipmentStatus;
  status_note: string | null;
  created_at: Date;
  created_by_user_id: string;
  create_request_hash: string;
  updated_at: Date;
  updated_by_user_id: string;
  updated_by_initials_snapshot: string | null;
  updated_by_name_snapshot: string;
  version: number;
}

interface CalibrationRow {
  id: string;
  equipment_id: string;
  entry_number: number;
  calibrated_on: string;
  next_due_on: string;
  performed_by: string;
  result: string | null;
  recorded_at: Date;
  recorded_by_user_id: string;
  recorded_by_initials_snapshot: string | null;
  recorded_by_name_snapshot: string;
  request_hash: string;
  voided_at: Date | null;
  voided_by_user_id: string | null;
  voided_by_initials_snapshot: string | null;
  voided_by_name_snapshot: string | null;
  void_reason: string | null;
}

const SELECT_EQUIPMENT = `
  SELECT id, kind, identifier, description, make, model, assigned_user_id,
         assigned_initials_snapshot, assigned_name_snapshot, status, status_note, created_at,
         created_by_user_id, create_request_hash, updated_at, updated_by_user_id,
         updated_by_initials_snapshot, updated_by_name_snapshot, version
  FROM concrete_equipment`;

// Dates as text so no time zone ever shifts them.
const SELECT_CALIBRATION = `
  SELECT id, equipment_id, entry_number, calibrated_on::text AS calibrated_on,
         next_due_on::text AS next_due_on, performed_by, result, recorded_at, recorded_by_user_id,
         recorded_by_initials_snapshot, recorded_by_name_snapshot, request_hash, voided_at,
         voided_by_user_id, voided_by_initials_snapshot, voided_by_name_snapshot, void_reason
  FROM concrete_equipment_calibration`;

type CreateInput = z.output<typeof createConcreteEquipmentRequestSchema>;

function hashOf(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function forbidden(): ForbiddenException {
  return new ForbiddenException({ code: 'forbidden' });
}

function notFound(): NotFoundException {
  return new NotFoundException({ code: 'equipment_not_found' });
}

function fieldError(field: string, message: string): BadRequestException {
  return validationError([{ field, code: 'invalid', message }]);
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, message, errors: [{ field, code, message }] });
}

function person(userId: string, initials: string | null, name: string): PersonSnapshot {
  return { userId, initials, name };
}

function toCalibration(row: CalibrationRow): ConcreteCalibration {
  return {
    id: row.id,
    entryNumber: row.entry_number,
    calibratedOn: row.calibrated_on,
    nextDueOn: row.next_due_on,
    performedBy: row.performed_by,
    result: row.result,
    recordedAt: row.recorded_at.toISOString(),
    recordedBy: person(
      row.recorded_by_user_id,
      row.recorded_by_initials_snapshot,
      row.recorded_by_name_snapshot,
    ),
    voided: row.voided_at !== null,
    voidedAt: row.voided_at?.toISOString() ?? null,
    voidedBy: row.voided_by_user_id
      ? person(row.voided_by_user_id, row.voided_by_initials_snapshot, row.voided_by_name_snapshot!)
      : null,
    voidReason: row.void_reason,
  };
}

function assignedOf(row: EquipmentRow): PersonSnapshot | null {
  return row.assigned_user_id
    ? person(row.assigned_user_id, row.assigned_initials_snapshot, row.assigned_name_snapshot!)
    : null;
}

/** CD-45 rule on one item's history (shared, so web and API agree). */
function useOf(row: EquipmentRow, calibrations: ConcreteCalibration[], useDate: string) {
  const { calibration, flags } = concreteEquipmentFlags(row, calibrations, useDate);
  return {
    calibration: (calibration as ConcreteCalibration | null) ?? null,
    flags,
  };
}

function toEquipment(
  row: EquipmentRow,
  calibrations: ConcreteCalibration[],
  today: string,
  user: AuthUser,
): ConcreteEquipment {
  const { calibration, flags } = useOf(row, calibrations, today);
  return {
    id: row.id,
    kind: row.kind,
    identifier: row.identifier,
    description: row.description,
    make: row.make,
    model: row.model,
    assignedTo: assignedOf(row),
    status: row.status,
    statusNote: row.status_note,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
    updatedBy: person(
      row.updated_by_user_id,
      row.updated_by_initials_snapshot,
      row.updated_by_name_snapshot,
    ),
    version: row.version,
    currentCalibration: calibration,
    flagsToday: flags,
    canManage: can(user, MANAGE_PERMISSION[row.kind]),
  };
}

async function calibrationsFor(
  db: Db,
  equipmentIds: readonly string[],
): Promise<Map<string, ConcreteCalibration[]>> {
  const map = new Map<string, ConcreteCalibration[]>(equipmentIds.map((id) => [id, []]));
  if (equipmentIds.length === 0) return map;
  const { rows } = await db.query<CalibrationRow>(
    `${SELECT_CALIBRATION} WHERE equipment_id = ANY($1::uuid[])
     ORDER BY equipment_id, entry_number DESC`,
    [equipmentIds],
  );
  for (const row of rows) map.get(row.equipment_id)!.push(toCalibration(row));
  return map;
}

async function findEquipment(db: Db, id: string, lock = false): Promise<EquipmentRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<EquipmentRow>(
    `${SELECT_EQUIPMENT} WHERE id = $1${lock ? ' FOR UPDATE' : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * For the cards that record equipment use (field report air meter C04/C14, testing table C23,
 * review checklist C28): what using `equipmentId` on `useDate` flags, and the calibration entry in
 * effect, so the record can store the evaluation with itself. Null for unknown equipment. Pure
 * read: never blocks, never writes.
 */
export async function evaluateEquipmentUse(
  db: Db,
  equipmentId: string,
  useDate: string,
): Promise<ConcreteEquipmentUse | null> {
  const row = await findEquipment(db, equipmentId);
  if (!row) return null;
  const calibrations = (await calibrationsFor(db, [row.id])).get(row.id)!;
  const { calibration, flags } = useOf(row, calibrations, useDate);
  return {
    equipmentId: row.id,
    useDate,
    calibrationId: calibration?.id ?? null,
    nextDueOn: calibration?.nextDueOn ?? null,
    flags,
  };
}

/**
 * The testing machine in service now (CD-44: there is one) with the calibration in effect on
 * `useDate`, for the testing table (C23) and for issued reports to copy at issue (C32: issued
 * files keep the values used at issue; later setting changes never alter them). Null when none
 * is registered.
 */
export async function testingMachineSnapshot(
  db: Db,
  useDate: string,
): Promise<{
  equipmentId: string;
  identifier: string | null;
  make: string | null;
  model: string | null;
  calibratedOn: string | null;
  nextDueOn: string | null;
  use: ConcreteEquipmentUse;
} | null> {
  const { rows } = await db.query<{ id: string }>(
    `SELECT id FROM concrete_equipment WHERE kind = 'testing_machine' AND status <> 'retired'`,
  );
  if (!rows[0]) return null;
  const row = (await findEquipment(db, rows[0].id))!;
  const calibrations = (await calibrationsFor(db, [row.id])).get(row.id)!;
  const { calibration, flags } = useOf(row, calibrations, useDate);
  return {
    equipmentId: row.id,
    identifier: row.identifier,
    make: row.make,
    model: row.model,
    calibratedOn: calibration?.calibratedOn ?? null,
    nextDueOn: calibration?.nextDueOn ?? null,
    use: {
      equipmentId: row.id,
      useDate,
      calibrationId: calibration?.id ?? null,
      nextDueOn: calibration?.nextDueOn ?? null,
      flags,
    },
  };
}

/**
 * Concrete equipment register (MM-V2-C27). Every active session reads it (`inventory.read`, LAB
 * included: field and testing work use it). The testing machine is managed under
 * `concrete_settings.testing_machine.manage` and air meters under
 * `concrete_settings.air_meter.manage` (the Lab Manager role; air meters also the Lab Technician
 * role, MM-V2-C36).
 *
 * Each write is one transaction: the equipment row FOR UPDATE (the domain row), then the editor's
 * account (and an assignee's) FOR SHARE for the final authority check (D09). Every change is
 * audited in the same transaction with only the changed fields before and after. Calibration
 * history is append-only (voiding keeps the entry); creates and calibration entries are
 * idempotent by key; edits carry the version last read.
 */
@Injectable()
export class ConcreteEquipmentService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
  ) {}

  today(): string {
    return businessToday(new Date(), this.config.BUSINESS_TIME_ZONE);
  }

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(
    query: { kind?: ConcreteEquipmentKind; includeRetired?: boolean },
    user: AuthUser,
  ): Promise<ConcreteEquipmentList> {
    const where: string[] = [];
    const params: unknown[] = [];
    if (query.kind) {
      params.push(query.kind);
      where.push(`kind = $${params.length}`);
    }
    if (!query.includeRetired) where.push(`status <> 'retired'`);
    const { rows } = await this.database.pool.query<EquipmentRow>(
      `${SELECT_EQUIPMENT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY kind DESC, status = 'retired', lower(coalesce(identifier, '')), created_at, id`,
      params,
    );
    const calibrations = await calibrationsFor(
      this.database.pool,
      rows.map((row) => row.id),
    );
    const today = this.today();
    return {
      today,
      items: rows.map((row) => toEquipment(row, calibrations.get(row.id)!, today, user)),
      canManage: {
        testing_machine: can(user, MANAGE_PERMISSION.testing_machine),
        air_meter: can(user, MANAGE_PERMISSION.air_meter),
      },
    };
  }

  async detail(id: string, user: AuthUser): Promise<ConcreteEquipmentDetail> {
    const row = await findEquipment(this.database.pool, id);
    if (!row) throw notFound();
    return this.view(this.database.pool, row.id, user);
  }

  async useCheck(id: string, on: string | undefined): Promise<ConcreteEquipmentUse> {
    const use = await evaluateEquipmentUse(this.database.pool, id, on ?? this.today());
    if (!use) throw notFound();
    return use;
  }

  /** The field-report autofill (CD-45): the technician's one assigned meter, else none. */
  async assignedAirMeter(
    technicianUserId: string,
    on: string | undefined,
    user: AuthUser,
  ): Promise<AssignedAirMeter> {
    const useDate = on ?? this.today();
    const { rows } = await this.database.pool.query<EquipmentRow>(
      `${SELECT_EQUIPMENT}
       WHERE kind = 'air_meter' AND status <> 'retired' AND assigned_user_id = $1
       ORDER BY id`,
      [technicianUserId],
    );
    if (rows.length !== 1) {
      return { technicianUserId, useDate, assignedCount: rows.length, meter: null, use: null };
    }
    const row = rows[0]!;
    const calibrations = (await calibrationsFor(this.database.pool, [row.id])).get(row.id)!;
    const { calibration, flags } = useOf(row, calibrations, useDate);
    return {
      technicianUserId,
      useDate,
      assignedCount: 1,
      meter: toEquipment(row, calibrations, this.today(), user),
      use: {
        equipmentId: row.id,
        useDate,
        calibrationId: calibration?.id ?? null,
        nextDueOn: calibration?.nextDueOn ?? null,
        flags,
      },
    };
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  async create(
    kind: ConcreteEquipmentKind,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteEquipmentDetail> {
    // Authority before the body (403 before 400), with the request's user.
    if (!can(user, MANAGE_PERMISSION[kind])) throw forbidden();
    const parsed = parseBody(createConcreteEquipmentRequestSchema, body);
    if (parsed.kind !== kind)
      throw fieldError('kind', `This route registers a ${kind.replace('_', ' ')}`);
    const { idempotencyKey, ...intent } = parsed;
    const input: CreateInput = parsed;
    const hash = hashOf(intent);

    const replay = async (db: Db): Promise<ConcreteEquipmentDetail | null> => {
      const { rows } = await db.query<{
        id: string;
        create_request_hash: string;
        created_by_user_id: string;
      }>(
        `SELECT id, create_request_hash, created_by_user_id FROM concrete_equipment
         WHERE create_idempotency_key = $1`,
        [idempotencyKey],
      );
      const previous = rows[0];
      if (!previous) return null;
      if (previous.create_request_hash !== hash || previous.created_by_user_id !== user.userId) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      return this.view(db, previous.id, user);
    };

    try {
      return await withTransaction(this.database.pool, async (client) => {
        const ids = [user.userId, ...(input.assignedUserId ? [input.assignedUserId] : [])];
        const standing = await lockStanding(client, ids);
        if (!can(asLocked(user, standing), MANAGE_PERMISSION[kind])) throw forbidden();

        const previous = await replay(client);
        if (previous) return previous;

        if (kind === 'testing_machine') {
          const { rows } = await client.query(
            `SELECT 1 FROM concrete_equipment
             WHERE kind = 'testing_machine' AND status <> 'retired'`,
          );
          if (rows.length > 0) throw testingMachineExists();
        }
        const assignee = input.assignedUserId ? standing.get(input.assignedUserId) : undefined;
        if (input.assignedUserId && !isActiveStaff(assignee)) {
          unprocessable('invalid_recipient', 'assignedUserId', 'Choose an active staff member');
        }
        const editor = standing.get(user.userId)!;
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO concrete_equipment
             (kind, identifier, description, make, model, assigned_user_id,
              assigned_initials_snapshot, assigned_name_snapshot, created_by_user_id,
              created_by_initials_snapshot, created_by_name_snapshot, create_idempotency_key,
              create_request_hash, updated_by_user_id, updated_by_initials_snapshot,
              updated_by_name_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $9, $10, $11)
           RETURNING id`,
          [
            kind,
            input.identifier ?? null,
            input.description ?? null,
            input.make ?? null,
            input.model ?? null,
            assignee?.userId ?? null,
            assignee?.initials ?? null,
            assignee?.displayName ?? null,
            editor.userId,
            editor.initials,
            editor.displayName,
            idempotencyKey,
            hash,
          ],
        );
        const id = rows[0]!.id;
        await recordAudit(client, {
          action: 'concrete_equipment.registered',
          entityType: ENTITY_TYPE,
          entityId: id,
          actor,
          after: {
            kind,
            identifier: input.identifier ?? null,
            description: input.description ?? null,
            make: input.make ?? null,
            model: input.model ?? null,
            assignedTo: assignee ? snapshotOf(assignee) : null,
            status: 'in_service',
          },
          requestId,
        });
        return this.view(client, id, user);
      });
    } catch (error) {
      const constraint = (error as { constraint?: string }).constraint;
      if (constraint === 'concrete_equipment_create_key') {
        const previous = await replay(this.database.pool);
        if (previous) return previous;
      }
      if (constraint === 'concrete_equipment_one_testing_machine') throw testingMachineExists();
      if (constraint === 'concrete_equipment_identifier_key') throw identifierExists();
      throw error;
    }
  }

  async update(
    kind: ConcreteEquipmentKind,
    id: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteEquipmentDetail> {
    if (!can(user, MANAGE_PERMISSION[kind])) throw forbidden();
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const row = await this.lockKind(client, kind, id);
        const input = parseBody(updateConcreteEquipmentRequestSchema, body);
        const assigneeId =
          input.assignedUserId !== undefined && input.assignedUserId !== row.assigned_user_id
            ? input.assignedUserId
            : null;
        const standing = await lockStanding(client, [
          user.userId,
          ...(assigneeId ? [assigneeId] : []),
        ]);
        if (!can(asLocked(user, standing), MANAGE_PERMISSION[kind])) throw forbidden();

        if (input.version !== row.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.view(client, row.id, user),
          } satisfies ConcreteEquipmentVersionConflictResponse);
        }
        if (row.status === 'retired') {
          throw new ConflictException({
            code: 'equipment_retired',
            message: 'Retired equipment no longer changes.',
          });
        }
        if (input.assignedUserId && kind !== 'air_meter') {
          throw fieldError('assignedUserId', 'Only an air meter is assigned to a technician');
        }
        if (kind === 'air_meter' && input.identifier === null) {
          throw fieldError('identifier', 'Air meter ID is required');
        }

        const before = valuesOf(row);
        const after = { ...before };
        if (input.identifier !== undefined) after.identifier = input.identifier;
        if (input.description !== undefined) after.description = input.description;
        if (input.make !== undefined) after.make = input.make;
        if (input.model !== undefined) after.model = input.model;
        if (input.status !== undefined) after.status = input.status;
        if (input.statusNote !== undefined) after.statusNote = input.statusNote;
        // Back in service: the issue is resolved, so its note goes.
        if (after.status === 'in_service' && before.status !== 'in_service') {
          after.statusNote = input.statusNote ?? null;
        }
        if (after.status === 'in_service' && input.statusNote) {
          throw fieldError('statusNote', 'A status note is only for out of service or retired');
        }
        if (after.status !== 'in_service' && !after.statusNote) {
          throw fieldError('statusNote', 'Say why it is out of service or retired');
        }
        if (input.assignedUserId !== undefined) {
          if (input.assignedUserId === null) after.assignedTo = null;
          else if (assigneeId) {
            const assignee = standing.get(assigneeId);
            if (!isActiveStaff(assignee)) {
              unprocessable('invalid_recipient', 'assignedUserId', 'Choose an active staff member');
            }
            after.assignedTo = snapshotOf(assignee);
          }
        }
        // A retired meter is assigned to nobody.
        if (after.status === 'retired') after.assignedTo = null;

        const changed = (Object.keys(after) as (keyof Values)[]).filter(
          (field) => JSON.stringify(after[field]) !== JSON.stringify(before[field]),
        );
        if (changed.length === 0) return this.view(client, row.id, user);

        const editor = standing.get(user.userId)!;
        await client.query(
          `UPDATE concrete_equipment
           SET identifier = $2, description = $3, make = $4, model = $5, assigned_user_id = $6,
               assigned_initials_snapshot = $7, assigned_name_snapshot = $8, status = $9,
               status_note = $10, updated_by_user_id = $11, updated_by_initials_snapshot = $12,
               updated_by_name_snapshot = $13, updated_at = now(), version = version + 1
           WHERE id = $1`,
          [
            row.id,
            after.identifier,
            after.description,
            after.make,
            after.model,
            after.assignedTo?.userId ?? null,
            after.assignedTo?.initials ?? null,
            after.assignedTo?.name ?? null,
            after.status,
            after.statusNote,
            editor.userId,
            editor.initials,
            editor.displayName,
          ],
        );
        await recordAudit(client, {
          action: 'concrete_equipment.updated',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          actor,
          reason: input.reason ?? null,
          before: Object.fromEntries(changed.map((field) => [field, before[field]])),
          after: Object.fromEntries(changed.map((field) => [field, after[field]])),
          requestId,
        });
        return this.view(client, row.id, user);
      });
    } catch (error) {
      if ((error as { constraint?: string }).constraint === 'concrete_equipment_identifier_key') {
        throw identifierExists();
      }
      throw error;
    }
  }

  async recordCalibration(
    kind: ConcreteEquipmentKind,
    id: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteEquipmentDetail> {
    if (!can(user, MANAGE_PERMISSION[kind])) throw forbidden();
    const replay = async (db: Db, key: string, hash: string) => {
      const { rows } = await db.query<{
        equipment_id: string;
        request_hash: string;
        recorded_by_user_id: string;
      }>(
        `SELECT equipment_id, request_hash, recorded_by_user_id
         FROM concrete_equipment_calibration WHERE idempotency_key = $1`,
        [key],
      );
      const previous = rows[0];
      if (!previous) return null;
      if (
        previous.request_hash !== hash ||
        previous.recorded_by_user_id !== user.userId ||
        previous.equipment_id !== id
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      return this.view(db, previous.equipment_id, user);
    };
    let key: string | null = null;
    let hash = '';
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const row = await this.lockKind(client, kind, id);
        const input = parseBody(recordConcreteCalibrationRequestSchema, body);
        const { idempotencyKey, ...intent } = input;
        key = idempotencyKey;
        hash = hashOf(intent);
        const standing = await lockStanding(client, [user.userId]);
        if (!can(asLocked(user, standing), MANAGE_PERMISSION[kind])) throw forbidden();

        const previous = await replay(client, idempotencyKey, hash);
        if (previous) return previous;
        if (row.status === 'retired') {
          throw new ConflictException({
            code: 'equipment_retired',
            message: 'Retired equipment takes no new calibration.',
          });
        }
        const editor = standing.get(user.userId)!;
        // Numbered under the equipment row's lock, so entries stay 1, 2, 3…
        const { rows } = await client.query<{ entry_number: number }>(
          `INSERT INTO concrete_equipment_calibration
             (equipment_id, entry_number, calibrated_on, next_due_on, performed_by, result,
              recorded_by_user_id, recorded_by_initials_snapshot, recorded_by_name_snapshot,
              idempotency_key, request_hash)
           SELECT $1, 1 + coalesce(max(entry_number), 0), $2, $3, $4, $5, $6, $7, $8, $9, $10
           FROM concrete_equipment_calibration WHERE equipment_id = $1
           RETURNING entry_number`,
          [
            row.id,
            input.calibratedOn,
            input.nextDueOn,
            input.performedBy,
            input.result ?? null,
            editor.userId,
            editor.initials,
            editor.displayName,
            idempotencyKey,
            hash,
          ],
        );
        await recordAudit(client, {
          action: 'concrete_equipment.calibration_recorded',
          entityType: ENTITY_TYPE,
          entityId: row.id,
          actor,
          after: {
            entryNumber: rows[0]!.entry_number,
            calibratedOn: input.calibratedOn,
            nextDueOn: input.nextDueOn,
            performedBy: input.performedBy,
            result: input.result ?? null,
          },
          requestId,
        });
        return this.view(client, row.id, user);
      });
    } catch (error) {
      if (
        key &&
        (error as { constraint?: string }).constraint === 'concrete_equipment_calibration_key'
      ) {
        const previous = await replay(this.database.pool, key, hash);
        if (previous) return previous;
      }
      throw error;
    }
  }

  async voidCalibration(
    kind: ConcreteEquipmentKind,
    id: string,
    calibrationId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteEquipmentDetail> {
    if (!can(user, MANAGE_PERMISSION[kind])) throw forbidden();
    return withTransaction(this.database.pool, async (client) => {
      const row = await this.lockKind(client, kind, id);
      const input = parseBody(voidConcreteCalibrationRequestSchema, body);
      const standing = await lockStanding(client, [user.userId]);
      if (!can(asLocked(user, standing), MANAGE_PERMISSION[kind])) throw forbidden();
      if (!UUID_PATTERN.test(calibrationId)) {
        throw new NotFoundException({ code: 'calibration_not_found' });
      }
      const { rows } = await client.query<CalibrationRow>(
        `${SELECT_CALIBRATION} WHERE id = $1 AND equipment_id = $2 FOR UPDATE`,
        [calibrationId, row.id],
      );
      const entry = rows[0];
      if (!entry) throw new NotFoundException({ code: 'calibration_not_found' });
      if (entry.voided_at) {
        throw new ConflictException({
          code: 'calibration_already_voided',
          message: 'This calibration entry is already voided.',
        });
      }
      const editor = standing.get(user.userId)!;
      await client.query(
        `UPDATE concrete_equipment_calibration
         SET voided_at = now(), voided_by_user_id = $2, voided_by_initials_snapshot = $3,
             voided_by_name_snapshot = $4, void_reason = $5
         WHERE id = $1`,
        [entry.id, editor.userId, editor.initials, editor.displayName, input.reason],
      );
      await recordAudit(client, {
        action: 'concrete_equipment.calibration_voided',
        entityType: ENTITY_TYPE,
        entityId: row.id,
        actor,
        reason: input.reason,
        before: {
          entryNumber: entry.entry_number,
          calibratedOn: entry.calibrated_on,
          nextDueOn: entry.next_due_on,
          voided: false,
        },
        after: { entryNumber: entry.entry_number, voided: true },
        requestId,
      });
      return this.view(client, row.id, user);
    });
  }

  // -------------------------------------------------------------------------------------------

  /** Locks the equipment FOR UPDATE; 404 when missing or of another kind than the route's. */
  private async lockKind(
    client: PoolClient,
    kind: ConcreteEquipmentKind,
    id: string,
  ): Promise<EquipmentRow> {
    const row = await findEquipment(client, id, true);
    if (!row || row.kind !== kind) throw notFound();
    return row;
  }

  private async view(db: Db, id: string, user: AuthUser): Promise<ConcreteEquipmentDetail> {
    const row = (await findEquipment(db, id))!;
    const calibrations = (await calibrationsFor(db, [row.id])).get(row.id)!;
    const today = this.today();
    const { rows: history } = await db.query<{
      id: string;
      occurred_at: Date;
      action: string;
      actor_user_id: string | null;
      actor_initials_snapshot: string | null;
      actor_name_snapshot: string | null;
      reason: string | null;
      before_values: Record<string, unknown> | null;
      after_values: Record<string, unknown> | null;
    }>(
      `SELECT id, occurred_at, action, actor_user_id, actor_initials_snapshot, actor_name_snapshot,
              reason, before_values, after_values
       FROM audit_event WHERE entity_type = $1 AND entity_id = $2
       ORDER BY occurred_at DESC, id DESC LIMIT ${CONCRETE_EQUIPMENT_HISTORY_LIMIT}`,
      [ENTITY_TYPE, row.id],
    );
    const { rows: total } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event WHERE entity_type = $1 AND entity_id = $2',
      [ENTITY_TYPE, row.id],
    );
    return {
      ...toEquipment(row, calibrations, today, user),
      today,
      calibrations,
      history: history.map((event) => ({
        id: event.id,
        occurredAt: event.occurred_at.toISOString(),
        action: event.action,
        changedBy: event.actor_user_id
          ? person(
              event.actor_user_id,
              event.actor_initials_snapshot,
              event.actor_name_snapshot ?? '',
            )
          : null,
        reason: event.reason,
        before: event.before_values ?? {},
        after: event.after_values ?? {},
      })),
      historyTotal: total[0]!.n,
    };
  }
}

type Values = {
  identifier: string | null;
  description: string | null;
  make: string | null;
  model: string | null;
  assignedTo: PersonSnapshot | null;
  status: ConcreteEquipmentStatus;
  statusNote: string | null;
};

function valuesOf(row: EquipmentRow): Values {
  return {
    identifier: row.identifier,
    description: row.description,
    make: row.make,
    model: row.model,
    assignedTo: assignedOf(row),
    status: row.status,
    statusNote: row.status_note,
  };
}

function snapshotOf(standing: Standing): PersonSnapshot {
  return { userId: standing.userId, initials: standing.initials, name: standing.displayName };
}

function testingMachineExists(): ConflictException {
  return new ConflictException({
    code: 'testing_machine_exists',
    message: 'A testing machine is already registered. Retire it before registering another.',
  });
}

function identifierExists(): ConflictException {
  return new ConflictException({
    code: 'equipment_identifier_exists',
    message: 'Other equipment in service already uses this ID.',
    errors: [
      {
        field: 'identifier',
        code: 'equipment_identifier_exists',
        message: 'Already used by other equipment',
      },
    ],
  });
}
