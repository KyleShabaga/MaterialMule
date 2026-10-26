import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MAX_LIMIT,
  projectNumberKey,
  type ProjectConflictResponse,
  type ProjectSummary,
  type createProjectRequestSchema,
} from '@trapezoid/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { findActiveStaff } from '../staff-directory/staff-directory.js';
import { validationError } from '../validation/parse-body.js';

export type CreateProjectInput = z.output<typeof createProjectRequestSchema>;

/** Escapes LIKE wildcards so typed `%` and `_` match literally. */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const SELECT_PROJECT = `
  SELECT p.id, p.project_number, p.name, p.client,
         u.id AS pm_pe_id, u.display_name AS pm_pe_name, u.official_initials AS pm_pe_initials
  FROM project p
  JOIN app_user u ON u.id = p.pm_pe_user_id`;

interface ProjectRow {
  id: string;
  project_number: string;
  name: string;
  client: string;
  pm_pe_id: string;
  pm_pe_name: string;
  pm_pe_initials: string | null;
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    projectNumber: row.project_number,
    name: row.name,
    client: row.client,
    pmPe: { id: row.pm_pe_id, displayName: row.pm_pe_name, initials: row.pm_pe_initials },
  };
}

@Injectable()
export class ProjectsService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Projects whose number or name contains `query` (case-insensitive). Exact number matches come
   * first, then number prefixes, then name prefixes, then other matches.
   */
  async search(query: string, limit = PROJECT_SEARCH_DEFAULT_LIMIT): Promise<ProjectSummary[]> {
    const key = projectNumberKey(query);
    if (key === '') {
      return [];
    }
    const bounded = Math.min(Math.max(Math.trunc(limit) || 1, 1), PROJECT_SEARCH_MAX_LIMIT);
    const escaped = likeEscape(key);
    const { rows } = await this.database.pool.query<ProjectRow>(
      `${SELECT_PROJECT}
       WHERE p.project_number_normalized LIKE $1 ESCAPE '\\' OR lower(p.name) LIKE $1 ESCAPE '\\'
       ORDER BY p.project_number_normalized = $2 DESC,
                p.project_number_normalized LIKE $3 ESCAPE '\\' DESC,
                lower(p.name) LIKE $3 ESCAPE '\\' DESC,
                p.project_number_normalized
       LIMIT $4`,
      [`%${escaped}%`, key, `${escaped}%`, bounded],
    );
    return rows.map(toSummary);
  }

  async findById(client: Pool | PoolClient, id: string): Promise<ProjectSummary | null> {
    const { rows } = await client.query<ProjectRow>(`${SELECT_PROJECT} WHERE p.id = $1`, [id]);
    return rows[0] ? toSummary(rows[0]) : null;
  }

  async getById(id: string): Promise<ProjectSummary> {
    const project = await this.findById(this.database.pool, id);
    if (!project) {
      throw new NotFoundException({ code: 'project_not_found' });
    }
    return project;
  }

  /**
   * Creates a project. The unique index on the normalised number decides races: of two parallel
   * creates for one number, exactly one inserts and the other gets 409 with the existing project.
   */
  async create(
    input: CreateProjectInput,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ProjectSummary> {
    const created = await withTransaction(this.database.pool, async (client) => {
      const fieldErrors: Record<string, string[]> = {};
      if (!(await findActiveStaff(client, input.pmPeUserId))) {
        fieldErrors.pmPeUserId = ['PM/PE must be an active staff member'];
      }
      if (input.receiverUserId && !(await findActiveStaff(client, input.receiverUserId))) {
        fieldErrors.receiverUserId = ['Receiver must be an active staff member'];
      }
      if (Object.keys(fieldErrors).length > 0) {
        throw validationError(fieldErrors);
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project (project_number, name, client, pm_pe_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT project_number_key DO NOTHING
         RETURNING id`,
        [input.projectNumber, input.name, input.client, input.pmPeUserId],
      );
      const id = rows[0]?.id;
      if (!id) {
        return null;
      }
      const project = (await this.findById(client, id))!;
      await recordAudit(client, {
        action: 'project.created',
        entityType: 'project',
        entityId: id,
        actor,
        receiverUserId: input.receiverUserId ?? null,
        after: {
          projectNumber: project.projectNumber,
          name: project.name,
          client: project.client,
          pmPeUserId: project.pmPe.id,
        },
        requestId,
      });
      return project;
    });

    if (created) {
      return created;
    }
    throw await this.conflict(input.projectNumber);
  }

  private async conflict(projectNumber: string): Promise<ConflictException> {
    const { rows } = await this.database.pool.query<ProjectRow>(
      `${SELECT_PROJECT} WHERE p.project_number_normalized = $1`,
      [projectNumberKey(projectNumber)],
    );
    const existing = rows[0];
    if (!existing) {
      // The conflicting row vanished (projects are never deleted, so this shouldn't happen).
      return new ConflictException({ code: 'project_exists' });
    }
    return new ConflictException({
      code: 'project_exists',
      existing: toSummary(existing),
    } satisfies ProjectConflictResponse);
  }
}
