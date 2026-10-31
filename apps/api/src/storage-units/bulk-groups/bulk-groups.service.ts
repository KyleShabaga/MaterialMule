import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  normalizeStorageUnitCode,
  type BulkGroupSummary,
  type BulkSampleIdentityInput,
  type ChangeBulkGroupRequest,
  type CorrectBulkGroupRequest,
  type StorageUnitDetail,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../../audit/audit.js';
import type { AuthUser } from '../../auth/policy.js';
import { DatabaseService } from '../../database/database.service.js';
import { withTransaction } from '../../db/transaction.js';
import { validationError } from '../../validation/parse-body.js';
import {
  findBulkGroup,
  identityAuditValue,
  listProjectBulkGroups,
  loadSampleIdentities,
} from '../sample-identity.js';
import { getStorageUnitDetail } from '../storage-units.service.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

interface LockedUnit {
  id: string;
  readable_id: string;
  version: number;
  unit_type: string;
  holder_kind: string;
  project_id: string;
  status: string;
  bulk_group_id: string | null;
}

function actorOf(user: AuthUser): AuditActor {
  return {
    userId: user.userId,
    accountType: user.accountType,
    initials: user.initials,
    name: user.displayName,
  };
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, errors: [{ field, code, message }] });
}

/**
 * Bulk-sample groups (MM-T36): the receiving picker's list, moving a bulk soil bucket to another
 * group (membership correction) and correcting a group's identity. Corrections need a personal
 * account and a reason (D45); each is one transaction with a before/after audit event, and the
 * search documents of every affected bucket are refreshed by triggers in that same transaction.
 */
@Injectable()
export class BulkGroupsService {
  constructor(private readonly database: DatabaseService) {}

  /** A project's groups; 404 when the project doesn't exist. */
  async list(projectId: string): Promise<BulkGroupSummary[]> {
    if (!UUID_PATTERN.test(projectId)) throw new NotFoundException({ code: 'project_not_found' });
    const { rows } = await this.database.pool.query('SELECT 1 FROM project WHERE id = $1', [
      projectId,
    ]);
    if (rows.length === 0) throw new NotFoundException({ code: 'project_not_found' });
    return listProjectBulkGroups(this.database.pool, projectId);
  }

  /**
   * Moves a bulk soil bucket into an existing group of its project, or into a new group of its
   * own. The bucket keeps its BKT- ID, receipt, location and history; only the link changes.
   * Null (leaving every group) is refused: a bulk soil bucket's only contents summary is its
   * group. Making it an ordinary bucket is a unit correction that gives its test holes
   * (PATCH /storage-units/:id, MM-T82).
   */
  async changeMembership(
    idOrCode: string,
    request: ChangeBulkGroupRequest,
    user: AuthUser,
  ): Promise<StorageUnitDetail | null> {
    const unitId = await withTransaction(this.database.pool, async (client) => {
      const unit = await this.lockUnit(client, idOrCode);
      if (!unit) return null;
      if (unit.version !== request.version) {
        throw new ConflictException({ code: 'version_conflict', currentVersion: unit.version });
      }
      if (unit.unit_type !== 'bulk_container' || unit.bulk_group_id === null) {
        unprocessable(
          'not_bulk_bucket',
          'id',
          'only a bucket holding a bulk soil sample belongs to a bulk sample',
        );
      }
      if (request.groupId === null) {
        unprocessable(
          'bulk_identity_required',
          'groupId',
          'a bulk soil bucket must stay in a bulk sample; choose another one or describe a new one',
        );
      }
      // MM-T82 (owner decision 2026-10-30): a disposed or tested bucket keeps its bulk sample;
      // its disposal record or test evidence rests on it. The database refuses it too (0008).
      if (unit.status === 'disposed') {
        unprocessable('storage_unit_disposed', 'groupId', 'is not changed for a disposed unit');
      }
      const { rows: tested } = await client.query(
        'SELECT 1 FROM test_request_unit_link WHERE storage_unit_id = $1 LIMIT 1',
        [unit.id],
      );
      if (tested.length > 0) {
        unprocessable(
          'storage_unit_tested',
          'groupId',
          'is not changed for a unit used in a completed test',
        );
      }

      const before = (await findBulkGroup(client, unit.bulk_group_id, 'FOR SHARE OF g'))!;
      let after: BulkGroupSummary;
      if (request.groupId !== undefined) {
        if (request.groupId === unit.bulk_group_id) {
          throw validationError([
            { field: 'groupId', code: 'no_changes', message: 'is already its bulk sample' },
          ]);
        }
        const target = await findBulkGroup(client, request.groupId, 'FOR SHARE OF g');
        if (!target || target.projectId !== unit.project_id) {
          unprocessable(
            'bulk_group_not_in_project',
            'groupId',
            'bulk sample is not part of this project',
          );
        }
        after = target;
      } else {
        const groupId = await this.createGroup(client, unit.project_id, request.newGroup!, user);
        after = (await findBulkGroup(client, groupId))!;
        await recordAudit(client, {
          action: 'bulk_group.created',
          entityType: 'bulk_group',
          entityId: groupId,
          actor: actorOf(user),
          reason: request.reason,
          after: { ...identityAuditValue(after), createdFor: unit.readable_id },
        });
      }

      await client.query(
        `UPDATE storage_unit SET bulk_group_id = $2, version = version + 1, updated_at = now()
         WHERE id = $1`,
        [unit.id, after.id],
      );
      // Counts as they are after the move, so the history shows the new "n of N".
      const placed = (await loadSampleIdentities(client, [unit.id])).get(unit.id)!.bulkGroup!;
      await recordAudit(client, {
        action: 'storage_unit.bulk_group_changed',
        entityType: 'storage_unit',
        entityId: unit.id,
        actor: actorOf(user),
        reason: request.reason,
        before: { bulkGroup: { ...identityAuditValue(before), memberCount: before.memberCount } },
        after: {
          bulkGroup: {
            ...identityAuditValue(after),
            memberNumber: placed.memberNumber,
            memberCount: placed.memberCount,
          },
        },
      });
      return unit.id;
    });
    return unitId === null ? null : getStorageUnitDetail(this.database.pool, unitId);
  }

  /**
   * Corrects a group's identity (source, sample reference, depth, description). Every member
   * shows the new identity at once; members are never re-linked or renumbered by this.
   */
  async correctIdentity(
    groupId: string,
    request: CorrectBulkGroupRequest,
    user: AuthUser,
  ): Promise<BulkGroupSummary | null> {
    if (!UUID_PATTERN.test(groupId)) return null;
    return withTransaction(this.database.pool, async (client) => {
      // FOR UPDATE waits for receipts that are joining the group (they hold FOR SHARE).
      const before = await findBulkGroup(client, groupId, 'FOR UPDATE OF g');
      if (!before) return null;
      if (before.version !== request.version) {
        throw new ConflictException({ code: 'version_conflict', currentVersion: before.version });
      }
      const identity = request.identity;
      await this.checkTestHole(client, before.projectId, identity, 'identity.testHoleId');
      const { rowCount } = await client.query(
        `UPDATE bulk_group
         SET source_type = $2, test_hole_id = $3, source_location_reference = $4,
             sample_reference = $5, depth_from = $6, depth_to = $7, depth_unit = $8,
             description = $9, version = version + 1, updated_at = now()
         WHERE id = $1
           AND (source_type, test_hole_id, source_location_reference, sample_reference,
                depth_from, depth_to, depth_unit, description)
               IS DISTINCT FROM ($2, $3::uuid, $4, $5, $6::numeric, $7::numeric, $8, $9)`,
        [
          groupId,
          identity.sourceType,
          identity.testHoleId,
          identity.sourceLocationReference,
          identity.sampleReference,
          identity.depthFrom,
          identity.depthTo,
          identity.depthUnit,
          identity.description,
        ],
      );
      if (rowCount === 0) {
        throw validationError([
          { field: 'identity', code: 'no_changes', message: 'has nothing to change' },
        ]);
      }
      const after = (await findBulkGroup(client, groupId))!;
      await recordAudit(client, {
        action: 'bulk_group.corrected',
        entityType: 'bulk_group',
        entityId: groupId,
        actor: actorOf(user),
        reason: request.reason,
        before: { ...identityAuditValue(before), memberCount: before.memberCount },
        after: { ...identityAuditValue(after), memberCount: after.memberCount },
      });
      return after;
    });
  }

  private async createGroup(
    client: PoolClient,
    projectId: string,
    identity: BulkSampleIdentityInput,
    user: AuthUser,
  ): Promise<string> {
    await this.checkTestHole(client, projectId, identity, 'newGroup.testHoleId');
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO bulk_group (project_id, source_type, test_hole_id, source_location_reference,
                               sample_reference, depth_from, depth_to, depth_unit, description,
                               created_by_user_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING id`,
      [
        projectId,
        identity.sourceType,
        identity.testHoleId,
        identity.sourceLocationReference,
        identity.sampleReference,
        identity.depthFrom,
        identity.depthTo,
        identity.depthUnit,
        identity.description,
        user.userId,
      ],
    );
    return rows[0]!.id;
  }

  /** A test-hole source must be a hole of the group's own project (422 otherwise). */
  private async checkTestHole(
    client: PoolClient,
    projectId: string,
    identity: BulkSampleIdentityInput,
    field: string,
  ) {
    if (identity.testHoleId === null) return;
    const { rows } = await client.query(
      'SELECT 1 FROM test_hole WHERE project_id = $1 AND id = $2',
      [projectId, identity.testHoleId],
    );
    if (rows.length === 0) {
      unprocessable('test_hole_not_in_project', field, 'test hole is not part of this project');
    }
  }

  private async lockUnit(client: PoolClient, idOrCode: string): Promise<LockedUnit | null> {
    const byUuid = UUID_PATTERN.test(idOrCode);
    const { rows } = await client.query<LockedUnit>(
      `SELECT id, readable_id, version, unit_type, holder_kind, project_id, status, bulk_group_id
       FROM storage_unit WHERE ${byUuid ? 'id' : 'readable_id'} = $1
       FOR UPDATE`,
      [byUuid ? idOrCode : normalizeStorageUnitCode(idOrCode)],
    );
    return rows[0] ?? null;
  }
}
