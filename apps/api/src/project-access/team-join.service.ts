import { createHash, randomUUID } from 'node:crypto';
import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  acceptTeamJoinSchema,
  declineTeamJoinSchema,
  requestTeamJoinSchema,
  type ProjectTeamJoinRequests,
  type TeamJoinRequest,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { asLocked, isActiveStaff, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from '../lab/attribution.js';
import { enqueueActionItemEmails } from '../notifications/action-items.js';
import { parseBody } from '../validation/parse-body.js';
import { TEAM_MEMBER, endGrant, hasActive, insertGrant, lockGrant } from './grant-tables.js';
import {
  findProject,
  forbidden,
  unprocessable,
  type ProjectFacts,
} from './project-access.service.js';

// MISC-07 (owner decision, Kyle 2026-10-30): any active personal account may join a project's
// team itself. It is added at once with full team-member access (which carries no controlled
// authority, D04), marked "Pending LPE acceptance". The lead is told through an action request
// (admins while the project has no lead); the lead or an admin accepts, or declines with a reason,
// which removes the person, who may then ask again. The shared LAB account never asks. Every
// request, acceptance and decline is audited. Migration 0011 keeps one pending request per person
// and project, and declines a pending request whenever its membership ends by any route.

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The add reason recorded on a self-joined membership. */
export const SELF_JOIN_REASON = 'Asked to join the team';

function mayDecide(user: AuthUser, lead: string | null): boolean {
  return (
    user.status === 'active' &&
    user.accountType !== 'shared_lab' &&
    (user.userId === lead || user.roles.includes('admin'))
  );
}

interface RequestRow {
  id: string;
  team_member_id: string;
  user_id: string;
  user_initials: string | null;
  user_name: string;
  requested_at: Date;
  status: TeamJoinRequest['status'];
  decided_by_user_id: string | null;
  decided_by_initials_snapshot: string | null;
  decided_by_name_snapshot: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
}

const SELECT_REQUESTS = `
  SELECT r.id, r.team_member_id, r.user_id, t.user_initials_snapshot AS user_initials,
         t.user_name_snapshot AS user_name, r.requested_at, r.status, r.decided_by_user_id,
         r.decided_by_initials_snapshot, r.decided_by_name_snapshot, r.decided_at,
         r.decision_reason
  FROM project_team_join_request r
  JOIN project_team_member t ON t.id = r.team_member_id`;

function toRequest(row: RequestRow): TeamJoinRequest {
  return {
    id: row.id,
    teamMemberId: row.team_member_id,
    person: { userId: row.user_id, initials: row.user_initials, name: row.user_name },
    requestedAt: row.requested_at.toISOString(),
    status: row.status,
    decidedBy: row.decided_by_user_id
      ? {
          userId: row.decided_by_user_id,
          initials: row.decided_by_initials_snapshot,
          name: row.decided_by_name_snapshot ?? '',
        }
      : null,
    decidedAt: row.decided_at?.toISOString() ?? null,
    reason: row.decision_reason,
  };
}

@Injectable()
export class TeamJoinService {
  constructor(private readonly database: DatabaseService) {}

  async list(projectId: string, user: AuthUser): Promise<ProjectTeamJoinRequests> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return this.view(this.database.pool, project, user);
  }

  request(projectId: string, body: unknown, user: AuthUser): Promise<ProjectTeamJoinRequests> {
    if (user.accountType === 'shared_lab') throw forbidden();
    const { idempotencyKey } = parseBody(requestTeamJoinSchema, body);
    return withTransaction(this.database.pool, async (client) => {
      // Joins on one project run one at a time, and wholly before or after a lead change.
      const project = await findProject(client, projectId, 'FOR UPDATE');
      if (!project) throw new NotFoundException({ code: 'project_not_found' });
      const standing = await lockStanding(client, [user.userId]);
      const me = standing.get(user.userId);
      if (!isActiveStaff(me)) throw forbidden();
      const actor = asLocked(user, standing);
      const { rows: earlier } = await client.query<{ user_id: string }>(
        `SELECT user_id FROM project_team_join_request WHERE request_idempotency_key = $1`,
        [idempotencyKey],
      );
      if (earlier[0]) {
        if (earlier[0].user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return this.view(client, project, actor);
      }
      if (project.lead_project_engineer_user_id === user.userId) {
        unprocessable('invalid_recipient', 'userId', 'You already lead this project');
      }
      // Already on the team (accepted or still pending): nothing new is made.
      if (
        await hasActive(client, TEAM_MEMBER, {
          parentId: project.id,
          subjectId: user.userId,
          scope: null,
        })
      ) {
        return this.view(client, project, actor);
      }
      const memberId = await insertGrant(client, TEAM_MEMBER, {
        parentId: project.id,
        subject: me,
        scope: null,
        by: me,
        reason: SELF_JOIN_REASON,
        key: randomUUID(),
        hash: createHash('sha256')
          .update(JSON.stringify({ projectId: project.id, selfJoin: user.userId }))
          .digest('hex'),
        actor: actorOf(actor),
        audit: { via: 'self_join' },
      });
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project_team_join_request
           (project_id, user_id, team_member_id, request_idempotency_key)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [project.id, user.userId, memberId, idempotencyKey],
      );
      const requestId = rows[0]!.id;
      await recordAudit(client, {
        action: 'project_team_join_request.requested',
        entityType: 'project_team_join_request',
        entityId: requestId,
        actor: actorOf(actor),
        after: { status: 'pending', projectId: project.id, teamMemberId: memberId },
      });
      // The lead is told; while the project has none, admins are.
      const lead = project.lead_project_engineer_user_id;
      const { rows: item } = await client.query<{ id: string }>(
        `INSERT INTO action_item (kind, target_user_id, target_role, entity_type, entity_id,
                                  project_id, created_by_user_id, created_by_initials_snapshot,
                                  created_by_name_snapshot, reason)
         VALUES ('team_join_request', $1, $2, 'team_join_request', $3, $4, $5, $6, $7, $8)
         RETURNING id`,
        [
          lead,
          lead ? null : 'admin',
          requestId,
          project.id,
          me.userId,
          me.initials,
          me.displayName,
          `${me.displayName} joined the ${project.project_number} team and waits for acceptance`,
        ],
      );
      await enqueueActionItemEmails(client, item[0]!.id);
      return this.view(client, project, actor);
    });
  }

  accept(projectId: string, requestId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, requestId, body, user, 'accepted');
  }

  decline(projectId: string, requestId: string, body: unknown, user: AuthUser) {
    return this.decide(projectId, requestId, body, user, 'declined');
  }

  private decide(
    projectId: string,
    requestId: string,
    body: unknown,
    user: AuthUser,
    decision: 'accepted' | 'declined',
  ): Promise<ProjectTeamJoinRequests> {
    return withTransaction(this.database.pool, async (client) => {
      const project = await findProject(client, projectId, 'FOR SHARE');
      if (!project) throw new NotFoundException({ code: 'project_not_found' });
      const lead = project.lead_project_engineer_user_id;
      if (!mayDecide(user, lead)) throw forbidden();
      const reason =
        decision === 'accepted'
          ? (parseBody(acceptTeamJoinSchema, body ?? {}).reason ?? null)
          : parseBody(declineTeamJoinSchema, body).reason;
      // Unlocked: only to find the request and its membership (neither ever changes).
      const { rows } = UUID_PATTERN.test(requestId)
        ? await client.query<RequestRow>(
            `${SELECT_REQUESTS} WHERE r.id = $1 AND r.project_id = $2`,
            [requestId, project.id],
          )
        : { rows: [] };
      const found = rows[0];
      if (!found) throw new NotFoundException({ code: 'team_join_request_not_found' });
      const standing = await lockStanding(client, [user.userId]);
      const actor = asLocked(user, standing);
      if (!mayDecide(actor, lead)) throw forbidden();
      // Lock order as an ordinary removal (whose 0011 trigger then declines the request): the
      // membership, then the request, re-read under the locks so the first committed decision wins.
      const member =
        decision === 'declined' ? await lockGrant(client, TEAM_MEMBER, found.team_member_id) : null;
      const { rows: locked } = await client.query<{
        status: TeamJoinRequest['status'];
        decided_by_user_id: string | null;
      }>(
        `SELECT status, decided_by_user_id FROM project_team_join_request WHERE id = $1 FOR UPDATE`,
        [found.id],
      );
      const now = locked[0]!;
      if (now.status !== 'pending') {
        // An exact retry of this decision by this person returns the current state.
        if (now.status === decision && now.decided_by_user_id === user.userId) {
          return this.view(client, project, actor);
        }
        throw new ConflictException({ code: 'team_join_request_decided', status: now.status });
      }
      const by = { userId: user.userId, initials: user.initials, displayName: user.displayName };
      const receiver = {
        userId: found.user_id,
        initials: found.user_initials,
        name: found.user_name,
      };
      if (decision === 'accepted') {
        await client.query(
          `UPDATE project_team_join_request
           SET status = 'accepted', decided_at = now(), decided_by_user_id = $2,
               decided_by_initials_snapshot = $3, decided_by_name_snapshot = $4,
               decision_reason = $5
           WHERE id = $1`,
          [found.id, by.userId, by.initials, by.displayName, reason],
        );
        await client.query(
          `UPDATE action_item SET status = 'resolved', resolution = 'accepted', resolved_at = now(),
                  resolved_by_user_id = $2
           WHERE kind = 'team_join_request' AND entity_id = $1 AND status = 'open'`,
          [found.id, by.userId],
        );
      } else {
        if (!member) throw new NotFoundException({ code: 'team_join_request_not_found' });
        // Removing them declines the request and resolves its action request (0011 trigger).
        await endGrant(client, TEAM_MEMBER, member, {
          by,
          reason: reason!,
          actor: actorOf(actor),
          audit: { via: 'team_join_declined', teamJoinRequestId: found.id },
        });
      }
      await recordAudit(client, {
        action: `project_team_join_request.${decision}`,
        entityType: 'project_team_join_request',
        entityId: found.id,
        actor: actorOf(actor),
        receiver,
        reason,
        before: { status: 'pending' },
        after: { status: decision, projectId: project.id, userId: found.user_id },
      });
      return this.view(client, project, actor);
    });
  }

  private async view(
    db: Db,
    project: ProjectFacts,
    user: AuthUser,
  ): Promise<ProjectTeamJoinRequests> {
    const { rows } = await db.query<RequestRow>(
      `${SELECT_REQUESTS} WHERE r.project_id = $1 AND r.status = 'pending'
       ORDER BY r.requested_at, r.id`,
      [project.id],
    );
    const { rows: mine } = await db.query<RequestRow>(
      `${SELECT_REQUESTS} WHERE r.project_id = $1 AND r.user_id = $2
       ORDER BY r.requested_at DESC, r.id LIMIT 1`,
      [project.id, user.userId],
    );
    const personal = user.status === 'active' && user.accountType !== 'shared_lab';
    const onTeam = await hasActive(db, TEAM_MEMBER, {
      parentId: project.id,
      subjectId: user.userId,
      scope: null,
    });
    return {
      projectId: project.id,
      canRequest: personal && !onTeam && project.lead_project_engineer_user_id !== user.userId,
      canDecide: mayDecide(user, project.lead_project_engineer_user_id),
      mine: mine[0] ? toRequest(mine[0]) : null,
      pending: rows.map(toRequest),
    };
  }
}
