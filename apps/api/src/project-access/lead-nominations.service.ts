import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  confirmNominationRequestSchema,
  decideNominationRequestSchema,
  nominateLeadRequestSchema,
  type LeadNomination,
  type ProjectLeadNominations,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import {
  decideNomination,
  insertNomination,
  nominationHash,
  openLeadAppointment,
  resolveLeadAppointment,
  type PendingNomination,
} from '../projects/lead-appointment.js';
import { rerouteOpenItems } from '../notifications/rerouting.js';
import { parseBody } from '../validation/parse-body.js';
import { flagInheritedGrants } from './grant-reviews.service.js';
import { findProject, forbidden, unprocessable } from './project-access.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Decided nominations returned with the list (newest first). */
const NOMINATION_HISTORY_LIMIT = 50;

type Db = Pool | PoolClient;

interface NominationRow {
  id: string;
  nominee_user_id: string;
  nominee_initials_snapshot: string | null;
  nominee_name_snapshot: string;
  nominated_by_user_id: string;
  nominated_by_initials_snapshot: string | null;
  nominated_by_name_snapshot: string;
  nominated_at: Date;
  nomination_note: string | null;
  status: LeadNomination['status'];
  decided_by_user_id: string | null;
  decided_by_initials_snapshot: string | null;
  decided_by_name_snapshot: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

function toNomination(row: NominationRow): LeadNomination {
  return {
    id: row.id,
    nominee: {
      userId: row.nominee_user_id,
      initials: row.nominee_initials_snapshot,
      name: row.nominee_name_snapshot,
    },
    nominatedBy: {
      userId: row.nominated_by_user_id,
      initials: row.nominated_by_initials_snapshot,
      name: row.nominated_by_name_snapshot,
    },
    nominatedAt: row.nominated_at.toISOString(),
    note: row.nomination_note,
    status: row.status,
    decidedBy: row.decided_by_user_id
      ? {
          userId: row.decided_by_user_id,
          initials: row.decided_by_initials_snapshot,
          name: row.decided_by_name_snapshot ?? '',
        }
      : null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    decisionReason: row.decision_reason,
  };
}

/** The project's pending nomination and its newest decided ones. */
export async function loadNominations(
  db: Db,
  projectId: string,
): Promise<{ pending: LeadNomination | null; history: LeadNomination[] }> {
  const { rows } = await db.query<NominationRow>(
    `(SELECT * FROM project_lead_nomination WHERE project_id = $1 AND status = 'pending')
     UNION ALL
     (SELECT * FROM project_lead_nomination WHERE project_id = $1 AND status <> 'pending'
      ORDER BY decided_at DESC, id LIMIT ${NOMINATION_HISTORY_LIMIT})`,
    [projectId],
  );
  const all = rows.map(toNomination);
  return {
    pending: all.find((n) => n.status === 'pending') ?? null,
    history: all.filter((n) => n.status !== 'pending'),
  };
}

type Decision = 'confirmed' | 'rejected' | 'withdrawn';

/**
 * Lead Project Engineer nominations (MM-AO04; D01, D02, with Kyle's 2026-10-29 answers). Any
 * active personal staff member may nominate on a project with no lead and no pending nomination
 * (the creator may also nominate while creating, in ProjectsService). An admin confirms, which
 * makes the nominee the one effective lead, or rejects; the nominator may withdraw. A pending
 * nomination grants nothing. Every decision needs a reason (D15) and is audited.
 *
 * Lock order (D09): the project (FOR UPDATE), then the accounts (FOR SHARE), then the nomination
 * (FOR UPDATE). A confirmation and a direct appointment, removal or second decision therefore
 * serialise on the project: the first to commit wins and the other sees its result.
 */
@Injectable()
export class LeadNominationsService {
  constructor(private readonly database: DatabaseService) {}

  async list(projectId: string, user: AuthUser): Promise<ProjectLeadNominations> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return this.view(this.database.pool, projectId, user);
  }

  async nominate(projectId: string, body: unknown, user: AuthUser) {
    if (!can(user, 'project_lead.nominate')) throw forbidden();
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR UPDATE');
      if (!project) throw new NotFoundException({ code: 'project_not_found' });
      const request = parseBody(nominateLeadRequestSchema, body);
      const note = request.note ?? null;
      const hash = nominationHash(projectId, request.nomineeUserId, note);
      const { rows: previous } = await client.query<{ hash: string; by: string }>(
        `SELECT nomination_request_hash AS hash, nominated_by_user_id AS by
         FROM project_lead_nomination WHERE nomination_idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].hash !== hash || previous[0].by !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return this.view(client, projectId, user);
      }
      const standing = await lockStanding(client, [user.userId, request.nomineeUserId]);
      const actor = asLocked(user, standing);
      if (!can(actor, 'project_lead.nominate')) throw forbidden();
      if (project.lead_project_engineer_user_id) {
        unprocessable(
          'lead_already_appointed',
          'nomineeUserId',
          'This project already has a Lead Project Engineer',
        );
      }
      const { rows: pending } = await client.query(
        `SELECT 1 FROM project_lead_nomination WHERE project_id = $1 AND status = 'pending'`,
        [projectId],
      );
      if (pending.length > 0) {
        unprocessable(
          'nomination_pending',
          'nomineeUserId',
          'A nomination for this project is already waiting for an admin',
        );
      }
      const nominee = standing.get(request.nomineeUserId);
      if (!isActiveStaff(nominee)) {
        unprocessable('invalid_recipient', 'nomineeUserId', 'Choose an active staff member');
      }
      const by = standing.get(user.userId)!;
      await insertNomination(client, {
        projectId,
        nominee,
        by,
        note,
        idempotencyKey: request.idempotencyKey,
        actor: actorOf(actor),
      });
      // Normally open already (since creation or the lead's removal).
      await openLeadAppointment(
        client,
        projectId,
        by,
        `${project.project_number}: ${nominee.displayName} nominated as Lead Project Engineer`,
      );
      return this.view(client, projectId, actor);
    });
  }

  confirm(projectId: string, nominationId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, nominationId, body, user, 'confirmed');
  }

  reject(projectId: string, nominationId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, nominationId, body, user, 'rejected');
  }

  withdraw(projectId: string, nominationId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, nominationId, body, user, 'withdrawn');
  }

  private decide(
    projectId: string,
    nominationId: string,
    body: unknown,
    user: AuthUser,
    decision: Decision,
  ): Promise<ProjectLeadNominations> {
    // Confirm and reject: admins only (the same authority that changes a lead). Withdraw: the
    // nominator, checked against the row below.
    const mayDecide = (who: AuthUser) =>
      decision === 'withdrawn'
        ? can(who, 'project_lead.nominate')
        : can(who, 'project.lead_project_engineer.change');
    if (!mayDecide(user)) throw forbidden();
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR UPDATE');
      if (!project) throw new NotFoundException({ code: 'project_not_found' });
      // MISC-03: a confirmation's reason is optional; rejecting or withdrawing needs one.
      const reason: string | null =
        decision === 'confirmed'
          ? (parseBody(confirmNominationRequestSchema, body ?? {}).reason ?? null)
          : parseBody(decideNominationRequestSchema, body).reason;
      const { rows } = UUID_PATTERN.test(nominationId)
        ? await client.query<
            PendingNomination & { status: Decision | 'pending'; decided_by_user_id: string | null }
          >(
            `SELECT id, nominee_user_id, nominee_name_snapshot, nominated_by_user_id, status,
                    decided_by_user_id
             FROM project_lead_nomination WHERE id = $1 AND project_id = $2`,
            [nominationId, projectId],
          )
        : { rows: [] };
      const found = rows[0];
      if (!found) throw new NotFoundException({ code: 'project_lead_nomination_not_found' });
      const standing = await lockStanding(client, [user.userId, found.nominee_user_id]);
      const actor = asLocked(user, standing);
      if (!mayDecide(actor)) throw forbidden();
      if (decision === 'withdrawn' && found.nominated_by_user_id !== user.userId) {
        throw forbidden();
      }
      const { rows: locked } = await client.query<{
        status: string;
        decided_by_user_id: string | null;
      }>(
        `SELECT status, decided_by_user_id FROM project_lead_nomination WHERE id = $1 FOR UPDATE`,
        [found.id],
      );
      const now = locked[0]!;
      if (now.status !== 'pending') {
        // An exact retry of this decision by this person returns the current state.
        if (now.status === decision && now.decided_by_user_id === user.userId) {
          return this.view(client, projectId, actor);
        }
        throw new ConflictException({ code: 'nomination_decided', status: now.status });
      }
      const by = standing.get(user.userId)!;
      if (decision === 'confirmed') {
        if (project.lead_project_engineer_user_id) {
          throw new ConflictException({ code: 'lead_already_appointed' });
        }
        if (!isActiveStaff(standing.get(found.nominee_user_id))) {
          unprocessable(
            'invalid_recipient',
            'nomineeUserId',
            'The nominee is no longer an active staff member',
          );
        }
        await client.query(
          `UPDATE project SET lead_project_engineer_user_id = $2, version = version + 1,
                  updated_at = now()
           WHERE id = $1`,
          [projectId, found.nominee_user_id],
        );
        await recordAudit(client, {
          action: 'project.lead_appointed',
          entityType: 'project',
          entityId: projectId,
          actor: actorOf(actor),
          reason,
          before: { leadProjectEngineerUserId: null },
          after: {
            leadProjectEngineerUserId: found.nominee_user_id,
            via: 'nomination',
            nominationId: found.id,
          },
        });
      }
      await decideNomination(client, found, decision, {
        by,
        reason,
        actor: actorOf(actor),
        projectId,
      });
      if (decision === 'confirmed') {
        await resolveLeadAppointment(client, projectId, by);
        // MTR-25: grants made while the project had no lead (or under an earlier one).
        await flagInheritedGrants(client, {
          projectId,
          projectNumber: project.project_number,
          lead: found.nominee_user_id,
          by,
          actor: actorOf(actor),
        });
        // D10 (MM-AO07): requests that waited for a lead now go to them, and they are told.
        await rerouteOpenItems(
          client,
          { projectId },
          {
            actor: actorOf(actor),
            reason: reason
              ? `Lead Project Engineer appointed: ${reason}`
              : 'Lead Project Engineer appointed',
          },
        );
      }
      return this.view(client, projectId, actor);
    });
  }

  private async view(db: Db, projectId: string, user: AuthUser): Promise<ProjectLeadNominations> {
    const { rows } = await db.query<{ lead_project_engineer_user_id: string | null }>(
      'SELECT lead_project_engineer_user_id FROM project WHERE id = $1',
      [projectId],
    );
    const hasLead = Boolean(rows[0]?.lead_project_engineer_user_id);
    const { pending, history } = await loadNominations(db, projectId);
    return {
      projectId,
      hasLead,
      pending,
      history,
      canNominate: !hasLead && !pending && can(user, 'project_lead.nominate'),
      canDecide: Boolean(pending) && can(user, 'project.lead_project_engineer.change'),
      canWithdraw:
        Boolean(pending) &&
        pending!.nominatedBy.userId === user.userId &&
        can(user, 'project_lead.nominate'),
    };
  }
}
