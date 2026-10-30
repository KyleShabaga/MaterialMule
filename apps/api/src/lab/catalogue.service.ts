import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import type {
  CreateTestGroupRequest,
  CreateTestSubgroupRequest,
  CreateTestTemplateRequest,
  CreateTestTypeRequest,
  SampleTagMode,
  TestCatalogue,
  TestGroup,
  TestSubgroup,
  TestTemplate,
  TestType,
  UpdateTestGroupRequest,
  UpdateTestTemplateRequest,
  UpdateTestTypeRequest,
} from '@materialmule/shared';
import { DatabaseError, type Pool, type PoolClient } from 'pg';
import { recordAudit } from '../audit/audit.js';
import type { AuthUser } from '../auth/policy.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { actorOf } from './attribution.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface TestTypeRow {
  id: string;
  group_id: string;
  group_name: string;
  subgroup_id: string | null;
  subgroup_name: string | null;
  code: string;
  name: string | null;
  description: string;
  sort_order: number;
  active: boolean;
  retired_at: Date | null;
  version: number;
  sample_tag_mode: SampleTagMode;
  sample_tag_group: string | null;
}

const SELECT_TEST_TYPE = `
  SELECT t.id, t.group_id, g.name AS group_name, t.subgroup_id, s.name AS subgroup_name, t.code,
         t.name, t.description, t.sort_order, t.active, t.retired_at, t.version,
         t.sample_tag_mode, t.sample_tag_group
  FROM test_type t
  JOIN test_group g ON g.id = t.group_id
  LEFT JOIN test_subgroup s ON s.id = t.subgroup_id`;

/** Groups, then subgroups (none first), then the entry's own order and code. */
const TEST_TYPE_ORDER = `g.sort_order, lower(g.name), s.sort_order NULLS FIRST, lower(s.name) NULLS FIRST,
                         t.sort_order, t.code COLLATE "C"`;

function toTestType(row: TestTypeRow): TestType {
  return {
    id: row.id,
    groupId: row.group_id,
    groupName: row.group_name,
    subgroupId: row.subgroup_id,
    subgroupName: row.subgroup_name,
    code: row.code,
    name: row.name,
    description: row.description,
    sortOrder: row.sort_order,
    active: row.active,
    retiredAt: row.retired_at?.toISOString() ?? null,
    version: row.version,
    sampleTagMode: row.sample_tag_mode,
    sampleTagGroup: row.sample_tag_group,
  };
}

function versionConflict(current: unknown): never {
  throw new ConflictException({ code: 'version_conflict', current });
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, code, message }] });
}

/** Turns a unique-name/code violation into a 409 the client can explain. */
function rethrowUnique(error: unknown): never {
  if (error instanceof DatabaseError && error.code === '23505') {
    const byConstraint: Record<string, [string, string]> = {
      test_type_code_key: ['test_code_exists', 'A test with this code already exists.'],
      test_group_name_key: ['test_group_exists', 'A group with this name already exists.'],
      test_subgroup_name_key: [
        'test_subgroup_exists',
        'This group already has a subgroup with this name.',
      ],
      test_template_name_key: ['test_template_exists', 'A template with this name already exists.'],
    };
    const known = error.constraint ? byConstraint[error.constraint] : undefined;
    if (known) throw new ConflictException({ code: known[0], message: known[1] });
  }
  throw error;
}

export async function loadTestTypes(db: Pool | PoolClient, ids?: string[]): Promise<TestType[]> {
  const { rows } = await db.query<TestTypeRow>(
    `${SELECT_TEST_TYPE}
     ${ids ? 'WHERE t.id = ANY ($1::uuid[])' : ''}
     ORDER BY ${TEST_TYPE_ORDER}`,
    ids ? [ids] : [],
  );
  return rows.map(toTestType);
}

/**
 * Lab test catalogue and templates (MM-T23). Reads are open to everyone who enters programs (LAB
 * included); every change needs `test_catalog.manage` (Lab Manager and admin) and is audited.
 * Nothing is deleted: entries and templates are retired and restored, groups renamed.
 */
@Injectable()
export class CatalogueService {
  constructor(private readonly database: DatabaseService) {}

  async catalogue(): Promise<TestCatalogue> {
    const pool = this.database.pool;
    const [groups, subgroups, tests] = await Promise.all([
      pool.query<{ id: string; name: string; sort_order: number; version: number }>(
        'SELECT id, name, sort_order, version FROM test_group ORDER BY sort_order, lower(name)',
      ),
      pool.query<{
        id: string;
        group_id: string;
        name: string;
        sort_order: number;
        version: number;
      }>(
        `SELECT id, group_id, name, sort_order, version FROM test_subgroup
         ORDER BY sort_order, lower(name)`,
      ),
      loadTestTypes(pool),
    ]);
    const toSubgroup = (row: (typeof subgroups.rows)[number]): TestSubgroup => ({
      id: row.id,
      groupId: row.group_id,
      name: row.name,
      sortOrder: row.sort_order,
      version: row.version,
    });
    return {
      groups: groups.rows.map((group): TestGroup => ({
        id: group.id,
        name: group.name,
        sortOrder: group.sort_order,
        version: group.version,
        subgroups: subgroups.rows.filter((s) => s.group_id === group.id).map(toSubgroup),
      })),
      tests,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Groups and subgroups
  // -------------------------------------------------------------------------------------------

  async createGroup(request: CreateTestGroupRequest, user: AuthUser): Promise<TestGroup> {
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client
        .query<{ id: string; version: number; sort_order: number }>(
          `INSERT INTO test_group (name, sort_order) VALUES ($1, $2)
           RETURNING id, version, sort_order`,
          [request.name, request.sortOrder ?? 0],
        )
        .catch(rethrowUnique);
      const group = rows[0]!;
      await recordAudit(client, {
        action: 'test_group.added',
        entityType: 'test_group',
        entityId: group.id,
        actor: actorOf(user),
        after: { name: request.name, sortOrder: group.sort_order },
      });
      return {
        id: group.id,
        name: request.name,
        sortOrder: group.sort_order,
        version: group.version,
        subgroups: [],
      };
    });
  }

  async updateGroup(id: string, request: UpdateTestGroupRequest, user: AuthUser) {
    return this.updateNamed('test_group', id, request, user);
  }

  async createSubgroup(request: CreateTestSubgroupRequest, user: AuthUser): Promise<TestSubgroup> {
    return withTransaction(this.database.pool, async (client) => {
      const { rows: groups } = await client.query('SELECT 1 FROM test_group WHERE id = $1', [
        request.groupId,
      ]);
      if (groups.length === 0) unprocessable('test_group_not_found', 'groupId', 'group not found');
      const { rows } = await client
        .query<{ id: string; version: number; sort_order: number }>(
          `INSERT INTO test_subgroup (group_id, name, sort_order) VALUES ($1, $2, $3)
           RETURNING id, version, sort_order`,
          [request.groupId, request.name, request.sortOrder ?? 0],
        )
        .catch(rethrowUnique);
      const subgroup = rows[0]!;
      await recordAudit(client, {
        action: 'test_subgroup.added',
        entityType: 'test_subgroup',
        entityId: subgroup.id,
        actor: actorOf(user),
        after: { groupId: request.groupId, name: request.name, sortOrder: subgroup.sort_order },
      });
      return {
        id: subgroup.id,
        groupId: request.groupId,
        name: request.name,
        sortOrder: subgroup.sort_order,
        version: subgroup.version,
      };
    });
  }

  async updateSubgroup(id: string, request: UpdateTestGroupRequest, user: AuthUser) {
    return this.updateNamed('test_subgroup', id, request, user);
  }

  /** Rename or reorder a group or subgroup; its tests follow by reference. */
  private async updateNamed(
    table: 'test_group' | 'test_subgroup',
    id: string,
    request: UpdateTestGroupRequest,
    user: AuthUser,
  ): Promise<{ id: string; name: string; sortOrder: number; version: number }> {
    const notFound = table === 'test_group' ? 'test_group_not_found' : 'test_subgroup_not_found';
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: notFound });
    return withTransaction(this.database.pool, async (client) => {
      const { rows } = await client.query<{
        id: string;
        name: string;
        sort_order: number;
        version: number;
      }>(`SELECT id, name, sort_order, version FROM ${table} WHERE id = $1 FOR UPDATE`, [id]);
      const before = rows[0];
      if (!before) throw new NotFoundException({ code: notFound });
      const current = {
        id,
        name: before.name,
        sortOrder: before.sort_order,
        version: before.version,
      };
      if (before.version !== request.version) versionConflict(current);
      const name = request.name ?? before.name;
      const sortOrder = request.sortOrder ?? before.sort_order;
      const { rows: updated } = await client
        .query<{ version: number }>(
          `UPDATE ${table} SET name = $2, sort_order = $3, version = version + 1, updated_at = now()
           WHERE id = $1 RETURNING version`,
          [id, name, sortOrder],
        )
        .catch(rethrowUnique);
      await recordAudit(client, {
        action: `${table}.updated`,
        entityType: table,
        entityId: id,
        actor: actorOf(user),
        before: { name: before.name, sortOrder: before.sort_order },
        after: { name, sortOrder },
      });
      return { id, name, sortOrder, version: updated[0]!.version };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Test entries
  // -------------------------------------------------------------------------------------------

  async createTestType(request: CreateTestTypeRequest, user: AuthUser): Promise<TestType> {
    return withTransaction(this.database.pool, async (client) => {
      await this.checkPlacement(client, request.groupId, request.subgroupId);
      const { rows } = await client
        .query<{ id: string }>(
          `INSERT INTO test_type (group_id, subgroup_id, code, name, description, sort_order,
                                  sample_tag_mode, sample_tag_group)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
          [
            request.groupId,
            request.subgroupId,
            request.code,
            request.name,
            request.description,
            request.sortOrder ?? 0,
            request.sampleTagMode,
            request.sampleTagGroup,
          ],
        )
        .catch(rethrowUnique);
      const test = (await loadTestTypes(client, [rows[0]!.id]))[0]!;
      await recordAudit(client, {
        action: 'test_type.added',
        entityType: 'test_type',
        entityId: test.id,
        actor: actorOf(user),
        after: auditValue(test),
      });
      return test;
    });
  }

  async updateTestType(id: string, request: UpdateTestTypeRequest, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const before = await this.lockTestType(client, id);
      if (before.version !== request.version) versionConflict(before);
      const groupId = request.groupId ?? before.groupId;
      // Moving to another group drops a subgroup that doesn't belong to it unless one is named.
      const subgroupId =
        request.subgroupId !== undefined
          ? request.subgroupId
          : groupId === before.groupId
            ? before.subgroupId
            : null;
      await this.checkPlacement(client, groupId, subgroupId);
      // The tag mode and group change together (MM-T69): a new mode without a group clears it.
      const sampleTagMode = request.sampleTagMode ?? before.sampleTagMode;
      const sampleTagGroup =
        request.sampleTagMode === undefined
          ? before.sampleTagGroup
          : (request.sampleTagGroup ?? null);
      await client
        .query(
          `UPDATE test_type
           SET group_id = $2, subgroup_id = $3, code = $4, name = $5, description = $6,
               sort_order = $7, sample_tag_mode = $8, sample_tag_group = $9,
               version = version + 1, updated_at = now()
           WHERE id = $1`,
          [
            id,
            groupId,
            subgroupId,
            request.code ?? before.code,
            request.name !== undefined ? request.name : before.name,
            request.description ?? before.description,
            request.sortOrder ?? before.sortOrder,
            sampleTagMode,
            sampleTagGroup,
          ],
        )
        .catch(rethrowUnique);
      const after = (await loadTestTypes(client, [id]))[0]!;
      await recordAudit(client, {
        action: 'test_type.updated',
        entityType: 'test_type',
        entityId: id,
        actor: actorOf(user),
        ...changedFields(auditValue(before), auditValue(after)),
      });
      return after;
    });
  }

  /** Retired entries leave new selection; submitted requests keep their snapshots. */
  async setTestTypeActive(id: string, version: number, active: boolean, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const before = await this.lockTestType(client, id);
      if (before.version !== version) versionConflict(before);
      if (before.active === active) {
        unprocessable(
          active ? 'already_active' : 'already_retired',
          'id',
          active ? 'test is already available' : 'test is already retired',
        );
      }
      await client.query(
        `UPDATE test_type
         SET active = $2, retired_at = CASE WHEN $2 THEN NULL ELSE now() END,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, active],
      );
      const after = (await loadTestTypes(client, [id]))[0]!;
      await recordAudit(client, {
        action: active ? 'test_type.restored' : 'test_type.retired',
        entityType: 'test_type',
        entityId: id,
        actor: actorOf(user),
        before: { code: before.code, active: before.active },
        after: { code: after.code, active: after.active },
      });
      return after;
    });
  }

  private async lockTestType(client: PoolClient, id: string): Promise<TestType> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'test_type_not_found' });
    const { rows } = await client.query('SELECT 1 FROM test_type WHERE id = $1 FOR UPDATE', [id]);
    if (rows.length === 0) throw new NotFoundException({ code: 'test_type_not_found' });
    return (await loadTestTypes(client, [id]))[0]!;
  }

  /** The group exists and the subgroup, when given, belongs to it (422 otherwise). */
  private async checkPlacement(client: PoolClient, groupId: string, subgroupId: string | null) {
    const { rows } = await client.query('SELECT 1 FROM test_group WHERE id = $1', [groupId]);
    if (rows.length === 0) unprocessable('test_group_not_found', 'groupId', 'group not found');
    if (subgroupId === null) return;
    const { rows: subgroups } = await client.query(
      'SELECT 1 FROM test_subgroup WHERE id = $1 AND group_id = $2',
      [subgroupId, groupId],
    );
    if (subgroups.length === 0) {
      unprocessable('subgroup_not_in_group', 'subgroupId', 'subgroup is not part of this group');
    }
  }

  // -------------------------------------------------------------------------------------------
  // Templates
  // -------------------------------------------------------------------------------------------

  async listTemplates(): Promise<TestTemplate[]> {
    return loadTemplates(this.database.pool);
  }

  async createTemplate(request: CreateTestTemplateRequest, user: AuthUser): Promise<TestTemplate> {
    return withTransaction(this.database.pool, async (client) => {
      await this.checkTemplateTests(client, request.testTypeIds, []);
      const { rows } = await client
        .query<{ id: string }>('INSERT INTO test_template (name) VALUES ($1) RETURNING id', [
          request.name,
        ])
        .catch(rethrowUnique);
      const id = rows[0]!.id;
      await this.replaceItems(client, id, request.testTypeIds);
      const template = (await loadTemplates(client, id))[0]!;
      await recordAudit(client, {
        action: 'test_template.added',
        entityType: 'test_template',
        entityId: id,
        actor: actorOf(user),
        after: templateAudit(template),
      });
      return template;
    });
  }

  async updateTemplate(id: string, request: UpdateTestTemplateRequest, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const before = await this.lockTemplate(client, id);
      if (before.version !== request.version) versionConflict(before);
      if (request.testTypeIds) {
        // A retired test may stay where it already was, but can't be newly added.
        await this.checkTemplateTests(
          client,
          request.testTypeIds,
          before.items.map((item) => item.testTypeId),
        );
        await this.replaceItems(client, id, request.testTypeIds);
      }
      await client
        .query(
          `UPDATE test_template SET name = $2, version = version + 1, updated_at = now()
           WHERE id = $1`,
          [id, request.name ?? before.name],
        )
        .catch(rethrowUnique);
      const after = (await loadTemplates(client, id))[0]!;
      await recordAudit(client, {
        action: 'test_template.updated',
        entityType: 'test_template',
        entityId: id,
        actor: actorOf(user),
        before: templateAudit(before),
        after: templateAudit(after),
      });
      return after;
    });
  }

  async setTemplateActive(id: string, version: number, active: boolean, user: AuthUser) {
    return withTransaction(this.database.pool, async (client) => {
      const before = await this.lockTemplate(client, id);
      if (before.version !== version) versionConflict(before);
      if (before.active === active) {
        unprocessable(
          active ? 'already_active' : 'already_retired',
          'id',
          active ? 'template is already available' : 'template is already retired',
        );
      }
      await client.query(
        `UPDATE test_template
         SET active = $2, retired_at = CASE WHEN $2 THEN NULL ELSE now() END,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [id, active],
      );
      const after = (await loadTemplates(client, id))[0]!;
      await recordAudit(client, {
        action: active ? 'test_template.restored' : 'test_template.retired',
        entityType: 'test_template',
        entityId: id,
        actor: actorOf(user),
        before: { name: before.name, active: before.active },
        after: { name: after.name, active: after.active },
      });
      return after;
    });
  }

  private async lockTemplate(client: PoolClient, id: string): Promise<TestTemplate> {
    if (!UUID_PATTERN.test(id)) throw new NotFoundException({ code: 'test_template_not_found' });
    const { rows } = await client.query('SELECT 1 FROM test_template WHERE id = $1 FOR UPDATE', [
      id,
    ]);
    if (rows.length === 0) throw new NotFoundException({ code: 'test_template_not_found' });
    return (await loadTemplates(client, id))[0]!;
  }

  private async checkTemplateTests(client: PoolClient, ids: string[], alreadyThere: string[]) {
    if (ids.length === 0) return;
    const tests = await loadTestTypes(client, ids);
    const byId = new Map(tests.map((test) => [test.id, test]));
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      unprocessable('test_type_not_found', 'testTypeIds', 'lists a test that does not exist');
    }
    const newlyRetired = ids.filter((id) => !byId.get(id)!.active && !alreadyThere.includes(id));
    if (newlyRetired.length > 0) {
      unprocessable('retired_tests', 'testTypeIds', 'retired tests can’t be added to a template');
    }
  }

  private async replaceItems(client: PoolClient, templateId: string, ids: string[]) {
    await client.query('DELETE FROM test_template_item WHERE template_id = $1', [templateId]);
    if (ids.length === 0) return;
    await client.query(
      `INSERT INTO test_template_item (template_id, test_type_id, sort_order)
       SELECT $1, id, ord::int FROM unnest($2::uuid[]) WITH ORDINALITY AS t(id, ord)`,
      [templateId, ids],
    );
  }
}

export async function loadTemplates(db: Pool | PoolClient, id?: string): Promise<TestTemplate[]> {
  const { rows } = await db.query<{
    id: string;
    name: string;
    active: boolean;
    retired_at: Date | null;
    version: number;
    items: {
      testTypeId: string;
      code: string;
      name: string | null;
      description: string;
      active: boolean;
    }[];
  }>(
    `SELECT tt.id, tt.name, tt.active, tt.retired_at, tt.version,
            coalesce(json_agg(json_build_object(
              'testTypeId', t.id, 'code', t.code, 'name', t.name,
              'description', t.description, 'active', t.active)
              ORDER BY i.sort_order, t.code) FILTER (WHERE t.id IS NOT NULL), '[]') AS items
     FROM test_template tt
     LEFT JOIN test_template_item i ON i.template_id = tt.id
     LEFT JOIN test_type t ON t.id = i.test_type_id
     ${id ? 'WHERE tt.id = $1' : ''}
     GROUP BY tt.id
     ORDER BY tt.active DESC, lower(tt.name)`,
    id ? [id] : [],
  );
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    active: row.active,
    retiredAt: row.retired_at?.toISOString() ?? null,
    version: row.version,
    items: row.items.map((item) => ({
      testTypeId: item.testTypeId,
      code: item.code,
      displayName: item.name ?? item.description,
      active: item.active,
    })),
  }));
}

function auditValue(test: TestType) {
  return {
    code: test.code,
    name: test.name,
    description: test.description,
    group: test.groupName,
    subgroup: test.subgroupName,
    sortOrder: test.sortOrder,
    sampleTagMode: test.sampleTagMode,
    sampleTagGroup: test.sampleTagGroup,
  };
}

function templateAudit(template: TestTemplate) {
  return { name: template.name, tests: template.items.map((item) => item.code) };
}

/** Only the fields that changed, for before/after audit values. */
function changedFields(before: Record<string, unknown>, after: Record<string, unknown>) {
  const keys = Object.keys(after).filter((key) => before[key] !== after[key]);
  return {
    before: Object.fromEntries(keys.map((key) => [key, before[key]])),
    after: Object.fromEntries(keys.map((key) => [key, after[key]])),
  };
}
