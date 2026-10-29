import { createHash } from 'node:crypto';
import {
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  DISPOSED_AFTER_TESTING_LABEL,
  normalizeStorageUnitCode,
  testedRemovalReasonLabel,
  type ConfirmTestedRemovalRequest,
  type ConfirmTestedRemovalResponse,
  type StorageUnitTesting,
  type TestedRemovalBlocker,
  type TestedRemovalReason,
  type TestedUnitEvidence,
  type TestedUnitRemoval,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit } from '../../audit/audit.js';
import type { AuthUser } from '../../auth/policy.js';
import { DatabaseService } from '../../database/database.service.js';
import { withTransaction } from '../../db/transaction.js';

// Post-testing removal of tested Shelby tubes and tested bulk soil buckets (MM-T36).
//
// Testing evidence is MM-T24's exact-unit completion link (test_request_unit_link), never a
// shared project, source, group, receipt, coverage or sibling's test, and never a cancelled
// request. Removal is a separate personal-account confirmation that the whole unit physically
// left the lab: it disposes the unit with "Disposed after testing", keeps its last saved
// location as history (so it no longer occupies it or counts as Current stock) and blocks any
// further test allocation. This route ignores retention, extensions and holds, disposal
// approval, the standard disposal scan and program closure, and it never changes a test
// request, review, acceptance or program.
//
// Lock order (as moves, corrections and lab completion): the storage unit FOR UPDATE first,
// then the test request FOR SHARE. A completion that is linking the unit holds it FOR SHARE, so
// removal and a new link never interleave; the database refuses a link to a disposed unit too.

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function intentHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function unprocessable(code: string, field: string, message: string): never {
  throw new UnprocessableEntityException({ code, message, errors: [{ field, code, message }] });
}

interface UnitRow {
  id: string;
  readable_id: string;
  project_id: string;
  unit_type: 'bucket' | 'shelby_tube' | 'bulk_container';
  bulk_group_id: string | null;
  status: 'in_stock' | 'approved_for_disposal' | 'disposed';
  version: number;
  current_location_id: string;
  location_code: string;
  location_name: string;
}

/** The post-testing exception a unit would use; ordinary buckets never qualify. */
export function testedRemovalReason(unit: {
  unit_type: string;
  bulk_group_id: string | null;
}): TestedRemovalReason | null {
  if (unit.unit_type === 'shelby_tube') return 'tested_shelby';
  if (unit.unit_type === 'bulk_container' && unit.bulk_group_id !== null) return 'tested_bulk';
  return null;
}

interface EvidenceRow {
  link_id: string;
  test_request_id: string;
  program_id: string;
  program_number: string;
  program_project_id: string;
  link_project_id: string;
  test_code: string;
  request_status: string;
  completion_event_id: string;
  completed_at: Date;
  account_user_id: string;
  account_type: 'personal' | 'shared_lab' | 'test';
  account_initials_snapshot: string | null;
  account_name_snapshot: string;
  person_user_id: string;
  person_initials_snapshot: string | null;
  person_name_snapshot: string;
  coverage_basis: 'frozen_coverage' | 'same_source_confirmed';
  confirmed_by_person_user_id: string | null;
  confirmed_by_person_initials_snapshot: string | null;
  confirmed_by_person_name_snapshot: string | null;
  confirmed_at: Date | null;
}

/**
 * Completed tests that linked this exact unit, oldest first. A cancelled request (MM-T26) is not
 * evidence. A request moved on since (review, acceptance, a later reset) still is: the physical
 * testing happened.
 */
async function loadEvidence(db: Db, storageUnitId: string, testRequestId?: string) {
  const { rows } = await db.query<EvidenceRow>(
    `SELECT l.id AS link_id, l.test_request_id, lp.id AS program_id, lp.program_number,
            lp.project_id AS program_project_id, l.project_id AS link_project_id,
            r.test_code_snapshot AS test_code, r.status AS request_status,
            h.id AS completion_event_id, h.changed_at AS completed_at, h.account_user_id,
            h.account_type, h.account_initials_snapshot, h.account_name_snapshot,
            h.person_user_id, h.person_initials_snapshot, h.person_name_snapshot,
            -- MM-T73: a confirmed same-source link (outside the line's coverage) is evidence too.
            l.coverage_basis, l.confirmed_by_person_user_id,
            l.confirmed_by_person_initials_snapshot, l.confirmed_by_person_name_snapshot,
            l.confirmed_at
     FROM test_request_unit_link l
     JOIN test_request_status_history h ON h.id = l.status_history_id AND h.to_status = 'completed'
     JOIN test_request r ON r.id = l.test_request_id
     JOIN lab_program lp ON lp.id = r.program_id
     WHERE l.storage_unit_id = $1 AND r.status <> 'cancelled'
       ${testRequestId ? 'AND l.test_request_id = $2' : ''}
     ORDER BY h.changed_at, h.id`,
    testRequestId ? [storageUnitId, testRequestId] : [storageUnitId],
  );
  return rows;
}

function toEvidence(row: EvidenceRow): TestedUnitEvidence {
  return {
    testRequestId: row.test_request_id,
    programId: row.program_id,
    programNumber: row.program_number,
    testCode: row.test_code,
    requestStatus: row.request_status,
    completionEventId: row.completion_event_id,
    completedAt: row.completed_at.toISOString(),
    completedBy: {
      account: {
        userId: row.account_user_id,
        accountType: row.account_type,
        initials: row.account_initials_snapshot,
        name: row.account_name_snapshot,
      },
      person: {
        userId: row.person_user_id,
        initials: row.person_initials_snapshot,
        name: row.person_name_snapshot,
      },
    },
    sameSourceConfirmation:
      row.coverage_basis === 'same_source_confirmed'
        ? {
            person: {
              userId: row.confirmed_by_person_user_id!,
              initials: row.confirmed_by_person_initials_snapshot,
              name: row.confirmed_by_person_name_snapshot!,
            },
            confirmedAt: row.confirmed_at!.toISOString(),
          }
        : null,
  };
}

interface RemovalRow {
  id: string;
  storage_unit_id: string;
  reason: TestedRemovalReason;
  test_request_id: string;
  program_number_snapshot: string;
  test_code_snapshot: string;
  previous_status: 'in_stock' | 'approved_for_disposal';
  location_id: string;
  location_code_snapshot: string;
  location_name_snapshot: string;
  removed_by_user_id: string;
  removed_by_initials_snapshot: string | null;
  removed_by_name_snapshot: string;
  removed_at: Date;
  request_hash: string;
}

const REMOVAL_COLUMNS = `id, storage_unit_id, reason, test_request_id, program_number_snapshot,
  test_code_snapshot, previous_status, location_id, location_code_snapshot, location_name_snapshot,
  removed_by_user_id, removed_by_initials_snapshot, removed_by_name_snapshot, removed_at,
  request_hash`;

function toRemoval(row: RemovalRow): TestedUnitRemoval {
  return {
    id: row.id,
    reason: row.reason,
    testRequestId: row.test_request_id,
    programNumber: row.program_number_snapshot,
    testCode: row.test_code_snapshot,
    previousStatus: row.previous_status,
    location: {
      id: row.location_id,
      code: row.location_code_snapshot,
      name: row.location_name_snapshot,
    },
    removedBy: {
      userId: row.removed_by_user_id,
      initials: row.removed_by_initials_snapshot,
      name: row.removed_by_name_snapshot,
    },
    removedAt: row.removed_at.toISOString(),
  };
}

async function loadRemoval(db: Db, storageUnitId: string): Promise<RemovalRow | null> {
  const { rows } = await db.query<RemovalRow>(
    `SELECT ${REMOVAL_COLUMNS} FROM tested_unit_removal WHERE storage_unit_id = $1`,
    [storageUnitId],
  );
  return rows[0] ?? null;
}

async function hasOpenConflict(db: Db, storageUnitId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM location_conflict WHERE storage_unit_id = $1 AND status = 'open'`,
    [storageUnitId],
  );
  return rows.length > 0;
}

/** Evidence, contents and removal state of one unit, for its detail page. */
export async function loadStorageUnitTesting(
  db: Db,
  unit: { id: string; unit_type: string; bulk_group_id: string | null; status: string },
): Promise<StorageUnitTesting> {
  const reason = testedRemovalReason(unit);
  const evidence = await loadEvidence(db, unit.id);
  const removal = await loadRemoval(db, unit.id);
  let blocker: TestedRemovalBlocker | null = null;
  if (removal) blocker = 'already_removed';
  else if (reason === null) blocker = 'not_eligible_unit_type';
  else if (unit.status === 'disposed') blocker = 'storage_unit_disposed';
  else if (evidence.length === 0) blocker = 'no_tested_evidence';
  else if (await hasOpenConflict(db, unit.id)) blocker = 'location_conflict_open';
  return {
    reason,
    contentsDestroyed: unit.unit_type === 'shelby_tube' && evidence.length > 0,
    evidence: evidence.map(toEvidence),
    removal: removal && toRemoval(removal),
    blocker,
  };
}

function response(
  unit: UnitRow,
  version: number,
  removal: RemovalRow,
  replayed: boolean,
): ConfirmTestedRemovalResponse {
  return {
    storageUnitId: unit.id,
    readableId: unit.readable_id,
    status: 'disposed',
    version,
    removal: toRemoval(removal),
    replayed,
  };
}

@Injectable()
export class TestedRemovalService {
  constructor(private readonly database: DatabaseService) {}

  /**
   * Records the confirmed physical removal of a tested unit. 404 unknown unit; 409 stale version
   * (`version_conflict`), already removed (`already_removed`, with that removal), an open location
   * conflict (`location_conflict_open`) or a reused retry key; 422 for an ineligible unit, missing
   * or mismatched evidence, or a unit disposed some other way. An exact retry returns the original
   * result (`replayed: true`).
   */
  async confirm(
    idOrCode: string,
    request: ConfirmTestedRemovalRequest,
    user: AuthUser,
    requestId: string | null,
  ): Promise<ConfirmTestedRemovalResponse> {
    return withTransaction(this.database.pool, async (client) => {
      const unit = await this.lockUnit(client, idOrCode);
      if (!unit) throw new NotFoundException({ code: 'storage_unit_not_found' });
      const hash = intentHash({
        storageUnitId: unit.id,
        testRequestId: request.testRequestId,
        version: request.version,
      });

      const { rows: previous } = await client.query<RemovalRow>(
        `SELECT ${REMOVAL_COLUMNS} FROM tested_unit_removal WHERE idempotency_key = $1`,
        [request.idempotencyKey],
      );
      if (previous[0]) {
        if (previous[0].request_hash !== hash || previous[0].removed_by_user_id !== user.userId) {
          throw new ConflictException({ code: 'idempotency_key_reused' });
        }
        return response(unit, unit.version, previous[0], true);
      }

      const existing = await loadRemoval(client, unit.id);
      if (existing) {
        throw new ConflictException({
          code: 'already_removed',
          message: `${unit.readable_id} was already removed after testing.`,
          removal: toRemoval(existing),
        });
      }
      const reason = testedRemovalReason(unit);
      if (reason === null) {
        unprocessable(
          'not_eligible_unit_type',
          'id',
          'only a tested Shelby tube or a tested bulk soil bucket can be removed after testing',
        );
      }
      if (unit.status === 'disposed') {
        unprocessable('storage_unit_disposed', 'id', `${unit.readable_id} is already disposed`);
      }
      if (unit.version !== request.version) {
        throw new ConflictException({
          code: 'version_conflict',
          current: { storageUnitId: unit.id, status: unit.status, version: unit.version },
        });
      }

      await client.query('SELECT id FROM test_request WHERE id = $1 FOR SHARE', [
        request.testRequestId,
      ]);
      const evidence = (await loadEvidence(client, unit.id, request.testRequestId))[0];
      if (!evidence) {
        unprocessable(
          'no_tested_evidence',
          'testRequestId',
          `that test has no completion linked to ${unit.readable_id}`,
        );
      }
      if (
        evidence.link_project_id !== unit.project_id ||
        evidence.program_project_id !== unit.project_id
      ) {
        unprocessable('no_tested_evidence', 'testRequestId', 'that test is in another project');
      }
      if (await hasOpenConflict(client, unit.id)) {
        throw new ConflictException({
          code: 'location_conflict_open',
          message: `Confirm ${unit.readable_id}’s actual location before recording its removal.`,
        });
      }

      const { rows: updated } = await client.query<{ version: number }>(
        `UPDATE storage_unit SET status = 'disposed', version = version + 1, updated_at = now(),
                disposed_at = now(), disposed_by_user_id = $2
         WHERE id = $1 RETURNING version`,
        [unit.id, user.userId],
      );
      // An earlier standard approval (MM-T30) is used up by this disposition, not left live, and
      // that use is audited in the same transaction (MM-T71).
      const { rows: used } = await client.query<{
        id: string;
        batch_id: string;
        project_id: string;
        approved_by_user_id: string;
        approved_by_name_snapshot: string;
        approved_at: Date;
      }>(
        `UPDATE disposal_approval SET used_at = now()
         WHERE storage_unit_id = $1 AND revoked_at IS NULL AND used_at IS NULL
         RETURNING id, batch_id, project_id, approved_by_user_id, approved_by_name_snapshot,
                   approved_at`,
        [unit.id],
      );
      for (const approval of used) {
        await recordAudit(client, {
          action: 'disposal.approval_used',
          entityType: 'storage_unit',
          entityId: unit.id,
          actor: {
            userId: user.userId,
            accountType: user.accountType,
            initials: user.initials,
            name: user.displayName,
          },
          reason: `Used by ${DISPOSED_AFTER_TESTING_LABEL.toLowerCase()}`,
          before: { approvalId: approval.id, live: true },
          after: {
            approvalId: approval.id,
            batchId: approval.batch_id,
            projectId: approval.project_id,
            approvedByUserId: approval.approved_by_user_id,
            approvedByName: approval.approved_by_name_snapshot,
            approvedAt: approval.approved_at.toISOString(),
            usedBy: 'tested_removal',
          },
          requestId,
        });
      }
      const { rows: inserted } = await client.query<RemovalRow>(
        `INSERT INTO tested_unit_removal
           (storage_unit_id, project_id, unit_readable_id_snapshot, unit_type_snapshot,
            bulk_group_id_snapshot, reason, test_request_id, unit_link_id, completion_event_id,
            program_number_snapshot, test_code_snapshot, previous_status, location_id,
            location_code_snapshot, location_name_snapshot, removed_by_user_id,
            removed_by_account_type, removed_by_initials_snapshot, removed_by_name_snapshot,
            physical_removal_confirmed, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18,
                 $19, true, $20, $21)
         RETURNING ${REMOVAL_COLUMNS}`,
        [
          unit.id,
          unit.project_id,
          unit.readable_id,
          unit.unit_type,
          reason === 'tested_bulk' ? unit.bulk_group_id : null,
          reason,
          evidence.test_request_id,
          evidence.link_id,
          evidence.completion_event_id,
          evidence.program_number,
          evidence.test_code,
          unit.status,
          unit.current_location_id,
          unit.location_code,
          unit.location_name,
          user.userId,
          user.accountType,
          user.initials,
          user.displayName,
          request.idempotencyKey,
          hash,
        ],
      );
      const removal = inserted[0]!;
      await recordAudit(client, {
        action: 'disposal.removed',
        entityType: 'storage_unit',
        entityId: unit.id,
        actor: {
          userId: user.userId,
          accountType: user.accountType,
          initials: user.initials,
          name: user.displayName,
        },
        reason: `${DISPOSED_AFTER_TESTING_LABEL} (${testedRemovalReasonLabel(reason)})`,
        before: {
          status: unit.status,
          location: `${unit.location_name} (${unit.location_code})`,
        },
        after: {
          status: 'disposed',
          disposalReason: reason,
          readableId: unit.readable_id,
          programNumber: evidence.program_number,
          test: evidence.test_code,
          testRequestId: evidence.test_request_id,
          completedAt: evidence.completed_at.toISOString(),
        },
        requestId,
      });
      return response(unit, updated[0]!.version, removal, false);
    });
  }

  private async lockUnit(client: PoolClient, idOrCode: string): Promise<UnitRow | null> {
    const byUuid = UUID_PATTERN.test(idOrCode);
    const { rows } = await client.query<UnitRow>(
      `SELECT su.id, su.readable_id, su.project_id, su.unit_type, su.bulk_group_id, su.status,
              su.version, su.current_location_id, l.code AS location_code,
              l.name AS location_name
       FROM storage_unit su JOIN location l ON l.id = su.current_location_id
       WHERE ${byUuid ? 'su.id' : 'su.readable_id'} = $1
       FOR UPDATE OF su`,
      [byUuid ? idOrCode : normalizeStorageUnitCode(idOrCode)],
    );
    return rows[0] ?? null;
  }
}
