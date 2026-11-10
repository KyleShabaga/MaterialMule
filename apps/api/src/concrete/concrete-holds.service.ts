import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_HOLD_PAGE_SIZE,
  concreteDisposalReadyQuerySchema,
  concreteHoldAuthorizeDisposalRequestSchema,
  concreteHoldListQuerySchema,
  concreteHoldScheduleTestRequestSchema,
  concreteHoldStatusOf,
  concreteLabToday,
  concreteRecordDisposalRequestSchema,
  concreteRescheduledTarget,
  type ConcreteDisposalReady,
  type ConcreteHoldActionResult,
  type ConcreteHoldEvent,
  type ConcreteHoldHistory,
  type ConcreteHoldKind,
  type ConcreteHoldList,
  type ConcreteHoldProblemCode,
  type ConcreteHoldRow,
  type ConcreteHoldStatusFilter,
  type ConcreteSpecimenAge,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type Permission, type ProjectContext } from '../auth/policy.js';
import { asLocked, canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf, resolveActingPerson } from '../lab/attribution.js';
import {
  concreteLabManagers,
  findProject,
  intentHash,
  projectContext,
} from '../project-access/project-access.service.js';
import { parseBody, validationError } from '../validation/parse-body.js';

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ORDINARY: Permission = 'concrete_ordinary_hold.manage';
const FAILED: Permission = 'concrete_hold.manage';
const RECORD: Permission = 'concrete_specimen.dispose_record';
type CommandKind = 'schedule_test' | 'authorize_disposal' | 'record_disposal';

const forbidden = (extra: Record<string, unknown> = {}) =>
  new ForbiddenException({ code: 'forbidden', ...extra });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

const toAge = (value: string): ConcreteSpecimenAge =>
  value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);

/**
 * Every specimen the HOLD table can show: on an ordinary HOLD (assigned HOLD) or a failed-specimen
 * hold (C25), in a set and report that aren't Void. A HOLD specimen that was scheduled for a test
 * is no longer HOLD and leaves the table (its history stays).
 */
const HELD_FROM = `
  FROM concrete_specimen sp
  JOIN concrete_specimen_set st ON st.id = sp.set_id
  JOIN concrete_field_report r ON r.id = st.field_report_id
  JOIN project p ON p.id = sp.project_id
  LEFT JOIN concrete_specimen_failure_hold fh ON fh.specimen_id = sp.id
  LEFT JOIN concrete_specimen_disposal d ON d.specimen_id = sp.id
  WHERE st.voided_at IS NULL AND r.workflow_state <> 'void'
    AND (sp.assigned_age = 'HOLD' OR fh.id IS NOT NULL OR d.id IS NOT NULL)`;

const STATUS_PREDICATE: Record<ConcreteHoldStatusFilter, string> = {
  open: 'd.id IS NULL',
  disposal_authorized: 'd.id IS NOT NULL AND d.disposed_at IS NULL',
  disposed: 'd.disposed_at IS NOT NULL',
  all: 'TRUE',
};

const HOLD_KIND_SQL = `COALESCE(d.hold_kind,
  CASE WHEN fh.id IS NOT NULL THEN 'failed' ELSE 'ordinary' END)`;

const ROW_COLUMNS = `sp.id AS specimen_id, sp.set_id, st.field_report_id, sp.project_id,
  p.project_number, p.name AS project_name, sp.letter, st.temporary_id, st.permanent_id,
  st.permanent_number, sp.assigned_age, concrete_casting_date(r.cast_at)::text AS casting_date,
  sp.hold_expires_on::text, sp.version, r.workflow_state, ${HOLD_KIND_SQL} AS hold_kind,
  fh.reason AS failure_reason, d.id AS disposal_id, d.authorization_reason,
  d.authorized_at, d.authorized_by_user_id, d.authorized_by_initials_snapshot,
  d.authorized_by_name_snapshot, d.disposed_at, d.disposed_by_user_id,
  d.disposed_by_initials_snapshot, d.disposed_by_name_snapshot, d.disposal_recorded_at`;

interface HeldSql {
  specimen_id: string;
  set_id: string;
  field_report_id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  letter: string;
  temporary_id: string | null;
  permanent_id: string | null;
  permanent_number: number | null;
  assigned_age: string;
  casting_date: string | null;
  hold_expires_on: string | null;
  version: number;
  workflow_state: string;
  hold_kind: ConcreteHoldKind;
  failure_reason: string | null;
  disposal_id: string | null;
  authorization_reason: string | null;
  authorized_at: Date | null;
  authorized_by_user_id: string | null;
  authorized_by_initials_snapshot: string | null;
  authorized_by_name_snapshot: string | null;
  disposed_at: Date | null;
  disposed_by_user_id: string | null;
  disposed_by_initials_snapshot: string | null;
  disposed_by_name_snapshot: string | null;
  disposal_recorded_at: Date | null;
}

/** Facts for a command, read under the specimen lock. */
interface SpecimenFacts extends HeldSql {
  set_voided: boolean;
  report_void: boolean;
  has_failure_hold: boolean;
}

/** What the caller may do on one project (memoized per request). */
interface Authority {
  ordinary: boolean;
  failed: boolean;
}

function identityOf(row: {
  temporary_id: string | null;
  permanent_id: string | null;
  letter: string;
}) {
  return {
    temporaryId: row.temporary_id === null ? null : row.temporary_id + row.letter,
    permanentId: row.permanent_id === null ? null : row.permanent_id + row.letter,
  };
}

function person(
  userId: string | null,
  initials: string | null,
  name: string | null,
): PersonSnapshot | null {
  return userId === null ? null : { userId, initials, name: name ?? '' };
}

/**
 * HOLD management, bulk HOLD actions and concrete specimen disposal (MM-V2-C26).
 *
 * Reads follow the concrete reads before it (`inventory.read`, LAB included). Commands:
 * - Schedule test (ordinary HOLD → an age in days) and Authorize disposal of an ordinary HOLD:
 *   `concrete_ordinary_hold.manage` (the lead, or any Lab Manager by role alone).
 * - Authorize disposal of a failed-specimen hold: `concrete_hold.manage` (the lead, or a Lab
 *   Manager holding the project's concrete grant).
 * - Record disposal (actual removal): `concrete_specimen.dispose_record` (lab staff; LAB names
 *   the performing person, who is attribution only).
 * Each command takes up to 200 specimens and is all-or-nothing: it checks every specimen's
 * permission and eligibility under the D09 locks (reports, then sets, then specimens, each in id
 * order) and writes one history row and one audit event per specimen. Nothing runs on a date.
 */
@Injectable()
export class ConcreteHoldsService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(query: unknown, user: AuthUser): Promise<ConcreteHoldList> {
    const input = parseBody(concreteHoldListQuerySchema, query);
    const db = this.database.pool;
    const today = input.on ?? concreteLabToday();
    const filters: string[] = [];
    const params: unknown[] = [];
    if (input.kind !== 'all') {
      params.push(input.kind);
      filters.push(`${HOLD_KIND_SQL} = $${params.length}`);
    }
    if (input.projectId) {
      params.push(input.projectId);
      filters.push(`sp.project_id = $${params.length}`);
    }
    const scoped = filters.length === 0 ? '' : ` AND ${filters.join(' AND ')}`;

    const { rows: countRows } = await db.query<Record<string, number>>(
      `SELECT ${Object.entries(STATUS_PREDICATE)
        .map(([status, predicate]) => `count(*) FILTER (WHERE ${predicate})::int AS ${status}`)
        .join(', ')}
       ${HELD_FROM}${scoped}`,
      params,
    );
    const counts = countRows[0] as ConcreteHoldList['counts'];

    const { rows } = await db.query<HeldSql>(
      `SELECT ${ROW_COLUMNS}
       ${HELD_FROM}${scoped} AND ${STATUS_PREDICATE[input.status]}
       ORDER BY p.project_number, p.id, sp.hold_expires_on NULLS LAST,
                st.permanent_number NULLS LAST, st.temporary_id NULLS LAST, st.created_at, st.id,
                sp.letter
       LIMIT ${CONCRETE_HOLD_PAGE_SIZE} OFFSET ${(input.page - 1) * CONCRETE_HOLD_PAGE_SIZE}`,
      params,
    );
    const { rows: projects } = await db.query<{ id: string; project_number: string; name: string }>(
      `SELECT DISTINCT p.id, p.project_number, p.name ${HELD_FROM}
       ORDER BY p.project_number, p.id LIMIT 500`,
    );
    const authority = new Map<string, Authority>();
    const out: ConcreteHoldRow[] = [];
    for (const row of rows) out.push(await this.toRow(db, row, today, user, authority));
    return {
      today,
      kind: input.kind,
      status: input.status,
      counts,
      total: counts[input.status],
      page: input.page,
      pageSize: CONCRETE_HOLD_PAGE_SIZE,
      rows: out,
      projects: projects.map((p) => ({ id: p.id, projectNumber: p.project_number, name: p.name })),
    };
  }

  async history(specimenId: string): Promise<ConcreteHoldHistory> {
    const db = this.database.pool;
    if (!UUID_PATTERN.test(specimenId)) {
      throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    }
    const { rows } = await db.query<{
      id: string;
      letter: string;
      temporary_id: string | null;
      permanent_id: string | null;
    }>(
      `SELECT sp.id, sp.letter, st.temporary_id, st.permanent_id
       FROM concrete_specimen sp JOIN concrete_specimen_set st ON st.id = sp.set_id
       WHERE sp.id = $1`,
      [specimenId],
    );
    const specimen = rows[0];
    if (!specimen) throw new NotFoundException({ code: 'concrete_specimen_not_found' });

    const events: ConcreteHoldEvent[] = [];
    const blank = {
      recordedBy: null,
      reason: null,
      newAge: null,
      newTargetDate: null,
      previousHoldExpiresOn: null,
      disposedAt: null,
      commandId: null,
    };
    const { rows: holds } = await db.query<{
      created_at: Date;
      reason: string;
      placed_by_user_id: string;
      placed_by_name_snapshot: string;
    }>(
      `SELECT created_at, reason, placed_by_user_id, placed_by_name_snapshot
       FROM concrete_specimen_failure_hold WHERE specimen_id = $1`,
      [specimenId],
    );
    for (const h of holds) {
      events.push({
        ...blank,
        kind: 'failure_hold',
        at: h.created_at.toISOString(),
        by: { userId: h.placed_by_user_id, initials: null, name: h.placed_by_name_snapshot },
        reason: h.reason,
      });
    }
    const { rows: schedules } = await db.query<{
      created_at: Date;
      reason: string;
      new_age: string;
      new_target_date: string;
      previous_hold_expires_on: string;
      scheduled_by_user_id: string;
      scheduled_by_initials_snapshot: string | null;
      scheduled_by_name_snapshot: string;
      command_id: string;
    }>(
      `SELECT created_at, reason, new_age, new_target_date::text, previous_hold_expires_on::text,
              scheduled_by_user_id, scheduled_by_initials_snapshot, scheduled_by_name_snapshot,
              command_id
       FROM concrete_specimen_hold_schedule WHERE specimen_id = $1 ORDER BY created_at, id`,
      [specimenId],
    );
    for (const s of schedules) {
      events.push({
        ...blank,
        kind: 'test_scheduled',
        at: s.created_at.toISOString(),
        by: {
          userId: s.scheduled_by_user_id,
          initials: s.scheduled_by_initials_snapshot,
          name: s.scheduled_by_name_snapshot,
        },
        reason: s.reason,
        newAge: Number(s.new_age),
        newTargetDate: s.new_target_date,
        previousHoldExpiresOn: s.previous_hold_expires_on,
        commandId: s.command_id,
      });
    }
    const { rows: disposals } = await db.query<{
      authorization_reason: string;
      authorized_at: Date;
      authorized_by_user_id: string;
      authorized_by_initials_snapshot: string | null;
      authorized_by_name_snapshot: string;
      authorization_command_id: string;
      disposed_at: Date | null;
      disposed_by_user_id: string | null;
      disposed_by_initials_snapshot: string | null;
      disposed_by_name_snapshot: string | null;
      disposal_recorded_at: Date | null;
      disposal_command_id: string | null;
      recorder_id: string | null;
      recorder_initials: string | null;
      recorder_name: string | null;
    }>(
      `SELECT d.authorization_reason, d.authorized_at, d.authorized_by_user_id,
              d.authorized_by_initials_snapshot, d.authorized_by_name_snapshot,
              d.authorization_command_id, d.disposed_at, d.disposed_by_user_id,
              d.disposed_by_initials_snapshot, d.disposed_by_name_snapshot, d.disposal_recorded_at,
              d.disposal_command_id, u.id AS recorder_id, u.official_initials AS recorder_initials,
              u.display_name AS recorder_name
       FROM concrete_specimen_disposal d
       LEFT JOIN app_user u ON u.id = d.disposal_recorded_by_user_id
       WHERE d.specimen_id = $1`,
      [specimenId],
    );
    for (const d of disposals) {
      events.push({
        ...blank,
        kind: 'disposal_authorized',
        at: d.authorized_at.toISOString(),
        by: {
          userId: d.authorized_by_user_id,
          initials: d.authorized_by_initials_snapshot,
          name: d.authorized_by_name_snapshot,
        },
        reason: d.authorization_reason,
        commandId: d.authorization_command_id,
      });
      if (d.disposed_at && d.disposal_recorded_at) {
        events.push({
          ...blank,
          kind: 'disposed',
          at: d.disposal_recorded_at.toISOString(),
          by: person(
            d.disposed_by_user_id,
            d.disposed_by_initials_snapshot,
            d.disposed_by_name_snapshot,
          )!,
          recordedBy:
            d.recorder_id && d.recorder_id !== d.disposed_by_user_id
              ? {
                  userId: d.recorder_id,
                  initials: d.recorder_initials,
                  name: d.recorder_name ?? '',
                }
              : null,
          disposedAt: d.disposed_at.toISOString(),
          commandId: d.disposal_command_id,
        });
      }
    }
    events.sort((x, y) => x.at.localeCompare(y.at));
    return { specimenId: specimen.id, identity: identityOf(specimen), events };
  }

  /** Concrete specimens authorized for disposal and not yet removed (MISC-13 list filter). */
  async ready(query: unknown, user: AuthUser): Promise<ConcreteDisposalReady> {
    const input = parseBody(concreteDisposalReadyQuerySchema, query);
    const { rows } = await this.database.pool.query<HeldSql & { total: number }>(
      `SELECT ${ROW_COLUMNS}, count(*) OVER ()::int AS total
       FROM concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       JOIN project p ON p.id = sp.project_id
       JOIN concrete_specimen_disposal d ON d.specimen_id = sp.id AND d.disposed_at IS NULL
       LEFT JOIN concrete_specimen_failure_hold fh ON fh.specimen_id = sp.id
       ORDER BY d.authorized_at, p.project_number, st.permanent_number NULLS LAST, sp.letter, sp.id
       LIMIT ${CONCRETE_HOLD_PAGE_SIZE} OFFSET ${(input.page - 1) * CONCRETE_HOLD_PAGE_SIZE}`,
    );
    let total = rows[0]?.total ?? 0;
    if (rows.length === 0 && input.page > 1) {
      const { rows: n } = await this.database.pool.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM concrete_specimen_disposal WHERE disposed_at IS NULL`,
      );
      total = n[0]!.n;
    }
    return {
      total,
      page: input.page,
      pageSize: CONCRETE_HOLD_PAGE_SIZE,
      canRecord: can(user, RECORD),
      requiresPerformer: user.accountType === 'shared_lab',
      specimens: rows.map((row) => ({
        specimenId: row.specimen_id,
        identity: identityOf(row),
        project: { id: row.project_id, projectNumber: row.project_number, name: row.project_name },
        holdKind: row.hold_kind,
        castingDate: row.casting_date,
        reason: row.authorization_reason!,
        authorizedAt: row.authorized_at!.toISOString(),
        authorizedBy: person(
          row.authorized_by_user_id,
          row.authorized_by_initials_snapshot,
          row.authorized_by_name_snapshot,
        )!,
      })),
    };
  }

  // -------------------------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------------------------

  /** Before the body: someone who could release an ordinary or failed hold anywhere. */
  async assertMayManage(user: AuthUser): Promise<void> {
    if (user.status !== 'active' || user.accountType === 'shared_lab') throw forbidden();
    if (user.roles.includes('lab_manager')) return;
    const { rows } = await this.database.pool.query(
      'SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1 LIMIT 1',
      [user.userId],
    );
    if (rows.length === 0) throw forbidden();
  }

  async scheduleTest(
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteHoldActionResult> {
    await this.assertMayManage(user);
    const input = parseBody(concreteHoldScheduleTestRequestSchema, body);
    const hash = intentHash({
      kind: 'schedule_test',
      items: input.items,
      newAge: input.newAge,
      reason: input.reason,
    });
    return this.command(
      'schedule_test',
      input.idempotencyKey,
      hash,
      input.items,
      user,
      async (client, facts, authority) => {
        const problems: Problem[] = [];
        const refused: string[] = [];
        for (const item of input.items) {
          const s = facts.get(item.specimenId);
          if (!s) {
            problems.push({ specimenId: item.specimenId, code: 'not_found' });
            continue;
          }
          if (s.has_failure_hold || s.hold_kind === 'failed') {
            problems.push({ specimenId: s.specimen_id, code: 'failed_hold' });
            continue;
          }
          if (!(await authority(s.project_id)).ordinary) {
            refused.push(s.specimen_id);
            continue;
          }
          const code = commonProblem(s, item.version);
          if (code) problems.push({ specimenId: s.specimen_id, code });
          else if (s.casting_date === null || s.hold_expires_on === null) {
            problems.push({ specimenId: s.specimen_id, code: 'no_casting_time' });
          } else if (s.permanent_number === null) {
            // Owner decision (C38): an unnumbered set's ages change on its draft report only.
            problems.push({ specimenId: s.specimen_id, code: 'unnumbered_set' });
          }
        }
        settle(refused, problems);

        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        return async (commandId) => {
          for (const item of input.items) {
            const s = facts.get(item.specimenId)!;
            const newTarget = concreteRescheduledTarget(s.casting_date!, input.newAge);
            await client.query(
              `INSERT INTO concrete_specimen_hold_schedule
               (project_id, specimen_id, command_id, previous_hold_expires_on, new_age,
                new_target_date, reason, scheduled_by_user_id, scheduled_by_initials_snapshot,
                scheduled_by_name_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
              [
                s.project_id,
                s.specimen_id,
                commandId,
                s.hold_expires_on,
                String(input.newAge),
                newTarget,
                input.reason,
                user.userId,
                by.initials,
                by.displayName,
              ],
            );
            // The database recomputes the target from the casting date (C05 trigger).
            await client.query(
              `UPDATE concrete_specimen SET assigned_age = $2, version = version + 1, updated_at = now()
             WHERE id = $1`,
              [s.specimen_id, String(input.newAge)],
            );
            await recordAudit(client, {
              action: 'concrete_specimen.hold_test_scheduled',
              entityType: 'concrete_specimen',
              entityId: s.specimen_id,
              actor,
              reason: input.reason,
              before: { version: s.version, assignedAge: 'HOLD', holdExpiresOn: s.hold_expires_on },
              after: {
                version: s.version + 1,
                assignedAge: input.newAge,
                targetDate: newTarget,
                commandId,
              },
              requestId,
            });
          }
        };
      },
    );
  }

  async authorizeDisposal(
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteHoldActionResult> {
    await this.assertMayManage(user);
    const input = parseBody(concreteHoldAuthorizeDisposalRequestSchema, body);
    const hash = intentHash({
      kind: 'authorize_disposal',
      items: input.items,
      reason: input.reason,
    });
    return this.command(
      'authorize_disposal',
      input.idempotencyKey,
      hash,
      input.items,
      user,
      async (client, facts, authority) => {
        const problems: Problem[] = [];
        const refused: string[] = [];
        for (const item of input.items) {
          const s = facts.get(item.specimenId);
          if (!s) {
            problems.push({ specimenId: item.specimenId, code: 'not_found' });
            continue;
          }
          const failed = s.has_failure_hold;
          const may = await authority(s.project_id);
          if (!(failed ? may.failed : may.ordinary)) {
            refused.push(s.specimen_id);
            continue;
          }
          const code = commonProblem(s, item.version);
          if (code) problems.push({ specimenId: s.specimen_id, code });
        }
        settle(refused, problems);

        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        return async (commandId) => {
          for (const item of input.items) {
            const s = facts.get(item.specimenId)!;
            const kind: ConcreteHoldKind = s.has_failure_hold ? 'failed' : 'ordinary';
            await client.query(
              `INSERT INTO concrete_specimen_disposal
               (project_id, specimen_id, hold_kind, authorization_command_id, authorization_reason,
                authorized_by_user_id, authorized_by_initials_snapshot, authorized_by_name_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
              [
                s.project_id,
                s.specimen_id,
                kind,
                commandId,
                input.reason,
                user.userId,
                by.initials,
                by.displayName,
              ],
            );
            await recordAudit(client, {
              action: 'concrete_specimen.disposal_authorized',
              entityType: 'concrete_specimen',
              entityId: s.specimen_id,
              actor,
              reason: input.reason,
              before: { holdKind: kind, status: 'held' },
              after: { holdKind: kind, status: 'disposal_authorized', commandId },
              requestId,
            });
          }
        };
      },
    );
  }

  async recordDisposal(
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteHoldActionResult> {
    const input = parseBody(concreteRecordDisposalRequestSchema, body);
    const disposedAt = new Date(input.disposedAt);
    if (disposedAt.getTime() > Date.now() + 5 * 60_000) {
      throw validationError([
        { field: 'disposedAt', code: 'in_future', message: 'Removal can’t be in the future' },
      ]);
    }
    const hash = intentHash({
      kind: 'record_disposal',
      specimenIds: input.specimenIds,
      disposedAt: disposedAt.toISOString(),
      performedByUserId: input.performedByUserId ?? null,
    });
    const items = input.specimenIds.map((specimenId) => ({ specimenId, version: null }));
    return this.command(
      'record_disposal',
      input.idempotencyKey,
      hash,
      items,
      user,
      async (client, facts) => {
        // Recheck under lock: lab staff now (a role removed since sign-in counts).
        if (!can(asLocked(user, await lockStanding(client, [user.userId])), RECORD)) {
          throw forbidden();
        }
        const performer = await resolveActingPerson(client, user, input.performedByUserId, {
          field: 'performedByUserId',
          invalidCode: 'invalid_performer',
        });
        const problems: Problem[] = [];
        for (const id of input.specimenIds) {
          const s = facts.get(id);
          if (!s) problems.push({ specimenId: id, code: 'not_found' });
          else if (s.disposed_at) problems.push({ specimenId: id, code: 'disposed' });
          else if (!s.disposal_id)
            problems.push({ specimenId: id, code: 'not_authorized_for_disposal' });
          else if (disposedAt < truncMinute(s.authorized_at!)) {
            problems.push({ specimenId: id, code: 'before_authorization' });
          }
        }
        settle([], problems);
        return async (commandId) => {
          for (const id of input.specimenIds) {
            const s = facts.get(id)!;
            await client.query(
              `UPDATE concrete_specimen_disposal
             SET disposal_command_id = $2, disposed_at = $3, disposed_by_user_id = $4,
                 disposed_by_initials_snapshot = $5, disposed_by_name_snapshot = $6,
                 disposal_recorded_by_user_id = $7, disposal_recorded_at = now()
             WHERE specimen_id = $1`,
              [
                id,
                commandId,
                disposedAt,
                performer.userId,
                performer.initials,
                performer.name,
                user.userId,
              ],
            );
            await recordAudit(client, {
              action: 'concrete_specimen.disposed',
              entityType: 'concrete_specimen',
              entityId: id,
              actor,
              receiver: receiverOf(performer),
              before: { status: 'disposal_authorized', holdKind: s.hold_kind },
              after: { status: 'disposed', disposedAt: disposedAt.toISOString(), commandId },
              requestId,
            });
          }
        };
      },
    );
  }

  // -------------------------------------------------------------------------------------------
  // Plumbing
  // -------------------------------------------------------------------------------------------

  /**
   * One all-or-nothing command: replay by idempotency key, lock the specimens (D09), let `check`
   * refuse (403/409) or return the writer, record the command, write, and return the rows.
   */
  private async command(
    kind: CommandKind,
    key: string,
    hash: string,
    items: { specimenId: string; version: number | null }[],
    user: AuthUser,
    check: (
      client: PoolClient,
      facts: Map<string, SpecimenFacts>,
      authority: (projectId: string) => Promise<Authority>,
    ) => Promise<(commandId: string) => Promise<void>>,
  ): Promise<ConcreteHoldActionResult> {
    const ids = items.map((i) => i.specimenId);
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const replay = await this.replay(client, key, kind, hash, user);
        if (replay) return replay;
        const facts = await lockSpecimens(client, ids);
        // An identical command that held these locks first has committed by now: replay it rather
        // than refuse the specimens it just changed (review fix, PR #145).
        const replayed = await this.replay(client, key, kind, hash, user);
        if (replayed) return replayed;
        const cache = new Map<string, Promise<Authority>>();
        const authority = (projectId: string) => {
          let found = cache.get(projectId);
          if (!found) {
            found = lockedAuthority(client, user, projectId);
            cache.set(projectId, found);
          }
          return found;
        };
        const write = await check(client, facts, authority);
        const { rows } = await client.query<{ id: string }>(
          `INSERT INTO concrete_hold_command
             (idempotency_key, kind, request_hash, account_user_id, specimen_ids)
           VALUES ($1, $2, $3, $4, $5::uuid[]) RETURNING id`,
          [key, kind, hash, user.userId, ids],
        );
        const commandId = rows[0]!.id;
        await write(commandId);
        return { commandId, rows: await this.rowsOf(client, ids, user) };
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_hold_command_idempotency_key_key')) {
        const replay = await withTransaction(this.database.pool, (client) =>
          this.replay(client, key, kind, hash, user),
        );
        if (replay) return replay;
      }
      throw error;
    }
  }

  /** An exact retry returns the specimens as they stand; the same key for anything else is 409. */
  private async replay(
    client: PoolClient,
    key: string,
    kind: CommandKind,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteHoldActionResult | null> {
    const { rows } = await client.query<{
      id: string;
      kind: string;
      request_hash: string;
      account_user_id: string;
      specimen_ids: string[];
    }>(
      `SELECT id, kind, request_hash, account_user_id, specimen_ids
       FROM concrete_hold_command WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.kind !== kind ||
      previous.request_hash !== hash ||
      previous.account_user_id !== user.userId
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return { commandId: previous.id, rows: await this.rowsOf(client, previous.specimen_ids, user) };
  }

  /** The HOLD rows of `ids` as they stand (in the order given; scheduled ones read as such). */
  private async rowsOf(db: Db, ids: string[], user: AuthUser): Promise<ConcreteHoldRow[]> {
    const { rows } = await db.query<HeldSql>(
      `SELECT ${ROW_COLUMNS}
       FROM concrete_specimen sp
       JOIN concrete_specimen_set st ON st.id = sp.set_id
       JOIN concrete_field_report r ON r.id = st.field_report_id
       JOIN project p ON p.id = sp.project_id
       LEFT JOIN concrete_specimen_failure_hold fh ON fh.specimen_id = sp.id
       LEFT JOIN concrete_specimen_disposal d ON d.specimen_id = sp.id
       WHERE sp.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(rows.map((row) => [row.specimen_id, row]));
    const authority = new Map<string, Authority>();
    const today = concreteLabToday();
    const out: ConcreteHoldRow[] = [];
    for (const id of ids) {
      const row = byId.get(id);
      if (row) out.push(await this.toRow(db, row, today, user, authority));
    }
    return out;
  }

  private async toRow(
    db: Db,
    row: HeldSql,
    today: string,
    user: AuthUser,
    cache: Map<string, Authority>,
  ): Promise<ConcreteHoldRow> {
    let may = cache.get(row.project_id);
    if (!may) {
      may = await readAuthority(db, user, row.project_id);
      cache.set(row.project_id, may);
    }
    const assignedAge = toAge(row.assigned_age);
    const disposalAuthorized = row.disposal_id !== null;
    const disposed = row.disposed_at !== null;
    const live = row.workflow_state !== 'void';
    const ordinary = row.hold_kind === 'ordinary';
    const open = live && !disposalAuthorized;
    return {
      specimenId: row.specimen_id,
      setId: row.set_id,
      fieldReportId: row.field_report_id,
      project: { id: row.project_id, projectNumber: row.project_number, name: row.project_name },
      letter: row.letter,
      identity: identityOf(row),
      holdKind: row.hold_kind,
      assignedAge,
      castingDate: row.casting_date,
      holdExpiresOn: row.hold_expires_on,
      status: concreteHoldStatusOf({
        holdKind: row.hold_kind,
        holdExpiresOn: row.hold_expires_on,
        today,
        disposalAuthorized,
        disposed,
      }),
      failureReason: row.failure_reason,
      disposal: disposalAuthorized
        ? {
            reason: row.authorization_reason!,
            authorizedAt: row.authorized_at!.toISOString(),
            authorizedBy: person(
              row.authorized_by_user_id,
              row.authorized_by_initials_snapshot,
              row.authorized_by_name_snapshot,
            )!,
            disposedAt: row.disposed_at?.toISOString() ?? null,
            disposedBy: person(
              row.disposed_by_user_id,
              row.disposed_by_initials_snapshot,
              row.disposed_by_name_snapshot,
            ),
            recordedAt: row.disposal_recorded_at?.toISOString() ?? null,
          }
        : null,
      actions: {
        scheduleTest:
          open &&
          ordinary &&
          assignedAge === CONCRETE_HOLD_AGE &&
          may.ordinary &&
          row.permanent_number !== null &&
          row.hold_expires_on !== null,
        authorizeDisposal: open && (ordinary ? may.ordinary : may.failed),
        recordDisposal: disposalAuthorized && !disposed && can(user, RECORD),
      },
      version: row.version,
    };
  }
}

interface Problem {
  specimenId: string;
  code: ConcreteHoldProblemCode;
}

/** 403 when the caller may not act on some specimen; else 409 when some aren't eligible. */
function settle(refused: string[], problems: Problem[]): void {
  if (refused.length > 0) throw forbidden({ specimens: refused });
  if (problems.length > 0) throw new ConflictException({ code: 'not_eligible', problems });
}

/** Problems Schedule test and Authorize disposal share. */
function commonProblem(s: SpecimenFacts, version: number | null): ConcreteHoldProblemCode | null {
  if (s.report_void) return 'report_void';
  if (s.set_voided) return 'set_void';
  if (s.disposed_at) return 'disposed';
  if (s.disposal_id) return 'disposal_authorized';
  if (!s.has_failure_hold && s.assigned_age !== CONCRETE_HOLD_AGE) return 'not_on_hold';
  if (version !== null && version !== s.version) return 'version_conflict';
  return null;
}

function truncMinute(date: Date): Date {
  return new Date(Math.floor(date.getTime() / 60_000) * 60_000);
}

/** The caller's authority on one project, read without locks (list actions). */
async function readAuthority(db: Db, user: AuthUser, projectId: string): Promise<Authority> {
  if (user.status !== 'active' || user.accountType === 'shared_lab') {
    return { ordinary: false, failed: false };
  }
  const project = await findProject(db, projectId);
  if (!project) return { ordinary: false, failed: false };
  const context = await projectContext(db, project, undefined, undefined, {
    concreteLabManagers: true,
  });
  return { ordinary: can(user, ORDINARY, context), failed: can(user, FAILED, context) };
}

/** The same, under the project lead and account locks (commands). */
async function lockedAuthority(
  client: PoolClient,
  user: AuthUser,
  projectId: string,
): Promise<Authority> {
  if (user.status !== 'active' || user.accountType === 'shared_lab') {
    return { ordinary: false, failed: false };
  }
  const context: Omit<ProjectContext, 'leadProjectEngineerUserId'> = {
    concreteLabManagerUserIds: await concreteLabManagers(client, projectId),
  };
  return {
    ordinary: await canUnderLock(client, user, ORDINARY, projectId),
    failed: await canUnderLock(client, user, FAILED, projectId, { context }),
  };
}

/** D09: reports, then sets, then specimens, each FOR UPDATE in id order. */
async function lockSpecimens(
  client: PoolClient,
  ids: string[],
): Promise<Map<string, SpecimenFacts>> {
  const valid = ids.filter((id) => UUID_PATTERN.test(id));
  const { rows: parents } = await client.query<{ set_id: string; field_report_id: string }>(
    `SELECT sp.set_id, st.field_report_id
     FROM concrete_specimen sp JOIN concrete_specimen_set st ON st.id = sp.set_id
     WHERE sp.id = ANY($1::uuid[])`,
    [valid],
  );
  const reports = [...new Set(parents.map((p) => p.field_report_id))].sort();
  const sets = [...new Set(parents.map((p) => p.set_id))].sort();
  await client.query(
    'SELECT 1 FROM concrete_field_report WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [reports],
  );
  await client.query(
    'SELECT 1 FROM concrete_specimen_set WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [sets],
  );
  await client.query(
    'SELECT 1 FROM concrete_specimen WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
    [valid],
  );
  const { rows } = await client.query<SpecimenFacts>(
    `SELECT ${ROW_COLUMNS}, st.voided_at IS NOT NULL AS set_voided,
            r.workflow_state = 'void' AS report_void, fh.id IS NOT NULL AS has_failure_hold
     FROM concrete_specimen sp
     JOIN concrete_specimen_set st ON st.id = sp.set_id
     JOIN concrete_field_report r ON r.id = st.field_report_id
     JOIN project p ON p.id = sp.project_id
     LEFT JOIN concrete_specimen_failure_hold fh ON fh.specimen_id = sp.id
     LEFT JOIN concrete_specimen_disposal d ON d.specimen_id = sp.id
     WHERE sp.id = ANY($1::uuid[])`,
    [valid],
  );
  return new Map(rows.map((row) => [row.specimen_id, row]));
}
