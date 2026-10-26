import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import {
  testHoleNameKey,
  type TestHole,
  type TestHoleConflictResponse,
  type createTestHoleRequestSchema,
} from '@trapezoid/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { likeEscape } from '../projects/projects.service.js';
import { findActiveStaff } from '../staff-directory/staff-directory.js';
import { validationError } from '../validation/parse-body.js';

export type CreateTestHoleInput = z.output<typeof createTestHoleRequestSchema>;

/** Upper bound on holes returned for one project; a project rarely has more than a few dozen. */
export const TEST_HOLE_LIST_LIMIT = 200;

interface TestHoleRow {
  id: string;
  project_id: string;
  name: string;
}

function toTestHole(row: TestHoleRow): TestHole {
  return { id: row.id, projectId: row.project_id, name: row.name };
}

@Injectable()
export class TestHolesService {
  constructor(private readonly database: DatabaseService) {}

  private async requireProject(client: Pool | PoolClient, projectId: string) {
    const { rows } = await client.query<{ project_number: string }>(
      'SELECT project_number FROM project WHERE id = $1',
      [projectId],
    );
    if (!rows[0]) {
      throw new NotFoundException({ code: 'project_not_found' });
    }
    return rows[0];
  }

  /** Holes in one project whose name contains `query` (ignoring case); all of them when empty. */
  async list(projectId: string, query: string): Promise<TestHole[]> {
    await this.requireProject(this.database.pool, projectId);
    const key = testHoleNameKey(query);
    const escaped = likeEscape(key);
    const { rows } = await this.database.pool.query<TestHoleRow>(
      `SELECT id, project_id, name FROM test_hole
       WHERE project_id = $1 AND name_normalized LIKE $2 ESCAPE '\\'
       ORDER BY name_normalized = $3 DESC, name_normalized LIKE $4 ESCAPE '\\' DESC,
                name_normalized, id
       LIMIT $5`,
      [projectId, `%${escaped}%`, key, `${escaped}%`, TEST_HOLE_LIST_LIMIT],
    );
    return rows.map(toTestHole);
  }

  /**
   * Adds a hole to a project, stored exactly as entered once trimmed (never renamed, never
   * re-yeared). The unique index on (project, lower(name)) decides races: 409 with the existing
   * hole for the loser or for a duplicate that differs only in case or surrounding spaces.
   */
  async create(
    projectId: string,
    input: CreateTestHoleInput,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<TestHole> {
    const created = await withTransaction(this.database.pool, async (client) => {
      const project = await this.requireProject(client, projectId);
      if (input.receiverUserId && !(await findActiveStaff(client, input.receiverUserId))) {
        throw validationError([
          {
            field: 'receiverUserId',
            code: 'not_active_staff',
            message: 'Receiver must be an active staff member',
          },
        ]);
      }
      const { rows } = await client.query<TestHoleRow>(
        `INSERT INTO test_hole (project_id, name)
         VALUES ($1, $2)
         ON CONFLICT ON CONSTRAINT test_hole_project_name_key DO NOTHING
         RETURNING id, project_id, name`,
        [projectId, input.name],
      );
      const row = rows[0];
      if (!row) {
        return null;
      }
      await recordAudit(client, {
        action: 'test_hole.created',
        entityType: 'test_hole',
        entityId: row.id,
        actor,
        receiverUserId: input.receiverUserId ?? null,
        after: { projectId, projectNumber: project.project_number, name: row.name },
        requestId,
      });
      return toTestHole(row);
    });

    if (created) {
      return created;
    }
    const { rows } = await this.database.pool.query<TestHoleRow>(
      `SELECT id, project_id, name FROM test_hole WHERE project_id = $1 AND name_normalized = $2`,
      [projectId, testHoleNameKey(input.name)],
    );
    throw new ConflictException({
      code: 'test_hole_exists',
      existing: toTestHole(rows[0]!),
    } satisfies TestHoleConflictResponse);
  }
}
