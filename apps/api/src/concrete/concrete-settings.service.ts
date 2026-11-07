import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_SETTINGS_DEFAULTS,
  CONCRETE_SETTINGS_FIELDS,
  CONCRETE_SETTINGS_HISTORY_LIMIT,
  updateConcreteSettingsRequestSchema,
  type ConcreteProjectSettings,
  type ConcreteSettingsField,
  type ConcreteSettingsVersionConflictResponse,
  type ConcreteSpecimenAge,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { findProject, type ProjectFacts } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';

type Db = Pool | PoolClient;

interface SettingsRow {
  default_specimen_ages: string[];
  hold_duration_days: number;
  include_machine_info: boolean | null;
  updated_at: Date;
  updated_by_user_id: string;
  updated_by_initials_snapshot: string | null;
  updated_by_name_snapshot: string;
  version: number;
}

type Values = {
  defaultSpecimenAges: ConcreteSpecimenAge[];
  holdDurationDays: number;
  includeMachineInfo: boolean | null;
};

const SELECT_SETTINGS = `SELECT default_specimen_ages, hold_duration_days, include_machine_info,
         updated_at, updated_by_user_id, updated_by_initials_snapshot, updated_by_name_snapshot,
         version
  FROM concrete_project_settings WHERE project_id = $1`;

function toAge(value: string): ConcreteSpecimenAge {
  return value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);
}

function valuesOf(row: SettingsRow | undefined): Values {
  if (!row) {
    return {
      defaultSpecimenAges: [...CONCRETE_SETTINGS_DEFAULTS.defaultSpecimenAges],
      holdDurationDays: CONCRETE_SETTINGS_DEFAULTS.holdDurationDays,
      includeMachineInfo: CONCRETE_SETTINGS_DEFAULTS.includeMachineInfo,
    };
  }
  return {
    defaultSpecimenAges: row.default_specimen_ages.map(toAge),
    holdDurationDays: row.hold_duration_days,
    includeMachineInfo: row.include_machine_info,
  };
}

function same(a: Values[ConcreteSettingsField], b: Values[ConcreteSettingsField]): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

const ENTITY_TYPE = 'concrete_project_settings';

/**
 * Per-project concrete settings (MM-V2-C02). Read by every active session (as the project itself,
 * `inventory.read`); written under `project.edit` (the project's Lead Project Engineer or an
 * admin; AO08 Q4: settings only, never mixes).
 *
 * A save is one transaction in the D09 lock order: the settings row (FOR UPDATE; the domain row),
 * then the project (FOR SHARE) and the editor's account (FOR SHARE) for the final authority check.
 * A stale `version` is 409 `version_conflict` with the current settings, and nothing is written.
 * Only changed fields are written and audited (`concrete_project_settings.updated`). Saving
 * defaults never touches existing specimen sets, schedules or reports.
 */
@Injectable()
export class ConcreteSettingsService {
  constructor(private readonly database: DatabaseService) {}

  async get(projectId: string, user: AuthUser): Promise<ConcreteProjectSettings> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    return this.view(this.database.pool, project, user);
  }

  async update(
    projectId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteProjectSettings> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const project = await findProject(client, projectId);
        if (!project) {
          // 403 for a caller who could never edit any project, 404 otherwise (as AO03 writes).
          if (!can(user, 'project.edit', { leadProjectEngineerUserId: null })) {
            throw new ForbiddenException({ code: 'forbidden' });
          }
          throw new NotFoundException({ code: 'project_not_found' });
        }
        // Authority before the body (403 before 400), with the request's user.
        if (
          !can(user, 'project.edit', {
            leadProjectEngineerUserId: project.lead_project_engineer_user_id,
          })
        ) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
        const input = parseBody(updateConcreteSettingsRequestSchema, body);

        // D09: the domain row first, then the project and the editor's account.
        const { rows } = await client.query<SettingsRow>(`${SELECT_SETTINGS} FOR UPDATE`, [
          projectId,
        ]);
        const row = rows[0];
        if (!(await canUnderLock(client, user, 'project.edit', projectId))) {
          throw new ForbiddenException({ code: 'forbidden' });
        }
        // The lead as it stands under the lock, for `canEdit` in the response.
        const locked = (await findProject(client, projectId))!;

        if (input.version !== (row?.version ?? 0)) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.view(client, locked, user),
          } satisfies ConcreteSettingsVersionConflictResponse);
        }

        const before = valuesOf(row);
        const requested: Partial<Values> = {
          defaultSpecimenAges: input.defaultSpecimenAges,
          holdDurationDays: input.holdDurationDays,
          includeMachineInfo: input.includeMachineInfo,
        };
        const changed = CONCRETE_SETTINGS_FIELDS.filter(
          (field) => requested[field] !== undefined && !same(requested[field]!, before[field]),
        );
        if (changed.length === 0) return this.view(client, locked, user);

        const after: Values = { ...before };
        for (const field of changed) {
          (after as Record<ConcreteSettingsField, unknown>)[field] = requested[field];
        }
        const editor = (await lockStanding(client, [user.userId])).get(user.userId)!;
        const params = [
          projectId,
          after.defaultSpecimenAges.map(String),
          after.holdDurationDays,
          after.includeMachineInfo,
          editor.userId,
          editor.initials,
          editor.displayName,
        ];
        if (!row) {
          await client.query(
            `INSERT INTO concrete_project_settings
               (project_id, default_specimen_ages, hold_duration_days, include_machine_info,
                updated_by_user_id, updated_by_initials_snapshot, updated_by_name_snapshot)
             VALUES ($1, $2, $3, $4, $5, $6, $7)`,
            params,
          );
        } else {
          await client.query(
            `UPDATE concrete_project_settings
             SET default_specimen_ages = $2, hold_duration_days = $3, include_machine_info = $4,
                 updated_by_user_id = $5, updated_by_initials_snapshot = $6,
                 updated_by_name_snapshot = $7, version = version + 1, updated_at = now()
             WHERE project_id = $1`,
            params,
          );
        }
        await recordAudit(client, {
          action: 'concrete_project_settings.updated',
          entityType: ENTITY_TYPE,
          entityId: projectId,
          actor,
          reason: input.reason ?? null,
          before: Object.fromEntries(changed.map((field) => [field, before[field]])),
          after: Object.fromEntries(changed.map((field) => [field, after[field]])),
          requestId,
        });
        return this.view(client, locked, user);
      });
    } catch (error) {
      // Two first saves raced: the other committed its row first, so this one was stale.
      if (
        (error as { code?: string; constraint?: string }).constraint ===
        'concrete_project_settings_pkey'
      ) {
        const project = await findProject(this.database.pool, projectId);
        throw new ConflictException({
          code: 'version_conflict',
          current: await this.view(this.database.pool, project!, user),
        } satisfies ConcreteSettingsVersionConflictResponse);
      }
      throw error;
    }
  }

  private async view(
    db: Db,
    project: ProjectFacts,
    user: AuthUser,
  ): Promise<ConcreteProjectSettings> {
    const { rows } = await db.query<SettingsRow>(SELECT_SETTINGS, [project.id]);
    const row = rows[0];
    const { rows: history } = await db.query<{
      id: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_initials_snapshot: string | null;
      actor_name_snapshot: string | null;
      reason: string | null;
      before_values: Record<string, unknown> | null;
      after_values: Record<string, unknown> | null;
    }>(
      `SELECT id, occurred_at, actor_user_id, actor_initials_snapshot, actor_name_snapshot, reason,
              before_values, after_values
       FROM audit_event WHERE entity_type = $1 AND entity_id = $2
       ORDER BY occurred_at DESC, id DESC LIMIT ${CONCRETE_SETTINGS_HISTORY_LIMIT}`,
      [ENTITY_TYPE, project.id],
    );
    const { rows: total } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event WHERE entity_type = $1 AND entity_id = $2',
      [ENTITY_TYPE, project.id],
    );
    return {
      projectId: project.id,
      ...valuesOf(row),
      version: row?.version ?? 0,
      updatedAt: row?.updated_at.toISOString() ?? null,
      updatedBy: row
        ? {
            userId: row.updated_by_user_id,
            initials: row.updated_by_initials_snapshot,
            name: row.updated_by_name_snapshot,
          }
        : null,
      canEdit: can(user, 'project.edit', {
        leadProjectEngineerUserId: project.lead_project_engineer_user_id,
      }),
      history: history.map((event) => ({
        id: event.id,
        occurredAt: event.occurred_at.toISOString(),
        changedBy: event.actor_user_id
          ? {
              userId: event.actor_user_id,
              initials: event.actor_initials_snapshot,
              name: event.actor_name_snapshot ?? '',
            }
          : null,
        reason: event.reason,
        before: event.before_values ?? {},
        after: event.after_values ?? {},
      })),
      historyTotal: total[0]!.n,
    };
  }
}
