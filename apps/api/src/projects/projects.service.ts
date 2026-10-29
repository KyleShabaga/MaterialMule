import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  PROJECT_DETAIL_RECEIPT_LIMIT,
  PROJECT_NUMBER_LOCKED_MESSAGE,
  PROJECT_SEARCH_DEFAULT_LIMIT,
  PROJECT_SEARCH_MAX_LIMIT,
  projectNumberKey,
  type FieldError,
  type ProjectConflictResponse,
  type ProjectDetail,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
  type ProjectSummary,
  type ProjectVersionConflictResponse,
  type StaffOption,
  type createProjectRequestSchema,
  type updateProjectRequestSchema,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { can, type AuthUser } from '../auth/policy.js';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { auditReceiver, findActiveStaff } from '../staff-directory/staff-directory.js';
import { validationError } from '../validation/parse-body.js';
import { buildProjectListQuery } from './project-list-query.js';

export type CreateProjectInput = z.output<typeof createProjectRequestSchema>;
export type UpdateProjectInput = z.output<typeof updateProjectRequestSchema>;

/** Escapes LIKE wildcards so typed `%` and `_` match literally. */
export function likeEscape(value: string): string {
  return value.replace(/[\\%_]/g, (character) => `\\${character}`);
}

const SELECT_PROJECT = `
  SELECT p.id, p.project_number, p.name, p.client,
         u.id AS lead_project_engineer_id, u.display_name AS lead_project_engineer_name, u.official_initials AS lead_project_engineer_initials
  FROM project p
  JOIN app_user u ON u.id = p.lead_project_engineer_user_id`;

interface ProjectRow {
  id: string;
  project_number: string;
  name: string;
  client: string;
  lead_project_engineer_id: string;
  lead_project_engineer_name: string;
  lead_project_engineer_initials: string | null;
}

function toSummary(row: ProjectRow): ProjectSummary {
  return {
    id: row.id,
    projectNumber: row.project_number,
    name: row.name,
    client: row.client,
    leadProjectEngineer: {
      id: row.lead_project_engineer_id,
      displayName: row.lead_project_engineer_name,
      initials: row.lead_project_engineer_initials,
    },
  };
}

// Projects list and detail (MM-T35). Counts are computed by query, never stored.

const SELECT_PROJECT_WITH_PEOPLE = `
  SELECT p.id, p.project_number, p.name, p.client,
         u.id AS lead_project_engineer_id, u.display_name AS lead_project_engineer_name, u.official_initials AS lead_project_engineer_initials,
         re.id AS re_id, re.display_name AS re_name, re.official_initials AS re_initials`;

const PROJECT_WITH_PEOPLE_FROM = `
  FROM project p
  JOIN app_user u ON u.id = p.lead_project_engineer_user_id
  LEFT JOIN app_user re ON re.id = p.review_engineer_user_id`;

interface ProjectWithPeopleRow extends ProjectRow {
  re_id: string | null;
  re_name: string | null;
  re_initials: string | null;
}

interface ProjectListRow extends ProjectWithPeopleRow {
  test_hole_count: number;
  in_stock_unit_count: number;
  last_receipt_date: string | null;
}

interface ProjectDetailRow extends ProjectWithPeopleRow {
  lead_project_engineer_user_id: string;
  review_engineer_user_id: string | null;
  server_folder_path: string | null;
  version: number;
}

function reviewEngineerOf(row: ProjectWithPeopleRow): StaffOption | null {
  return row.re_id
    ? { id: row.re_id, displayName: row.re_name ?? '', initials: row.re_initials }
    : null;
}

/** The editable fields as audit before/after values. */
interface EditableValues {
  projectNumber: string;
  name: string;
  client: string;
  leadProjectEngineerUserId: string;
  reviewEngineerUserId: string | null;
  serverFolderPath: string | null;
}

const EDITABLE_COLUMNS: Record<keyof EditableValues, string> = {
  projectNumber: 'project_number',
  name: 'name',
  client: 'client',
  leadProjectEngineerUserId: 'lead_project_engineer_user_id',
  reviewEngineerUserId: 'review_engineer_user_id',
  serverFolderPath: 'server_folder_path',
};

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

  async getDetail(id: string, user: AuthUser): Promise<ProjectDetail> {
    return this.detail(this.database.pool, id, user);
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
      const errors: FieldError[] = [];
      if (!(await findActiveStaff(client, input.leadProjectEngineerUserId))) {
        errors.push({
          field: 'leadProjectEngineerUserId',
          code: 'not_active_staff',
          message: 'Lead Project Engineer must be an active staff member',
        });
      }
      const receiver = input.receiverUserId
        ? await findActiveStaff(client, input.receiverUserId)
        : null;
      if (input.receiverUserId && !receiver) {
        errors.push({
          field: 'receiverUserId',
          code: 'not_active_staff',
          message: 'Receiver must be an active staff member',
        });
      }
      if (errors.length > 0) {
        throw validationError(errors);
      }

      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO project (project_number, name, client, lead_project_engineer_user_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT ON CONSTRAINT project_number_key DO NOTHING
         RETURNING id`,
        [input.projectNumber, input.name, input.client, input.leadProjectEngineerUserId],
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
        receiver: receiver && auditReceiver(receiver),
        after: {
          projectNumber: project.projectNumber,
          name: project.name,
          client: project.client,
          leadProjectEngineerUserId: project.leadProjectEngineer.id,
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

  /** One page of the projects table with its total (MM-T35). */
  async list(query: ProjectListQuery, userId: string): Promise<ProjectListPage> {
    const sql = buildProjectListQuery(query, userId);
    const pool = this.database.pool;
    const [count, page] = await Promise.all([
      pool.query<{ total: number }>(
        `SELECT count(*)::int AS total FROM project p ${sql.where}`,
        sql.params,
      ),
      pool.query<ProjectListRow>(
        `${SELECT_PROJECT_WITH_PEOPLE},
                (SELECT count(*)::int FROM test_hole th WHERE th.project_id = p.id)
                  AS test_hole_count,
                (SELECT count(*)::int FROM storage_unit su
                  WHERE su.project_id = p.id AND su.status = 'in_stock') AS in_stock_unit_count,
                (SELECT max(r.received_date)::text FROM receipt r WHERE r.project_id = p.id)
                  AS last_receipt_date
         ${PROJECT_WITH_PEOPLE_FROM}
         ${sql.where}
         ORDER BY ${sql.orderBy}
         LIMIT ${sql.limit} OFFSET ${sql.offset}`,
        sql.params,
      ),
    ]);
    return {
      items: page.rows.map((row): ProjectListItem => ({
        ...toSummary(row),
        reviewEngineer: reviewEngineerOf(row),
        testHoleCount: row.test_hole_count,
        inStockUnitCount: row.in_stock_unit_count,
        lastReceiptDate: row.last_receipt_date,
      })),
      total: count.rows[0]!.total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private async detailRow(
    client: Pool | PoolClient,
    id: string,
    lock = false,
  ): Promise<ProjectDetailRow | null> {
    const { rows } = await client.query<ProjectDetailRow>(
      `${SELECT_PROJECT_WITH_PEOPLE}, p.lead_project_engineer_user_id, p.review_engineer_user_id,
              p.server_folder_path, p.version
       ${PROJECT_WITH_PEOPLE_FROM}
       WHERE p.id = $1
       ${lock ? 'FOR UPDATE OF p' : ''}`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Header, test holes with unit counts and receipts, plus what `user` may edit (MM-T35). */
  async detail(client: Pool | PoolClient, id: string, user: AuthUser): Promise<ProjectDetail> {
    const row = await this.detailRow(client, id);
    if (!row) {
      throw new NotFoundException({ code: 'project_not_found' });
    }
    // One after another: `client` may be a transaction's single connection.
    const holes = await client.query<{
      id: string;
      project_id: string;
      name: string;
      unit_count: number;
    }>(
      // Units from each hole: hole summaries, Shelby tubes sourced from it and bulk buckets whose
      // group is sourced from it (MM-T36). A unit is counted once per hole it names.
      `SELECT th.id, th.project_id, th.name,
              ((SELECT count(*) FROM storage_unit_hole_summary h WHERE h.test_hole_id = th.id)
               + (SELECT count(*) FROM storage_unit su WHERE su.source_test_hole_id = th.id)
               + (SELECT count(*) FROM storage_unit su
                  JOIN bulk_group g ON g.id = su.bulk_group_id
                  WHERE g.test_hole_id = th.id))::int AS unit_count
         FROM test_hole th
         WHERE th.project_id = $1
         ORDER BY th.name_normalized, th.id`,
      [id],
    );
    const receipts = await client.query<{
      id: string;
      received_date: string;
      receiver_name_snapshot: string;
      receiver_initials_snapshot: string;
      unit_count: number;
    }>(
      `SELECT r.id, r.received_date::text AS received_date, r.receiver_name_snapshot,
                r.receiver_initials_snapshot,
                (SELECT count(*)::int FROM storage_unit su WHERE su.receipt_id = r.id) AS unit_count
         FROM receipt r
         WHERE r.project_id = $1
         ORDER BY r.received_date DESC, r.confirmed_at DESC, r.id
         LIMIT ${PROJECT_DETAIL_RECEIPT_LIMIT}`,
      [id],
    );
    const totals = await client.query<{
      receipt_count: number;
      unit_count: number;
      in_stock_unit_count: number;
    }>(
      `SELECT (SELECT count(*)::int FROM receipt WHERE project_id = $1) AS receipt_count,
                count(su.id)::int AS unit_count,
                (count(su.id) FILTER (WHERE su.status = 'in_stock'))::int AS in_stock_unit_count
         FROM storage_unit su WHERE su.project_id = $1`,
      [id],
    );
    const counts = totals.rows[0]!;
    return {
      ...toSummary(row),
      reviewEngineer: reviewEngineerOf(row),
      serverFolderPath: row.server_folder_path,
      version: row.version,
      numberLocked: counts.receipt_count > 0,
      canEdit: can(user, 'project.edit', {
        leadProjectEngineerUserId: row.lead_project_engineer_user_id,
      }),
      canChangeLeadProjectEngineer: can(user, 'project.lead_project_engineer.change'),
      unitCount: counts.unit_count,
      inStockUnitCount: counts.in_stock_unit_count,
      testHoles: holes.rows.map((hole) => ({
        id: hole.id,
        projectId: hole.project_id,
        name: hole.name,
        unitCount: hole.unit_count,
      })),
      receipts: receipts.rows.map((receipt) => ({
        id: receipt.id,
        receivedDate: receipt.received_date,
        receiver: {
          name: receipt.receiver_name_snapshot,
          initials: receipt.receiver_initials_snapshot,
        },
        unitCount: receipt.unit_count,
      })),
      receiptCount: counts.receipt_count,
    };
  }

  /**
   * Edits a project (MM-T35, owner decision 2026-10-25): admins and the project's current Lead Project Engineer
   * may edit; only admins change the Lead Project Engineer (with a reason); the number locks once any receipt
   * exists. Optimistic: a stale `version` gets 409 with the current project. Only changed fields
   * are written and audited; a save that changes nothing returns the project untouched.
   */
  async update(
    id: string,
    input: UpdateProjectInput,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ProjectDetail> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        // The row lock serialises edits and waits for any receipt being confirmed for it.
        const row = await this.detailRow(client, id, true);
        if (!row) {
          throw new NotFoundException({ code: 'project_not_found' });
        }
        if (
          !can(user, 'project.edit', {
            leadProjectEngineerUserId: row.lead_project_engineer_user_id,
          })
        ) {
          throw new ForbiddenException({ code: 'forbidden' });
        }

        const before: EditableValues = {
          projectNumber: row.project_number,
          name: row.name,
          client: row.client,
          leadProjectEngineerUserId: row.lead_project_engineer_user_id,
          reviewEngineerUserId: row.review_engineer_user_id,
          serverFolderPath: row.server_folder_path,
        };
        const requested: Partial<EditableValues> = {
          projectNumber: input.projectNumber,
          name: input.name,
          client: input.client,
          leadProjectEngineerUserId: input.leadProjectEngineerId,
          reviewEngineerUserId: input.reviewEngineerId,
          serverFolderPath: input.serverFolderPath,
        };
        const changed = (Object.keys(EDITABLE_COLUMNS) as (keyof EditableValues)[]).filter(
          (key) => requested[key] !== undefined && requested[key] !== before[key],
        );

        if (
          changed.includes('leadProjectEngineerUserId') &&
          !can(user, 'project.lead_project_engineer.change')
        ) {
          throw new ForbiddenException({ code: 'forbidden' });
        }

        const errors: FieldError[] = [];
        if (changed.includes('leadProjectEngineerUserId')) {
          if (!input.reason) {
            errors.push({
              field: 'reason',
              code: 'required',
              message: 'Give a reason for changing the Lead Project Engineer',
            });
          }
          if (!(await findActiveStaff(client, input.leadProjectEngineerId!))) {
            errors.push({
              field: 'leadProjectEngineerId',
              code: 'not_active_staff',
              message: 'Lead Project Engineer must be an active staff member',
            });
          }
        }
        if (
          changed.includes('reviewEngineerUserId') &&
          input.reviewEngineerId &&
          !(await findActiveStaff(client, input.reviewEngineerId))
        ) {
          errors.push({
            field: 'reviewEngineerId',
            code: 'not_active_staff',
            message: 'Review engineer must be an active staff member',
          });
        }
        if (errors.length > 0) {
          throw validationError(errors);
        }

        if (input.version !== row.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.detail(client, id, user),
          } satisfies ProjectVersionConflictResponse);
        }

        if (changed.includes('projectNumber')) {
          const receipts = await client.query(
            'SELECT 1 FROM receipt WHERE project_id = $1 LIMIT 1',
            [id],
          );
          if (receipts.rows.length > 0) {
            throw new UnprocessableEntityException({
              code: 'project_number_locked',
              message: PROJECT_NUMBER_LOCKED_MESSAGE,
            });
          }
        }

        if (changed.length === 0) {
          return this.detail(client, id, user);
        }

        const params: unknown[] = [id];
        const assignments = changed.map((key) => {
          params.push(requested[key]);
          return `${EDITABLE_COLUMNS[key]} = $${params.length}`;
        });
        await client.query(
          `UPDATE project SET ${assignments.join(', ')}, version = version + 1, updated_at = now()
           WHERE id = $1`,
          params,
        );
        await recordAudit(client, {
          action: 'project.updated',
          entityType: 'project',
          entityId: id,
          actor,
          reason: input.reason ?? null,
          before: Object.fromEntries(changed.map((key) => [key, before[key]])),
          after: Object.fromEntries(changed.map((key) => [key, requested[key]])),
          requestId,
        });
        return this.detail(client, id, user);
      });
    } catch (error) {
      // A new number that another project already uses (compared ignoring case).
      if (
        input.projectNumber !== undefined &&
        (error as { code?: string; constraint?: string }).constraint === 'project_number_key'
      ) {
        throw await this.conflict(input.projectNumber);
      }
      throw error;
    }
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
