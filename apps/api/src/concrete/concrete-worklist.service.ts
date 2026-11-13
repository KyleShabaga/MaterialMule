import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_UPCOMING_DAYS,
  CONCRETE_WORKLIST_PAGE_SIZE,
  CONCRETE_WORKLIST_VIEWS,
  concreteAddDays,
  concreteDaysBetween,
  concreteLabToday,
  concreteRescheduleRequestSchema,
  concreteRescheduledTarget,
  concreteWorklistFlags,
  concreteWorklistQuerySchema,
  type ConcreteHolidayDates,
  type ConcreteRescheduleEntry,
  type ConcreteRescheduleResult,
  type ConcreteScheduleHistory,
  type ConcreteSpecimenAge,
  type ConcreteWorklist,
  type ConcreteWorklistException,
  type ConcreteWorklistGroup,
  type ConcreteWorklistRow,
  type ConcreteWorklistView,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import {
  concreteRescheduleContext,
  findProject,
  intentHash,
  projectContext,
} from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { testingMachineSnapshot } from './concrete-equipment.service.js';
import { loadHolidayDates } from './concrete-reference-data.service.js';
import { entryCompleteSql } from './concrete-testing-table.service.js';

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RESCHEDULE = 'concrete_specimen.reschedule' as const;
const ORDINARY_HOLD = 'concrete_ordinary_hold.manage' as const;

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

const toAge = (value: string): ConcreteSpecimenAge =>
  value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);

/**
 * Every specimen the worklist can show: a set that isn't Void, on a report that isn't Void, with a
 * known casting time and an assigned age. Untested: no concrete result exists yet (C07/C23), so
 * C23 adds its "not yet tested" condition here. A specimen authorized for disposal (C26) is
 * leaving the lab and is on no worklist view.
 */
const SCHEDULED = `
  FROM (SELECT $1::date AS today, $2::date AS upcoming_through, $3::uuid AS project_id) q
  CROSS JOIN concrete_specimen sp
  JOIN concrete_specimen_set st ON st.id = sp.set_id
  JOIN concrete_field_report r ON r.id = st.field_report_id
  JOIN project p ON p.id = sp.project_id
  WHERE st.voided_at IS NULL AND r.workflow_state <> 'void' AND r.cast_at IS NOT NULL
    AND sp.assigned_age IS NOT NULL
    AND (q.project_id IS NULL OR sp.project_id = q.project_id)
    AND NOT EXISTS (SELECT 1 FROM concrete_specimen_disposal d WHERE d.specimen_id = sp.id)`;

/**
 * MM-V2-C23: the specimen has a complete test entry (the testing table's rule). Entry
 * completeness only: strength and pass/fail wait on C24.
 */
const TESTED = `EXISTS (SELECT 1 FROM concrete_test_result tc WHERE tc.specimen_id = sp.id
  AND ${entryCompleteSql('tc')})`;

/**
 * The date views (q.today, q.upcoming_through), the same rule as the shared
 * `concreteWorklistViewOf`. Reading a specimen as overdue never changes its target (AC2).
 */
const VIEW_PREDICATE: Record<Exclude<ConcreteWorklistView, 'exceptions'>, string> = {
  today: `sp.assigned_age <> 'HOLD' AND sp.target_date = q.today`,
  // Overdue = untested past its target (MM-V2-C23 adds the tested condition).
  overdue: `sp.assigned_age <> 'HOLD' AND sp.target_date < q.today AND NOT ${TESTED}`,
  upcoming: `sp.assigned_age <> 'HOLD' AND sp.target_date > q.today
             AND sp.target_date <= q.upcoming_through`,
  hold: `sp.assigned_age = 'HOLD' AND sp.hold_expires_on IS NOT NULL`,
};

/**
 * HOLDs due for review (MM-V2-C31): the hold-until date has come (the `hold_review_due` flag's
 * rule). Nothing is released or disposed of automatically.
 */
const HOLD_REVIEW_DUE = `${VIEW_PREDICATE.hold} AND sp.hold_expires_on <= q.today`;

const VIEW_ORDER: Record<Exclude<ConcreteWorklistView, 'exceptions'>, string> = {
  today: 'sp.target_date',
  overdue: 'sp.target_date',
  upcoming: 'sp.target_date',
  hold: 'sp.hold_expires_on',
};

interface WorklistRowSql {
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
  casting_date: string;
  target_date: string | null;
  hold_expires_on: string | null;
  workflow_state: string;
  reschedules: number;
  version: number;
}

interface SpecimenFacts {
  id: string;
  project_id: string;
  set_id: string;
  field_report_id: string;
  letter: string;
  assigned_age: string;
  target_date: string | null;
  hold_expires_on: string | null;
  casting_date: string | null;
  temporary_id: string | null;
  permanent_id: string | null;
  permanent_number: number | null;
  set_voided: boolean;
  workflow_state: string;
  version: number;
}

const SELECT_SPECIMEN = `SELECT sp.id, sp.project_id, sp.set_id, st.field_report_id, sp.letter,
         sp.assigned_age, sp.target_date::text, sp.hold_expires_on::text,
         concrete_casting_date(r.cast_at)::text AS casting_date, st.temporary_id, st.permanent_id,
         st.permanent_number, st.voided_at IS NOT NULL AS set_voided, r.workflow_state, sp.version
  FROM concrete_specimen sp
  JOIN concrete_specimen_set st ON st.id = sp.set_id
  JOIN concrete_field_report r ON r.id = st.field_report_id`;

/**
 * The daily concrete lab worklist and authorized rescheduling (MM-V2-C22).
 *
 * Reads follow the existing internal read (`inventory.read`, LAB included), as every concrete
 * read before it; the owner keeps the worklist on it after "lab staff" (C36) exists. The
 * worklist stores nothing and schedules nothing: it reads C05's stored target dates and HOLD
 * expiries.
 *
 * Rescheduling needs `concrete_specimen.reschedule` on the specimen's project (the lead, a
 * designated `concrete_field` reviewer or a concrete-grant Lab Manager; personal accounts only),
 * checked before the body and again under the D09 locks: the report FOR UPDATE, the set FOR
 * UPDATE, the specimen FOR UPDATE, then the project and the actor's account FOR SHARE.
 */
@Injectable()
export class ConcreteWorklistService {
  constructor(private readonly database: DatabaseService) {}

  async worklist(query: unknown, user: AuthUser): Promise<ConcreteWorklist> {
    const input = parseBody(concreteWorklistQuerySchema, query);
    const db = this.database.pool;
    const today = input.on ?? concreteLabToday();
    const upcomingThrough = concreteAddDays(today, CONCRETE_UPCOMING_DAYS);
    const projectId = input.projectId ?? null;
    const params = [today, upcomingThrough, projectId];

    const exceptions = await this.exceptions(db, today);
    const { rows: countRows } = await db.query<Record<string, number>>(
      `SELECT ${Object.entries(VIEW_PREDICATE)
        .map(([view, predicate]) => `count(*) FILTER (WHERE ${predicate})::int AS ${view}`)
        .join(', ')}, count(*) FILTER (WHERE ${HOLD_REVIEW_DUE})::int AS hold_review_due
       ${SCHEDULED}`,
      params,
    );
    const counts = Object.fromEntries(
      CONCRETE_WORKLIST_VIEWS.map((view) => [
        view,
        view === 'exceptions' ? exceptions.items.length : (countRows[0]?.[view] ?? 0),
      ]),
    ) as ConcreteWorklist['counts'];

    const { rows: projects } = await db.query<{
      id: string;
      project_number: string;
      name: string;
    }>(
      `SELECT DISTINCT p.id, p.project_number, p.name
       ${SCHEDULED}
       ORDER BY p.project_number, p.id LIMIT 500`,
      [today, upcomingThrough, null],
    );

    const base = {
      view: input.view,
      today,
      upcomingThrough,
      counts,
      holdReviewDue: countRows[0]?.hold_review_due ?? 0,
      holdDue: input.view === 'hold' && input.holdDue,
      page: input.page,
      pageSize: CONCRETE_WORKLIST_PAGE_SIZE,
      projects: projects.map((p) => ({ id: p.id, projectNumber: p.project_number, name: p.name })),
      testingMachineRegistered: exceptions.registered,
    };
    if (input.view === 'exceptions') {
      return { ...base, total: exceptions.items.length, groups: [], exceptions: exceptions.items };
    }

    const predicate =
      input.view === 'hold' && input.holdDue ? HOLD_REVIEW_DUE : VIEW_PREDICATE[input.view];
    const { rows } = await db.query<WorklistRowSql>(
      `SELECT sp.id AS specimen_id, sp.set_id, st.field_report_id, sp.project_id,
              p.project_number, p.name AS project_name, sp.letter, st.temporary_id,
              st.permanent_id, st.permanent_number, sp.assigned_age,
              concrete_casting_date(r.cast_at)::text AS casting_date, sp.target_date::text,
              sp.hold_expires_on::text, r.workflow_state, sp.version,
              (SELECT count(*)::int FROM concrete_specimen_reschedule x
               WHERE x.specimen_id = sp.id) AS reschedules
       ${SCHEDULED} AND ${predicate}
       ORDER BY p.project_number, p.id, ${VIEW_ORDER[input.view]}, st.permanent_number NULLS LAST,
                st.temporary_id NULLS LAST, st.created_at, st.id, sp.letter
       LIMIT ${CONCRETE_WORKLIST_PAGE_SIZE} OFFSET ${(input.page - 1) * CONCRETE_WORKLIST_PAGE_SIZE}`,
      params,
    );
    const { rows: groupCounts } = await db.query<{ project_id: string; count: number }>(
      `SELECT sp.project_id, count(*)::int AS count ${SCHEDULED} AND ${predicate}
       GROUP BY sp.project_id`,
      params,
    );
    const countOf = new Map(groupCounts.map((g) => [g.project_id, g.count]));
    // MM-V2-C37: targets on a company holiday are flagged like weekends (never moved).
    const holidays = await loadHolidayDates(db);
    const groups: ConcreteWorklistGroup[] = [];
    const byProject = new Map<string, ConcreteWorklistGroup>();
    for (const row of rows) {
      let group = byProject.get(row.project_id);
      if (!group) {
        group = {
          projectId: row.project_id,
          projectNumber: row.project_number,
          projectName: row.project_name,
          count: countOf.get(row.project_id) ?? 0,
          canReschedule: await this.canReschedule(db, row.project_id, user),
          canHoldUntil: await this.canHoldUntil(db, row.project_id, user),
          rows: [],
        };
        byProject.set(row.project_id, group);
        groups.push(group);
      }
      group.rows.push(toRow(row, today, holidays));
    }
    return {
      ...base,
      total: [...countOf.values()].reduce((sum, n) => sum + n, 0),
      groups,
      exceptions: [],
    };
  }

  async history(specimenId: string): Promise<ConcreteScheduleHistory> {
    const specimen = await findSpecimen(this.database.pool, specimenId);
    if (!specimen) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
    return historyOf(this.database.pool, specimen);
  }

  async reschedule(
    specimenId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteRescheduleResult> {
    // Authority first (before the body or any lock): the caller must hold the permission on the
    // specimen's project.
    const found = await findSpecimen(this.database.pool, specimenId);
    if (!found) return notFoundOrForbidden(this.database.pool, user);
    if (!(await this.canReschedule(this.database.pool, found.project_id, user))) throw forbidden();
    const input = parseBody(concreteRescheduleRequestSchema, body);
    const hash = intentHash({
      kind: 'reschedule',
      specimenId: found.id,
      version: input.version,
      newAge: input.newAge,
      reason: input.reason,
    });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        // D09: the report, then the set, then the specimen.
        await client.query('SELECT 1 FROM concrete_field_report WHERE id = $1 FOR UPDATE', [
          found.field_report_id,
        ]);
        await client.query('SELECT 1 FROM concrete_specimen_set WHERE id = $1 FOR UPDATE', [
          found.set_id,
        ]);
        const specimen = (await findSpecimen(client, found.id, 'FOR UPDATE OF sp'))!;
        const replay = await this.replay(client, input.idempotencyKey, specimen, hash, user);
        if (replay) return replay;
        const project = (await findProject(client, specimen.project_id))!;
        const context = await concreteRescheduleContext(client, project);
        if (!(await canUnderLock(client, user, RESCHEDULE, specimen.project_id, { context }))) {
          throw forbidden();
        }
        if (input.version !== specimen.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await historyOf(client, specimen),
          });
        }
        if (specimen.workflow_state === 'void')
          throw new ConflictException({ code: 'report_void' });
        if (specimen.set_voided) throw new ConflictException({ code: 'set_void' });
        // HOLD release and HOLD changes are C26's (concrete_ordinary_hold.manage).
        if (specimen.assigned_age === CONCRETE_HOLD_AGE) {
          throw new ConflictException({ code: 'hold_specimen' });
        }
        // A specimen authorized for disposal keeps its age (C26; the database refuses it too).
        const { rowCount: disposing } = await client.query(
          'SELECT 1 FROM concrete_specimen_disposal WHERE specimen_id = $1',
          [specimen.id],
        );
        if (disposing) throw new ConflictException({ code: 'disposal_authorized' });
        // MM-V2-C23: a specimen with a complete test entry has been broken; its age stays.
        const { rowCount: tested } = await client.query(
          `SELECT 1 FROM concrete_specimen sp WHERE sp.id = $1 AND ${TESTED}`,
          [specimen.id],
        );
        if (tested) throw new ConflictException({ code: 'tested_specimen' });
        if (specimen.target_date === null || specimen.casting_date === null) {
          throw new ConflictException({ code: 'no_casting_time' });
        }
        // An unnumbered set on a draft report: its technician changes the ages on the draft (C05).
        if (specimen.permanent_number === null && specimen.workflow_state === 'draft') {
          throw new ConflictException({ code: 'edit_on_draft' });
        }
        // MM-V2-C38 (owner decision 2026-11-09): past draft, a set is rescheduled only once it has
        // its permanent number. Number it first.
        if (specimen.permanent_number === null) {
          throw new ConflictException({
            code: 'set_not_numbered',
            message: 'Number this set first: an unnumbered set can’t be rescheduled.',
          });
        }
        if (String(input.newAge) === specimen.assigned_age) {
          throw new UnprocessableEntityException({
            code: 'no_change',
            errors: [{ field: 'newAge', code: 'no_change', message: 'That is the assigned age' }],
          });
        }
        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        const newTarget = concreteRescheduledTarget(specimen.casting_date, input.newAge);
        await client.query(
          `INSERT INTO concrete_specimen_reschedule
             (project_id, specimen_id, previous_age, new_age, previous_target_date,
              new_target_date, reason, rescheduled_by_user_id, rescheduled_by_initials_snapshot,
              rescheduled_by_name_snapshot, idempotency_key, request_hash)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
          [
            specimen.project_id,
            specimen.id,
            specimen.assigned_age,
            String(input.newAge),
            specimen.target_date,
            newTarget,
            input.reason,
            user.userId,
            by.initials,
            by.displayName,
            input.idempotencyKey,
            hash,
          ],
        );
        // The database recomputes the target from the casting date (C05 trigger).
        await client.query(
          `UPDATE concrete_specimen
           SET assigned_age = $2, version = version + 1, updated_at = now() WHERE id = $1`,
          [specimen.id, String(input.newAge)],
        );
        await recordAudit(client, {
          action: 'concrete_specimen.rescheduled',
          entityType: 'concrete_specimen',
          entityId: specimen.id,
          actor,
          reason: input.reason,
          before: {
            version: specimen.version,
            assignedAge: Number(specimen.assigned_age),
            targetDate: specimen.target_date,
          },
          after: {
            version: specimen.version + 1,
            assignedAge: input.newAge,
            targetDate: newTarget,
          },
          requestId,
        });
        return this.result(client, specimen.id);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_specimen_reschedule_idempotency_key_key')) {
        const replay = await withTransaction(this.database.pool, async (client) =>
          this.replay(
            client,
            input.idempotencyKey,
            (await findSpecimen(client, found.id))!,
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

  private async canReschedule(db: Db, projectId: string, user: AuthUser): Promise<boolean> {
    // Personal accounts only: skip the queries for LAB and inactive sessions.
    if (user.status !== 'active' || user.accountType === 'shared_lab') return false;
    const project = await findProject(db, projectId);
    if (!project) return false;
    return can(user, RESCHEDULE, await concreteRescheduleContext(db, project));
  }

  /** STRATA-121: Hold until is ordinary HOLD authority (the lead or any Lab Manager). */
  private async canHoldUntil(db: Db, projectId: string, user: AuthUser): Promise<boolean> {
    if (user.status !== 'active' || user.accountType === 'shared_lab') return false;
    const project = await findProject(db, projectId);
    if (!project) return false;
    return can(user, ORDINARY_HOLD, await projectContext(db, project));
  }

  /** An exact retry returns the specimen as it stands; the same key for anything else is 409. */
  private async replay(
    client: PoolClient,
    key: string,
    specimen: SpecimenFacts,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteRescheduleResult | null> {
    const { rows } = await client.query<{
      specimen_id: string;
      request_hash: string;
      rescheduled_by_user_id: string;
    }>(
      `SELECT specimen_id, request_hash, rescheduled_by_user_id
       FROM concrete_specimen_reschedule WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.specimen_id !== specimen.id ||
      previous.request_hash !== hash ||
      previous.rescheduled_by_user_id !== user.userId
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return this.result(client, specimen.id);
  }

  private async result(db: Db, specimenId: string): Promise<ConcreteRescheduleResult> {
    const specimen = (await findSpecimen(db, specimenId))!;
    const history = await historyOf(db, specimen);
    return {
      ...history,
      flags: concreteWorklistFlags({
        assignedAge: history.assignedAge,
        targetDate: history.targetDate,
        holdExpiresOn: history.holdExpiresOn,
        today: concreteLabToday(),
        rescheduleCount: history.history.length,
        reportState: specimen.workflow_state,
        holidays: await loadHolidayDates(db),
      }),
    };
  }

  /** Exceptions sources wired so far: the testing machine's C27 flags for today. */
  private async exceptions(
    db: Db,
    today: string,
  ): Promise<{ registered: boolean; items: ConcreteWorklistException[] }> {
    const machine = await testingMachineSnapshot(db, today);
    if (!machine) return { registered: false, items: [] };
    const items: ConcreteWorklistException[] =
      machine.use.flags.length === 0
        ? []
        : [
            {
              kind: 'testing_machine',
              equipmentId: machine.equipmentId,
              label: [machine.make, machine.model].filter(Boolean).join(' ') || 'Testing machine',
              nextDueOn: machine.nextDueOn,
              flags: machine.use.flags as ConcreteWorklistException['flags'],
            },
          ];
    return { registered: true, items };
  }
}

function toRow(
  row: WorklistRowSql,
  today: string,
  holidays: ConcreteHolidayDates,
): ConcreteWorklistRow {
  const assignedAge = toAge(row.assigned_age);
  const daysLate = row.target_date === null ? null : concreteDaysBetween(row.target_date, today);
  return {
    specimenId: row.specimen_id,
    setId: row.set_id,
    fieldReportId: row.field_report_id,
    projectId: row.project_id,
    letter: row.letter,
    identity: {
      temporaryId: row.temporary_id === null ? null : row.temporary_id + row.letter,
      permanentId: row.permanent_id === null ? null : row.permanent_id + row.letter,
    },
    assignedAge,
    castingDate: row.casting_date,
    targetDate: row.target_date,
    holdExpiresOn: row.hold_expires_on,
    daysOverdue: daysLate !== null && daysLate > 0 ? daysLate : null,
    holdKind: assignedAge === CONCRETE_HOLD_AGE ? 'ordinary' : null,
    reportState: row.workflow_state,
    flags: concreteWorklistFlags({
      assignedAge,
      targetDate: row.target_date,
      holdExpiresOn: row.hold_expires_on,
      today,
      rescheduleCount: row.reschedules,
      reportState: row.workflow_state,
      holidays,
    }),
    rescheduleCount: row.reschedules,
    reschedulable: assignedAge !== CONCRETE_HOLD_AGE && row.permanent_number !== null,
    version: row.version,
  };
}

async function findSpecimen(
  db: Db,
  id: string,
  lock: '' | 'FOR UPDATE OF sp' = '',
): Promise<SpecimenFacts | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<SpecimenFacts>(`${SELECT_SPECIMEN} WHERE sp.id = $1 ${lock}`, [
    id,
  ]);
  return rows[0] ?? null;
}

async function historyOf(db: Db, specimen: SpecimenFacts): Promise<ConcreteScheduleHistory> {
  const { rows } = await db.query<{
    id: string;
    previous_age: string;
    new_age: string;
    previous_target_date: string;
    new_target_date: string;
    reason: string;
    rescheduled_by_user_id: string;
    rescheduled_by_initials_snapshot: string | null;
    rescheduled_by_name_snapshot: string;
    created_at: Date;
  }>(
    `SELECT id, previous_age, new_age, previous_target_date::text, new_target_date::text, reason,
            rescheduled_by_user_id, rescheduled_by_initials_snapshot, rescheduled_by_name_snapshot,
            created_at
     FROM concrete_specimen_reschedule WHERE specimen_id = $1 ORDER BY created_at, id`,
    [specimen.id],
  );
  const history: ConcreteRescheduleEntry[] = rows.map((row) => ({
    id: row.id,
    previousAge: Number(row.previous_age),
    newAge: Number(row.new_age),
    previousTargetDate: row.previous_target_date,
    newTargetDate: row.new_target_date,
    reason: row.reason,
    by: {
      userId: row.rescheduled_by_user_id,
      initials: row.rescheduled_by_initials_snapshot,
      name: row.rescheduled_by_name_snapshot,
    },
    at: row.created_at.toISOString(),
  }));
  return {
    specimenId: specimen.id,
    identity: {
      temporaryId: specimen.temporary_id === null ? null : specimen.temporary_id + specimen.letter,
      permanentId: specimen.permanent_id === null ? null : specimen.permanent_id + specimen.letter,
    },
    assignedAge: toAge(specimen.assigned_age),
    castingDate: specimen.casting_date,
    targetDate: specimen.target_date,
    holdExpiresOn: specimen.hold_expires_on,
    version: specimen.version,
    history,
  };
}

/**
 * An unknown specimen: 404 only to someone who could hold the reschedule permission on some
 * project (a lead, a reviewer or a concrete-grant Lab Manager); everyone else gets 403.
 */
async function notFoundOrForbidden(db: Db, user: AuthUser): Promise<never> {
  if (
    (user.accountType === 'personal' || user.accountType === 'test') &&
    user.status === 'active'
  ) {
    const { rows } = await db.query(
      `SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1
       UNION ALL SELECT 1 FROM project_reviewer_assignment WHERE reviewer_user_id = $1
       UNION ALL SELECT 1 FROM project_concrete_lab_manager_grant
                 WHERE lab_manager_user_id = $1 AND revoked_at IS NULL
       LIMIT 1`,
      [user.userId],
    );
    if (rows.length > 0) throw new NotFoundException({ code: 'concrete_specimen_not_found' });
  }
  throw forbidden();
}
