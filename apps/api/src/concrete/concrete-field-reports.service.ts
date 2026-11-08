import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_DUPLICATE_TICKET_LIMIT,
  CONCRETE_FIELD_REPORT_DEFERRED_CHECKS,
  CONCRETE_READING_TESTS,
  CONCRETE_REPORT_SPEC_EMPTY,
  concreteFieldReportCompleteness,
  concreteFieldReportListQuerySchema,
  concreteAttachmentRefSchema,
  concreteFieldReportWarnings,
  concreteMixSnapshotSchema,
  concreteReportManualSpecChanges,
  concreteReportSpecColumnSchema,
  concreteReportSpecFromMix,
  concreteEquipmentUseSchema,
  createConcreteFieldReportRequestSchema,
  saveConcreteFieldReportRequestSchema,
  type ConcreteDuplicateTicket,
  type ConcreteEquipmentUse,
  type ConcreteFieldReading,
  type ConcreteFieldReportDetail,
  type ConcreteFieldReportDraftField,
  type ConcreteFieldReportFields,
  type ConcreteFieldReportList,
  type ConcreteFieldReportWarning,
  type ConcreteFieldReviewRouting,
  type ConcreteMixSnapshot,
  type ConcreteReportSpecColumn,
  type PersonSnapshot,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import type { z } from 'zod';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { receiverOf, resolveActingPerson } from '../lab/attribution.js';
import {
  designatedReviewers,
  findProject,
  intentHash,
} from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { evaluateEquipmentUse } from './concrete-equipment.service.js';
import { reportLifecycle } from './concrete-report-lifecycle.read.js';
import { captureMixSnapshot } from './concrete-mixes.service.js';
import { specimenSetSummaries } from './concrete-specimen-sets.service.js';

type Db = Pool | PoolClient;
type Kind = 'create' | 'save';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'concrete_field_report';
const REVIEW_SCOPE = 'concrete_field';
const PERMISSION = 'concrete_report.draft' as const;
/** MM-V2-C09: states a technician edits in (a returned report is corrected like a draft). */
const EDITABLE_STATES: readonly string[] = ['draft', 'returned'];

type ColumnKind = 'text' | 'number' | 'date' | 'timestamp' | 'boolean' | 'array' | 'uuid';

/** Draft field → column and how it is stored (all nullable; arrays default to '{}'). */
const COLUMNS: Record<ConcreteFieldReportDraftField, [string, ColumnKind]> = {
  reportDate: ['report_date', 'date'],
  contractorName: ['contractor_name', 'text'],
  paperFieldId: ['paper_field_id', 'text'],
  locationElements: ['location_elements', 'array'],
  locationElementOther: ['location_element_other', 'text'],
  locationDescription: ['location_description', 'text'],
  supplierName: ['supplier_name', 'text'],
  mixNumber: ['mix_number', 'text'],
  ticketNumber: ['ticket_number', 'text'],
  truckNumber: ['truck_number', 'text'],
  plantName: ['plant_name', 'text'],
  batchedAt: ['batched_at', 'timestamp'],
  loadVolumeM3: ['load_volume_m3', 'number'],
  cumulativeVolumeM3: ['cumulative_volume_m3', 'number'],
  arrivedAt: ['arrived_at', 'timestamp'],
  sampledAt: ['sampled_at', 'timestamp'],
  testedAt: ['tested_at', 'timestamp'],
  castAt: ['cast_at', 'timestamp'],
  timeLimitExceeded: ['time_limit_exceeded', 'boolean'],
  timeLimitInformed: ['time_limit_informed', 'text'],
  loadRejected: ['load_rejected', 'boolean'],
  loadDecisionByName: ['load_decision_by_name', 'text'],
  loadDecisionByCompany: ['load_decision_by_company', 'text'],
  samplingLocation: ['sampling_location', 'text'],
  samplingLocationOther: ['sampling_location_other', 'text'],
  placementMethods: ['placement_methods', 'array'],
  placementMethodOther: ['placement_method_other', 'text'],
  material: ['material', 'text'],
  superplasticizerAdded: ['superplasticizer_added', 'text'],
  unitWeightKgM3: ['unit_weight_kg_m3', 'number'],
  concreteTempC: ['concrete_temp_c', 'number'],
  ambientTempC: ['ambient_temp_c', 'number'],
  waterAdded: ['water_added', 'boolean'],
  waterAddedAuthorizedBy: ['water_added_authorized_by', 'text'],
  specimensCast: ['specimens_cast', 'boolean'],
  airMeterEquipmentId: ['air_meter_equipment_id', 'uuid'],
  comments: ['comments', 'text'],
  resultsReportedToName: ['results_reported_to_name', 'text'],
  resultsReportedToCompany: ['results_reported_to_company', 'text'],
};
const DRAFT_FIELDS = Object.keys(COLUMNS) as ConcreteFieldReportDraftField[];

function selectColumn([column, kind]: [string, ColumnKind]): string {
  return kind === 'date' ? `r.${column}::text AS ${column}` : `r.${column}`;
}

const SELECT_REPORT = `SELECT r.id, r.project_id, p.project_number, p.name AS project_name, p.client,
         p.lead_project_engineer_user_id, r.created_by_user_id, r.technician_user_id,
         r.workflow_state, r.ready_to_submit_at, r.submitted_at, r.issue_count,
         r.last_issued_version, r.last_issued_at, r.last_issued_by_user_id, r.created_at,
         r.updated_at, r.version, r.mix_id, r.mix_snapshot, r.project_spec, r.ticket_spec,
         r.air_meter_use, r.attachment_refs, r.lab_manager_corrected_by_user_id,
         ${Object.values(COLUMNS).map(selectColumn).join(', ')}
  FROM concrete_field_report r JOIN project p ON p.id = r.project_id`;

export type ReportRow = Record<string, unknown> & {
  id: string;
  project_id: string;
  project_number: string;
  project_name: string;
  client: string;
  lead_project_engineer_user_id: string | null;
  created_by_user_id: string;
  technician_user_id: string | null;
  workflow_state: ConcreteFieldReportDetail['workflow']['state'];
  ready_to_submit_at: Date | null;
  submitted_at: Date | null;
  issue_count: number;
  last_issued_version: number | null;
  last_issued_at: Date | null;
  last_issued_by_user_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  mix_id: string | null;
  mix_snapshot: unknown;
  project_spec: unknown;
  ticket_spec: unknown;
  air_meter_use: unknown;
  attachment_refs: unknown;
  lab_manager_corrected_by_user_id: string | null;
};

interface ReadingRow {
  id: string;
  field_report_id: string;
  test: ConcreteFieldReading['test'];
  context: ConcreteFieldReading['context'];
  position: number;
  value: string | null;
  measured_at: Date | null;
  note: string | null;
}

type DraftValues = Omit<ConcreteFieldReportFields, 'readings'> & {
  readings: Omit<ConcreteFieldReading, 'position'>[];
};

function fromColumn(kind: ColumnKind, value: unknown): unknown {
  if (value === null || value === undefined) return kind === 'array' ? [] : null;
  if (kind === 'number') return Number(value);
  if (kind === 'timestamp') return (value as Date).toISOString();
  return value;
}

function fieldsOf(row: ReportRow, readings: ReadingRow[]): ConcreteFieldReportFields {
  const fields = Object.fromEntries(
    DRAFT_FIELDS.map((field) => {
      const [column, kind] = COLUMNS[field];
      return [field, fromColumn(kind, row[column])];
    }),
  ) as unknown as ConcreteFieldReportFields;
  return {
    ...fields,
    mixId: row.mix_id,
    projectSpec: concreteReportSpecColumnSchema.parse(row.project_spec),
    ticketSpec: concreteReportSpecColumnSchema.parse(row.ticket_spec),
    readings: readings
      .filter((r) => r.field_report_id === row.id)
      .sort(
        (a, b) =>
          CONCRETE_READING_TESTS.indexOf(a.test) - CONCRETE_READING_TESTS.indexOf(b.test) ||
          a.position - b.position,
      )
      .map((r) => ({
        id: r.id,
        test: r.test,
        context: r.context,
        position: r.position,
        value: r.value === null ? null : Number(r.value),
        measuredAt: r.measured_at?.toISOString() ?? null,
        note: r.note,
      })),
    attachmentRefs: concreteAttachmentRefSchema.array().parse(row.attachment_refs),
  };
}

function snapshotOf(row: ReportRow): ConcreteMixSnapshot | null {
  return row.mix_snapshot ? concreteMixSnapshotSchema.parse(row.mix_snapshot) : null;
}

function useOf(row: ReportRow): ConcreteEquipmentUse | null {
  return row.air_meter_use ? concreteEquipmentUseSchema.parse(row.air_meter_use) : null;
}

/** Instants as the database returns them, so an unchanged time never looks changed. */
const instant = (value: string | null) => (value === null ? null : new Date(value).toISOString());

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function mergeSpec(
  base: ConcreteReportSpecColumn,
  patch: z.output<typeof saveConcreteFieldReportRequestSchema>['projectSpec'],
): ConcreteReportSpecColumn {
  if (!patch) return base;
  const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
  const merged = concreteReportSpecColumnSchema.safeParse({ ...base, ...defined });
  if (!merged.success) {
    unprocessable(
      'invalid_specification',
      merged.error.issues.map((issue) => ({ field: issue.path.join('.'), message: issue.message })),
    );
  }
  return merged.data;
}

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

const forbidden = (code = 'forbidden') => new ForbiddenException({ code });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

type ParsedSave = z.output<typeof saveConcreteFieldReportRequestSchema>;
type Changes = Omit<ParsedSave, 'idempotencyKey' | 'version' | 'technicianUserId'>;

/**
 * Concrete field-report drafts (MM-V2-C04). Reads follow the project (`inventory.read`, LAB
 * included). Writes need `concrete_report.draft` (C10: any active internal user on any project,
 * and LAB with the performing staff member selected), checked before any lock or transaction and
 * again under the D09 locks. The technician credited is always the acting person (LAB: the
 * selected person, never LAB itself), and a person saves only their own drafts (CD-58).
 *
 * Each write is one transaction in the D09 lock order: the report FOR UPDATE (save), the chosen
 * mix FOR SHARE (a domain row read for its snapshot), then the project and the actor's account
 * FOR SHARE (`canUnderLock`), then the performing person's account FOR SHARE. Then the
 * idempotency ledger, the version check, the write, its readings, the ledger row and the audit
 * event, all or nothing. Nothing here writes the mix registry, sets, specimens or settings.
 */
@Injectable()
export class ConcreteFieldReportsService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(projectId: string, rawQuery: unknown): Promise<ConcreteFieldReportList> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    const query = parseBody(concreteFieldReportListQuerySchema, rawQuery);
    const params: unknown[] = [project.id];
    const where = ['r.project_id = $1'];
    if (query.state) {
      params.push(query.state);
      where.push(`r.workflow_state = $${params.length}`);
    }
    if (query.technicianUserId) {
      params.push(query.technicianUserId);
      where.push(`r.technician_user_id = $${params.length}`);
    }
    const whereSql = where.join(' AND ');
    const { rows: total } = await this.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM concrete_field_report r WHERE ${whereSql}`,
      params,
    );
    const { rows } = await this.database.pool.query<ReportRow>(
      `${SELECT_REPORT} WHERE ${whereSql}
       ORDER BY r.report_date DESC NULLS LAST, r.created_at DESC, r.id
       LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params,
    );
    const readings = await readingsFor(
      this.database.pool,
      rows.map((r) => r.id),
    );
    const people = await peopleFor(
      this.database.pool,
      rows.map((r) => r.technician_user_id).filter((id): id is string => id !== null),
    );
    const sets = await specimenSetSummaries(
      this.database.pool,
      rows.map((r) => r.id),
    );
    return {
      projectId: project.id,
      items: rows.map((row) => {
        const fields = fieldsOf(row, readings);
        return {
          id: row.id,
          projectId: row.project_id,
          reportDate: fields.reportDate,
          technician: row.technician_user_id ? (people.get(row.technician_user_id) ?? null) : null,
          supplierName: fields.supplierName,
          mixNumber: fields.mixNumber,
          ticketNumber: fields.ticketNumber,
          workflowState: row.workflow_state,
          completeness: concreteFieldReportCompleteness({
            technicianUserId: row.technician_user_id,
            fields,
            mixSnapshot: snapshotOf(row),
            specimenSets: sets.get(row.id) ?? [],
          }),
          version: row.version,
          createdAt: row.created_at.toISOString(),
          updatedAt: row.updated_at.toISOString(),
        };
      }),
      total: total[0]!.n,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async get(reportId: string, user: AuthUser): Promise<ConcreteFieldReportDetail> {
    const report = await findReport(this.database.pool, reportId);
    if (!report) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
    return this.detail(this.database.pool, report, user);
  }

  // -------------------------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------------------------

  async create(
    projectId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteFieldReportDetail> {
    // Authority first: before the body, any lock or the transaction.
    if (!can(user, PERMISSION)) throw forbidden();
    const input = parseBody(createConcreteFieldReportRequestSchema, body);
    const hash = intentHash({ kind: 'create', projectId, ...withoutKey(input) });
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const project = await findProject(client, projectId);
        if (!project) throw new NotFoundException({ code: 'project_not_found' });
        const replay = await this.replay(client, input.idempotencyKey, 'create', null, hash, user);
        if (replay) return replay;

        const reportId = input.id ?? randomUUID();
        const empty = emptyDraft();
        const resolved = await this.resolveChanges(client, project.id, empty, null, input);
        if (!(await canUnderLock(client, user, PERMISSION, project.id))) throw forbidden();
        const person = await this.actingPerson(client, user, input.technicianUserId);

        const { rows: taken } = await client.query(
          'SELECT 1 FROM concrete_field_report WHERE id = $1',
          [reportId],
        );
        if (taken.length > 0) {
          throw new ConflictException({ code: 'report_id_taken' });
        }
        const values = resolved.values;
        const columns = ['id', 'project_id', 'created_by_user_id', 'technician_user_id'];
        const params: unknown[] = [reportId, project.id, user.userId, person.userId];
        for (const field of DRAFT_FIELDS) {
          columns.push(COLUMNS[field][0]);
          params.push(toParam(field, values));
        }
        columns.push(
          'mix_id',
          'mix_snapshot',
          'project_spec',
          'ticket_spec',
          'air_meter_use',
          'attachment_refs',
        );
        params.push(
          values.mixId,
          resolved.snapshot ? JSON.stringify(resolved.snapshot) : null,
          JSON.stringify(values.projectSpec),
          JSON.stringify(values.ticketSpec),
          resolved.airMeterUse ? JSON.stringify(resolved.airMeterUse) : null,
          JSON.stringify(values.attachmentRefs),
        );
        await client.query(
          `INSERT INTO concrete_field_report (${columns.join(', ')})
           VALUES (${params.map((_, i) => `$${i + 1}`).join(', ')})`,
          params,
        );
        await writeReadings(client, project.id, reportId, [], values.readings);
        await this.recordCommand(client, input.idempotencyKey, reportId, 'create', hash, user);
        await recordAudit(client, {
          action: 'concrete_field_report.draft_created',
          entityType: ENTITY_TYPE,
          entityId: reportId,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
          before: null,
          after: {
            version: 1,
            projectId: project.id,
            technicianUserId: person.userId,
            ...changedOnly(empty, values),
            ...(resolved.snapshot ? { mixRevisionId: resolved.snapshot.revisionId } : {}),
          },
          requestId,
        });
        return this.detail(client, (await findReport(client, reportId))!, user);
      });
    } catch (error) {
      return this.retryRace(error, input.idempotencyKey, 'create', hash, user);
    }
  }

  async save(
    reportId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteFieldReportDetail> {
    if (!can(user, PERMISSION)) throw forbidden();
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const found = await findReport(client, reportId, 'FOR UPDATE');
        if (!found) throw new NotFoundException({ code: 'concrete_field_report_not_found' });
        // A personal account is its own technician, so its ownership is known before the body.
        if (user.accountType !== 'shared_lab' && found.technician_user_id !== user.userId) {
          throw forbidden('not_own_draft');
        }
        const input = parseBody(saveConcreteFieldReportRequestSchema, body);
        const hash = intentHash({ kind: 'save', reportId: found.id, ...withoutKey(input) });
        const replay = await this.replay(
          client,
          input.idempotencyKey,
          'save',
          found.id,
          hash,
          user,
        );
        if (replay) return replay;

        const readings = await readingsFor(client, [found.id]);
        const before = fieldsOf(found, readings);
        const beforeValues: DraftValues = {
          ...before,
          readings: before.readings.map(stripPosition),
        };
        const resolved = await this.resolveChanges(
          client,
          found.project_id,
          beforeValues,
          { row: found, snapshot: snapshotOf(found) },
          input,
        );
        if (!(await canUnderLock(client, user, PERMISSION, found.project_id))) throw forbidden();
        const person = await this.actingPerson(client, user, input.technicianUserId);
        if (found.technician_user_id !== person.userId) throw forbidden('not_own_draft');
        if (input.version !== found.version) {
          throw new ConflictException({
            code: 'version_conflict',
            current: await this.detail(client, found, user),
          });
        }
        // MM-V2-C09: a report returned for correction is edited like a draft; a submitted or
        // reviewed one is locked (the database refuses it too).
        if (!EDITABLE_STATES.includes(found.workflow_state)) {
          throw new ConflictException({ code: 'not_a_draft' });
        }
        // D11: a correction saved by a Lab Manager is reviewed by the project's lead.
        const labManagerCorrection =
          found.workflow_state === 'returned' &&
          found.lab_manager_corrected_by_user_id === null &&
          (await holdsLabManagerRole(client, person.userId));

        const after = resolved.values;
        const changed = changedOnly(beforeValues, after);
        const snapshotChanged = !same(snapshotOf(found), resolved.snapshot);
        const useChanged = !same(useOf(found), resolved.airMeterUse);
        if (Object.keys(changed).length === 0 && !snapshotChanged && !useChanged) {
          await this.recordCommand(client, input.idempotencyKey, found.id, 'save', hash, user);
          return this.detail(client, found, user);
        }
        const sets: string[] = [];
        const params: unknown[] = [found.id];
        const set = (column: string, value: unknown) => {
          params.push(value);
          sets.push(`${column} = $${params.length}`);
        };
        for (const field of DRAFT_FIELDS) {
          if (field in changed) set(COLUMNS[field][0], toParam(field, after));
        }
        if (labManagerCorrection) set('lab_manager_corrected_by_user_id', person.userId);
        if ('mixId' in changed || snapshotChanged) {
          set('mix_id', after.mixId);
          set('mix_snapshot', resolved.snapshot ? JSON.stringify(resolved.snapshot) : null);
        }
        if ('projectSpec' in changed) set('project_spec', JSON.stringify(after.projectSpec));
        if ('ticketSpec' in changed) set('ticket_spec', JSON.stringify(after.ticketSpec));
        if (useChanged)
          set('air_meter_use', resolved.airMeterUse ? JSON.stringify(resolved.airMeterUse) : null);
        if ('attachmentRefs' in changed)
          set('attachment_refs', JSON.stringify(after.attachmentRefs));
        await client.query(
          `UPDATE concrete_field_report
           SET ${[...sets, 'version = version + 1', 'updated_at = now()'].join(', ')}
           WHERE id = $1`,
          params,
        );
        if ('readings' in changed) {
          await writeReadings(client, found.project_id, found.id, readings, after.readings);
        }
        await this.recordCommand(client, input.idempotencyKey, found.id, 'save', hash, user);
        await recordAudit(client, {
          action: 'concrete_field_report.draft_saved',
          entityType: ENTITY_TYPE,
          entityId: found.id,
          actor,
          receiver: user.accountType === 'shared_lab' ? receiverOf(person) : null,
          before: {
            version: found.version,
            ...pick(beforeValues, Object.keys(changed)),
            ...(snapshotChanged ? { mixRevisionId: snapshotOf(found)?.revisionId ?? null } : {}),
          },
          after: {
            version: found.version + 1,
            ...changed,
            ...(snapshotChanged ? { mixRevisionId: resolved.snapshot?.revisionId ?? null } : {}),
          },
          requestId,
        });
        return this.detail(client, (await findReport(client, found.id))!, user);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_field_report_command_pkey')) {
        throw new ConflictException({ code: 'idempotency_key_reused' });
      }
      // MM-V2-C05: once a set is numbered, casting time changes only through the recorded
      // correction (POST /api/concrete/field-reports/:id/casting-correction, AC5).
      if (isConstraint(error, 'concrete_casting_correction_required')) {
        throw new ConflictException({ code: 'casting_correction_required' });
      }
      throw error;
    }
  }

  // -------------------------------------------------------------------------------------------
  // Write plumbing
  // -------------------------------------------------------------------------------------------

  /**
   * The draft after `changes`: the mix snapshot (re-taken only when the mix changes), mix
   * defaults when asked, spec patches on top, the air meter's evaluation and the readings.
   * Validates references (mix in the project, air meter, readings owned by this report).
   */
  private async resolveChanges(
    client: PoolClient,
    projectId: string,
    base: DraftValues,
    existing: { row: ReportRow; snapshot: ConcreteMixSnapshot | null } | null,
    changes: Changes,
  ): Promise<{
    values: DraftValues;
    snapshot: ConcreteMixSnapshot | null;
    airMeterUse: ConcreteEquipmentUse | null;
  }> {
    const values: DraftValues = { ...base };
    for (const field of DRAFT_FIELDS) {
      const value = changes[field];
      if (value === undefined) continue;
      (values as Record<string, unknown>)[field] =
        COLUMNS[field][1] === 'timestamp' ? instant(value as string | null) : value;
    }

    let snapshot = existing?.snapshot ?? null;
    if (changes.mixId !== undefined && changes.mixId !== base.mixId) {
      values.mixId = changes.mixId;
      snapshot = null;
      if (changes.mixId !== null) {
        // D09: the mix is a domain row, held FOR SHARE while its snapshot is copied.
        const captured = await captureMixSnapshot(client, changes.mixId, 'FOR SHARE');
        if (!captured || captured.projectId !== projectId) {
          unprocessable('mix_not_in_project', [
            { field: 'mixId', message: "Choose a mix from this project's registry" },
          ]);
        }
        snapshot = captured.snapshot;
      }
    }
    if (changes.applyMixDefaults) {
      if (!snapshot) {
        unprocessable('no_mix_to_apply', [
          { field: 'applyMixDefaults', message: 'Choose a registry mix first' },
        ]);
      }
      const fromMix = concreteReportSpecFromMix(snapshot);
      values.projectSpec = fromMix.projectSpec;
      values.ticketSpec = fromMix.ticketSpec;
      if (changes.supplierName === undefined) values.supplierName = snapshot.spec.supplierName;
      if (changes.mixNumber === undefined) values.mixNumber = snapshot.spec.mixNumber;
      if (changes.plantName === undefined && snapshot.spec.plantNames.length === 1) {
        values.plantName = snapshot.spec.plantNames[0]!;
      }
    }
    values.projectSpec = mergeSpec(values.projectSpec, changes.projectSpec);
    values.ticketSpec = mergeSpec(values.ticketSpec, changes.ticketSpec);
    if (changes.attachmentRefs !== undefined) values.attachmentRefs = changes.attachmentRefs;

    if (changes.readings !== undefined) {
      values.readings = changes.readings.map((r) => ({
        id: r.id,
        test: r.test,
        context: r.context,
        value: r.value,
        measuredAt: instant(r.measuredAt),
        note: r.note,
      }));
      const ids = values.readings.map((r) => r.id);
      const { rows } = await client.query<{
        id: string;
        field_report_id: string;
        test: string;
        context: string;
      }>(
        'SELECT id, field_report_id, test, context FROM concrete_field_reading WHERE id = ANY($1::uuid[])',
        [ids],
      );
      for (const row of rows) {
        const index = values.readings.findIndex((r) => r.id === row.id);
        const reading = values.readings[index]!;
        if (!existing || row.field_report_id !== existing.row.id) {
          unprocessable('reading_id_taken', [
            { field: `readings.${index}.id`, message: 'This reading ID belongs to another report' },
          ]);
        }
        if (reading.test !== row.test || reading.context !== row.context) {
          unprocessable('reading_identity_fixed', [
            {
              field: `readings.${index}`,
              message: 'A saved reading keeps its test and context; remove it and add a new one',
            },
          ]);
        }
      }
    }

    // The air meter (optional, CD-45): an air meter, evaluated on the report date (C27). The
    // evaluation is re-taken when the meter or the date changes.
    let airMeterUse = existing ? useOf(existing.row) : null;
    if (
      values.airMeterEquipmentId !== base.airMeterEquipmentId ||
      values.reportDate !== base.reportDate ||
      !existing
    ) {
      airMeterUse = null;
      if (values.airMeterEquipmentId !== null) {
        const { rows } = await client.query<{ kind: string }>(
          'SELECT kind FROM concrete_equipment WHERE id = $1',
          [values.airMeterEquipmentId],
        );
        if (rows[0]?.kind !== 'air_meter') {
          unprocessable('not_an_air_meter', [
            { field: 'airMeterEquipmentId', message: 'Choose a registered air meter' },
          ]);
        }
        if (values.reportDate !== null) {
          airMeterUse = await evaluateEquipmentUse(
            client,
            values.airMeterEquipmentId,
            values.reportDate,
          );
        }
      }
    }
    return { values, snapshot, airMeterUse };
  }

  /** The person credited: LAB's selected staff member, or the personal account itself. */
  private async actingPerson(client: PoolClient, user: AuthUser, personUserId: string | undefined) {
    return resolveActingPerson(client, user, personUserId, {
      field: 'technicianUserId',
      invalidCode: 'invalid_technician',
    });
  }

  private async replay(
    client: PoolClient,
    key: string,
    kind: Kind,
    reportId: string | null,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteFieldReportDetail | null> {
    const { rows } = await client.query<{
      report_id: string;
      kind: Kind;
      request_hash: string;
      user_id: string;
    }>(
      `SELECT report_id, kind, request_hash, user_id FROM concrete_field_report_command
       WHERE idempotency_key = $1`,
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.kind !== kind ||
      previous.request_hash !== hash ||
      previous.user_id !== user.userId ||
      (reportId !== null && previous.report_id !== reportId)
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return this.detail(client, (await findReport(client, previous.report_id))!, user);
  }

  /** The same key raced itself: the other request committed first, so this is its retry. */
  private async retryRace(
    error: unknown,
    key: string,
    kind: Kind,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteFieldReportDetail> {
    if (
      isConstraint(error, 'concrete_field_report_command_pkey') ||
      isConstraint(error, 'concrete_field_report_pkey')
    ) {
      const replay = await withTransaction(this.database.pool, (client) =>
        this.replay(client, key, kind, null, hash, user),
      );
      if (replay) return replay;
      if (isConstraint(error, 'concrete_field_report_pkey')) {
        throw new ConflictException({ code: 'report_id_taken' });
      }
    }
    throw error;
  }

  private async recordCommand(
    client: PoolClient,
    key: string,
    reportId: string,
    kind: Kind,
    hash: string,
    user: AuthUser,
  ) {
    await client.query(
      `INSERT INTO concrete_field_report_command
         (idempotency_key, report_id, kind, request_hash, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, reportId, kind, hash, user.userId],
    );
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  /** The report's detail as the caller sees it (also the lifecycle commands' response). */
  async detailOf(db: Db, row: ReportRow, user: AuthUser): Promise<ConcreteFieldReportDetail> {
    return this.detail(db, row, user);
  }

  private async detail(db: Db, row: ReportRow, user: AuthUser): Promise<ConcreteFieldReportDetail> {
    const readings = await readingsFor(db, [row.id]);
    const fields = fieldsOf(row, readings);
    const mixSnapshot = snapshotOf(row);
    const airMeterUse = useOf(row);
    const reviewInput = {
      technicianUserId: row.technician_user_id,
      fields,
      mixSnapshot,
      // MM-V2-C05: set detail is now a real review rule (no longer a deferred check).
      specimenSets: (await specimenSetSummaries(db, [row.id])).get(row.id) ?? [],
    };
    const duplicates = await duplicateTickets(db, row.id, fields);
    const warnings: ConcreteFieldReportWarning[] = concreteFieldReportWarnings(reviewInput);
    if (duplicates.length > 0) {
      warnings.push({
        code: 'duplicate_ticket',
        field: 'ticketNumber',
        message: `This supplier and ticket are on ${duplicates.length} other report${duplicates.length === 1 ? '' : 's'} (CD-18)`,
      });
    }
    for (const flag of airMeterUse?.flags ?? []) {
      warnings.push({ code: 'air_meter_flag', field: 'airMeterEquipmentId', message: flag });
    }
    const completeness = concreteFieldReportCompleteness(reviewInput);
    const reviewerIds = await designatedReviewers(db, row.project_id, REVIEW_SCOPE);
    const people = await peopleFor(db, [
      row.created_by_user_id,
      ...(row.technician_user_id ? [row.technician_user_id] : []),
      ...(row.lead_project_engineer_user_id ? [row.lead_project_engineer_user_id] : []),
      ...reviewerIds,
    ]);
    const reviewRouting: ConcreteFieldReviewRouting = {
      scope: REVIEW_SCOPE,
      designatedReviewers: reviewerIds.map((id) => people.get(id)!).filter(Boolean),
      leadProjectEngineer: row.lead_project_engineer_user_id
        ? (people.get(row.lead_project_engineer_user_id) ?? null)
        : null,
      blocked:
        reviewerIds.length === 0 && !row.lead_project_engineer_user_id ? 'no_reviewer' : null,
    };
    return {
      id: row.id,
      projectId: row.project_id,
      projectNumber: row.project_number,
      projectName: row.project_name,
      client: row.client,
      version: row.version,
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
      createdBy: people.get(row.created_by_user_id)!,
      technician: row.technician_user_id ? (people.get(row.technician_user_id) ?? null) : null,
      workflow: {
        state: row.workflow_state,
        readyToSubmitAt: row.ready_to_submit_at?.toISOString() ?? null,
        submittedAt: row.submitted_at?.toISOString() ?? null,
      },
      issuance: {
        status: row.issue_count > 0 ? 'issued' : 'not_issued',
        issueCount: row.issue_count,
        lastIssuedVersion: row.last_issued_version,
        lastIssuedAt: row.last_issued_at?.toISOString() ?? null,
        lastIssuedByUserId: row.last_issued_by_user_id,
      },
      fields,
      mixSnapshot,
      manualSpecChanges: concreteReportManualSpecChanges(fields, mixSnapshot),
      airMeterUse,
      duplicateTickets: duplicates,
      completeness,
      review: {
        missingRequired: completeness.missingRequired,
        warnings,
        deferredChecks: CONCRETE_FIELD_REPORT_DEFERRED_CHECKS.map((c) => ({ ...c })),
      },
      reviewRouting,
      canEdit:
        can(user, PERMISSION) &&
        EDITABLE_STATES.includes(row.workflow_state) &&
        row.technician_user_id !== null &&
        (user.accountType === 'shared_lab' || row.technician_user_id === user.userId),
      lifecycle: await reportLifecycle(db, row, user),
    };
  }
}

// ---------------------------------------------------------------------------------------------

function withoutKey<T extends { idempotencyKey: string }>(input: T): Omit<T, 'idempotencyKey'> {
  const { idempotencyKey: _key, ...rest } = input;
  void _key;
  return rest;
}

function stripPosition(reading: ConcreteFieldReading): Omit<ConcreteFieldReading, 'position'> {
  const { position: _position, ...rest } = reading;
  void _position;
  return rest;
}

function emptyDraft(): DraftValues {
  const values = Object.fromEntries(
    DRAFT_FIELDS.map((field) => [field, COLUMNS[field][1] === 'array' ? [] : null]),
  ) as unknown as DraftValues;
  return {
    ...values,
    mixId: null,
    projectSpec: CONCRETE_REPORT_SPEC_EMPTY,
    ticketSpec: CONCRETE_REPORT_SPEC_EMPTY,
    readings: [],
    attachmentRefs: [],
  };
}

const COMPARED = [
  ...DRAFT_FIELDS,
  'mixId',
  'projectSpec',
  'ticketSpec',
  'readings',
  'attachmentRefs',
] as const;

/** Only the fields whose values differ (for the write and the audit event). */
function changedOnly(before: DraftValues, after: DraftValues): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of COMPARED) {
    const a = (before as Record<string, unknown>)[field];
    const b = (after as Record<string, unknown>)[field];
    if (!same(a, b)) out[field] = b;
  }
  return out;
}

function pick(values: DraftValues, keys: string[]): Record<string, unknown> {
  return Object.fromEntries(keys.map((key) => [key, (values as Record<string, unknown>)[key]]));
}

function toParam(field: ConcreteFieldReportDraftField, values: DraftValues): unknown {
  return (values as Record<string, unknown>)[field];
}

export async function findReport(
  db: Db,
  id: string,
  lock: '' | 'FOR UPDATE' = '',
): Promise<ReportRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<ReportRow>(
    `${SELECT_REPORT} WHERE r.id = $1 ${lock ? `${lock} OF r` : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function readingsFor(db: Db, reportIds: string[]): Promise<ReadingRow[]> {
  if (reportIds.length === 0) return [];
  const { rows } = await db.query<ReadingRow>(
    `SELECT id, field_report_id, test, context, position, value, measured_at, note
     FROM concrete_field_reading WHERE field_report_id = ANY($1::uuid[])
     ORDER BY field_report_id, test, position`,
    [reportIds],
  );
  return rows;
}

/**
 * Replace a report's readings with `next` (in order; positions 1… per test): rows left out are
 * removed, kept rows updated in place (their id, test and context never change), new rows added.
 * The position key is deferred, so reordering never collides mid-statement.
 */
async function writeReadings(
  client: PoolClient,
  projectId: string,
  reportId: string,
  current: ReadingRow[],
  next: Omit<ConcreteFieldReading, 'position'>[],
) {
  const keep = new Set(next.map((r) => r.id));
  const removed = current.filter((r) => !keep.has(r.id)).map((r) => r.id);
  if (removed.length > 0) {
    await client.query('DELETE FROM concrete_field_reading WHERE id = ANY($1::uuid[])', [removed]);
  }
  const byId = new Map(current.map((r) => [r.id, r]));
  const positions: Record<string, number> = {};
  for (const reading of next) {
    positions[reading.test] = (positions[reading.test] ?? 0) + 1;
    const position = positions[reading.test]!;
    const old = byId.get(reading.id);
    if (!old) {
      await client.query(
        `INSERT INTO concrete_field_reading
           (id, project_id, field_report_id, test, context, position, value, measured_at, note)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
        [
          reading.id,
          projectId,
          reportId,
          reading.test,
          reading.context,
          position,
          reading.value,
          reading.measuredAt,
          reading.note,
        ],
      );
      continue;
    }
    const unchanged =
      old.position === position &&
      (old.value === null ? null : Number(old.value)) === reading.value &&
      (old.measured_at?.toISOString() ?? null) === reading.measuredAt &&
      old.note === reading.note;
    if (unchanged) continue;
    await client.query(
      `UPDATE concrete_field_reading
       SET position = $2, value = $3, measured_at = $4, note = $5, version = version + 1,
           updated_at = now()
       WHERE id = $1`,
      [reading.id, position, reading.value, reading.measuredAt, reading.note],
    );
  }
}

async function peopleFor(db: Db, ids: string[]): Promise<Map<string, PersonSnapshot>> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return new Map();
  const { rows } = await db.query<{
    id: string;
    display_name: string;
    official_initials: string | null;
  }>('SELECT id, display_name, official_initials FROM app_user WHERE id = ANY($1::uuid[])', [
    unique,
  ]);
  return new Map(
    rows.map((row) => [
      row.id,
      { userId: row.id, initials: row.official_initials, name: row.display_name },
    ]),
  );
}

/**
 * Other reports with the same supplier and ticket number, ignoring case and blanks (CD-18), in any
 * project and not void. A warning only: repeat sampling of one load is legitimate.
 */
async function duplicateTickets(
  db: Db,
  reportId: string,
  fields: ConcreteFieldReportFields,
): Promise<ConcreteDuplicateTicket[]> {
  if (fields.supplierName === null || fields.ticketNumber === null) return [];
  const { rows } = await db.query<{
    id: string;
    project_id: string;
    project_number: string;
    report_date: string | null;
    technician_name: string | null;
  }>(
    `SELECT r.id, r.project_id, p.project_number, r.report_date::text AS report_date,
            u.display_name AS technician_name
     FROM concrete_field_report r
     JOIN project p ON p.id = r.project_id
     LEFT JOIN app_user u ON u.id = r.technician_user_id
     WHERE lower(btrim(r.supplier_name)) = lower(btrim($1))
       AND lower(btrim(r.ticket_number)) = lower(btrim($2))
       AND r.supplier_name IS NOT NULL AND r.ticket_number IS NOT NULL
       AND r.id <> $3 AND r.workflow_state <> 'void'
     ORDER BY r.created_at, r.id
     LIMIT ${CONCRETE_DUPLICATE_TICKET_LIMIT}`,
    [fields.supplierName, fields.ticketNumber, reportId],
  );
  return rows.map((row) => ({
    reportId: row.id,
    projectId: row.project_id,
    projectNumber: row.project_number,
    reportDate: row.report_date,
    technicianName: row.technician_name,
  }));
}

/** Whether the person holds the Lab Manager role now (D11 correction routing, MM-V2-C09). */
async function holdsLabManagerRole(db: Db, userId: string): Promise<boolean> {
  const { rows } = await db.query(
    `SELECT 1 FROM role_assignment WHERE user_id = $1 AND role = 'lab_manager'`,
    [userId],
  );
  return rows.length > 0;
}
