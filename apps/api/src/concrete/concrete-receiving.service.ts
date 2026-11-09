import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS,
  CONCRETE_PICKUP_WINDOW_VERIFIED,
  CONCRETE_RECEIVING_EXCEPTION_PAGE_SIZE,
  concreteCuringFlags,
  concreteCuringResolutionRequestSchema,
  concreteFormatTenths,
  concreteMarkerConfirmationRequestSchema,
  concreteMassCorrectionRequestSchema,
  concretePickupMissing,
  concretePickupRequestSchema,
  concretePickupWindowEndsAt,
  concretePickupWindowRequestSchema,
  concreteReceiptRequestSchema,
  concreteReceivingExceptionQuerySchema,
  concreteReceivingExceptionRequestSchema,
  concreteReceivingIssues,
  concreteResolveReceivingExceptionRequestSchema,
  type ConcreteCuringFlag,
  type ConcreteCuringRange,
  type ConcretePickup,
  type ConcreteReceipt,
  type ConcreteReceivingException,
  type ConcreteReceivingExceptionKind,
  type ConcreteReceivingExceptionList,
  type ConcreteReceivingSpecimen,
  type ConcreteReportReceiving,
  type ConcreteSetReceiving,
  type ConcreteSpecimenAge,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import {
  can,
  permissionSources,
  type AuthUser,
  type Permission,
  type PermissionSource,
  type ProjectContext,
} from '../auth/policy.js';
import { asLocked, lockProjectLead, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf } from '../lab/attribution.js';
import { notifyConcreteEvent } from '../notifications/concrete-notifications.js';
import {
  concreteLabManagers,
  designatedReviewers,
  findProject,
  intentHash,
} from '../project-access/project-access.service.js';
import { parseBody, validationError } from '../validation/parse-body.js';

type Db = Pool | PoolClient;
type Kind =
  'pickup' | 'pickup_window' | 'receipt' | 'marker' | 'exception' | 'resolve' | 'curing_resolve';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RECEIVE = 'concrete_specimen.receive' as const;
const MASS_CORRECT = 'concrete_specimen.mass_correct' as const;
const RESOLVE = 'concrete_receiving_exception.resolve' as const;
const REVIEW = 'concrete.review' as const;
/** The review scope for receiving exceptions and curing flags (as C22's reschedule). */
const FIELD_SCOPE = 'concrete_field';
/** The order a resolution's source is recorded in when the person holds several. */
const RESOLUTION_SOURCES: PermissionSource[] = [
  'lead_project_engineer',
  'designated_reviewer',
  'concrete_lab_manager',
  'record_technician',
];

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });
const unprocessable = (code: string, field: string, message: string) =>
  new UnprocessableEntityException({ code, errors: [{ field, code, message }] });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

function withoutKey<T extends { idempotencyKey: string }>(input: T): Omit<T, 'idempotencyKey'> {
  const { idempotencyKey: _key, ...rest } = input;
  void _key;
  return rest;
}

interface SetFacts {
  id: string;
  project_id: string;
  field_report_id: string;
  temporary_id: string | null;
  permanent_id: string | null;
  permanent_number: number | null;
  technician_user_id: string | null;
  voided: boolean;
  cast_at: Date | null;
  workflow_state: string;
  lead_project_engineer_user_id: string | null;
}

const SELECT_SET = `SELECT s.id, s.project_id, s.field_report_id, s.temporary_id, s.permanent_id,
         s.permanent_number, s.technician_user_id, s.voided_at IS NOT NULL AS voided, r.cast_at,
         r.workflow_state, p.lead_project_engineer_user_id
  FROM concrete_specimen_set s
  JOIN concrete_field_report r ON r.id = s.field_report_id
  JOIN project p ON p.id = s.project_id`;

async function findSet(db: Db, setId: string): Promise<SetFacts | null> {
  if (!UUID_PATTERN.test(setId)) return null;
  const { rows } = await db.query<SetFacts>(`${SELECT_SET} WHERE s.id = $1`, [setId]);
  return rows[0] ?? null;
}

async function setOfSpecimen(db: Db, specimenId: string): Promise<SetFacts | null> {
  if (!UUID_PATTERN.test(specimenId)) return null;
  const { rows } = await db.query<SetFacts>(
    `${SELECT_SET} JOIN concrete_specimen sp ON sp.set_id = s.id WHERE sp.id = $1`,
    [specimenId],
  );
  return rows[0] ?? null;
}

/**
 * D09 lock order for receiving writes: the report FOR SHARE (a Void or a casting correction
 * takes it FOR UPDATE, so one commits wholly first), the set (FOR SHARE, or FOR UPDATE where the
 * command is per set), then the specimens FOR UPDATE, then the accounts (lockStanding).
 */
async function lockSet(
  client: PoolClient,
  set: SetFacts,
  setLock: 'FOR SHARE' | 'FOR UPDATE' = 'FOR SHARE',
): Promise<SetFacts> {
  await client.query('SELECT 1 FROM concrete_field_report WHERE id = $1 FOR SHARE', [
    set.field_report_id,
  ]);
  await client.query(`SELECT 1 FROM concrete_specimen_set WHERE id = $1 ${setLock}`, [set.id]);
  return (await findSet(client, set.id))!;
}

function assertOpen(set: SetFacts): void {
  if (set.workflow_state === 'void') throw new ConflictException({ code: 'report_void' });
  if (set.voided) throw new ConflictException({ code: 'set_void' });
}

function notBeforeCasting(set: SetFacts, at: string | null, field: string): void {
  if (at !== null && set.cast_at !== null && Date.parse(at) < set.cast_at.getTime()) {
    throw unprocessable('before_casting', field, 'This is before the specimens were cast');
  }
}

/**
 * Pickup, initial curing and lab receipt of concrete specimens (MM-V2-C06).
 *
 * Writes need `concrete_specimen.receive` (lab staff: Lab Technician, Lab Manager, or LAB naming
 * the actual person), checked by the route guard and again with the account as it stands under
 * the locks. The person a record names (collector, receiver, confirming or reporting person) is
 * attribution only: a LAB station must name them, a personal account is itself unless it names
 * the actual person, and naming someone grants nothing. Mass corrections are personal-account
 * only (CD-46). Exception resolution and curing resolution are project authority, checked in
 * the handler before the body and again under the locks.
 *
 * Every command is one transaction with its audit event(s); an exact retry (same key, body and
 * account) returns the records as they stand without a second row or event (409
 * `idempotency_key_reused` for a key reused for anything else). Stale versions are 409
 * `version_conflict` with the current view, and nothing is written.
 */
@Injectable()
export class ConcreteReceivingService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads (inventory.read)
  // -------------------------------------------------------------------------------------------

  async setReceiving(setId: string): Promise<ConcreteSetReceiving> {
    const set = await findSet(this.database.pool, setId);
    if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    return this.view(this.database.pool, set);
  }

  async reportReceiving(reportId: string): Promise<ConcreteReportReceiving> {
    const db = this.database.pool;
    if (!UUID_PATTERN.test(reportId)) {
      throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    }
    const { rows: report } = await db.query('SELECT 1 FROM concrete_field_report WHERE id = $1', [
      reportId,
    ]);
    if (report.length === 0)
      throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    const { rows } = await db.query<SetFacts>(
      `${SELECT_SET} WHERE s.field_report_id = $1 ORDER BY s.created_at, s.id`,
      [reportId],
    );
    const sets = await Promise.all(rows.map((set) => this.view(db, set)));
    return {
      fieldReportId: reportId,
      sets,
      blockers: sets.flatMap((s) => s.blockers.map((b) => ({ ...b, setId: s.setId }))),
      issuanceGates: sets.flatMap((s) => s.issuanceGates.map((g) => ({ ...g, setId: s.setId }))),
    };
  }

  async listExceptions(projectId: string, query: unknown): Promise<ConcreteReceivingExceptionList> {
    const db = this.database.pool;
    const input = parseBody(concreteReceivingExceptionQuerySchema, query);
    if (!UUID_PATTERN.test(projectId) || !(await findProject(db, projectId))) {
      throw new NotFoundException({ code: 'project_not_found' });
    }
    const status =
      input.status === 'open'
        ? 'AND e.resolved_at IS NULL'
        : input.status === 'resolved'
          ? 'AND e.resolved_at IS NOT NULL'
          : '';
    const { rows: count } = await db.query<{ total: number }>(
      `SELECT count(*)::int AS total FROM concrete_receiving_exception e
       WHERE e.project_id = $1 ${status}`,
      [projectId],
    );
    const pageSize = CONCRETE_RECEIVING_EXCEPTION_PAGE_SIZE;
    const items = await exceptionsWhere(
      db,
      `e.project_id = $1 ${status}`,
      [projectId, pageSize, (input.page - 1) * pageSize],
      'LIMIT $2 OFFSET $3',
    );
    return { items, page: input.page, pageSize, total: count[0]!.total };
  }

  // -------------------------------------------------------------------------------------------
  // Pickup and initial curing (AC1, AC4)
  // -------------------------------------------------------------------------------------------

  async pickup(
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const found = await findSet(this.database.pool, setId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    const input = parseBody(concretePickupRequestSchema, body);
    const hash = intentHash({ kind: 'pickup', setId: found.id, ...withoutKey(input) });
    return this.retrying(input.idempotencyKey, 'pickup', found.id, hash, user, async (client) => {
      const set = await lockSet(client, found);
      const ids = [...new Set(input.specimens.map((s) => s.id))];
      if (ids.length !== input.specimens.length) {
        throw unprocessable('duplicate_specimen', 'specimens', 'Each specimen once');
      }
      const { rows: specimens } = await client.query<{
        id: string;
        pickup_id: string | null;
        pickup_version: number | null;
      }>(
        `SELECT sp.id, pk.id AS pickup_id, pk.version AS pickup_version
         FROM concrete_specimen sp
         LEFT JOIN concrete_specimen_pickup pk ON pk.specimen_id = sp.id
         WHERE sp.set_id = $1 AND sp.id = ANY($2::uuid[])
         ORDER BY sp.id FOR UPDATE OF sp`,
        [set.id, ids],
      );
      if (specimens.length !== ids.length) {
        throw unprocessable(
          'specimen_not_in_set',
          'specimens',
          'Every specimen must be of this set',
        );
      }
      // The collector is the person doing the pickup: a LAB station names them on every save.
      const collector =
        user.accountType === 'shared_lab'
          ? this.personFor(user, input.collectedByUserId ?? undefined, 'collectedByUserId')
          : input.collectedByUserId === undefined
            ? user.userId
            : input.collectedByUserId;
      const people = await this.authorize(client, user, RECEIVE, collector ? [collector] : []);
      assertOpen(set);
      const versions = new Map(input.specimens.map((s) => [s.id, s.version]));
      if (specimens.some((s) => (s.pickup_version ?? null) !== versions.get(s.id))) {
        throw new ConflictException({
          code: 'version_conflict',
          current: await this.view(client, set),
        });
      }
      const values = {
        collectedByUserId: collector,
        collectedAt: input.collectedAt ?? null,
        curingMinC: input.curingMinC ?? null,
        curingMaxC: input.curingMaxC ?? null,
        curingBox: input.curingBox ?? null,
        curingLocation: input.curingLocation ?? null,
      };
      if (values.collectedByUserId && !people.get(values.collectedByUserId)) {
        throw unprocessable(
          'invalid_collector',
          'collectedByUserId',
          'must be an active staff member with confirmed initials',
        );
      }
      notBeforeCasting(set, values.collectedAt, 'collectedAt');
      if (
        values.curingMinC !== null &&
        values.curingMaxC !== null &&
        Number(values.curingMinC) > Number(values.curingMaxC)
      ) {
        throw unprocessable('min_above_max', 'curingMaxC', 'The maximum is below the minimum');
      }
      if (input.complete) {
        const missing = concretePickupMissing(values);
        if (missing.length > 0) {
          throw new UnprocessableEntityException({
            code: 'pickup_incomplete',
            errors: missing.map((field) => ({
              field,
              code: 'required',
              message: 'Needed to complete the pickup',
            })),
          });
        }
      }
      const range = await currentRange(client);
      const person = collector ? people.get(collector)! : null;
      for (const specimen of specimens) {
        const before = specimen.pickup_id ? await pickupRow(client, specimen.pickup_id) : null;
        const readingsChanged =
          !before ||
          tenths(before.curing_min_c) !== tenths(values.curingMinC) ||
          tenths(before.curing_max_c) !== tenths(values.curingMaxC);
        // Keep the check made on unchanged readings (never rewrite history); re-check new ones
        // against the range that applies now, and drop a resolution of the old readings.
        const check = readingsChanged
          ? checkWith(range, values.curingMinC, values.curingMaxC)
          : {
              standardId: before.curing_standard_id,
              rangeMin: before.curing_range_min_c,
              rangeMax: before.curing_range_max_c,
              flags: before.curing_flags,
            };
        const params = [
          values.collectedByUserId,
          values.collectedAt,
          values.curingMinC,
          values.curingMaxC,
          values.curingBox,
          values.curingLocation,
          input.complete,
          check.standardId,
          check.rangeMin,
          check.rangeMax,
          check.flags,
        ];
        let pickupId: string;
        if (before) {
          pickupId = before.id;
          await client.query(
            `UPDATE concrete_specimen_pickup
             SET collected_by_user_id = $2, collected_at = $3, curing_min_c = $4,
                 curing_max_c = $5, curing_box = $6, curing_location = $7, completed = $8,
                 curing_standard_id = $9, curing_range_min_c = $10, curing_range_max_c = $11,
                 curing_flags = $12,
                 curing_resolved_at = CASE WHEN $13 THEN NULL ELSE curing_resolved_at END,
                 curing_resolved_by_user_id = CASE WHEN $13 THEN NULL ELSE curing_resolved_by_user_id END,
                 curing_resolution_note = CASE WHEN $13 THEN NULL ELSE curing_resolution_note END,
                 version = version + 1, updated_at = now()
             WHERE id = $1`,
            [before.id, ...params, readingsChanged],
          );
        } else {
          const { rows } = await client.query<{ id: string }>(
            `INSERT INTO concrete_specimen_pickup
               (project_id, specimen_id, collected_by_user_id, collected_at, curing_min_c,
                curing_max_c, curing_box, curing_location, completed, curing_standard_id,
                curing_range_min_c, curing_range_max_c, curing_flags, recorded_by_user_id)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
             RETURNING id`,
            [set.project_id, specimen.id, ...params, user.userId],
          );
          pickupId = rows[0]!.id;
        }
        const after = (await pickupRow(client, pickupId))!;
        await recordAudit(client, {
          action: input.complete
            ? 'concrete_specimen.pickup_completed'
            : 'concrete_specimen.pickup_saved',
          entityType: 'concrete_specimen',
          entityId: specimen.id,
          actor,
          receiver: user.accountType === 'shared_lab' && person ? receiverOf(person) : null,
          before: before ? auditPickup(before) : null,
          after: auditPickup(after),
          requestId,
        });
        // CD-32: a new out-of-range flag notifies the reviewers and the lead (in-app only).
        if (readingsChanged && (check.flags?.length ?? 0) > 0) {
          await notifyConcreteEvent(
            client,
            'concrete_curing.out_of_range',
            { fieldReportId: set.field_report_id },
            `concrete_curing.out_of_range:${pickupId}:${after.version}`,
            {
              actorUserId: user.userId,
              designatedReviewerUserIds: await designatedReviewers(
                client,
                set.project_id,
                FIELD_SCOPE,
              ),
              leadProjectEngineerUserId: set.lead_project_engineer_user_id,
            },
          );
        }
      }
      return this.view(client, set);
    });
  }

  async pickupWindow(
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const found = await findSet(this.database.pool, setId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    const input = parseBody(concretePickupWindowRequestSchema, body);
    const hash = intentHash({ kind: 'pickup_window', setId: found.id, ...withoutKey(input) });
    return this.retrying(
      input.idempotencyKey,
      'pickup_window',
      found.id,
      hash,
      user,
      async (client) => {
        const set = await lockSet(client, found, 'FOR UPDATE');
        await this.authorize(client, user, RECEIVE, []);
        assertOpen(set);
        const { rows } = await client.query<{ hours: number; version: number }>(
          'SELECT hours, version FROM concrete_set_pickup_window WHERE set_id = $1 FOR UPDATE',
          [set.id],
        );
        const current = rows[0] ?? null;
        if ((current?.version ?? null) !== input.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.view(client, set),
          });
        }
        if (current) {
          await client.query(
            `UPDATE concrete_set_pickup_window
             SET hours = $2, updated_by_user_id = $3, updated_at = now(), version = version + 1
             WHERE set_id = $1`,
            [set.id, input.hours, user.userId],
          );
        } else {
          await client.query(
            `INSERT INTO concrete_set_pickup_window (set_id, project_id, hours, updated_by_user_id)
             VALUES ($1, $2, $3, $4)`,
            [set.id, set.project_id, input.hours, user.userId],
          );
        }
        await recordAudit(client, {
          action: 'concrete_specimen_set.pickup_window_changed',
          entityType: 'concrete_specimen_set',
          entityId: set.id,
          actor,
          before: {
            hours: current?.hours ?? CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS,
            source: current ? 'edited' : 'default',
          },
          after: {
            hours: input.hours,
            source: 'edited',
            verified: CONCRETE_PICKUP_WINDOW_VERIFIED,
          },
          requestId,
        });
        return this.view(client, set);
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Receipt and mass (AC2, AC3)
  // -------------------------------------------------------------------------------------------

  async receipt(
    specimenId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const found = await setOfSpecimen(this.database.pool, specimenId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    const input = parseBody(concreteReceiptRequestSchema, body);
    const hash = intentHash({ kind: 'receipt', specimenId, ...withoutKey(input) });
    return this.retrying(
      input.idempotencyKey,
      'receipt',
      specimenId,
      hash,
      user,
      async (client) => {
        const set = await lockSet(client, found);
        await client.query('SELECT 1 FROM concrete_specimen WHERE id = $1 FOR UPDATE', [
          specimenId,
        ]);
        const receiverId = this.personFor(user, input.receivedByUserId, 'receivedByUserId');
        const people = await this.authorize(client, user, RECEIVE, [receiverId]);
        const receiver = people.get(receiverId);
        if (!receiver) {
          throw unprocessable(
            'invalid_receiver',
            'receivedByUserId',
            'must be an active staff member with confirmed initials',
          );
        }
        assertOpen(set);
        const { rows: existing } = await client.query(
          'SELECT 1 FROM concrete_specimen_receipt WHERE specimen_id = $1',
          [specimenId],
        );
        // One receipt per specimen; a wrong mass is corrected, with a reason (CD-46).
        if (existing.length > 0) throw new ConflictException({ code: 'already_received' });
        notBeforeCasting(set, input.receivedAt, 'receivedAt');
        await client.query(
          `INSERT INTO concrete_specimen_receipt
           (project_id, specimen_id, received_at, received_by_user_id, mass_g, recorded_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
          [set.project_id, specimenId, input.receivedAt, receiverId, input.massG, user.userId],
        );
        await recordAudit(client, {
          action: 'concrete_specimen.received',
          entityType: 'concrete_specimen',
          entityId: specimenId,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(receiver) : null,
          before: null,
          after: {
            receivedAt: new Date(input.receivedAt).toISOString(),
            receivedByUserId: receiverId,
            massG: concreteFormatTenths(input.massG),
          },
          requestId,
        });
        return this.view(client, set);
      },
    );
  }

  async massCorrection(
    specimenId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const found = await setOfSpecimen(this.database.pool, specimenId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    // CD-46: a personal account; a LAB station's selected person grants nothing.
    if (user.accountType === 'shared_lab') throw forbidden('personal_account_required');
    const input = parseBody(concreteMassCorrectionRequestSchema, body);
    const hash = intentHash({ kind: 'mass_correction', specimenId, ...withoutKey(input) });
    const run = async (client: PoolClient): Promise<ConcreteSetReceiving | null> => {
      const { rows } = await client.query<{
        specimen_id: string;
        request_hash: string;
        corrected_by_user_id: string;
      }>(
        `SELECT specimen_id, request_hash, corrected_by_user_id
         FROM concrete_specimen_mass_correction WHERE idempotency_key = $1`,
        [input.idempotencyKey],
      );
      const previous = rows[0];
      if (!previous) return null;
      if (
        previous.specimen_id !== specimenId ||
        previous.request_hash !== hash ||
        previous.corrected_by_user_id !== user.userId
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      return this.view(client, (await findSet(client, found.id))!);
    };
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const set = await lockSet(client, found);
        await client.query('SELECT 1 FROM concrete_specimen WHERE id = $1 FOR UPDATE', [
          specimenId,
        ]);
        const replay = await run(client);
        if (replay) return replay;
        await this.authorize(client, user, MASS_CORRECT, []);
        assertOpen(set);
        const { rows } = await client.query<{ id: string; mass_g: string; version: number }>(
          `SELECT id, mass_g::text, version FROM concrete_specimen_receipt
           WHERE specimen_id = $1 FOR UPDATE`,
          [specimenId],
        );
        const receipt = rows[0];
        if (!receipt) throw new ConflictException({ code: 'not_received' });
        if (receipt.version !== input.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.view(client, set),
          });
        }
        if (Number(receipt.mass_g) === Number(input.massG)) {
          throw unprocessable('no_change', 'massG', 'That is the recorded mass');
        }
        await client.query(
          `INSERT INTO concrete_specimen_mass_correction
             (project_id, specimen_id, receipt_id, previous_mass_g, new_mass_g, reason,
              corrected_by_user_id, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            set.project_id,
            specimenId,
            receipt.id,
            receipt.mass_g,
            input.massG,
            input.reason,
            user.userId,
            input.idempotencyKey,
            hash,
          ],
        );
        await client.query(
          `UPDATE concrete_specimen_receipt
           SET mass_g = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [receipt.id, input.massG],
        );
        await recordAudit(client, {
          action: 'concrete_specimen.mass_corrected',
          entityType: 'concrete_specimen',
          entityId: specimenId,
          actor,
          reason: input.reason,
          before: { version: receipt.version, massG: receipt.mass_g },
          after: { version: receipt.version + 1, massG: concreteFormatTenths(input.massG) },
          requestId,
        });
        return this.view(client, set);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_specimen_mass_correction_idempotency_key_key')) {
        const replay = await withTransaction(this.database.pool, run);
        if (replay) return replay;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Permanent-marker confirmation (AC6)
  // -------------------------------------------------------------------------------------------

  async markerConfirmation(
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const found = await findSet(this.database.pool, setId);
    if (!found) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    const input = parseBody(concreteMarkerConfirmationRequestSchema, body);
    const hash = intentHash({ kind: 'marker', setId: found.id, ...withoutKey(input) });
    return this.retrying(input.idempotencyKey, 'marker', found.id, hash, user, async (client) => {
      // FOR UPDATE: two confirmations of one set take turns, so coverage never overlaps.
      const set = await lockSet(client, found, 'FOR UPDATE');
      const personId = this.personFor(user, input.confirmedByUserId, 'confirmedByUserId');
      const people = await this.authorize(client, user, RECEIVE, [personId]);
      const person = people.get(personId);
      if (!person) {
        throw unprocessable(
          'invalid_person',
          'confirmedByUserId',
          'must be an active staff member with confirmed initials',
        );
      }
      assertOpen(set);
      if (set.permanent_number === null) throw new ConflictException({ code: 'set_not_numbered' });
      const { rows: uncovered } = await client.query<{ id: string }>(
        `SELECT sp.id FROM concrete_specimen sp
         JOIN concrete_specimen_receipt r ON r.specimen_id = sp.id
         WHERE sp.set_id = $1
           AND NOT EXISTS (SELECT 1 FROM concrete_set_marker_confirmation_specimen c
                           WHERE c.specimen_id = sp.id)
         ORDER BY sp.letter`,
        [set.id],
      );
      if (uncovered.length === 0) throw new ConflictException({ code: 'nothing_to_confirm' });
      const confirmationId = randomUUID();
      await client.query(
        `INSERT INTO concrete_set_marker_confirmation
           (id, project_id, set_id, confirmed_at, confirmed_by_user_id, recorded_by_user_id)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [confirmationId, set.project_id, set.id, input.confirmedAt, personId, user.userId],
      );
      await client.query(
        `INSERT INTO concrete_set_marker_confirmation_specimen (confirmation_id, set_id, specimen_id)
         SELECT $1, $2, unnest($3::uuid[])`,
        [confirmationId, set.id, uncovered.map((s) => s.id)],
      );
      await recordAudit(client, {
        action: 'concrete_specimen_set.markers_confirmed',
        entityType: 'concrete_specimen_set',
        entityId: set.id,
        actor,
        receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
        before: null,
        after: {
          confirmationId,
          confirmedAt: new Date(input.confirmedAt).toISOString(),
          confirmedByUserId: personId,
          specimenIds: uncovered.map((s) => s.id),
        },
        requestId,
      });
      return this.view(client, set);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Receiving exceptions (AC5)
  // -------------------------------------------------------------------------------------------

  async recordException(
    projectId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteReceivingException> {
    if (!UUID_PATTERN.test(projectId) || !(await findProject(this.database.pool, projectId))) {
      throw new NotFoundException({ code: 'project_not_found' });
    }
    const input = parseBody(concreteReceivingExceptionRequestSchema, body);
    const hash = intentHash({ command: 'exception', projectId, ...withoutKey(input) });
    const exceptionId = input.id ?? randomUUID();
    return this.retrying(
      input.idempotencyKey,
      'exception',
      exceptionId,
      hash,
      user,
      async (client) => {
        // The set it concerns, from the specimen (missing) or as named (extra).
        let set: SetFacts | null = null;
        if (input.specimenId) {
          set = await setOfSpecimen(client, input.specimenId);
          if (!set || set.project_id !== projectId) {
            throw unprocessable(
              'specimen_not_found',
              'specimenId',
              'No such specimen on this project',
            );
          }
        } else if (input.setId) {
          set = await findSet(client, input.setId);
          if (!set || set.project_id !== projectId) {
            throw unprocessable('set_not_found', 'setId', 'No such set on this project');
          }
        }
        if (set) {
          set = await lockSet(client, set);
          assertOpen(set);
        }
        if (input.specimenId) {
          await client.query('SELECT 1 FROM concrete_specimen WHERE id = $1 FOR UPDATE', [
            input.specimenId,
          ]);
        }
        const reporterId = this.personFor(user, input.reportedByUserId, 'reportedByUserId');
        const receiverId =
          input.receivedAt !== undefined
            ? this.personFor(user, input.receivedByUserId, 'receivedByUserId')
            : null;
        const people = await this.authorize(client, user, RECEIVE, [
          reporterId,
          ...(receiverId ? [receiverId] : []),
        ]);
        for (const [field, id] of [
          ['reportedByUserId', reporterId],
          ['receivedByUserId', receiverId],
        ] as const) {
          if (id && !people.get(id)) {
            throw unprocessable(
              'invalid_person',
              field,
              'must be an active staff member with confirmed initials',
            );
          }
        }
        if (input.kind === 'missing') {
          const { rows } = await client.query(
            `SELECT (SELECT count(*)::int FROM concrete_specimen_receipt WHERE specimen_id = $1) AS received,
                    (SELECT count(*)::int FROM concrete_receiving_exception
                     WHERE specimen_id = $1 AND kind = 'missing' AND resolved_at IS NULL) AS open`,
            [input.specimenId],
          );
          const facts = rows[0] as { received: number; open: number };
          if (facts.received > 0) throw new ConflictException({ code: 'specimen_received' });
          if (facts.open > 0) throw new ConflictException({ code: 'already_reported' });
        }
        if (set) notBeforeCasting(set, input.receivedAt ?? null, 'receivedAt');
        const { rows: taken } = await client.query(
          'SELECT 1 FROM concrete_receiving_exception WHERE id = $1',
          [exceptionId],
        );
        if (taken.length > 0) throw new ConflictException({ code: 'exception_id_taken' });
        await client.query(
          `INSERT INTO concrete_receiving_exception
             (id, project_id, kind, set_id, specimen_id, observed_marking, note, received_at,
              received_by_user_id, mass_g, reported_by_user_id, recorded_by_user_id)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            exceptionId,
            projectId,
            input.kind,
            set?.id ?? null,
            input.specimenId ?? null,
            input.observedMarking ?? null,
            input.note ?? null,
            input.receivedAt ?? null,
            receiverId,
            input.massG ?? null,
            reporterId,
            user.userId,
          ],
        );
        const reporter = people.get(reporterId)!;
        await recordAudit(client, {
          action: 'concrete_receiving_exception.recorded',
          entityType: 'concrete_receiving_exception',
          entityId: exceptionId,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(reporter) : null,
          before: null,
          after: {
            projectId,
            kind: input.kind,
            setId: set?.id ?? null,
            specimenId: input.specimenId ?? null,
            observedMarking: input.observedMarking ?? null,
            receivedAt: input.receivedAt ? new Date(input.receivedAt).toISOString() : null,
            receivedByUserId: receiverId,
            massG: input.massG ? concreteFormatTenths(input.massG) : null,
          },
          requestId,
        });
        return (await exceptionsWhere(client, 'e.id = $1', [exceptionId]))[0]!;
      },
    );
  }

  async resolveException(
    exceptionId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteReceivingException> {
    const db = this.database.pool;
    const found = UUID_PATTERN.test(exceptionId) ? await exceptionFacts(db, exceptionId) : null;
    if (!found) return notFoundOrForbidden(db, user, 'concrete_receiving_exception_not_found');
    // Authority before the body: a personal account that could hold the permission here.
    if (!(await this.couldResolve(db, user, found))) throw forbidden();
    const input = parseBody(concreteResolveReceivingExceptionRequestSchema, body);
    const hash = intentHash({ kind: 'resolve', exceptionId, ...withoutKey(input) });
    return this.retrying(
      input.idempotencyKey,
      'resolve',
      exceptionId,
      hash,
      user,
      async (client) => {
        const matched = input.matchedSpecimenId
          ? await setOfSpecimen(client, input.matchedSpecimenId)
          : null;
        if (input.matchedSpecimenId) {
          if (found.kind === 'missing') {
            throw unprocessable(
              'not_matchable',
              'matchedSpecimenId',
              'A missing specimen is its own',
            );
          }
          if (!matched || matched.project_id !== found.project_id) {
            throw unprocessable(
              'specimen_not_found',
              'matchedSpecimenId',
              'No such specimen on this project',
            );
          }
        }
        // Lock order: the sets concerned (report, set), the specimens, the exception, then the
        // project and accounts (canUnderLock-style, inside resolveAuthority).
        const own = found.set_id ? await findSet(client, found.set_id) : null;
        for (const set of [own, matched].filter((s): s is SetFacts => s !== null)) {
          await lockSet(client, set);
        }
        if (matched) {
          await client.query('SELECT 1 FROM concrete_specimen WHERE id = $1 FOR UPDATE', [
            input.matchedSpecimenId,
          ]);
        }
        const exception = (await exceptionFacts(client, exceptionId, 'FOR UPDATE'))!;
        // Casting-technician authority covers only specimens they cast: the set the record names
        // and, when matched, the matched specimen's set; both must be theirs.
        const technicians = [own?.technician_user_id, matched?.technician_user_id].filter(
          (id) => id !== undefined,
        );
        const recordTechnician =
          technicians.length > 0 && technicians.every((id) => id && id === technicians[0])
            ? (technicians[0] ?? null)
            : null;
        const source = await this.resolveAuthority(client, user, exception.project_id, {
          recordTechnicianUserId: recordTechnician,
        });
        if (!source) throw forbidden();
        if (exception.resolved_at !== null)
          throw new ConflictException({ code: 'already_resolved' });
        await client.query(
          `UPDATE concrete_receiving_exception
         SET resolved_at = now(), resolved_by_user_id = $2, resolution_source = $3,
             disposition = $4, resolution_reason = $5, matched_specimen_id = $6
         WHERE id = $1`,
          [
            exceptionId,
            user.userId,
            source,
            input.disposition,
            input.reason,
            input.matchedSpecimenId ?? null,
          ],
        );
        // Linked after verification: the recorded receipt becomes the matched specimen's.
        let linkedReceipt = false;
        if (matched && exception.received_at !== null && exception.mass_g !== null) {
          const { rows } = await client.query(
            'SELECT 1 FROM concrete_specimen_receipt WHERE specimen_id = $1',
            [input.matchedSpecimenId],
          );
          if (rows.length === 0) {
            await client.query(
              `INSERT INTO concrete_specimen_receipt
               (project_id, specimen_id, received_at, received_by_user_id, mass_g,
                recorded_by_user_id, from_exception_id)
             SELECT project_id, $2, received_at, received_by_user_id, mass_g, recorded_by_user_id, id
             FROM concrete_receiving_exception WHERE id = $1`,
              [exceptionId, input.matchedSpecimenId],
            );
            linkedReceipt = true;
          }
        }
        await recordAudit(client, {
          action: 'concrete_receiving_exception.resolved',
          entityType: 'concrete_receiving_exception',
          entityId: exceptionId,
          actor,
          reason: input.reason,
          before: { resolved: false },
          after: {
            resolved: true,
            source,
            disposition: input.disposition,
            matchedSpecimenId: input.matchedSpecimenId ?? null,
            linkedReceipt,
          },
          requestId,
        });
        return (await exceptionsWhere(client, 'e.id = $1', [exceptionId]))[0]!;
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Curing flag resolution (issuance gate, CD-32)
  // -------------------------------------------------------------------------------------------

  async curingResolution(
    specimenId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSetReceiving> {
    const db = this.database.pool;
    const found = await setOfSpecimen(db, specimenId);
    if (!found) return notFoundOrForbidden(db, user, 'concrete_specimen_not_found');
    if (!(await this.couldReview(db, user, found.project_id))) throw forbidden();
    const input = parseBody(concreteCuringResolutionRequestSchema, body);
    const hash = intentHash({ kind: 'curing_resolve', specimenId, ...withoutKey(input) });
    return this.retrying(
      input.idempotencyKey,
      'curing_resolve',
      specimenId,
      hash,
      user,
      async (client) => {
        const set = await lockSet(client, found);
        await client.query('SELECT 1 FROM concrete_specimen WHERE id = $1 FOR UPDATE', [
          specimenId,
        ]);
        const { rows } = await client.query<PickupRow>(
          `${SELECT_PICKUP} WHERE pk.specimen_id = $1 FOR UPDATE OF pk`,
          [specimenId],
        );
        const pickup = rows[0];
        const context = await this.reviewContext(client, set.project_id);
        const lead = await lockProjectLead(client, set.project_id);
        const actorNow = asLocked(user, await lockStanding(client, [user.userId]));
        if (!can(actorNow, REVIEW, { ...context, leadProjectEngineerUserId: lead ?? null })) {
          throw forbidden();
        }
        if (!pickup || !pickup.curing_flags || pickup.curing_flags.length === 0) {
          throw new ConflictException({ code: 'no_curing_flag' });
        }
        if (pickup.curing_resolved_at !== null) {
          throw new ConflictException({ code: 'already_resolved' });
        }
        if (pickup.version !== input.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.view(client, set),
          });
        }
        await client.query(
          `UPDATE concrete_specimen_pickup
           SET curing_resolved_at = now(), curing_resolved_by_user_id = $2,
               curing_resolution_note = $3, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [pickup.id, user.userId, input.note],
        );
        await recordAudit(client, {
          action: 'concrete_specimen.curing_flag_resolved',
          entityType: 'concrete_specimen',
          entityId: specimenId,
          actor,
          reason: input.note,
          before: { version: pickup.version, curingFlags: pickup.curing_flags, resolved: false },
          after: { version: pickup.version + 1, curingFlags: pickup.curing_flags, resolved: true },
          requestId,
        });
        return this.view(client, set);
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  /**
   * The person a record names: a personal account is itself unless it names the actual person; a
   * LAB station must name them (400 `<field>`/required).
   */
  private personFor(user: AuthUser, personUserId: string | undefined, field: string): string {
    if (personUserId !== undefined) return personUserId;
    if (user.accountType === 'shared_lab') {
      throw validationError([{ field, code: 'required', message: 'choose who is doing this' }]);
    }
    return user.userId;
  }

  /**
   * The account's authority as it stands under the locks (a role removed or an account disabled
   * by a transaction that committed first is honoured), and the named people locked FOR SHARE:
   * the map holds those who are active staff (never LAB) with confirmed initials.
   */
  private async authorize(
    client: PoolClient,
    user: AuthUser,
    permission: Permission,
    personIds: readonly string[],
  ): Promise<Map<string, PersonSnapshot>> {
    const valid = personIds.filter((id) => UUID_PATTERN.test(id));
    const standing = await lockStanding(client, [user.userId, ...valid]);
    if (!can(asLocked(user, standing), permission)) throw forbidden();
    const people = new Map<string, PersonSnapshot>();
    for (const id of valid) {
      const person = standing.get(id);
      if (
        person &&
        person.status === 'active' &&
        person.accountType !== 'shared_lab' &&
        person.initials
      ) {
        people.set(id, { userId: id, initials: person.initials, name: person.displayName });
      }
    }
    return people;
  }

  private async reviewContext(
    db: Db,
    projectId: string,
  ): Promise<Omit<ProjectContext, 'leadProjectEngineerUserId'>> {
    return { designatedReviewerUserIds: await designatedReviewers(db, projectId, FIELD_SCOPE) };
  }

  private async couldReview(db: Db, user: AuthUser, projectId: string): Promise<boolean> {
    if (user.status !== 'active' || user.accountType === 'shared_lab') return false;
    const project = await findProject(db, projectId);
    if (!project) return false;
    return can(user, REVIEW, {
      ...(await this.reviewContext(db, projectId)),
      leadProjectEngineerUserId: project.lead_project_engineer_user_id,
    });
  }

  /** Pre-body check: could this personal account resolve this record (any matched specimen)? */
  private async couldResolve(db: Db, user: AuthUser, exception: ExceptionFacts): Promise<boolean> {
    if (user.status !== 'active' || user.accountType === 'shared_lab') return false;
    const project = await findProject(db, exception.project_id);
    if (!project) return false;
    const context: ProjectContext = {
      leadProjectEngineerUserId: project.lead_project_engineer_user_id,
      designatedReviewerUserIds: await designatedReviewers(db, project.id, FIELD_SCOPE),
      concreteLabManagerUserIds: await concreteLabManagers(db, project.id),
    };
    if (can(user, RESOLVE, context)) return true;
    // The casting technician: of the record's set, or (no set named) of some set on the project
    // a match could name; the full check runs under the locks.
    const { rows } = await db.query(
      exception.set_id
        ? 'SELECT 1 FROM concrete_specimen_set WHERE id = $2 AND technician_user_id = $1'
        : `SELECT 1 FROM concrete_specimen_set WHERE project_id = $2 AND technician_user_id = $1
           LIMIT 1`,
      [user.userId, exception.set_id ?? exception.project_id],
    );
    return rows.length > 0;
  }

  /** The source a resolution is recorded under, as it stands under the locks; null: refused. */
  private async resolveAuthority(
    client: PoolClient,
    user: AuthUser,
    projectId: string,
    extra: { recordTechnicianUserId: string | null },
  ): Promise<PermissionSource | null> {
    const lead = await lockProjectLead(client, projectId);
    if (lead === undefined) return null;
    const actorNow = asLocked(user, await lockStanding(client, [user.userId]));
    const sources = permissionSources(actorNow, RESOLVE, {
      leadProjectEngineerUserId: lead,
      designatedReviewerUserIds: await designatedReviewers(client, projectId, FIELD_SCOPE),
      concreteLabManagerUserIds: await concreteLabManagers(client, projectId),
      recordTechnicianUserId: extra.recordTechnicianUserId,
    });
    return RESOLUTION_SOURCES.find((s) => sources.includes(s)) ?? null;
  }

  /** One transaction with exactly-once semantics through the receiving command ledger. */
  private async retrying<T>(
    key: string,
    kind: Kind,
    targetId: string,
    hash: string,
    user: AuthUser,
    work: (client: PoolClient) => Promise<T>,
  ): Promise<T> {
    const replay = async (client: PoolClient): Promise<T | null> => {
      const { rows } = await client.query<{
        kind: string;
        target_id: string;
        request_hash: string;
        user_id: string;
      }>(
        'SELECT kind, target_id, request_hash, user_id FROM concrete_receiving_command WHERE idempotency_key = $1',
        [key],
      );
      const previous = rows[0];
      if (!previous) return null;
      // A new exception's id may be server-generated, so its retry is matched on the key alone.
      if (
        previous.kind !== kind ||
        (kind !== 'exception' && previous.target_id !== targetId) ||
        previous.request_hash !== hash ||
        previous.user_id !== user.userId
      ) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      return this.replayResult(client, kind, previous.target_id) as Promise<T>;
    };
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const previous = await replay(client);
        if (previous) return previous;
        const result = await work(client);
        await client.query(
          `INSERT INTO concrete_receiving_command (idempotency_key, kind, target_id, request_hash, user_id)
           VALUES ($1, $2, $3, $4, $5)`,
          [key, kind, targetId, hash, user.userId],
        );
        return result;
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_receiving_command_pkey')) {
        const previous = await withTransaction(this.database.pool, replay);
        if (previous) return previous;
      }
      throw error;
    }
  }

  private async replayResult(client: PoolClient, kind: Kind, targetId: string): Promise<unknown> {
    if (kind === 'exception' || kind === 'resolve') {
      return (await exceptionsWhere(client, 'e.id = $1', [targetId]))[0]!;
    }
    const set =
      kind === 'receipt' || kind === 'curing_resolve'
        ? await setOfSpecimen(client, targetId)
        : await findSet(client, targetId);
    return this.view(client, set!);
  }

  /** The set's receiving records, blockers and gates as they stand. */
  private async view(db: Db, set: SetFacts): Promise<ConcreteSetReceiving> {
    const { rows: specimens } = await db.query<{
      id: string;
      letter: string;
      assigned_age: string | null;
    }>('SELECT id, letter, assigned_age FROM concrete_specimen WHERE set_id = $1 ORDER BY letter', [
      set.id,
    ]);
    const ids = specimens.map((s) => s.id);
    const { rows: pickups } = await db.query<PickupRow>(
      `${SELECT_PICKUP} WHERE pk.specimen_id = ANY($1::uuid[])`,
      [ids],
    );
    const { rows: receipts } = await db.query<ReceiptRow>(
      `SELECT id, specimen_id, received_at, received_by_user_id, mass_g::text, recorded_by_user_id,
              from_exception_id, version
       FROM concrete_specimen_receipt WHERE specimen_id = ANY($1::uuid[])`,
      [ids],
    );
    const { rows: corrections } = await db.query<{
      id: string;
      specimen_id: string;
      previous_mass_g: string;
      new_mass_g: string;
      reason: string;
      corrected_by_user_id: string;
      created_at: Date;
    }>(
      `SELECT id, specimen_id, previous_mass_g::text, new_mass_g::text, reason,
              corrected_by_user_id, created_at
       FROM concrete_specimen_mass_correction WHERE specimen_id = ANY($1::uuid[])
       ORDER BY created_at, id`,
      [ids],
    );
    const { rows: confirmations } = await db.query<{
      id: string;
      confirmed_at: Date;
      confirmed_by_user_id: string;
      recorded_by_user_id: string;
      specimen_ids: string[];
    }>(
      `SELECT c.id, c.confirmed_at, c.confirmed_by_user_id, c.recorded_by_user_id,
              array_agg(cs.specimen_id ORDER BY sp.letter)::text[] AS specimen_ids
       FROM concrete_set_marker_confirmation c
       JOIN concrete_set_marker_confirmation_specimen cs ON cs.confirmation_id = c.id
       JOIN concrete_specimen sp ON sp.id = cs.specimen_id
       WHERE c.set_id = $1 GROUP BY c.id ORDER BY c.created_at, c.id`,
      [set.id],
    );
    const exceptions = await exceptionsWhere(
      db,
      `(e.set_id = $1 OR e.specimen_id = ANY($2::uuid[]) OR e.matched_specimen_id = ANY($2::uuid[]))`,
      [set.id, ids],
    );
    const { rows: windows } = await db.query<{ hours: number; version: number }>(
      'SELECT hours, version FROM concrete_set_pickup_window WHERE set_id = $1',
      [set.id],
    );
    const range = await currentRange(db);
    const people = await peopleFor(db, [
      ...(set.technician_user_id ? [set.technician_user_id] : []),
      ...pickups.flatMap((p) =>
        [p.collected_by_user_id, p.recorded_by_user_id, p.curing_resolved_by_user_id].filter(
          (id): id is string => id !== null,
        ),
      ),
      ...receipts.flatMap((r) => [r.received_by_user_id, r.recorded_by_user_id]),
      ...corrections.map((c) => c.corrected_by_user_id),
      ...confirmations.flatMap((c) => [c.confirmed_by_user_id, c.recorded_by_user_id]),
    ]);
    const person = (id: string) => people.get(id)!;
    const pickupBySpecimen = new Map(pickups.map((p) => [p.specimen_id, p]));
    const receiptBySpecimen = new Map(receipts.map((r) => [r.specimen_id, r]));
    const coveredBy = new Map(
      confirmations.flatMap((c) => c.specimen_ids.map((id) => [id, c.id] as const)),
    );
    const rows: ConcreteReceivingSpecimen[] = specimens.map((sp) => {
      const pickup = pickupBySpecimen.get(sp.id);
      const receipt = receiptBySpecimen.get(sp.id);
      const missingResolved =
        !receipt &&
        exceptions.some((e) => e.kind === 'missing' && e.specimenId === sp.id && e.resolution);
      return {
        specimenId: sp.id,
        letter: sp.letter,
        identity: {
          temporaryId: set.temporary_id === null ? null : set.temporary_id + sp.letter,
          permanentId: set.permanent_id === null ? null : set.permanent_id + sp.letter,
        },
        assignedAge: sp.assigned_age === null ? null : toAge(sp.assigned_age),
        state: receipt
          ? 'received'
          : missingResolved
            ? 'missing_resolved'
            : pickup?.completed
              ? 'picked_up'
              : 'awaiting_pickup',
        pickup: pickup ? toPickup(pickup, person) : null,
        receipt: receipt
          ? toReceipt(
              receipt,
              corrections.filter((c) => c.specimen_id === sp.id),
              person,
            )
          : null,
        markerConfirmationId: coveredBy.get(sp.id) ?? null,
        openExceptionIds: exceptions
          .filter((e) => !e.resolution && e.specimenId === sp.id)
          .map((e) => e.id),
      };
    });
    const issues = concreteReceivingIssues({
      setVoided: set.voided || set.workflow_state === 'void',
      specimens: rows.map((row) => ({
        specimenId: row.specimenId,
        pickupCompleted: row.pickup?.completed ?? false,
        received: row.receipt !== null,
        markerCovered: row.markerConfirmationId !== null,
        missingResolved: row.state === 'missing_resolved',
        curingUnresolvedFlag:
          (row.pickup?.curingFlags?.length ?? 0) > 0 && row.pickup?.curingResolution === null,
      })),
      exceptions: exceptions
        .filter((e) => e.kind === 'missing' || e.setId === set.id)
        .map((e) => ({
          id: e.id,
          kind: e.kind,
          specimenId: e.specimenId,
          resolved: e.resolution !== null,
        })),
    });
    const window = windows[0] ?? null;
    const hours = window?.hours ?? CONCRETE_PICKUP_WINDOW_DEFAULT_HOURS;
    const castAt = set.cast_at?.toISOString() ?? null;
    return {
      setId: set.id,
      fieldReportId: set.field_report_id,
      projectId: set.project_id,
      identity: { temporaryId: set.temporary_id, permanentId: set.permanent_id },
      castAt,
      technician: set.technician_user_id ? (people.get(set.technician_user_id) ?? null) : null,
      voided: set.voided,
      pickupWindow: {
        hours,
        source: window ? 'edited' : 'default',
        endsAt: concretePickupWindowEndsAt(castAt, hours),
        verified: CONCRETE_PICKUP_WINDOW_VERIFIED,
        version: window?.version ?? null,
      },
      currentCuringRange: range ? toRange(range) : null,
      specimens: rows,
      markerConfirmations: confirmations.map((c) => ({
        id: c.id,
        confirmedAt: c.confirmed_at.toISOString(),
        confirmedBy: person(c.confirmed_by_user_id),
        recordedBy: person(c.recorded_by_user_id),
        specimenIds: c.specimen_ids,
      })),
      exceptions,
      blockers: issues.blockers,
      issuanceGates: issues.issuanceGates,
    };
  }
}

// ---------------------------------------------------------------------------------------------

const toAge = (value: string): ConcreteSpecimenAge => (value === 'HOLD' ? 'HOLD' : Number(value));

interface RangeRow {
  id: string;
  specification: string;
  edition: string;
  min_c: string;
  max_c: string;
}

async function currentRange(db: Db): Promise<RangeRow | null> {
  const { rows } = await db.query<RangeRow>(
    `SELECT id, specification, edition, min_c::text, max_c::text FROM concrete_curing_standard
     WHERE retired_at IS NULL`,
  );
  return rows[0] ?? null;
}

const toRange = (row: RangeRow): ConcreteCuringRange => ({
  id: row.id,
  specification: row.specification,
  edition: row.edition,
  minC: concreteFormatTenths(row.min_c),
  maxC: concreteFormatTenths(row.max_c),
});

function checkWith(
  range: RangeRow | null,
  minC: string | null,
  maxC: string | null,
): {
  standardId: string | null;
  rangeMin: string | null;
  rangeMax: string | null;
  flags: ConcreteCuringFlag[] | null;
} {
  const flags = concreteCuringFlags(
    { minC, maxC },
    range ? { minC: range.min_c, maxC: range.max_c } : null,
  );
  if (!range || flags === null) {
    return { standardId: null, rangeMin: null, rangeMax: null, flags: null };
  }
  return { standardId: range.id, rangeMin: range.min_c, rangeMax: range.max_c, flags };
}

interface PickupRow {
  id: string;
  specimen_id: string;
  collected_by_user_id: string | null;
  collected_at: Date | null;
  curing_min_c: string | null;
  curing_max_c: string | null;
  curing_box: string | null;
  curing_location: string | null;
  completed: boolean;
  curing_standard_id: string | null;
  curing_range_min_c: string | null;
  curing_range_max_c: string | null;
  curing_flags: ConcreteCuringFlag[] | null;
  curing_resolved_at: Date | null;
  curing_resolved_by_user_id: string | null;
  curing_resolution_note: string | null;
  recorded_by_user_id: string;
  updated_at: Date;
  version: number;
  specification: string | null;
  edition: string | null;
}

const SELECT_PICKUP = `SELECT pk.id, pk.specimen_id, pk.collected_by_user_id, pk.collected_at,
         pk.curing_min_c::text, pk.curing_max_c::text, pk.curing_box, pk.curing_location,
         pk.completed, pk.curing_standard_id, pk.curing_range_min_c::text,
         pk.curing_range_max_c::text, pk.curing_flags, pk.curing_resolved_at,
         pk.curing_resolved_by_user_id, pk.curing_resolution_note, pk.recorded_by_user_id,
         pk.updated_at, pk.version, cs.specification, cs.edition
  FROM concrete_specimen_pickup pk
  LEFT JOIN concrete_curing_standard cs ON cs.id = pk.curing_standard_id`;

async function pickupRow(db: Db, id: string): Promise<PickupRow | null> {
  const { rows } = await db.query<PickupRow>(`${SELECT_PICKUP} WHERE pk.id = $1`, [id]);
  return rows[0] ?? null;
}

const tenths = (value: string | null) => (value === null ? null : concreteFormatTenths(value));

function auditPickup(row: PickupRow) {
  return {
    version: row.version,
    completed: row.completed,
    collectedByUserId: row.collected_by_user_id,
    collectedAt: row.collected_at?.toISOString() ?? null,
    curingMinC: tenths(row.curing_min_c),
    curingMaxC: tenths(row.curing_max_c),
    curingBox: row.curing_box,
    curingLocation: row.curing_location,
    curingStandardId: row.curing_standard_id,
    curingFlags: row.curing_flags,
  };
}

function toPickup(row: PickupRow, person: (id: string) => PersonSnapshot): ConcretePickup {
  return {
    id: row.id,
    completed: row.completed,
    collectedBy: row.collected_by_user_id ? person(row.collected_by_user_id) : null,
    collectedAt: row.collected_at?.toISOString() ?? null,
    curingMinC: tenths(row.curing_min_c),
    curingMaxC: tenths(row.curing_max_c),
    curingBox: row.curing_box,
    curingLocation: row.curing_location,
    curingRange:
      row.curing_standard_id === null
        ? null
        : {
            id: row.curing_standard_id,
            specification: row.specification!,
            edition: row.edition!,
            minC: tenths(row.curing_range_min_c)!,
            maxC: tenths(row.curing_range_max_c)!,
          },
    curingFlags: row.curing_flags,
    curingResolution:
      row.curing_resolved_at === null
        ? null
        : {
            at: row.curing_resolved_at.toISOString(),
            by: person(row.curing_resolved_by_user_id!),
            note: row.curing_resolution_note!,
          },
    recordedBy: person(row.recorded_by_user_id),
    updatedAt: row.updated_at.toISOString(),
    version: row.version,
  };
}

interface ReceiptRow {
  id: string;
  specimen_id: string;
  received_at: Date;
  received_by_user_id: string;
  mass_g: string;
  recorded_by_user_id: string;
  from_exception_id: string | null;
  version: number;
}

function toReceipt(
  row: ReceiptRow,
  corrections: {
    id: string;
    previous_mass_g: string;
    new_mass_g: string;
    reason: string;
    corrected_by_user_id: string;
    created_at: Date;
  }[],
  person: (id: string) => PersonSnapshot,
): ConcreteReceipt {
  return {
    id: row.id,
    receivedAt: row.received_at.toISOString(),
    receivedBy: person(row.received_by_user_id),
    massG: concreteFormatTenths(row.mass_g),
    recordedBy: person(row.recorded_by_user_id),
    fromExceptionId: row.from_exception_id,
    corrections: corrections.map((c) => ({
      id: c.id,
      previousMassG: concreteFormatTenths(c.previous_mass_g),
      newMassG: concreteFormatTenths(c.new_mass_g),
      reason: c.reason,
      by: person(c.corrected_by_user_id),
      at: c.created_at.toISOString(),
    })),
    version: row.version,
  };
}

interface ExceptionFacts {
  id: string;
  project_id: string;
  kind: ConcreteReceivingExceptionKind;
  set_id: string | null;
  specimen_id: string | null;
  received_at: Date | null;
  mass_g: string | null;
  resolved_at: Date | null;
}

async function exceptionFacts(
  db: Db,
  id: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<ExceptionFacts | null> {
  const { rows } = await db.query<ExceptionFacts>(
    `SELECT id, project_id, kind, set_id, specimen_id, received_at, mass_g::text, resolved_at
     FROM concrete_receiving_exception WHERE id = $1 ${lock}`,
    [id],
  );
  return rows[0] ?? null;
}

async function exceptionsWhere(
  db: Db,
  where: string,
  params: unknown[],
  tail = '',
): Promise<ConcreteReceivingException[]> {
  const { rows } = await db.query<{
    id: string;
    project_id: string;
    kind: ConcreteReceivingExceptionKind;
    set_id: string | null;
    specimen_id: string | null;
    observed_marking: string | null;
    note: string | null;
    received_at: Date | null;
    received_by_user_id: string | null;
    mass_g: string | null;
    reported_by_user_id: string;
    recorded_by_user_id: string;
    created_at: Date;
    resolved_at: Date | null;
    resolved_by_user_id: string | null;
    resolution_source: string | null;
    disposition: string | null;
    resolution_reason: string | null;
    matched_specimen_id: string | null;
  }>(
    `SELECT e.id, e.project_id, e.kind, e.set_id, e.specimen_id, e.observed_marking, e.note,
            e.received_at, e.received_by_user_id, e.mass_g::text, e.reported_by_user_id,
            e.recorded_by_user_id, e.created_at, e.resolved_at, e.resolved_by_user_id,
            e.resolution_source, e.disposition, e.resolution_reason, e.matched_specimen_id
     FROM concrete_receiving_exception e WHERE ${where}
     ORDER BY e.created_at DESC, e.id ${tail}`,
    params,
  );
  const people = await peopleFor(
    db,
    rows.flatMap((r) =>
      [
        r.received_by_user_id,
        r.reported_by_user_id,
        r.recorded_by_user_id,
        r.resolved_by_user_id,
      ].filter((id): id is string => id !== null),
    ),
  );
  return rows.map((r) => ({
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    setId: r.set_id,
    specimenId: r.specimen_id,
    observedMarking: r.observed_marking,
    note: r.note,
    receivedAt: r.received_at?.toISOString() ?? null,
    receivedBy: r.received_by_user_id ? people.get(r.received_by_user_id)! : null,
    massG: tenths(r.mass_g),
    reportedBy: people.get(r.reported_by_user_id)!,
    recordedBy: people.get(r.recorded_by_user_id)!,
    createdAt: r.created_at.toISOString(),
    resolution:
      r.resolved_at === null
        ? null
        : {
            at: r.resolved_at.toISOString(),
            by: people.get(r.resolved_by_user_id!)!,
            source: r.resolution_source!,
            disposition: r.disposition!,
            reason: r.resolution_reason!,
            matchedSpecimenId: r.matched_specimen_id,
          },
  }));
}

/** People by id, as they are named now (initials may be null for LAB). */
async function peopleFor(db: Db, ids: readonly string[]): Promise<Map<string, PersonSnapshot>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query<{
    id: string;
    display_name: string;
    official_initials: string | null;
  }>('SELECT id, display_name, official_initials FROM app_user WHERE id = ANY($1::uuid[])', [
    unique,
  ]);
  return new Map(
    rows.map((r) => [r.id, { userId: r.id, initials: r.official_initials, name: r.display_name }]),
  );
}

/**
 * An unknown record on a project-authority route: 404 only to someone who could hold that
 * authority on some project (a lead, a reviewer, a concrete-grant Lab Manager or a set's
 * technician); everyone else gets 403, so the route never confirms what exists.
 */
async function notFoundOrForbidden(db: Db, user: AuthUser, code: string): Promise<never> {
  if (user.accountType !== 'shared_lab' && user.status === 'active') {
    const { rows } = await db.query(
      `SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1
       UNION ALL SELECT 1 FROM project_reviewer_assignment WHERE reviewer_user_id = $1
       UNION ALL SELECT 1 FROM project_concrete_lab_manager_grant
                 WHERE lab_manager_user_id = $1 AND revoked_at IS NULL
       UNION ALL SELECT 1 FROM concrete_specimen_set WHERE technician_user_id = $1
       LIMIT 1`,
      [user.userId],
    );
    if (rows.length > 0) throw new NotFoundException({ code });
  }
  throw forbidden();
}
