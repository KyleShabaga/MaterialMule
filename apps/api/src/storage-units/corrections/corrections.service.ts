import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  normalizeStorageUnitCode,
  type FieldError,
  type StorageUnitCorrectionRequest,
  type StorageUnitDetail,
  type StorageUnitHoleSummary,
  type StorageUnitType,
  type UnresolvedLabLinksResponse,
} from '@materialmule/shared';
import type { PoolClient } from 'pg';
import { recordAudit } from '../../audit/audit.js';
import type { AuthUser } from '../../auth/policy.js';
import { APP_CONFIG } from '../../config/config.constants.js';
import type { AppConfig } from '../../config/env.js';
import { DatabaseService } from '../../database/database.service.js';
import { withTransaction } from '../../db/transaction.js';
import { businessToday } from '../../receiving/receipts.service.js';
import { validationError } from '../../validation/parse-body.js';
import { loadHoleSummaries } from '../hole-summaries.js';
import { getStorageUnitDetail } from '../storage-units.service.js';
import { diffCorrection, type CorrectableValues } from './correction-diff.js';
import { LAB_REQUEST_LINK_CHECKER, type LabRequestLinkChecker } from './lab-request-links.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Current physical holder for a corrected unit type (the issued holder and ID never change). */
const HOLDER_BY_UNIT_TYPE: Readonly<Partial<Record<StorageUnitType, string>>> = {
  bucket: 'bucket',
};

interface LockedUnit {
  id: string;
  version: number;
  unit_type: StorageUnitType;
  holder_kind: string;
  /** True for a Shelby tube with a sampling source or a bulk soil bucket (MM-T36). */
  has_sample_identity: boolean;
  note: string | null;
  received_date: string;
  project_id: string;
  project_number: string;
}

/**
 * Corrections to a confirmed storage unit (MM-T13, D45–D47). One transaction per save: lock the
 * unit, check its version, validate, update the unit, replace its summaries as a set, bump the
 * version and append one `storage_unit.corrected` audit event holding only the changed fields.
 * The readable ID, saved location, print history and receipt header are never touched (the
 * database also refuses any change to the issued identity).
 */
@Injectable()
export class StorageUnitCorrectionsService {
  constructor(
    private readonly database: DatabaseService,
    @Inject(APP_CONFIG) private readonly config: AppConfig,
    @Inject(LAB_REQUEST_LINK_CHECKER) private readonly labLinks: LabRequestLinkChecker,
  ) {}

  /** The corrected unit, or null when no unit has that ID. */
  async correct(
    idOrCode: string,
    request: StorageUnitCorrectionRequest,
    user: AuthUser,
    options: { now?: Date } = {},
  ): Promise<StorageUnitDetail | null> {
    const now = options.now ?? new Date();
    const unitId = await withTransaction(this.database.pool, async (client) => {
      const unit = await this.lockUnit(client, idOrCode);
      if (!unit) return null;
      if (unit.version !== request.version) {
        throw new ConflictException({ code: 'version_conflict', currentVersion: unit.version });
      }
      // A Shelby tube's source or a bulk bucket's group is its only contents summary (MM-T36):
      // type, project and hole-summary changes would leave it with none, or two. Bulk buckets
      // change group through PATCH /storage-units/:id/bulk-group; tube source corrections are a
      // later increment. Received date and note can be corrected as for any unit.
      if (unit.has_sample_identity) {
        const blocked = (['unitType', 'projectId', 'holeSummaries'] as const).filter(
          (field) => request.changes[field] !== undefined,
        );
        if (blocked.length > 0) {
          throw new UnprocessableEntityException({
            code: 'not_correctable_for_contents',
            errors: blocked.map((field) => ({
              field: `changes.${field}`,
              code: 'not_correctable_for_contents',
              message: 'is not corrected here for a Shelby tube or bulk soil bucket',
            })),
          });
        }
      }

      const current: CorrectableValues = {
        unitType: unit.unit_type,
        receivedDate: unit.received_date,
        project: { id: unit.project_id, projectNumber: unit.project_number },
        holeSummaries: (await loadHoleSummaries(client, [unit.id])).get(unit.id) ?? [],
        note: unit.note,
      };
      const next = await this.proposed(client, current, request, now);
      const diff = diffCorrection(current, next);
      if (diff.fields.length === 0) {
        throw validationError([
          { field: 'changes', code: 'no_changes', message: 'has nothing to change' },
        ]);
      }

      if (diff.fields.includes('project')) {
        const links = await this.labLinks.unresolvedLinks(client, unit.id);
        if (links.length > 0) {
          throw new ConflictException({
            code: 'unresolved_lab_links',
            links,
          } satisfies UnresolvedLabLinksResponse);
        }
      }

      const rewriteSummaries =
        diff.fields.includes('project') || diff.fields.includes('holeSummaries');
      if (rewriteSummaries) {
        // Summaries reference (project_id, storage_unit_id), so they go before the unit moves.
        await client.query('DELETE FROM storage_unit_hole_summary WHERE storage_unit_id = $1', [
          unit.id,
        ]);
      }
      await client.query(
        `UPDATE storage_unit
         SET unit_type = $2, holder_kind = $3, note = $4, received_date = $5, project_id = $6,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [
          unit.id,
          next.unitType,
          next.unitType === unit.unit_type
            ? unit.holder_kind
            : (HOLDER_BY_UNIT_TYPE[next.unitType] ?? unit.holder_kind),
          next.note,
          next.receivedDate,
          next.project.id,
        ],
      );
      if (rewriteSummaries) {
        for (const summary of next.holeSummaries) {
          await client.query(
            `INSERT INTO storage_unit_hole_summary (storage_unit_id, project_id, test_hole_id,
                                                    summary_type, sample_from, sample_to,
                                                    depth_from, depth_to, depth_unit, custom_text,
                                                    note)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
            [
              unit.id,
              next.project.id,
              summary.testHoleId,
              summary.type,
              summary.sampleFrom,
              summary.sampleTo,
              summary.depthFrom,
              summary.depthTo,
              summary.depthUnit,
              summary.customText,
              summary.note,
            ],
          );
        }
      }

      await recordAudit(client, {
        action: 'storage_unit.corrected',
        entityType: 'storage_unit',
        entityId: unit.id,
        actor: {
          userId: user.userId,
          accountType: user.accountType,
          initials: user.initials,
          name: user.displayName,
        },
        reason: request.reason,
        before: diff.before,
        after: diff.after,
      });
      return unit.id;
    });
    return unitId === null ? null : getStorageUnitDetail(this.database.pool, unitId);
  }

  /** Locks the unit row so concurrent corrections run one after another. */
  private async lockUnit(client: PoolClient, idOrCode: string): Promise<LockedUnit | null> {
    const byUuid = UUID_PATTERN.test(idOrCode);
    const { rows } = await client.query<LockedUnit>(
      `SELECT su.id, su.version, su.unit_type, su.holder_kind, su.note,
              (su.source_type IS NOT NULL OR su.bulk_group_id IS NOT NULL) AS has_sample_identity,
              su.received_date::text AS received_date, su.project_id, p.project_number
       FROM storage_unit su
       JOIN project p ON p.id = su.project_id
       WHERE ${byUuid ? 'su.id' : 'su.readable_id'} = $1
       FOR UPDATE OF su`,
      [byUuid ? idOrCode : normalizeStorageUnitCode(idOrCode)],
    );
    return rows[0] ?? null;
  }

  /** The values after this correction, validated against the database and the clock. */
  private async proposed(
    client: PoolClient,
    current: CorrectableValues,
    request: StorageUnitCorrectionRequest,
    now: Date,
  ): Promise<CorrectableValues> {
    const { changes } = request;
    const errors: FieldError[] = [];
    if (
      changes.receivedDate !== undefined &&
      changes.receivedDate > businessToday(now, this.config.BUSINESS_TIME_ZONE)
    ) {
      errors.push({
        field: 'changes.receivedDate',
        code: 'in_future',
        message: "can't be in the future",
      });
    }
    let project = current.project;
    if (changes.projectId !== undefined && changes.projectId !== current.project.id) {
      const { rows } = await client.query<{ id: string; project_number: string }>(
        'SELECT id, project_number FROM project WHERE id = $1',
        [changes.projectId],
      );
      if (rows[0]) {
        project = { id: rows[0].id, projectNumber: rows[0].project_number };
      } else {
        errors.push({
          field: 'changes.projectId',
          code: 'not_found',
          message: 'project not found',
        });
      }
    }
    if (errors.length > 0) throw validationError(errors);

    let holeSummaries = current.holeSummaries;
    if (changes.holeSummaries !== undefined) {
      // Every hole must belong to the unit's (new) project, as at receiving (D12).
      const { rows } = await client.query<{ id: string; name: string }>(
        'SELECT id, name FROM test_hole WHERE project_id = $1 AND id = ANY($2::uuid[])',
        [project.id, changes.holeSummaries.map((summary) => summary.testHoleId)],
      );
      const names = new Map(rows.map((row) => [row.id, row.name]));
      const holeErrors: FieldError[] = [];
      changes.holeSummaries.forEach((summary, index) => {
        if (!names.has(summary.testHoleId)) {
          holeErrors.push({
            field: `changes.holeSummaries.${index}.testHoleId`,
            code: 'test_hole_not_in_project',
            message: 'test hole is not part of this project',
          });
        }
      });
      if (holeErrors.length > 0) {
        throw new UnprocessableEntityException({
          code: 'test_hole_not_in_project',
          errors: holeErrors,
        });
      }
      holeSummaries = changes.holeSummaries
        .map((summary): StorageUnitHoleSummary => ({
          ...summary,
          testHoleName: names.get(summary.testHoleId)!,
        }))
        .sort((a, b) => a.testHoleName.localeCompare(b.testHoleName));
    }

    return {
      unitType: changes.unitType ?? current.unitType,
      receivedDate: changes.receivedDate ?? current.receivedDate,
      project,
      holeSummaries,
      note: changes.note === undefined ? current.note : changes.note,
    };
  }
}
