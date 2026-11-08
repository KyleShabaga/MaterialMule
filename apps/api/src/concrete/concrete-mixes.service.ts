import { randomUUID } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_MIX_HISTORY_LIMIT,
  CONCRETE_MIX_SPEC_DEFAULTS,
  CONCRETE_MIX_SPEC_FIELDS,
  CONCRETE_MIX_SUPPLIER_LIMIT,
  approveConcreteMixRequestSchema,
  concreteMixListQuerySchema,
  concreteMixMissingForApproval,
  concreteMixSpecSchema,
  copyConcreteMixRequestSchema,
  createConcreteMixRequestSchema,
  updateConcreteMixRequestSchema,
  type ConcreteMixDetail,
  type ConcreteMixList,
  type ConcreteMixRevision,
  type ConcreteMixSnapshot,
  type ConcreteMixSpec,
  type ConcreteMixSpecField,
  type ConcreteMixStatus,
  type ConcreteMixSummary,
  type ConcreteMixSuppliers,
  type ConcreteMixVersionConflictResponse,
  type ConcreteSpecimenAge,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser, type Permission } from '../auth/policy.js';
import { canUnderLock, lockStanding, type Standing } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { likeEscape } from '../projects/projects.service.js';
import { findProject, intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';

type Db = Pool | PoolClient;

interface ProjectFacts {
  id: string;
  lead_project_engineer_user_id: string | null;
  project_number: string;
}

interface NewMixPlan {
  input: { idempotencyKey: string };
  kind: Kind;
  hash: string;
  prepare: () => Promise<{
    spec: ConcreteMixSpec;
    copiedFromRevisionId: string | null;
    audit: {
      action: string;
      before: null;
      after: Record<string, unknown>;
      reason: string | null;
    };
  }>;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ENTITY_TYPE = 'concrete_mix';

interface MixRow {
  id: string;
  project_id: string;
  project_number: string;
  supplier_name: string;
  mix_number: string;
  effective_revision_id: string | null;
  draft_revision_id: string | null;
  copied_from_revision_id: string | null;
  created_at: Date;
  updated_at: Date;
  version: number;
  lead_project_engineer_user_id: string | null;
}

interface RevisionRow {
  id: string;
  mix_id: string;
  revision_number: number;
  state: ConcreteMixRevision['state'];
  supplier_name: string;
  mix_number: string;
  plant_names: string[];
  specified_strength_mpa: string | null;
  specified_strength_age_days: number | null;
  slump_target_mm: string | null;
  slump_tolerance_mm: string | null;
  air_min_percent: string | null;
  air_max_percent: string | null;
  max_aggregate_size_mm: string | null;
  cement_type: string | null;
  spec_admixtures: unknown;
  ticket_defaults: unknown;
  test_ages: string[];
  created_at: Date;
  created_by_user_id: string;
  created_by_initials_snapshot: string | null;
  created_by_name_snapshot: string;
  updated_at: Date;
  approved_at: Date | null;
  approved_by_user_id: string | null;
  approved_by_initials_snapshot: string | null;
  approved_by_name_snapshot: string | null;
  superseded_at: Date | null;
}

const SELECT_MIX = `SELECT m.id, m.project_id, p.project_number, m.supplier_name, m.mix_number,
         m.effective_revision_id, m.draft_revision_id, m.copied_from_revision_id, m.created_at,
         m.updated_at, m.version, p.lead_project_engineer_user_id
  FROM concrete_mix m JOIN project p ON p.id = m.project_id`;

const REVISION_COLUMNS = `id, mix_id, revision_number, state, supplier_name, mix_number,
  plant_names, specified_strength_mpa, specified_strength_age_days, slump_target_mm,
  slump_tolerance_mm, air_min_percent, air_max_percent, max_aggregate_size_mm, cement_type,
  spec_admixtures, ticket_defaults, test_ages, created_at, created_by_user_id,
  created_by_initials_snapshot, created_by_name_snapshot, updated_at, approved_at,
  approved_by_user_id, approved_by_initials_snapshot, approved_by_name_snapshot, superseded_at`;

/** Spec field → revision column (the jsonb and array columns are converted below). */
const COLUMN: Record<ConcreteMixSpecField, string> = {
  supplierName: 'supplier_name',
  mixNumber: 'mix_number',
  plantNames: 'plant_names',
  specifiedStrengthMpa: 'specified_strength_mpa',
  specifiedStrengthAgeDays: 'specified_strength_age_days',
  slumpTargetMm: 'slump_target_mm',
  slumpToleranceMm: 'slump_tolerance_mm',
  airMinPercent: 'air_min_percent',
  airMaxPercent: 'air_max_percent',
  maxAggregateSizeMm: 'max_aggregate_size_mm',
  cementType: 'cement_type',
  specAdmixtures: 'spec_admixtures',
  ticketDefaults: 'ticket_defaults',
  testAges: 'test_ages',
};

const num = (value: string | null) => (value === null ? null : Number(value));
const toAge = (value: string): ConcreteSpecimenAge =>
  value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);

function specOf(row: RevisionRow): ConcreteMixSpec {
  // Parsing fills defaults and proves the stored jsonb still matches the contract.
  return concreteMixSpecSchema.parse({
    supplierName: row.supplier_name,
    mixNumber: row.mix_number,
    plantNames: row.plant_names,
    specifiedStrengthMpa: num(row.specified_strength_mpa),
    specifiedStrengthAgeDays: row.specified_strength_age_days,
    slumpTargetMm: num(row.slump_target_mm),
    slumpToleranceMm: num(row.slump_tolerance_mm),
    airMinPercent: num(row.air_min_percent),
    airMaxPercent: num(row.air_max_percent),
    maxAggregateSizeMm: num(row.max_aggregate_size_mm),
    cementType: row.cement_type,
    specAdmixtures: row.spec_admixtures,
    ticketDefaults: row.ticket_defaults,
    testAges: row.test_ages.map(toAge),
  });
}

/** A spec value as its column parameter. */
function param(field: ConcreteMixSpecField, spec: ConcreteMixSpec): unknown {
  if (field === 'testAges') return spec.testAges.map(String);
  if (field === 'specAdmixtures' || field === 'ticketDefaults') return JSON.stringify(spec[field]);
  return spec[field];
}

function revisionOf(row: RevisionRow): ConcreteMixRevision {
  const spec = specOf(row);
  return {
    id: row.id,
    revisionNumber: row.revision_number,
    state: row.state,
    spec,
    createdAt: row.created_at.toISOString(),
    createdBy: {
      userId: row.created_by_user_id,
      initials: row.created_by_initials_snapshot,
      name: row.created_by_name_snapshot,
    },
    updatedAt: row.updated_at.toISOString(),
    approvedAt: row.approved_at?.toISOString() ?? null,
    approvedBy: row.approved_by_user_id
      ? {
          userId: row.approved_by_user_id,
          initials: row.approved_by_initials_snapshot,
          name: row.approved_by_name_snapshot ?? '',
        }
      : null,
    supersededAt: row.superseded_at?.toISOString() ?? null,
    missingForApproval: row.state === 'draft' ? concreteMixMissingForApproval(spec) : [],
  };
}

function statusOf(mix: { effective_revision_id: string | null; draft_revision_id: string | null }) {
  if (!mix.effective_revision_id) return 'unapproved' satisfies ConcreteMixStatus;
  return mix.draft_revision_id ? 'revision_pending' : 'approved';
}

function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** Who may manage or approve mixes on this project, as it stands (no fallback, AO08). */
function lead(project: { lead_project_engineer_user_id: string | null }) {
  return { leadProjectEngineerUserId: project.lead_project_engineer_user_id };
}

/**
 * For an unknown project or mix: 403 unless the caller could hold `permission` on some project,
 * i.e. leads at least one (the AO03 order of checks), then 404.
 */
async function notFoundOrForbidden(
  db: Db,
  user: AuthUser,
  permission: Permission,
  code: string,
): Promise<never> {
  const { rows } = await db.query(
    'SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1 LIMIT 1',
    [user.userId],
  );
  if (rows.length === 0 || !can(user, permission, { leadProjectEngineerUserId: user.userId })) {
    throw new ForbiddenException({ code: 'forbidden' });
  }
  throw new NotFoundException({ code });
}

const forbidden = () => new ForbiddenException({ code: 'forbidden' });

function unprocessable(code: string, errors: { field: string; message: string }[]): never {
  throw new UnprocessableEntityException({
    code,
    errors: errors.map((error) => ({ ...error, code })),
  });
}

const mixNumberTaken = () =>
  new ConflictException({
    code: 'mix_number_taken',
    errors: [
      {
        field: 'spec.mixNumber',
        code: 'mix_number_taken',
        message: 'This project already has this mix number from this supplier',
      },
    ],
  });

function isConstraint(error: unknown, constraint: string): boolean {
  return (error as { constraint?: string }).constraint === constraint;
}

type Kind = 'create' | 'edit' | 'approve' | 'copy';

/**
 * Project concrete mixes (MM-V2-C03; CD-52, D14). Reads follow the project (`inventory.read`, LAB
 * included: field preparation caches the project's mixes, CD-15). Every write is
 * `concrete_mix.manage` (create, edit, copy) or `concrete_mix.approve`, held only by the
 * project's Lead Project Engineer: no admin, Lab Manager, reviewer, delegate or issuer fallback,
 * and nobody while the project waits for a lead.
 *
 * Each write is one transaction in the D09 lock order: the mix row FOR UPDATE (a copy's source
 * FOR SHARE), then the project FOR SHARE and the actor's account FOR SHARE for the final authority
 * check (`canUnderLock`), so a lead change or disable that commits first wins. Then the
 * idempotency ledger, the version check, the write, the ledger row and the audit event, all or
 * nothing. Writes never touch field reports, specimen sets, specimens or project settings.
 */
@Injectable()
export class ConcreteMixesService {
  constructor(private readonly database: DatabaseService) {}

  // -------------------------------------------------------------------------------------------
  // Reads
  // -------------------------------------------------------------------------------------------

  async list(projectId: string, rawQuery: unknown, user: AuthUser): Promise<ConcreteMixList> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    const query = parseBody(concreteMixListQuerySchema, rawQuery);

    const params: unknown[] = [project.id];
    const where = ['m.project_id = $1'];
    if (query.supplier) {
      params.push(query.supplier.toLowerCase());
      where.push(`lower(m.supplier_name) = $${params.length}`);
    }
    if (query.search) {
      params.push(`%${likeEscape(query.search.toLowerCase())}%`);
      where.push(
        `(lower(m.mix_number) LIKE $${params.length} OR lower(m.supplier_name) LIKE $${params.length})`,
      );
    }
    if (query.status === 'unapproved') where.push('m.effective_revision_id IS NULL');
    if (query.status === 'approved') {
      where.push('m.effective_revision_id IS NOT NULL AND m.draft_revision_id IS NULL');
    }
    if (query.status === 'revision_pending') {
      where.push('m.effective_revision_id IS NOT NULL AND m.draft_revision_id IS NOT NULL');
    }
    const whereSql = where.join(' AND ');
    const { rows: total } = await this.database.pool.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM concrete_mix m WHERE ${whereSql}`,
      params,
    );
    const { rows } = await this.database.pool.query<MixRow>(
      `${SELECT_MIX} WHERE ${whereSql}
       ORDER BY lower(m.supplier_name), lower(m.mix_number) COLLATE "C", m.id
       LIMIT ${query.pageSize} OFFSET ${(query.page - 1) * query.pageSize}`,
      params,
    );
    const summaries = await this.summaries(this.database.pool, rows);
    return {
      projectId: project.id,
      items: summaries,
      total: total[0]!.n,
      page: query.page,
      pageSize: query.pageSize,
      canManage: can(user, 'concrete_mix.manage', lead(project)),
      canApprove: can(user, 'concrete_mix.approve', lead(project)),
    };
  }

  async suppliers(projectId: string): Promise<ConcreteMixSuppliers> {
    const project = await findProject(this.database.pool, projectId);
    if (!project) throw new NotFoundException({ code: 'project_not_found' });
    // One entry per supplier ignoring case, spelled as its first mix; plants from each mix's
    // latest revision (the draft, else the approved one).
    const { rows } = await this.database.pool.query<{
      supplier_name: string;
      mix_count: number;
      plant_names: string[];
    }>(
      `SELECT (array_agg(m.supplier_name ORDER BY m.created_at, m.id))[1] AS supplier_name,
              count(DISTINCT m.id)::int AS mix_count,
              coalesce(array_agg(DISTINCT plant ORDER BY plant)
                         FILTER (WHERE plant IS NOT NULL), '{}') AS plant_names
       FROM concrete_mix m
       JOIN concrete_mix_revision r
         ON r.id = coalesce(m.draft_revision_id, m.effective_revision_id)
       LEFT JOIN LATERAL unnest(r.plant_names) AS plant ON true
       WHERE m.project_id = $1
       GROUP BY lower(m.supplier_name)
       ORDER BY lower(m.supplier_name)
       LIMIT ${CONCRETE_MIX_SUPPLIER_LIMIT + 1}`,
      [project.id],
    );
    return {
      projectId: project.id,
      suppliers: rows.slice(0, CONCRETE_MIX_SUPPLIER_LIMIT).map((row) => ({
        supplierName: row.supplier_name,
        mixCount: row.mix_count,
        plantNames: row.plant_names,
      })),
      truncated: rows.length > CONCRETE_MIX_SUPPLIER_LIMIT,
    };
  }

  async get(mixId: string, user: AuthUser): Promise<ConcreteMixDetail> {
    const mix = await findMix(this.database.pool, mixId);
    if (!mix) throw new NotFoundException({ code: 'concrete_mix_not_found' });
    return this.detail(this.database.pool, mix, user);
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
  ): Promise<ConcreteMixDetail> {
    return this.newMix(projectId, user, actor, requestId, async (client, project) => {
      const input = parseBody(createConcreteMixRequestSchema, body);
      return {
        input,
        kind: 'create',
        hash: intentHash({
          kind: 'create',
          projectId: project.id,
          spec: input.spec,
          note: input.note ?? null,
        }),
        prepare: async () => {
          // CD-52 / AC1: 7 / 28 / 28 / HOLD unless the project's own default ages differ (C02);
          // given values win.
          const { rows } = await client.query<{ default_specimen_ages: string[] }>(
            'SELECT default_specimen_ages FROM concrete_project_settings WHERE project_id = $1',
            [project.id],
          );
          const testAges = rows[0]
            ? rows[0].default_specimen_ages.map(toAge)
            : [...CONCRETE_MIX_SPEC_DEFAULTS.testAges];
          const spec = concreteMixSpecSchema.parse({
            ...CONCRETE_MIX_SPEC_DEFAULTS,
            testAges,
            ...input.spec,
          });
          return {
            spec,
            copiedFromRevisionId: null,
            audit: {
              action: 'concrete_mix.created',
              before: null,
              after: { revision: 1, ...spec },
              reason: input.note ?? null,
            },
          };
        },
      };
    });
  }

  async copy(
    projectId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteMixDetail> {
    return this.newMix(projectId, user, actor, requestId, async (client, project) => {
      const input = parseBody(copyConcreteMixRequestSchema, body);
      // D09: the source is a domain row, read (FOR SHARE) before the authority check. Its
      // revisions are read only; approval never travels with a copy.
      const source = await findMix(client, input.sourceMixId, 'FOR SHARE');
      if (!source) {
        unprocessable('source_mix_not_found', [
          { field: 'sourceMixId', message: 'Choose an existing mix' },
        ]);
      }
      const revisionId =
        input.sourceRevisionId ?? source.effective_revision_id ?? source.draft_revision_id!;
      const { rows } = await client.query<RevisionRow>(
        `SELECT ${REVISION_COLUMNS} FROM concrete_mix_revision WHERE id = $1 AND mix_id = $2`,
        [revisionId, source.id],
      );
      if (!rows[0]) {
        unprocessable('invalid_source_revision', [
          { field: 'sourceRevisionId', message: 'Choose a revision of the source mix' },
        ]);
      }
      const spec = specOf(rows[0]);
      return {
        input,
        kind: 'copy',
        hash: intentHash({
          kind: 'copy',
          projectId: project.id,
          sourceMixId: source.id,
          sourceRevisionId: input.sourceRevisionId ?? null,
          note: input.note ?? null,
        }),
        prepare: async () => ({
          spec,
          copiedFromRevisionId: rows[0]!.id,
          audit: {
            action: 'concrete_mix.copied',
            before: null,
            after: {
              revision: 1,
              copiedFrom: {
                projectId: source.project_id,
                projectNumber: source.project_number,
                mixId: source.id,
                revisionId: rows[0]!.id,
                revisionNumber: rows[0]!.revision_number,
                revisionState: rows[0]!.state,
              },
              ...spec,
            },
            reason: input.note ?? null,
          },
        }),
      };
    });
  }

  async update(
    mixId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteMixDetail> {
    return this.existingMix(mixId, 'concrete_mix.manage', user, async (client, mix, editor) => {
      const input = parseBody(updateConcreteMixRequestSchema, body);
      const hash = intentHash({
        kind: 'edit',
        mixId: mix.id,
        version: input.version,
        spec: input.spec,
        note: input.note ?? null,
      });
      const replay = await this.replay(client, input.idempotencyKey, 'edit', mix.id, hash, user);
      if (replay) return replay;
      await this.checkVersion(client, mix, input.version, user);

      const draftId = mix.draft_revision_id;
      const baseId = draftId ?? mix.effective_revision_id!;
      const base = (await revisions(client, [baseId]))[0]!;
      const before = specOf(base);
      const after = concreteMixSpecSchema.safeParse({ ...before, ...input.spec });
      if (!after.success) {
        // A partial change that conflicts with the stored values (e.g. air max below min).
        unprocessable(
          'invalid_specification',
          after.error.issues.map((issue) => ({
            field: ['spec', ...issue.path].join('.'),
            message: issue.message,
          })),
        );
      }
      const changed = CONCRETE_MIX_SPEC_FIELDS.filter(
        (field) => input.spec[field] !== undefined && !same(after.data[field], before[field]),
      );
      if (changed.length === 0) {
        await this.recordCommand(client, input.idempotencyKey, mix.id, 'edit', hash, user);
        return this.detail(client, mix, user);
      }
      await this.checkNameFree(client, mix.project_id, after.data, mix.id);

      let revisionNumber = base.revision_number;
      let action = 'concrete_mix.draft_edited';
      let newDraftId = draftId;
      if (draftId) {
        await client.query(
          `UPDATE concrete_mix_revision
           SET ${changed.map((field, i) => `${COLUMN[field]} = $${i + 2}`).join(', ')},
               updated_at = now()
           WHERE id = $1`,
          [draftId, ...changed.map((field) => param(field, after.data))],
        );
      } else {
        // D14: an approved mix is never edited in place; a new draft revision starts from it and
        // the approved revision stays in effect until the Lead approves the draft.
        newDraftId = randomUUID();
        revisionNumber = base.revision_number + 1;
        action = 'concrete_mix.revision_drafted';
        await insertRevision(client, {
          id: newDraftId,
          mixId: mix.id,
          projectId: mix.project_id,
          revisionNumber,
          spec: after.data,
          by: editor,
        });
      }
      await client.query(
        `UPDATE concrete_mix
         SET draft_revision_id = $2, supplier_name = $3, mix_number = $4,
             version = version + 1, updated_at = now()
         WHERE id = $1`,
        [mix.id, newDraftId, after.data.supplierName, after.data.mixNumber],
      );
      await this.recordCommand(client, input.idempotencyKey, mix.id, 'edit', hash, user);
      await recordAudit(client, {
        action,
        entityType: ENTITY_TYPE,
        entityId: mix.id,
        actor,
        reason: input.note ?? null,
        before: {
          revision: base.revision_number,
          ...Object.fromEntries(changed.map((field) => [field, before[field]])),
        },
        after: {
          revision: revisionNumber,
          ...Object.fromEntries(changed.map((field) => [field, after.data[field]])),
        },
        requestId,
      });
      return this.detail(client, (await findMix(client, mix.id))!, user);
    });
  }

  async approve(
    mixId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteMixDetail> {
    return this.existingMix(mixId, 'concrete_mix.approve', user, async (client, mix, approver) => {
      const input = parseBody(approveConcreteMixRequestSchema, body);
      const hash = intentHash({
        kind: 'approve',
        mixId: mix.id,
        version: input.version,
        revisionId: input.revisionId,
        note: input.note ?? null,
      });
      const replay = await this.replay(client, input.idempotencyKey, 'approve', mix.id, hash, user);
      if (replay) return replay;
      await this.checkVersion(client, mix, input.version, user);
      if (mix.draft_revision_id !== input.revisionId) {
        unprocessable('revision_not_draft', [
          { field: 'revisionId', message: 'Only the open draft revision can be approved' },
        ]);
      }
      const draft = (await revisions(client, [input.revisionId]))[0]!;
      const missing = concreteMixMissingForApproval(specOf(draft));
      if (missing.length > 0) {
        unprocessable(
          'incomplete_for_approval',
          missing.map((field) => ({ field: `spec.${field}`, message: 'Required to approve' })),
        );
      }
      const previous = mix.effective_revision_id
        ? (await revisions(client, [mix.effective_revision_id]))[0]!
        : null;
      if (previous) {
        await client.query(
          `UPDATE concrete_mix_revision SET state = 'superseded', superseded_at = now(),
                  updated_at = now()
           WHERE id = $1`,
          [previous.id],
        );
      }
      await client.query(
        `UPDATE concrete_mix_revision
         SET state = 'approved', approved_at = now(), approved_by_user_id = $2,
             approved_by_initials_snapshot = $3, approved_by_name_snapshot = $4,
             updated_at = now()
         WHERE id = $1`,
        [draft.id, approver.userId, approver.initials, approver.displayName],
      );
      await client.query(
        `UPDATE concrete_mix
         SET effective_revision_id = $2, draft_revision_id = NULL, version = version + 1,
             updated_at = now()
         WHERE id = $1`,
        [mix.id, draft.id],
      );
      await this.recordCommand(client, input.idempotencyKey, mix.id, 'approve', hash, user);
      await recordAudit(client, {
        action: 'concrete_mix.approved',
        entityType: ENTITY_TYPE,
        entityId: mix.id,
        actor,
        reason: input.note ?? null,
        before: { effectiveRevision: previous?.revision_number ?? null },
        after: { effectiveRevision: draft.revision_number },
        requestId,
      });
      return this.detail(client, (await findMix(client, mix.id))!, user);
    });
  }

  // -------------------------------------------------------------------------------------------
  // Write plumbing
  // -------------------------------------------------------------------------------------------

  /** Create or copy: a new mix in `projectId` (a copy's source is its only domain row). */
  private async newMix(
    projectId: string,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
    plan: (client: PoolClient, project: ProjectFacts) => Promise<NewMixPlan>,
  ): Promise<ConcreteMixDetail> {
    let attempt: { key: string; kind: Kind; hash: string } | null = null;
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const project = await findProject(client, projectId);
        if (!project) {
          return notFoundOrForbidden(client, user, 'concrete_mix.manage', 'project_not_found');
        }
        // Authority before the body (403 before 400), against the project as it stands.
        if (!can(user, 'concrete_mix.manage', lead(project))) throw forbidden();
        const intent = await plan(client, project);
        attempt = { key: intent.input.idempotencyKey, kind: intent.kind, hash: intent.hash };
        if (!(await canUnderLock(client, user, 'concrete_mix.manage', project.id))) {
          throw forbidden();
        }
        const replay = await this.replay(client, attempt.key, intent.kind, null, intent.hash, user);
        if (replay) return replay;

        const prepared = await intent.prepare();
        await this.checkNameFree(client, project.id, prepared.spec, null);
        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        const mixId = randomUUID();
        const revisionId = randomUUID();
        await client.query(
          `INSERT INTO concrete_mix
             (id, project_id, supplier_name, mix_number, draft_revision_id,
              copied_from_revision_id, created_by_user_id, created_by_initials_snapshot,
              created_by_name_snapshot)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
          [
            mixId,
            project.id,
            prepared.spec.supplierName,
            prepared.spec.mixNumber,
            revisionId,
            prepared.copiedFromRevisionId,
            by.userId,
            by.initials,
            by.displayName,
          ],
        );
        await insertRevision(client, {
          id: revisionId,
          mixId,
          projectId: project.id,
          revisionNumber: 1,
          spec: prepared.spec,
          by,
        });
        await this.recordCommand(client, attempt.key, mixId, intent.kind, intent.hash, user);
        await recordAudit(client, {
          ...prepared.audit,
          entityType: ENTITY_TYPE,
          entityId: mixId,
          actor,
          requestId,
        });
        return this.detail(client, (await findMix(client, mixId))!, user);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_mix_project_supplier_number_key')) throw mixNumberTaken();
      // The same key raced itself: the other request committed first, so this is its retry.
      const raced = attempt as { key: string; kind: Kind; hash: string } | null;
      if (isConstraint(error, 'concrete_mix_command_pkey') && raced) {
        return withTransaction(this.database.pool, async (client) => {
          const replay = await this.replay(client, raced.key, raced.kind, null, raced.hash, user);
          if (!replay) throw error;
          return replay;
        });
      }
      throw error;
    }
  }

  /**
   * Edit or approve an existing mix: the mix row FOR UPDATE (D09 domain row), then the project and
   * the actor's account FOR SHARE (`canUnderLock`), then `work` with the actor's locked standing.
   */
  private async existingMix(
    mixId: string,
    permission: Permission,
    user: AuthUser,
    work: (client: PoolClient, mix: MixRow, by: Standing) => Promise<ConcreteMixDetail>,
  ): Promise<ConcreteMixDetail> {
    try {
      return await withTransaction(this.database.pool, async (client) => {
        const found = await findMix(client, mixId);
        if (!found) return notFoundOrForbidden(client, user, permission, 'concrete_mix_not_found');
        if (!can(user, permission, lead(found))) throw forbidden();
        await findMix(client, mixId, 'FOR UPDATE');
        if (!(await canUnderLock(client, user, permission, found.project_id))) throw forbidden();
        const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
        // The mix and its project's lead as they stand under the locks.
        return work(client, (await findMix(client, mixId))!, by);
      });
    } catch (error) {
      if (isConstraint(error, 'concrete_mix_project_supplier_number_key')) throw mixNumberTaken();
      throw error;
    }
  }

  private async replay(
    client: PoolClient,
    key: string,
    kind: Kind,
    mixId: string | null,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteMixDetail | null> {
    const { rows } = await client.query<{
      mix_id: string;
      kind: Kind;
      request_hash: string;
      user_id: string;
    }>(
      'SELECT mix_id, kind, request_hash, user_id FROM concrete_mix_command WHERE idempotency_key = $1',
      [key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.kind !== kind ||
      previous.request_hash !== hash ||
      previous.user_id !== user.userId ||
      (mixId !== null && previous.mix_id !== mixId)
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return this.detail(client, (await findMix(client, previous.mix_id))!, user);
  }

  private async recordCommand(
    client: PoolClient,
    key: string,
    mixId: string,
    kind: Kind,
    hash: string,
    user: AuthUser,
  ): Promise<void> {
    await client.query(
      `INSERT INTO concrete_mix_command (idempotency_key, mix_id, kind, request_hash, user_id)
       VALUES ($1, $2, $3, $4, $5)`,
      [key, mixId, kind, hash, user.userId],
    );
  }

  private async checkVersion(client: PoolClient, mix: MixRow, version: number, user: AuthUser) {
    if (version !== mix.version) {
      throw new ConflictException({
        code: 'version_conflict',
        current: await this.detail(client, mix, user),
      } satisfies ConcreteMixVersionConflictResponse);
    }
  }

  private async checkNameFree(
    client: PoolClient,
    projectId: string,
    spec: Pick<ConcreteMixSpec, 'supplierName' | 'mixNumber'>,
    exceptMixId: string | null,
  ) {
    const { rows } = await client.query(
      `SELECT 1 FROM concrete_mix
       WHERE project_id = $1 AND lower(supplier_name) = lower($2) AND lower(mix_number) = lower($3)
         AND id IS DISTINCT FROM $4`,
      [projectId, spec.supplierName, spec.mixNumber, exceptMixId],
    );
    if (rows.length > 0) throw mixNumberTaken();
  }

  // -------------------------------------------------------------------------------------------
  // Views
  // -------------------------------------------------------------------------------------------

  private async summaries(db: Db, mixes: MixRow[]): Promise<ConcreteMixSummary[]> {
    const ids = mixes.flatMap((m) =>
      [m.effective_revision_id, m.draft_revision_id].filter((id): id is string => id !== null),
    );
    const byId = new Map((await revisions(db, ids)).map((row) => [row.id, revisionOf(row)]));
    const sources = await copySources(
      db,
      mixes.map((m) => m.copied_from_revision_id).filter((id): id is string => id !== null),
    );
    return mixes.map((mix) => ({
      id: mix.id,
      projectId: mix.project_id,
      supplierName: mix.supplier_name,
      mixNumber: mix.mix_number,
      status: statusOf(mix),
      effectiveRevision: mix.effective_revision_id ? byId.get(mix.effective_revision_id)! : null,
      draftRevision: mix.draft_revision_id ? byId.get(mix.draft_revision_id)! : null,
      copiedFrom: mix.copied_from_revision_id
        ? (sources.get(mix.copied_from_revision_id) ?? null)
        : null,
      version: mix.version,
      createdAt: mix.created_at.toISOString(),
      updatedAt: mix.updated_at.toISOString(),
    }));
  }

  private async detail(db: Db, mix: MixRow, user: AuthUser): Promise<ConcreteMixDetail> {
    const [summary] = await this.summaries(db, [mix]);
    const { rows: all } = await db.query<RevisionRow>(
      `SELECT ${REVISION_COLUMNS} FROM concrete_mix_revision WHERE mix_id = $1
       ORDER BY revision_number DESC`,
      [mix.id],
    );
    const { rows: history } = await db.query<{
      id: string;
      action: string;
      occurred_at: Date;
      actor_user_id: string | null;
      actor_initials_snapshot: string | null;
      actor_name_snapshot: string | null;
      reason: string | null;
      before_values: Record<string, unknown> | null;
      after_values: Record<string, unknown> | null;
    }>(
      `SELECT id, action, occurred_at, actor_user_id, actor_initials_snapshot, actor_name_snapshot,
              reason, before_values, after_values
       FROM audit_event WHERE entity_type = $1 AND entity_id = $2
       ORDER BY occurred_at DESC, id DESC LIMIT ${CONCRETE_MIX_HISTORY_LIMIT}`,
      [ENTITY_TYPE, mix.id],
    );
    const { rows: total } = await db.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM audit_event WHERE entity_type = $1 AND entity_id = $2',
      [ENTITY_TYPE, mix.id],
    );
    return {
      ...summary!,
      projectNumber: mix.project_number,
      revisions: all.map(revisionOf),
      history: history.map((event) => ({
        id: event.id,
        action: event.action,
        occurredAt: event.occurred_at.toISOString(),
        changedBy: event.actor_user_id
          ? {
              userId: event.actor_user_id,
              initials: event.actor_initials_snapshot,
              name: event.actor_name_snapshot ?? '',
            }
          : null,
        note: event.reason,
        before: event.before_values ?? {},
        after: event.after_values ?? {},
      })),
      historyTotal: total[0]!.n,
      canManage: can(user, 'concrete_mix.manage', lead(mix)),
      canApprove: can(user, 'concrete_mix.approve', lead(mix)),
    };
  }
}

async function findMix(db: Db, id: string, lock: '' | 'FOR SHARE' | 'FOR UPDATE' = '') {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<MixRow>(
    `${SELECT_MIX} WHERE m.id = $1 ${lock ? `${lock} OF m` : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

/**
 * MM-V2-C04/C05: what a field report or set records about the mix it uses (C03 handoff): the
 * revision in effect (the approved one, else the open draft of an Unapproved mix) with a copy of
 * its values. Read only: field data never edits the registry. Null for an unknown mix. `lock`
 * lets the caller hold the mix FOR SHARE as a D09 domain row.
 */
export async function captureMixSnapshot(
  db: Db,
  mixId: string,
  lock: '' | 'FOR SHARE' = '',
): Promise<{ projectId: string; snapshot: ConcreteMixSnapshot } | null> {
  const mix = await findMix(db, mixId, lock);
  if (!mix) return null;
  const revisionId = mix.effective_revision_id ?? mix.draft_revision_id;
  if (!revisionId) return null;
  const row = (await revisions(db, [revisionId]))[0]!;
  return {
    projectId: mix.project_id,
    snapshot: {
      mixId: mix.id,
      revisionId: row.id,
      revisionNumber: row.revision_number,
      revisionState: row.state,
      spec: specOf(row),
      capturedAt: new Date().toISOString(),
    },
  };
}

async function revisions(db: Db, ids: string[]): Promise<RevisionRow[]> {
  if (ids.length === 0) return [];
  const { rows } = await db.query<RevisionRow>(
    `SELECT ${REVISION_COLUMNS} FROM concrete_mix_revision WHERE id = ANY($1::uuid[])`,
    [ids],
  );
  return rows;
}

async function copySources(db: Db, revisionIds: string[]) {
  const result = new Map<string, NonNullable<ConcreteMixSummary['copiedFrom']>>();
  if (revisionIds.length === 0) return result;
  const { rows } = await db.query<{
    revision_id: string;
    revision_number: number;
    mix_id: string;
    supplier_name: string;
    mix_number: string;
    project_id: string;
    project_number: string;
  }>(
    `SELECT r.id AS revision_id, r.revision_number, r.mix_id, r.supplier_name, r.mix_number,
            p.id AS project_id, p.project_number
     FROM concrete_mix_revision r JOIN project p ON p.id = r.project_id
     WHERE r.id = ANY($1::uuid[])`,
    [revisionIds],
  );
  for (const row of rows) {
    result.set(row.revision_id, {
      projectId: row.project_id,
      projectNumber: row.project_number,
      mixId: row.mix_id,
      revisionId: row.revision_id,
      revisionNumber: row.revision_number,
      supplierName: row.supplier_name,
      mixNumber: row.mix_number,
    });
  }
  return result;
}

async function insertRevision(
  client: PoolClient,
  revision: {
    id: string;
    mixId: string;
    projectId: string;
    revisionNumber: number;
    spec: ConcreteMixSpec;
    by: Standing;
  },
) {
  const fields = CONCRETE_MIX_SPEC_FIELDS;
  const columns = [
    'id',
    'mix_id',
    'project_id',
    'revision_number',
    ...fields.map((f) => COLUMN[f]),
  ];
  const values = [
    revision.id,
    revision.mixId,
    revision.projectId,
    revision.revisionNumber,
    ...fields.map((field) => param(field, revision.spec)),
  ];
  columns.push('created_by_user_id', 'created_by_initials_snapshot', 'created_by_name_snapshot');
  values.push(revision.by.userId, revision.by.initials, revision.by.displayName);
  await client.query(
    `INSERT INTO concrete_mix_revision (${columns.join(', ')})
     VALUES (${values.map((_, i) => `$${i + 1}`).join(', ')})`,
    values,
  );
}
