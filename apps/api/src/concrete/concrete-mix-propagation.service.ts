import { createHash } from 'node:crypto';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  CONCRETE_HOLD_AGE,
  CONCRETE_MIX_PROPAGATION_ITEM_LIMIT,
  concreteMixPropagationDecisionSchema,
  concreteMixPropagationReportBlock,
  concreteMixPropagationReportChanges,
  concreteMixPropagationSpecimenChange,
  concreteMixSnapshotSchema,
  concreteReportSpecColumnSchema,
  concreteRescheduledTarget,
  type ConcreteMixPropagationIneligible,
  type ConcreteMixPropagationItem,
  type ConcreteMixPropagationPreview,
  type ConcreteMixPropagationResult,
  type ConcreteMixSnapshot,
  type ConcreteReportSpecColumn,
  type ConcreteSpecimenAge,
} from '@materialmule/shared';
import type { Pool, PoolClient } from 'pg';
import { recordAudit, type AuditActor } from '../audit/audit.js';
import { can, type AuthUser } from '../auth/policy.js';
import { canUnderLock, lockStanding } from '../auth/standing.js';
import { DatabaseService } from '../database/database.service.js';
import { withTransaction } from '../db/transaction.js';
import { intentHash } from '../project-access/project-access.service.js';
import { parseBody } from '../validation/parse-body.js';
import { captureMixSnapshot } from './concrete-mixes.service.js';

type Db = Pool | PoolClient;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERMISSION = 'concrete_mix.approve' as const;
const APPLIED_ACTION = 'concrete_mix.propagation_applied';

interface MixFacts {
  id: string;
  project_id: string;
  supplier_name: string;
  mix_number: string;
  effective_revision_id: string | null;
  lead_project_engineer_user_id: string | null;
}

interface ReportCandidate {
  id: string;
  workflow_state: string;
  issue_count: number;
  report_date: string | null;
  ticket_number: string | null;
  mix_snapshot: unknown;
  project_spec: unknown;
}

interface SpecimenCandidate {
  id: string;
  project_id: string;
  letter: string;
  assigned_age: string | null;
  target_date: string | null;
  set_id: string;
  default_ages: string[];
  permanent_id: string | null;
  temporary_id: string | null;
  field_report_id: string;
  workflow_state: string;
  casting_date: string | null;
  revision_number: number;
}

/** What the preview found, with the rows each item came from (for applying it). */
interface Plan {
  preview: ConcreteMixPropagationPreview;
  target: ConcreteMixSnapshot | null;
  reports: Map<string, ReportCandidate>;
  specimens: Map<string, SpecimenCandidate>;
}

const toAge = (value: string | null): ConcreteSpecimenAge | null =>
  value === null ? null : value === CONCRETE_HOLD_AGE ? CONCRETE_HOLD_AGE : Number(value);

const lead = (mix: MixFacts) => ({ leadProjectEngineerUserId: mix.lead_project_engineer_user_id });
const forbidden = () => new ForbiddenException({ code: 'forbidden' });

/** A UUID-shaped key derived from text (per-specimen reschedule keys under one decision key). */
function derivedKey(text: string): string {
  const hex = createHash('sha256').update(text).digest('hex');
  const variant = ((parseInt(hex[16]!, 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-${variant}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

function reportLabel(report: ReportCandidate): string {
  const parts = [`Field report ${report.report_date ?? '(no date)'}`];
  if (report.ticket_number) parts.push(`ticket ${report.ticket_number}`);
  return parts.join(', ');
}

function specimenLabel(row: SpecimenCandidate): string {
  if (row.permanent_id) return `${row.permanent_id}${row.letter}`;
  if (row.temporary_id) return `${row.temporary_id}${row.letter}`;
  return `Unnumbered set, specimen ${row.letter}`;
}

/**
 * Mix propagation review (MM-V2-C30). The preview is read-only and open to every reader of the
 * project (`inventory.read`); applying is `concrete_mix.approve`, held only by the project's
 * Lead Project Engineer (no fallback, AC3).
 *
 * Applying is one transaction in the D09 order: the affected reports, their sets and specimens FOR
 * UPDATE, then the mix row FOR UPDATE, then the project and the actor FOR SHARE (`canUnderLock`).
 * The preview is rebuilt under those locks and must match the one the Lead saw (`previewId`), so a
 * decision never covers a record that changed since. A report item replaces the "Mix spec" members
 * that came from the mix (hand-changed members stay) and moves the report's mix snapshot to the
 * approved revision; a specimen item changes its test age through C22's reschedule history (a
 * set's saved schedule snapshot never changes, C05 AC4). Every applied record gets its own audit
 * event, and the mix gets one event naming the scope (chosen items or Approve all) and what was
 * applied. Measured values, the ticket column, IDs, tests and non-draft reports are never touched.
 */
@Injectable()
export class ConcreteMixPropagationService {
  constructor(private readonly database: DatabaseService) {}

  async preview(mixId: string, user: AuthUser): Promise<ConcreteMixPropagationPreview> {
    const mix = await findMix(this.database.pool, mixId);
    if (!mix) throw new NotFoundException({ code: 'concrete_mix_not_found' });
    return (await this.plan(this.database.pool, mix, user)).preview;
  }

  async apply(
    mixId: string,
    body: unknown,
    user: AuthUser,
    actor: AuditActor,
    requestId: string | null,
  ): Promise<ConcreteMixPropagationResult> {
    const found = await findMix(this.database.pool, mixId);
    if (!found) {
      // 404 only to someone who could hold the permission on some project (AO03 order).
      if (!(await leadsAnyProject(this.database.pool, user))) throw forbidden();
      throw new NotFoundException({ code: 'concrete_mix_not_found' });
    }
    // Authority before the body (403 before 400), against the project as it stands.
    if (!can(user, PERMISSION, lead(found))) throw forbidden();
    const input = parseBody(concreteMixPropagationDecisionSchema, body);
    const hash = intentHash({
      kind: 'propagate',
      mixId: found.id,
      previewId: input.previewId,
      selection: input.selection,
      note: input.note ?? null,
    });

    return withTransaction(this.database.pool, async (client) => {
      // D09: domain rows first (reports → sets → specimens), then the mix, then the authority.
      const seen = await this.plan(client, found, user);
      const reportIds = [...seen.reports.keys()].sort();
      const specimens = [...seen.specimens.values()];
      const setIds = [...new Set(specimens.map((s) => s.set_id))].sort();
      const specimenIds = specimens.map((s) => s.id).sort();
      if (reportIds.length > 0 || specimens.length > 0) {
        const reportsToLock = [
          ...new Set([...reportIds, ...specimens.map((s) => s.field_report_id)]),
        ].sort();
        await client.query(
          'SELECT 1 FROM concrete_field_report WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [reportsToLock],
        );
      }
      if (setIds.length > 0) {
        await client.query(
          'SELECT 1 FROM concrete_specimen_set WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [setIds],
        );
      }
      if (specimenIds.length > 0) {
        await client.query(
          'SELECT 1 FROM concrete_specimen WHERE id = ANY($1::uuid[]) ORDER BY id FOR UPDATE',
          [specimenIds],
        );
      }
      const mix = (await findMix(client, found.id, 'FOR UPDATE'))!;
      if (!(await canUnderLock(client, user, PERMISSION, mix.project_id))) throw forbidden();

      const replay = await this.replay(client, input.idempotencyKey, mix, hash, user);
      if (replay) return replay;

      const plan = await this.plan(client, mix, user);
      if (plan.preview.previewId !== input.previewId || !plan.target) {
        throw new ConflictException({ code: 'preview_stale', current: plan.preview });
      }
      const byId = new Map(plan.preview.items.map((item) => [item.itemId, item]));
      let chosen: ConcreteMixPropagationItem[];
      if (input.selection.kind === 'approve_all') {
        const displayed = new Set(input.selection.displayedItemIds);
        if (displayed.size !== byId.size || [...byId.keys()].some((id) => !displayed.has(id))) {
          throw new ConflictException({ code: 'preview_stale', current: plan.preview });
        }
        chosen = plan.preview.items.filter((item) => item.eligible);
      } else {
        chosen = [];
        for (const id of new Set(input.selection.itemIds)) {
          const item = byId.get(id);
          if (!item) {
            throw new ConflictException({ code: 'preview_stale', current: plan.preview });
          }
          if (!item.eligible) {
            throw new UnprocessableEntityException({
              code: 'item_not_eligible',
              errors: [
                {
                  field: 'selection.itemIds',
                  code: 'item_not_eligible',
                  message: `${item.recordLabel} can't be updated from the mix`,
                },
              ],
            });
          }
          chosen.push(item);
        }
      }
      if (chosen.length === 0) {
        throw new UnprocessableEntityException({
          code: 'nothing_to_apply',
          errors: [
            {
              field: 'selection',
              code: 'nothing_to_apply',
              message: 'None of the listed records can be updated from the mix',
            },
          ],
        });
      }

      const by = (await lockStanding(client, [user.userId])).get(user.userId)!;
      const target = { ...plan.target, capturedAt: new Date().toISOString() };
      const reason = [
        `Mix ${mix.supplier_name} ${mix.mix_number} revision ${target.revisionNumber} approved: updated from the mix by the Lead`,
        input.note ?? null,
      ]
        .filter(Boolean)
        .join('. ')
        .slice(0, 2000);
      const touchedSets = new Set<string>();
      for (const item of chosen) {
        if (item.recordType === 'field_report') {
          const report = plan.reports.get(item.recordId)!;
          await this.applyReport(client, report, item, target, actor, reason, requestId);
        } else {
          const specimen = plan.specimens.get(item.recordId)!;
          touchedSets.add(specimen.set_id);
          await this.applySpecimen(client, specimen, item, {
            key: derivedKey(`${input.idempotencyKey}:${specimen.id}`),
            hash,
            reason,
            by,
            actor,
            requestId,
          });
        }
      }
      if (touchedSets.size > 0) {
        // A technician's open set form sees the change as a newer version.
        await client.query(
          `UPDATE concrete_specimen_set SET version = version + 1, updated_at = now()
           WHERE id = ANY($1::uuid[])`,
          [[...touchedSets]],
        );
      }
      const appliedIds = chosen.map((item) => item.itemId);
      await recordAudit(client, {
        action: APPLIED_ACTION,
        entityType: 'concrete_mix',
        entityId: mix.id,
        actor,
        reason: input.note ?? null,
        before: { fromRevisions: [...new Set(chosen.map((i) => i.fromRevisionNumber))] },
        after: {
          idempotencyKey: input.idempotencyKey,
          requestHash: hash,
          toRevision: target.revisionNumber,
          scope: input.selection.kind,
          appliedItemIds: appliedIds,
          applied: chosen.map((item) => item.recordLabel),
          listed: plan.preview.items.length,
          notChosen: plan.preview.items.filter((i) => i.eligible).length - chosen.length,
          ineligible: plan.preview.items.filter((i) => !i.eligible).length,
        },
        requestId,
      });
      return {
        appliedItemIds: appliedIds,
        scope: input.selection.kind,
        preview: (await this.plan(client, mix, user)).preview,
      };
    });
  }

  // -------------------------------------------------------------------------------------------
  // Applying one item
  // -------------------------------------------------------------------------------------------

  private async applyReport(
    client: PoolClient,
    report: ReportCandidate,
    item: ConcreteMixPropagationItem,
    target: ConcreteMixSnapshot,
    actor: AuditActor,
    reason: string,
    requestId: string | null,
  ) {
    const before = concreteReportSpecColumnSchema.parse(report.project_spec);
    const after: ConcreteReportSpecColumn = { ...before };
    const changed: Record<string, unknown> = {};
    const previous: Record<string, unknown> = {};
    for (const change of item.changes) {
      if (!change.field.startsWith('projectSpec.')) continue;
      const key = change.field.slice('projectSpec.'.length) as keyof ConcreteReportSpecColumn;
      (after as Record<string, unknown>)[key] = change.proposed;
      changed[key] = change.proposed;
      previous[key] = before[key];
    }
    const snapshot = concreteMixSnapshotSchema.parse(report.mix_snapshot);
    const { rows } = await client.query<{ version: number }>(
      `UPDATE concrete_field_report
       SET project_spec = $2, mix_snapshot = $3, version = version + 1, updated_at = now()
       WHERE id = $1 AND workflow_state = 'draft' AND issue_count = 0
       RETURNING version`,
      [report.id, JSON.stringify(after), JSON.stringify(target)],
    );
    if (rows.length === 0) throw new ConflictException({ code: 'preview_stale' });
    await recordAudit(client, {
      action: 'concrete_field_report.mix_propagated',
      entityType: 'concrete_field_report',
      entityId: report.id,
      actor,
      reason,
      before: { version: rows[0]!.version - 1, mixRevisionId: snapshot.revisionId, ...previous },
      after: { version: rows[0]!.version, mixRevisionId: target.revisionId, ...changed },
      requestId,
    });
  }

  private async applySpecimen(
    client: PoolClient,
    specimen: SpecimenCandidate,
    item: ConcreteMixPropagationItem,
    context: {
      key: string;
      hash: string;
      reason: string;
      by: { userId: string; initials: string | null; displayName: string };
      actor: AuditActor;
      requestId: string | null;
    },
  ) {
    const newAge = String(item.changes[0]!.proposed);
    const previousAge = specimen.assigned_age!;
    let newTarget: string | null = null;
    if (specimen.casting_date !== null && specimen.target_date !== null) {
      // C22's history: the age guard lets a numbered set's age change only with this row.
      newTarget = concreteRescheduledTarget(specimen.casting_date, Number(newAge));
      await client.query(
        `INSERT INTO concrete_specimen_reschedule
           (project_id, specimen_id, previous_age, new_age, previous_target_date,
            new_target_date, reason, rescheduled_by_user_id, rescheduled_by_initials_snapshot,
            rescheduled_by_name_snapshot, idempotency_key, request_hash)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
        [
          specimen.project_id,
          specimen.id,
          previousAge,
          newAge,
          specimen.target_date,
          newTarget,
          context.reason,
          context.by.userId,
          context.by.initials,
          context.by.displayName,
          context.key,
          context.hash,
        ],
      );
    }
    // No casting time yet: an unnumbered set's age changes directly (C05 allows it on a draft).
    await client.query(
      `UPDATE concrete_specimen SET assigned_age = $2, version = version + 1, updated_at = now()
       WHERE id = $1`,
      [specimen.id, newAge],
    );
    await recordAudit(client, {
      action: 'concrete_specimen.rescheduled',
      entityType: 'concrete_specimen',
      entityId: specimen.id,
      actor: context.actor,
      reason: context.reason,
      before: { assignedAge: Number(previousAge), targetDate: specimen.target_date },
      after: { assignedAge: Number(newAge), targetDate: newTarget, source: 'mix_propagation' },
      requestId: context.requestId,
    });
  }

  // -------------------------------------------------------------------------------------------
  // The preview
  // -------------------------------------------------------------------------------------------

  private async plan(db: Db, mix: MixFacts, user: AuthUser): Promise<Plan> {
    const canApply = can(user, PERMISSION, lead(mix));
    const captured = mix.effective_revision_id ? await captureMixSnapshot(db, mix.id) : null;
    const target =
      captured && captured.snapshot.revisionState === 'approved' ? captured.snapshot : null;
    const items: ConcreteMixPropagationItem[] = [];
    const reports = new Map<string, ReportCandidate>();
    const specimens = new Map<string, SpecimenCandidate>();
    let truncated = false;

    if (target) {
      const limit = CONCRETE_MIX_PROPAGATION_ITEM_LIMIT;
      const { rows: reportRows } = await db.query<ReportCandidate>(
        `SELECT r.id, r.workflow_state, r.issue_count, r.report_date::text, r.ticket_number,
                r.mix_snapshot, r.project_spec
         FROM concrete_field_report r
         WHERE r.mix_id = $1 AND r.workflow_state <> 'void'
           AND (r.mix_snapshot ->> 'revisionId' IS DISTINCT FROM $2
                OR r.mix_snapshot ->> 'revisionState' IS DISTINCT FROM 'approved'
                OR r.mix_snapshot -> 'spec' IS DISTINCT FROM $3::jsonb)
         ORDER BY r.report_date DESC NULLS LAST, r.created_at DESC, r.id
         LIMIT ${limit + 1}`,
        [mix.id, target.revisionId, JSON.stringify(target.spec)],
      );
      for (const row of reportRows) {
        const snapshot = concreteMixSnapshotSchema.safeParse(row.mix_snapshot);
        if (!snapshot.success) continue;
        const spec = concreteReportSpecColumnSchema.parse(row.project_spec);
        const result = concreteMixPropagationReportChanges(spec, snapshot.data, target);
        if (!result.affected) continue;
        const block = concreteMixPropagationReportBlock({
          workflowState: row.workflow_state,
          issueCount: row.issue_count,
        });
        reports.set(row.id, row);
        items.push({
          itemId: `field_report:${row.id}`,
          recordType: 'field_report',
          recordId: row.id,
          recordLabel: reportLabel(row),
          fieldReportId: row.id,
          reportState: row.issue_count > 0 ? 'issued' : row.workflow_state,
          fromRevisionNumber: snapshot.data.revisionNumber,
          changes: result.changes,
          kept: result.kept,
          eligible: block === null,
          ineligibleReason: block,
        });
      }

      const targetAges = target.spec.testAges.map(String);
      // Untested: no concrete result exists yet. C07/C23 add their "already tested" condition
      // here (block 'specimen_tested'), as in C22's worklist.
      const { rows: specimenRows } = await db.query<SpecimenCandidate>(
        `SELECT sp.id, sp.project_id, sp.letter, sp.assigned_age, sp.target_date::text,
                st.id AS set_id, st.default_ages, st.permanent_id, st.temporary_id,
                r.id AS field_report_id, r.workflow_state,
                concrete_casting_date(r.cast_at)::text AS casting_date,
                rev.revision_number
         FROM concrete_specimen sp
         JOIN concrete_specimen_set st ON st.id = sp.set_id
         JOIN concrete_field_report r ON r.id = st.field_report_id
         JOIN concrete_mix_revision rev ON rev.id = st.default_ages_mix_revision_id
         WHERE rev.mix_id = $1 AND st.default_ages_source = 'mix' AND st.voided_at IS NULL
           AND r.workflow_state <> 'void'
           AND (st.default_ages_mix_revision_id <> $2 OR st.default_ages <> $3::text[])
         ORDER BY r.report_date DESC NULLS LAST, r.created_at DESC, st.id, sp.letter
         LIMIT ${limit + 1}`,
        [mix.id, target.revisionId, targetAges],
      );
      for (const row of specimenRows) {
        const index = row.letter.charCodeAt(0) - 'A'.charCodeAt(0);
        const result = concreteMixPropagationSpecimenChange({
          savedAge: toAge(row.default_ages[index] ?? null),
          currentAge: toAge(row.assigned_age),
          proposedAge: target.spec.testAges[index] ?? null,
        });
        if (!result) continue;
        let block: ConcreteMixPropagationIneligible | null = result.block;
        // Without a casting time, only an unnumbered set's age can change (no history row needs
        // a target date there); a numbered set waits for its casting time.
        if (!block && row.casting_date === null && row.permanent_id !== null) {
          block = 'no_casting_time';
        }
        specimens.set(row.id, row);
        items.push({
          itemId: `specimen:${row.id}`,
          recordType: 'specimen',
          recordId: row.id,
          recordLabel: specimenLabel(row),
          fieldReportId: row.field_report_id,
          reportState: row.workflow_state,
          fromRevisionNumber: row.revision_number,
          changes: [result.change],
          kept: [],
          eligible: block === null,
          ineligibleReason: block,
        });
      }
      truncated =
        reportRows.length > limit ||
        specimenRows.length > limit ||
        items.length > CONCRETE_MIX_PROPAGATION_ITEM_LIMIT;
    }
    const listed = items.slice(0, CONCRETE_MIX_PROPAGATION_ITEM_LIMIT);
    const previewId = intentHash({
      mixId: mix.id,
      to: target?.revisionId ?? null,
      spec: target?.spec ?? null,
      items: listed.map((i) => [i.itemId, i.changes, i.kept, i.eligible, i.ineligibleReason]),
    }).slice(0, 32);
    return {
      preview: {
        previewId,
        mixId: mix.id,
        projectId: mix.project_id,
        supplierName: mix.supplier_name,
        mixNumber: mix.mix_number,
        toRevisionId: target?.revisionId ?? null,
        toRevisionNumber: target?.revisionNumber ?? null,
        generatedAt: new Date().toISOString(),
        items: listed,
        eligibleCount: listed.filter((i) => i.eligible).length,
        truncated,
        canApply,
      },
      target,
      reports,
      specimens,
    };
  }

  /** An exact retry returns what the first request applied; another body is refused. */
  private async replay(
    client: PoolClient,
    key: string,
    mix: MixFacts,
    hash: string,
    user: AuthUser,
  ): Promise<ConcreteMixPropagationResult | null> {
    const { rows } = await client.query<{
      entity_id: string;
      actor_user_id: string | null;
      after_values: { requestHash?: string; appliedItemIds?: string[]; scope?: string };
    }>(
      `SELECT entity_id, actor_user_id, after_values FROM audit_event
       WHERE action = $1 AND entity_type = 'concrete_mix' AND after_values ->> 'idempotencyKey' = $2
       LIMIT 1`,
      [APPLIED_ACTION, key],
    );
    const previous = rows[0];
    if (!previous) return null;
    if (
      previous.entity_id !== mix.id ||
      previous.actor_user_id !== user.userId ||
      previous.after_values.requestHash !== hash
    ) {
      throw new ConflictException({ code: 'idempotency_key_reused' });
    }
    return {
      appliedItemIds: previous.after_values.appliedItemIds ?? [],
      scope: previous.after_values.scope === 'approve_all' ? 'approve_all' : 'items',
      preview: (await this.plan(client, mix, user)).preview,
    };
  }
}

async function findMix(db: Db, id: string, lock: '' | 'FOR UPDATE' = '') {
  if (!UUID_PATTERN.test(id)) return null;
  const { rows } = await db.query<MixFacts>(
    `SELECT m.id, m.project_id, m.supplier_name, m.mix_number, m.effective_revision_id,
            p.lead_project_engineer_user_id
     FROM concrete_mix m JOIN project p ON p.id = m.project_id
     WHERE m.id = $1 ${lock ? `${lock} OF m` : ''}`,
    [id],
  );
  return rows[0] ?? null;
}

async function leadsAnyProject(db: Db, user: AuthUser): Promise<boolean> {
  if (!can(user, PERMISSION, { leadProjectEngineerUserId: user.userId })) return false;
  const { rows } = await db.query(
    'SELECT 1 FROM project WHERE lead_project_engineer_user_id = $1 LIMIT 1',
    [user.userId],
  );
  return rows.length > 0;
}
