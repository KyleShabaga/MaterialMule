import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  concreteCastingCorrectionRequestSchema,
  concreteCastingDate,
  concreteMixSnapshotSchema,
  concreteSetShapeDefault,
  concreteSpecimenFlags,
  createConcreteSpecimenSetRequestSchema,
  discardConcreteSpecimenSetRequestSchema,
  normalizeConcreteSpecimenRows,
  resolveConcreteSchedule,
  saveConcreteSpecimenSetRequestSchema,
  type ConcreteCastingCorrectionResult,
  type ConcreteCastingEffect,
  type ConcreteNormalizedSpecimen,
  type ConcreteScheduleSnapshot,
  type ConcreteSpecimenAge,
  type ConcreteSpecimenSetDefaults,
  type ConcreteSpecimenSetDetail,
  type ConcreteSpecimenSetList,
  type ConcreteSpecimenType,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type ProjectContext } from '../auth/policy.js';
import { canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf, resolveActingPerson } from '../lab/attribution.js';
import {
  concreteRescheduleContext,
  findProject,
  intentHash,
} from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';

type Db = Pool | PoolClient;
type Kind = 'create' | 'save' | 'discard';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'concrete_specimen_set';
const DRAFT = 'concrete_report.draft' as const;
/**
 * Casting-time correction once a set is numbered (AC5). Confirmed by the owner (2026-11-08): reuses C10's
 * `concrete_specimen.reschedule` (the lead, a designated reviewer, or a concrete-grant Lab
 * Manager; personal accounts only), since it moves every dependent test date.
 */
const CORRECT = 'concrete_specimen.reschedule' as const;

interface ReportRow {
  id: string;
  project_id: string;
  technician_user_id: string | null;
  workflow_state: string;
  cast_at: Date | null;
  material: string | null;
  specimens_cast: boolean | null;
  mix_snapshot: unknown;
  version: number;
}

const SELECT_REPORT = `SELECT r.id, r.project_id, r.technician_user_id, r.workflow_state, r.cast_at,
         r.material, r.specimens_cast, r.mix_snapshot, r.version
  FROM concrete_field_report r`;

interface SetRow {
  id: string;
  project_id: string;
  field_report_id: string;
  temporary_id: string | null;
  permanent_id: string | null;
  permanent_number: number | null;
  specimen_type: ConcreteSpecimenType;
  mould_size: string | null;
  created_by_user_id: string | null;
  technician_user_id: string | null;
  default_ages: string[] | null;
  default_ages_source: ConcreteScheduleSnapshot['source'] | null;
  default_ages_mix_revision_id: string | null;
  hold_duration_days: number | null;
  hold_duration_source: ConcreteScheduleSnapshot['holdDurationSource'] | null;
  voided_at: Date | null;
  voided_by_user_id: string | null;
  void_reason: string | null;
  version: number;
  created_at: Date;
  updated_at: Date;
}

const SELECT_SET = `SELECT s.id, s.project_id, s.field_report_id, s.temporary_id, s.permanent_id,
         s.permanent_number, s.specimen_type, s.mould_size, s.created_by_user_id,
         s.technician_user_id, s.default_ages, s.default_ages_source,
         s.default_ages_mix_revision_id, s.hold_duration_days, s.hold_duration_source, s.voided_at,
         s.voided_by_user_id, s.void_reason, s.version, s.created_at, s.updated_at
  FROM concrete_specimen_set s`;

interface SpecimenRow {
  id: string;
  set_id: string;
  letter: string;
  assigned_age: string | null;
  target_date: string | null;
  hold_expires_on: string | null;
}

const toAge = (value: string): ConcreteSpecimenAge =>
  value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);
const fromAge = (age: ConcreteSpecimenAge): string => String(age);

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

/**
 * Specimen sets, age assignments and stable identity records (MM-V2-C05). Reads follow the
 * project (`inventory.read`, LAB included, as the field report). Draft writes need
 * `concrete_report.draft` and follow C04's own-draft rule (CD-58): the person credited is the
 * acting person (LAB: the selected staff member) and must be the report's technician; the report
 * must still be a draft. Casting-time corrections on numbered sets need `concrete_specimen.reschedule`.
 *
 * Each write is one transaction in the D09 lock order: the report FOR UPDATE, then the set FOR
 * UPDATE, then the project and the actor's account FOR SHARE (`canUnderLock`), then the performing
 * person's account. Then the ledger, the version check, the write, the ledger row and the audit
 * event, all or nothing. Nothing here allocates or reserves a permanent number (C18), issues a
 * device code (C12) or writes the mix registry or settings.
 */
@Injectable()
export class ConcreteSpecimenSetsService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async defaults(reportId: string): Promise<ConcreteSpecimenSetDefaults> {
    const report = await findReport(this.database.pool, reportId);
    if (!report) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    return {
      fieldReportId: report.id,
      schedule: await resolveFor(this.database.pool, report),
      ...concreteSetShapeDefault(report.material),
    };
  }

  async list(reportId: string, user: AuthUser): Promise<ConcreteSpecimenSetList> {
    const report = await findReport(this.database.pool, reportId);
    if (!report) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    const { rows } = await this.database.pool.query<SetRow>(
      `${SELECT_SET} WHERE s.field_report_id = $1 ORDER BY s.created_at, s.id`,
      [report.id],
    );
    return {
      fieldReportId: report.id,
      items: await this.details(this.database.pool, report, rows, user),
    };
  }

  async get(setId: string, user: AuthUser): Promise<ConcreteSpecimenSetDetail> {
    const set = await findSet(this.database.pool, setId);
    if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
    const report = (await findReport(this.database.pool, set.field_report_id))!;
    return this.detail(this.database.pool, report, set, user);
  }

  // -------------------------------------------------------------------------------------------
  // Draft writes
  // -------------------------------------------------------------------------------------------

  async create(
    reportId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSpecimenSetDetail> {
    // Authority first: before the body, any lock or the transaction.
    if (!can(user, DRAFT)) throw forbidden();
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const report = await findReport(client, reportId, 'FOR UPDATE');
        if (!report) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
        ownDraftBeforeBody(user, report);
        const input = parseBody(createConcreteSpecimenSetRequestSchema, body);
        const hash = intentHash({ kind: 'create', reportId: report.id, ...withoutKey(input) });
        const replay = await this.replay(client, input.idempotencyKey, 'create', null, hash, user);
        if (replay) return replay;

        const person = await this.authorizeDraft(client, user, report, input.technicianUserId);
        if (report.specimens_cast === false) {
          throw new ConflictException({ code: 'specimens_not_cast' });
        }
        const setId = input.id ?? randomUUID();
        const { rows: taken } = await client.query(
          'SELECT 1 FROM concrete_specimen_set WHERE id = $1',
          [setId],
        );
        if (taken.length > 0) throw new ConflictException({ code: 'set_id_taken' });

        const schedule = await resolveFor(client, report);
        const shape = concreteSetShapeDefault(report.material);
        const specimenType = input.specimenType ?? shape.specimenType;
        const mouldSize =
          input.mouldSize !== undefined
            ? input.mouldSize
            : specimenType === shape.specimenType
              ? shape.mouldSize
              : null;
        const specimens = normalizeConcreteSpecimenRows(
          input.specimens ?? schedule.ages.map((age) => ({ id: randomUUID(), age })),
        );
        await assertSpecimenIdsFree(client, specimens, null);

        await client.query(
          `INSERT INTO concrete_specimen_set
             (id, project_id, field_report_id, specimen_type, mould_size, created_by_user_id,
              technician_user_id, default_ages, default_ages_source, default_ages_mix_revision_id,
              hold_duration_days, hold_duration_source)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            setId,
            report.project_id,
            report.id,
            specimenType,
            mouldSize,
            user.userId,
            person.userId,
            schedule.ages.map(fromAge),
            schedule.source,
            schedule.mixRevisionId,
            schedule.holdDurationDays,
            schedule.holdDurationSource,
          ],
        );
        await insertSpecimens(client, report.project_id, setId, specimens);
        await this.recordCommand(
          client,
          input.idempotencyKey,
          report.id,
          setId,
          'create',
          hash,
          user,
        );
        await recordAudit(client, {
          action: 'concrete_specimen_set.created',
          entityType: ENTITY_TYPE,
          entityId: setId,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
          before: null,
          after: {
            version: 1,
            projectId: report.project_id,
            fieldReportId: report.id,
            technicianUserId: person.userId,
            specimenType,
            mouldSize,
            defaultSchedule: schedule,
            specimens: auditSpecimens(specimens),
            specimenCount: specimens.length,
          },
          requestId,
        });
        return this.detail(client, report, (await findSet(client, setId))!, user);
      });
    } catch (error) {
      return this.retryRace(error, rawKey(body), 'create', reportId, user);
    }
  }

  async save(
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteSpecimenSetDetail> {
    if (!can(user, DRAFT)) throw forbidden();
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const { report, set } = await lockSet(client, setId);
        ownDraftBeforeBody(user, report);
        const input = parseBody(saveConcreteSpecimenSetRequestSchema, body);
        const hash = intentHash({ kind: 'save', setId: set.id, ...withoutKey(input) });
        const replay = await this.replay(client, input.idempotencyKey, 'save', set.id, hash, user);
        if (replay) return replay;

        const person = await this.authorizeDraft(client, user, report, input.technicianUserId);
        await this.checkVersion(client, report, set, input.version, user);

        const current = await specimensFor(client, [set.id]);
        const beforeSpecimens = current.map((s) => ({
          id: s.id,
          letter: s.letter,
          age: toAge(s.assigned_age ?? CONCRETE_HOLD_AGE),
        }));
        const changes: Record<string, { before: unknown; after: unknown }> = {};
        const specimenType = input.specimenType ?? set.specimen_type;
        if (specimenType !== set.specimen_type) {
          changes.specimenType = { before: set.specimen_type, after: specimenType };
        }
        const mouldSize = input.mouldSize !== undefined ? input.mouldSize : set.mould_size;
        if (mouldSize !== set.mould_size) {
          changes.mouldSize = { before: set.mould_size, after: mouldSize };
        }
        let next: ConcreteNormalizedSpecimen[] | null = null;
        if (input.specimens !== undefined) {
          next = normalizeConcreteSpecimenRows(input.specimens);
          if (JSON.stringify(next) !== JSON.stringify(beforeSpecimens)) {
            if (set.permanent_number !== null) {
              // Letters and ages are written on numbered specimens (CD-33): rescheduling is C22.
              throw new ConflictException({ code: 'set_numbered' });
            }
            await assertSpecimenIdsFree(client, next, set.id);
            changes.specimens = {
              before: auditSpecimens(beforeSpecimens),
              after: auditSpecimens(next),
            };
          } else {
            next = null;
          }
        }
        if (Object.keys(changes).length === 0) {
          await this.recordCommand(
            client,
            input.idempotencyKey,
            report.id,
            set.id,
            'save',
            hash,
            user,
          );
          return this.detail(client, report, set, user);
        }
        await client.query(
          `UPDATE concrete_specimen_set
           SET specimen_type = $2, mould_size = $3, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [set.id, specimenType, mouldSize],
        );
        if (next) {
          await assertNoReceivingRecords(client, set.id);
          // An unnumbered draft: the list is replaced whole (stable row ids keep their specimen).
          await client.query('DELETE FROM concrete_specimen WHERE set_id = $1', [set.id]);
          await insertSpecimens(client, set.project_id, set.id, next);
        }
        await this.recordCommand(
          client,
          input.idempotencyKey,
          report.id,
          set.id,
          'save',
          hash,
          user,
        );
        const before: Record<string, unknown> = { version: set.version };
        const after: Record<string, unknown> = { version: set.version + 1 };
        for (const [field, change] of Object.entries(changes)) {
          before[field] = change.before;
          after[field] = change.after;
        }
        if (next) {
          before.specimenCount = beforeSpecimens.length;
          after.specimenCount = next.length;
        }
        await recordAudit(client, {
          action: 'concrete_specimen_set.saved',
          entityType: ENTITY_TYPE,
          entityId: set.id,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
          before,
          after,
          requestId,
        });
        return this.detail(client, report, (await findSet(client, set.id))!, user);
      });
    } catch (error) {
      return this.retryRace(error, rawKey(body), 'save', null, user);
    }
  }

  async discard(
    setId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<{ id: string; discarded: true }> {
    if (!can(user, DRAFT)) throw forbidden();
    return withTransaction(this.database.pool, async (client) => {
      const input = parseBody(discardConcreteSpecimenSetRequestSchema, body);
      const hash = intentHash({ kind: 'discard', setId, ...withoutKey(input) });
      // A retried discard finds its ledger row, not the (deleted) set.
      const previous = await this.command(client, input.idempotencyKey);
      if (previous) {
        if (
          previous.kind !== 'discard' ||
          previous.request_hash !== hash ||
          previous.user_id !== user.userId ||
          previous.set_id !== setId
        ) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return { id: setId, discarded: true as const };
      }
      const { report, set } = await lockSet(client, setId);
      ownDraftBeforeBody(user, report);
      const person = await this.authorizeDraft(client, user, report, input.technicianUserId);
      await this.checkVersion(client, report, set, input.version, user);
      if (set.permanent_number !== null) {
        // A numbered set stays in the register (CD-08): Void is C18's.
        throw new ConflictException({ code: 'set_numbered' });
      }
      await assertNoReceivingRecords(client, set.id);
      const specimens = await specimensFor(client, [set.id]);
      await client.query('DELETE FROM concrete_specimen WHERE set_id = $1', [set.id]);
      await client.query('DELETE FROM concrete_specimen_set WHERE id = $1', [set.id]);
      await this.recordCommand(
        client,
        input.idempotencyKey,
        report.id,
        set.id,
        'discard',
        hash,
        user,
      );
      await recordAudit(client, {
        action: 'concrete_specimen_set.discarded',
        entityType: ENTITY_TYPE,
        entityId: set.id,
        actor,
        receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
        before: {
          version: set.version,
          fieldReportId: report.id,
          temporaryId: set.temporary_id,
          specimenCount: specimens.length,
          specimens: specimens.map((s) => ({ id: s.id, letter: s.letter, age: s.assigned_age })),
        },
        after: null,
        requestId,
      });
      return { id: set.id, discarded: true as const };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Casting-time correction (AC5)
  // -------------------------------------------------------------------------------------------

  async correctCasting(
    reportId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteCastingCorrectionResult> {
    // Authority first (before the body): the caller must hold the permission on this project.
    const found = await findReport(this.database.pool, reportId);
    if (!found) return notFoundOrForbidden(this.database.pool, user);
    const project = (await findProject(this.database.pool, found.project_id))!;
    if (!can(user, CORRECT, await correctionContext(this.database.pool, project))) {
      throw forbidden();
    }
    const input = parseBody(concreteCastingCorrectionRequestSchema, body);
    const castAt = new Date(input.castAt).toISOString();
    const hash = intentHash({
      kind: 'casting_correction',
      reportId: found.id,
      version: input.version,
      castAt,
      reason: input.reason,
    });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const report = (await findReport(client, found.id, 'FOR UPDATE'))!;
        if (input.confirm) {
          const replay = await this.correctionReplay(
            client,
            input.idempotencyKey,
            report,
            hash,
            user,
          );
          if (replay) return replay;
        }
        const context = await correctionContext(client, project);
        if (!(await canUnderLock(client, user, CORRECT, report.project_id, { context }))) {
          throw forbidden();
        }
        if (input.version !== report.version) {
          throw new ConflictException({ code: 'version_conflict', currentVersion: report.version });
        }
        if (report.workflow_state === 'void') throw new ConflictException({ code: 'report_void' });
        const sets = await client.query<{ id: string; permanent_id: string | null }>(
          `SELECT id, permanent_id FROM concrete_specimen_set
           WHERE field_report_id = $1 AND permanent_number IS NOT NULL ORDER BY permanent_number`,
          [report.id],
        );
        if (sets.rows.length === 0) {
          // No numbered set: the technician corrects casting on the draft itself (C04 save).
          throw new ConflictException({ code: 'no_numbered_set' });
        }
        const previousCastAt = report.cast_at?.toISOString() ?? null;
        if (previousCastAt === castAt) {
          unprocessable('no_change', [{ field: 'castAt', message: 'That is the recorded time' }]);
        }
        const effects = await castingEffects(client, report.id, castAt);
        const castingYear = Number(concreteCastingDate(castAt).slice(0, 4));
        const castingYearDiffers = sets.rows
          .filter(
            (s) => Number(s.permanent_id!.replace(/^G/, '').slice(0, 2)) !== castingYear % 100,
          )
          .map((s) => ({ setId: s.id, permanentId: s.permanent_id!, castingYear }));
        const result = (applied: boolean, version: number): ConcreteCastingCorrectionResult => ({
          fieldReportId: report.id,
          applied,
          previousCastAt,
          castAt,
          effects,
          castingYearDiffers,
          reportVersion: version,
        });
        if (!input.confirm) return result(false, report.version);

        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        await client.query(
          `INSERT INTO concrete_casting_correction
             (project_id, field_report_id, previous_cast_at, new_cast_at, reason, effects,
              corrected_by_user_id, corrected_by_initials_snapshot, corrected_by_name_snapshot,
              idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
          [
            report.project_id,
            report.id,
            previousCastAt,
            castAt,
            input.reason,
            JSON.stringify(effects),
            user.userId,
            by.initials,
            by.displayName,
            input.idempotencyKey,
            hash,
          ],
        );
        // The database recomputes every specimen's dates from the corrected time; issued IDs and
        // assigned ages never change.
        await client.query(
          `UPDATE concrete_field_report
           SET cast_at = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [report.id, castAt],
        );
        await recordAudit(client, {
          action: 'concrete_field_report.casting_corrected',
          entityType: 'concrete_field_report',
          entityId: report.id,
          actor,
          reason: input.reason,
          before: { version: report.version, castAt: previousCastAt },
          after: {
            version: report.version + 1,
            castAt,
            dependentDates: effects.length,
            castingYearDiffers: castingYearDiffers.map((s) => s.permanentId),
          },
          requestId,
        });
        return result(true, report.version + 1);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_casting_correction_idempotency_key_key')) {
        const replay = await withTransaction(this.database.pool, async (client) =>
          this.correctionReplay(
            client,
            input.idempotencyKey,
            (await findReport(client, found.id))!,
            hash,
            user,
          ),
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  /**
   * The final authority check under the D09 locks, the acting person and the own-draft rule:
   * the person credited (LAB: the selected staff member) is the report's technician, and the
   * report is still a draft.
   */
  private async authorizeDraft(
    client: PoolClient,
    user: AuthUser,
    report: ReportRow,
    technicianUserId: string | undefined,
  ): Promise<PersonSnapshot> {
    if (!(await canUnderLock(client, user, DRAFT, report.project_id))) throw forbidden();
    const person = await resolveActingPerson(client, user, technicianUserId, {
      field: 'technicianUserId',
      invalidCode: 'invalid_technician',
    });
    if (report.technician_user_id !== person.userId) throw forbidden('not_own_draft');
    // MM-V2-C09: a report returned for correction is edited like a draft.
    if (!['draft', 'returned'].includes(report.workflow_state)) {
      throw new ConflictException({ code: 'not_a_draft' });
    }
    return person;
  }

  private async checkVersion(
    client: PoolClient,
    report: ReportRow,
    set: SetRow,
    version: number,
    user: AuthUser,
  ) {
    if (version !== set.version) {
      throw new ConflictException({
        code: 'version_conflict',
        current: await this.detail(client, report, set, user),
      });
    }
  }

  private async command(client: PoolClient, key: string) {
    const { rows } = await client.query<{
      set_id: string;
      kind: Kind;
      request_hash: string;
      user_id: string;
    }>(
      `SELECT set_id, kind, request_hash, user_id FROM concrete_specimen_set_command
       WHERE idempotency_key = $1`,
      [key],
    );
    return rows[0] ?? null;
  }

  private async replay(
    client: PoolClient,
    key: string,
    kind: Kind,
    setId: string | null,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteSpecimenSetDetail | null> {
    const previous = await this.command(client, key);
    if (!previous) return null;
    if (
      previous.kind !== kind ||
      previous.request_hash !== hash ||
      previous.user_id !== user.userId ||
      (setId !== null && previous.set_id !== setId)
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    const set = await findSet(client, previous.set_id);
    if (!set) throw new ConflictException({ code: 'idempotency_key_reused' });
    return this.detail(client, (await findReport(client, set.field_report_id))!, set, user);
  }

  /** The same key raced itself: the other request committed first, so this is its retry. */
  private async retryRace(
    error: unknown,
    raw: { idempotencyKey?: unknown },
    kind: Kind,
    reportId: string | null,
    user: AuthUser,
  ): Promise<ConcreteSpecimenSetDetail> {
    const raced =
      isConstraint(error, 'concrete_specimen_set_command_pkey') ||
      isConstraint(error, 'concrete_specimen_set_pkey');
    if (raced && typeof raw.idempotencyKey === 'string') {
      const key = raw.idempotencyKey;
      const replay = await withTransaction(this.database.pool, async (client) => {
        const previous = await this.command(client, key);
        if (!previous || previous.kind !== kind || previous.user_id !== user.userId) return null;
        const set = await findSet(client, previous.set_id);
        if (!set || (reportId !== null && set.field_report_id !== reportId)) return null;
        return this.detail(client, (await findReport(client, set.field_report_id))!, set, user);
      });
      if (replay) return replay;
      if (isConstraint(error, 'concrete_specimen_set_pkey')) {
        throw new ConflictException({ code: 'set_id_taken' });
      }
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    if (isConstraint(error, 'concrete_specimen_pkey')) {
      throw new ConflictException({ code: 'specimen_id_taken' });
    }
    throw error;
  }

  private async recordCommand(
    client: PoolClient,
    key: string,
    reportId: string,
    setId: string,
    kind: Kind,
    hash: string,
    user: AuthUser,
  ) {
    await client.query(
      `INSERT INTO concrete_specimen_set_command
         (idempotency_key, field_report_id, set_id, kind, request_hash, user_id)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [key, reportId, setId, kind, hash, user.userId],
    );
  }

  private async correctionReplay(
    client: PoolClient,
    key: string,
    report: ReportRow,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteCastingCorrectionResult | null> {
    const { rows } = await client.query<{
      field_report_id: string;
      request_hash: string;
      corrected_by_user_id: string;
      previous_cast_at: Date | null;
      new_cast_at: Date;
      effects: ConcreteCastingEffect[];
    }>(
      `SELECT field_report_id, request_hash, corrected_by_user_id, previous_cast_at, new_cast_at,
              effects
       FROM concrete_casting_correction WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.field_report_id !== report.id ||
      previous.request_hash !== hash ||
      previous.corrected_by_user_id !== user.userId
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    const castAt = previous.new_cast_at.toISOString();
    const castingYear = Number(concreteCastingDate(castAt).slice(0, 4));
    const { rows: numbered } = await client.query<{ id: string; permanent_id: string }>(
      `SELECT id, permanent_id FROM concrete_specimen_set
       WHERE field_report_id = $1 AND permanent_number IS NOT NULL ORDER BY permanent_number`,
      [report.id],
    );
    return {
      fieldReportId: report.id,
      applied: true,
      previousCastAt: previous.previous_cast_at?.toISOString() ?? null,
      castAt,
      effects: previous.effects,
      castingYearDiffers: numbered
        .filter((s) => Number(s.permanent_id.replace(/^G/, '').slice(0, 2)) !== castingYear % 100)
        .map((s) => ({ setId: s.id, permanentId: s.permanent_id, castingYear })),
      reportVersion: report.version,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private async detail(
    db: Db,
    report: ReportRow,
    set: SetRow,
    user: AuthUser,
  ): Promise<ConcreteSpecimenSetDetail> {
    return (await this.details(db, report, [set], user))[0]!;
  }

  private async details(
    db: Db,
    report: ReportRow,
    sets: SetRow[],
    user: AuthUser,
  ): Promise<ConcreteSpecimenSetDetail[]> {
    const specimens = await specimensFor(
      db,
      sets.map((s) => s.id),
    );
    const people = await peopleFor(
      db,
      sets.flatMap((s) =>
        [s.created_by_user_id, s.technician_user_id].filter((id): id is string => id !== null),
      ),
    );
    const castAt = report.cast_at?.toISOString() ?? null;
    const editable =
      can(user, DRAFT) &&
      ['draft', 'returned'].includes(report.workflow_state) &&
      report.technician_user_id !== null &&
      (user.accountType === 'shared_lab' || report.technician_user_id === user.userId);
    return sets.map((set) => {
      const own = specimens.filter((s) => s.set_id === set.id);
      return {
        id: set.id,
        projectId: set.project_id,
        fieldReportId: set.field_report_id,
        identity: {
          temporaryId: set.temporary_id,
          permanentId: set.permanent_id,
          permanentNumber: set.permanent_number,
        },
        specimenType: set.specimen_type,
        mouldSize: set.mould_size,
        castAt,
        castingDate: castAt === null ? null : concreteCastingDate(castAt),
        defaultSchedule: set.default_ages
          ? {
              ages: set.default_ages.map(toAge),
              source: set.default_ages_source!,
              mixRevisionId: set.default_ages_mix_revision_id,
              holdDurationDays: set.hold_duration_days!,
              holdDurationSource: set.hold_duration_source!,
            }
          : null,
        specimenCount: own.length,
        specimens: own.map((s) => ({
          id: s.id,
          letter: s.letter,
          assignedAge: toAge(s.assigned_age ?? CONCRETE_HOLD_AGE),
          targetDate: s.target_date,
          holdExpiresOn: s.hold_expires_on,
          flags: concreteSpecimenFlags(s.target_date),
          identity: {
            temporaryId: set.temporary_id === null ? null : `${set.temporary_id}${s.letter}`,
            permanentId: set.permanent_id === null ? null : `${set.permanent_id}${s.letter}`,
          },
        })),
        createdBy: set.created_by_user_id ? (people.get(set.created_by_user_id) ?? null) : null,
        technician: set.technician_user_id ? (people.get(set.technician_user_id) ?? null) : null,
        void: set.voided_at
          ? {
              voidedAt: set.voided_at.toISOString(),
              voidedByUserId: set.voided_by_user_id!,
              reason: set.void_reason!,
            }
          : null,
        version: set.version,
        createdAt: set.created_at.toISOString(),
        updatedAt: set.updated_at.toISOString(),
        canEdit: editable && set.permanent_number === null && set.voided_at === null,
      };
    });
  }
}

// ---------------------------------------------------------------------------------------------

/** The raw body's idempotency key, for the race retry (the body may not have parsed). */
function rawKey(body: unknown): { idempotencyKey?: unknown } {
  return typeof body === 'object' && body !== null ? (body as { idempotencyKey?: unknown }) : {};
}

function withoutKey<T extends { idempotencyKey: string }>(value: T): Omit<T, 'idempotencyKey'> {
  const { idempotencyKey: _key, ...rest } = value;
  void _key;
  return rest;
}

/** A personal account is its own technician, so ownership is known before the body. */
function ownDraftBeforeBody(user: AuthUser, report: ReportRow) {
  if (user.accountType !== 'shared_lab' && report.technician_user_id !== user.userId) {
    throw forbidden('not_own_draft');
  }
}

function auditSpecimens(specimens: readonly ConcreteNormalizedSpecimen[]) {
  return specimens.map((s) => ({ id: s.id, letter: s.letter, age: s.age }));
}

async function findReport(
  db: Db,
  id: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<ReportRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ReportRow>(`${SELECT_REPORT} WHERE r.id = $1 ${lock}`, [id]);
  return rows[0] ?? null;
}

async function findSet(db: Db, id: string, lock: '' | 'FOR UPDATE' = ''): Promise<SetRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<SetRow>(`${SELECT_SET} WHERE s.id = $1 ${lock}`, [id]);
  return rows[0] ?? null;
}

/** D09: the report FOR UPDATE, then the set FOR UPDATE. */
async function lockSet(client: PoolClient, setId: string) {
  const found = await findSet(client, setId);
  if (!found) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
  const report = (await findReport(client, found.field_report_id, 'FOR UPDATE'))!;
  const set = await findSet(client, setId, 'FOR UPDATE');
  if (!set) throw new NotFoundException({ code: 'concrete_specimen_set_not_found' });
  return { report, set };
}

async function specimensFor(db: Db, setIds: string[]): Promise<SpecimenRow[]> {
  if (setIds.length === 0) return [];
  const { rows } = await db.query<SpecimenRow>(
    `SELECT id, set_id, letter, assigned_age, target_date::text, hold_expires_on::text
     FROM concrete_specimen WHERE set_id = ANY($1::uuid[]) ORDER BY set_id, letter`,
    [setIds],
  );
  return rows;
}

async function insertSpecimens(
  client: PoolClient,
  projectId: string,
  setId: string,
  specimens: readonly ConcreteNormalizedSpecimen[],
) {
  if (specimens.length === 0) return;
  await client.query(
    `INSERT INTO concrete_specimen (id, project_id, set_id, letter, assigned_age)
     SELECT id, $1, $2, letter, age
     FROM unnest($3::uuid[], $4::text[], $5::text[]) AS t(id, letter, age)`,
    [
      projectId,
      setId,
      specimens.map((s) => s.id),
      specimens.map((s) => s.letter),
      specimens.map((s) => fromAge(s.age)),
    ],
  );
}

/** A row id may only name a new specimen or one already in this set (never another set's). */
async function assertSpecimenIdsFree(
  client: PoolClient,
  specimens: readonly ConcreteNormalizedSpecimen[],
  setId: string | null,
) {
  if (specimens.length === 0) return;
  const { rows } = await client.query<{ id: string; set_id: string }>(
    'SELECT id, set_id FROM concrete_specimen WHERE id = ANY($1::uuid[])',
    [specimens.map((s) => s.id)],
  );
  const foreign = rows.find((row) => row.set_id !== setId);
  if (foreign) {
    unprocessable('specimen_id_taken', [
      {
        field: `specimens.${specimens.findIndex((s) => s.id === foreign.id)}.id`,
        message: 'This specimen ID belongs to another set',
      },
    ]);
  }
}

/** Mix snapshot on the report (C04), else the project's saved settings (C02), else the lab default. */
async function resolveFor(db: Db, report: ReportRow): Promise<ConcreteScheduleSnapshot> {
  const { rows } = await db.query<{ default_specimen_ages: string[]; hold_duration_days: number }>(
    `SELECT default_specimen_ages, hold_duration_days FROM concrete_project_settings
     WHERE project_id = $1`,
    [report.project_id],
  );
  const settings = rows[0];
  return resolveConcreteSchedule({
    projectSettings: settings
      ? {
          defaultSpecimenAges: settings.default_specimen_ages.map(toAge),
          holdDurationDays: settings.hold_duration_days,
        }
      : null,
    mixSnapshot: report.mix_snapshot ? concreteMixSnapshotSchema.parse(report.mix_snapshot) : null,
  });
}

/** Every specimen of the report whose stored date would move, with the database's date math. */
async function castingEffects(
  client: PoolClient,
  reportId: string,
  castAt: string,
): Promise<ConcreteCastingEffect[]> {
  const { rows } = await client.query<{
    set_id: string;
    specimen_id: string;
    letter: string;
    temporary_id: string | null;
    permanent_id: string | null;
    assigned_age: string;
    target_date: string | null;
    hold_expires_on: string | null;
    new_target_date: string | null;
    new_hold_expires_on: string | null;
  }>(
    `SELECT s.id AS set_id, sp.id AS specimen_id, sp.letter, s.temporary_id, s.permanent_id,
            sp.assigned_age, sp.target_date::text, sp.hold_expires_on::text,
            CASE WHEN sp.assigned_age = 'HOLD' THEN NULL
                 ELSE (concrete_casting_date($2::timestamptz) + sp.assigned_age::integer)::text
            END AS new_target_date,
            CASE WHEN sp.assigned_age = 'HOLD'
                 THEN (concrete_casting_date($2::timestamptz) + s.hold_duration_days)::text
            END AS new_hold_expires_on
     FROM concrete_specimen sp
     JOIN concrete_specimen_set s ON s.id = sp.set_id
     WHERE s.field_report_id = $1 AND sp.assigned_age IS NOT NULL
     ORDER BY s.created_at, s.id, sp.letter`,
    [reportId, castAt],
  );
  return rows
    .filter(
      (r) => r.target_date !== r.new_target_date || r.hold_expires_on !== r.new_hold_expires_on,
    )
    .map((r) => ({
      setId: r.set_id,
      specimenId: r.specimen_id,
      letter: r.letter,
      temporaryId: r.temporary_id === null ? null : `${r.temporary_id}${r.letter}`,
      permanentId: r.permanent_id === null ? null : `${r.permanent_id}${r.letter}`,
      assignedAge: toAge(r.assigned_age),
      before: { targetDate: r.target_date, holdExpiresOn: r.hold_expires_on },
      after: { targetDate: r.new_target_date, holdExpiresOn: r.new_hold_expires_on },
    }));
}

/** The facts `concrete_specimen.reschedule` needs: lead, field reviewers, concrete-grant LMs. */
async function correctionContext(
  db: Db,
  project: NonNullable<Awaited<ReturnType<typeof findProject>>>,
): Promise<ProjectContext> {
  return concreteRescheduleContext(db, project);
}

/**
 * An unknown report: 404 only to someone who could hold the correction permission on some
 * project (a lead, a reviewer or a concrete-grant Lab Manager); everyone else gets 403.
 */
async function notFoundOrForbidden(db: Db, user: AuthUser): Promise<never> {
  if (user.accountType === 'personal' || user.accountType === 'test') {
    const { rows } = await db.query(
      `SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1
       UNION ALL SELECT 1 FROM project_reviewer_assignment WHERE reviewer_user_id = $1
       UNION ALL SELECT 1 FROM project_concrete_lab_manager_grant
                 WHERE lab_manager_user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [user.userId],
    );
    if (rows.length > 0 && user.status === 'active') {
      throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    }
  }
  throw forbidden();
}

async function peopleFor(db: Db, ids: string[]): Promise<Map<string, PersonSnapshot>> {
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
    rows.map((row) => [
      row.id,
      { userId: row.id, initials: row.official_initials, name: row.display_name },
    ]),
  );
}

/**
 * What the field report's review needs from its sets (C04 handoff): the derived specimen count
 * and the mould size of each set, for many reports at once.
 */
export async function specimenSetSummaries(
  db: Db,
  reportIds: string[],
): Promise<Map<string, { id: string; specimenCount: number; mouldSize: string | null }[]>> {
  const out = new Map<string, { id: string; specimenCount: number; mouldSize: string | null }[]>();
  if (reportIds.length === 0) return out;
  const { rows } = await db.query<{
    id: string;
    field_report_id: string;
    mould_size: string | null;
    specimen_count: number;
  }>(
    `SELECT s.id, s.field_report_id, s.mould_size,
            (SELECT count(*)::int FROM concrete_specimen sp WHERE sp.set_id = s.id) AS specimen_count
     FROM concrete_specimen_set s
     WHERE s.field_report_id = ANY($1::uuid[]) AND s.voided_at IS NULL
     ORDER BY s.created_at, s.id`,
    [reportIds],
  );
  for (const id of reportIds) out.set(id, []);
  for (const row of rows) {
    out.get(row.field_report_id)!.push({
      id: row.id,
      specimenCount: row.specimen_count,
      mouldSize: row.mould_size,
    });
  }
  return out;
}

/**
 * MM-V2-C06: once the lab has recorded a pickup, receipt, marker confirmation, exception or Pick
 * up window for a set's specimens, a draft edit no longer replaces or discards them (409
 * `set_has_receiving`); a later change goes through the lab records and their history.
 */
async function assertNoReceivingRecords(client: PoolClient, setId: string): Promise<void> {
  const { rows } = await client.query(
    `SELECT 1 FROM concrete_specimen sp
     WHERE sp.set_id = $1 AND (
       EXISTS (SELECT 1 FROM concrete_specimen_pickup x WHERE x.specimen_id = sp.id)
       OR EXISTS (SELECT 1 FROM concrete_specimen_receipt x WHERE x.specimen_id = sp.id)
       OR EXISTS (SELECT 1 FROM concrete_receiving_exception x
                  WHERE x.specimen_id = sp.id OR x.matched_specimen_id = sp.id))
     UNION ALL SELECT 1 FROM concrete_receiving_exception WHERE set_id = $1
     UNION ALL SELECT 1 FROM concrete_set_pickup_window WHERE set_id = $1
     LIMIT 1`,
    [setId],
  );
  if (rows.length > 0) throw new ConflictException({ code: 'set_has_receiving' });
}
