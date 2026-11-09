import { z } from 'zod';
import { concreteReportSpecFromMix, type ConcreteReportSpecColumn } from './concrete-field-reports';
import {
  concreteMixNoteSchema,
  type ConcreteMixSnapshot,
  type ConcreteMixSpec,
} from './concrete-mixes';
import { CONCRETE_HOLD_AGE, type ConcreteSpecimenAge } from './concrete-settings';

// Mix propagation review (MM-V2-C30; replaces C03's placeholder contract). After the project's
// Lead approves a mix revision, existing records still carry the values they were made with: a
// field report keeps its mix snapshot and the "Mix spec" column filled from it, and a specimen set
// keeps the test ages it was created with (C05 AC4: the set's saved snapshot never changes). The
// review lists what the approved revision would change, and nothing changes until the Lead
// approves items one by one or Approve all (D14, plan "Mix propagation").
//
// Never changed: measured results and the supplier-ticket column (what was observed), IDs,
// completed tests, HOLD specimens (C26), and any report that is no longer a draft (submitted,
// reviewed and issued reports follow C09: the Lead starts a revision first; a returned report is
// corrected by its technician only, owner decision 2026-11-08). A value the technician changed by
// hand on a draft is kept as written and shown as kept.

/** Why an item can't be applied. */
export const CONCRETE_MIX_PROPAGATION_INELIGIBLE = [
  'report_ready_to_submit',
  'report_submitted',
  'report_returned',
  'report_reviewed',
  'report_issued',
  'manually_edited',
  'specimen_tested',
  'hold_specimen',
  'no_casting_time',
] as const;
export type ConcreteMixPropagationIneligible = (typeof CONCRETE_MIX_PROPAGATION_INELIGIBLE)[number];

export const CONCRETE_MIX_PROPAGATION_INELIGIBLE_LABEL: Record<
  ConcreteMixPropagationIneligible,
  string
> = {
  report_ready_to_submit:
    'Marked ready to submit: the technician reopens it, or it follows review after submission',
  report_submitted: 'Submitted: it changes only through review (return or a later revision)',
  report_returned: 'Returned for correction: only its technician edits it',
  report_reviewed: 'Reviewed: start a revision first',
  report_issued: 'Issued: start a revision first',
  manually_edited: 'Changed by hand on the report or schedule: kept as written',
  specimen_tested: 'Already tested',
  hold_specimen: 'HOLD specimens change only through HOLD actions',
  no_casting_time: 'No casting time yet, so no test date to move',
};

export const CONCRETE_MIX_PROPAGATION_RECORD_TYPES = ['field_report', 'specimen'] as const;

/** One value the item would change. `field` is a dotted path, e.g. `projectSpec.slumpTargetMm`. */
export const concreteMixPropagationChangeSchema = z.object({
  field: z.string(),
  before: z.unknown(),
  proposed: z.unknown(),
});
export type ConcreteMixPropagationChange = z.infer<typeof concreteMixPropagationChangeSchema>;

export const concreteMixPropagationItemSchema = z.object({
  /** Stable for the record: `field_report:<id>` or `specimen:<id>`. */
  itemId: z.string(),
  recordType: z.enum(CONCRETE_MIX_PROPAGATION_RECORD_TYPES),
  recordId: z.string(),
  /** Human label, e.g. the report date and ticket, or the specimen ID. */
  recordLabel: z.string(),
  /** The field report the record belongs to (the row opens it). */
  fieldReportId: z.string(),
  reportState: z.string(),
  /** The mix revision the record was made from (null: not known, e.g. a set without a snapshot). */
  fromRevisionNumber: z.number().nullable(),
  /** What applying would change (also shown when ineligible, as the difference it would make). */
  changes: z.array(concreteMixPropagationChangeSchema),
  /** Values changed by hand on the report: kept as written even when the item is applied. */
  kept: z.array(concreteMixPropagationChangeSchema),
  eligible: z.boolean(),
  ineligibleReason: z.enum(CONCRETE_MIX_PROPAGATION_INELIGIBLE).nullable(),
});
export type ConcreteMixPropagationItem = z.infer<typeof concreteMixPropagationItemSchema>;

export const CONCRETE_MIX_PROPAGATION_ITEM_LIMIT = 500;

/** `GET /api/concrete-mixes/:id/propagation` (`inventory.read`). */
export const concreteMixPropagationPreviewSchema = z.object({
  /** Fingerprint of the listed items as shown; a decision names it (stale-preview guard). */
  previewId: z.string(),
  mixId: z.string(),
  projectId: z.string(),
  supplierName: z.string(),
  mixNumber: z.string(),
  /** The approved revision in effect (null: the mix is Unapproved, nothing to propagate). */
  toRevisionId: z.string().nullable(),
  toRevisionNumber: z.number().nullable(),
  generatedAt: z.string(),
  items: z.array(concreteMixPropagationItemSchema),
  eligibleCount: z.number(),
  /** More affected records exist than listed; apply these, then review again. */
  truncated: z.boolean(),
  /** `concrete_mix.approve` on the project (the Lead only), as it stands. */
  canApply: z.boolean(),
});
export type ConcreteMixPropagationPreview = z.infer<typeof concreteMixPropagationPreviewSchema>;

/**
 * `POST /api/concrete-mixes/:id/propagation` (`concrete_mix.approve`: the project's Lead only).
 * Chosen items, or Approve all of the displayed list (its item ids come back so an approval never
 * covers an item the Lead didn't see). Ineligible items are never applied; naming one is refused.
 */
export const concreteMixPropagationDecisionSchema = z.strictObject({
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
  previewId: z.string({ error: 'Preview is required' }).min(1).max(100),
  selection: z.discriminatedUnion(
    'kind',
    [
      z.strictObject({
        kind: z.literal('items'),
        itemIds: z
          .array(z.string().max(100))
          .min(1, { error: 'Choose at least one item' })
          .max(CONCRETE_MIX_PROPAGATION_ITEM_LIMIT),
      }),
      z.strictObject({
        kind: z.literal('approve_all'),
        displayedItemIds: z
          .array(z.string().max(100))
          .min(1, { error: 'Nothing to approve' })
          .max(CONCRETE_MIX_PROPAGATION_ITEM_LIMIT),
      }),
    ],
    { error: 'Choose items or Approve all' },
  ),
  note: concreteMixNoteSchema,
});
export type ConcreteMixPropagationDecision = z.input<typeof concreteMixPropagationDecisionSchema>;

export const concreteMixPropagationResultSchema = z.object({
  /** What this decision applied (an exact retry returns the same list). */
  appliedItemIds: z.array(z.string()),
  scope: z.enum(['items', 'approve_all']),
  /** The review as it stands after the decision. */
  preview: concreteMixPropagationPreviewSchema,
});
export type ConcreteMixPropagationResult = z.infer<typeof concreteMixPropagationResultSchema>;

/** 409 body when the records changed since the preview was shown. */
export const concreteMixPropagationStaleResponseSchema = z.object({
  code: z.literal('preview_stale'),
  current: concreteMixPropagationPreviewSchema,
});

// ---------------------------------------------------------------------------------------------
// The rules (pure, shared by the API and its tests)
// ---------------------------------------------------------------------------------------------

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * What a newer approved revision would change on one field report's "Mix spec" column, given the
 * column as saved and the snapshot it was filled from. A member that differs from its snapshot
 * was changed by hand and is kept. `revisionChanged` is true when the snapshot names another
 * revision (or the same revision captured while it was still a draft).
 */
export function concreteMixPropagationReportChanges(
  projectSpec: ConcreteReportSpecColumn,
  snapshot: ConcreteMixSnapshot,
  target: { revisionId: string; revisionNumber: number; spec: ConcreteMixSpec },
): {
  changes: ConcreteMixPropagationChange[];
  kept: ConcreteMixPropagationChange[];
  affected: boolean;
} {
  const from = concreteReportSpecFromMix(snapshot).projectSpec;
  const to = concreteReportSpecFromMix({ ...snapshot, spec: target.spec }).projectSpec;
  const changes: ConcreteMixPropagationChange[] = [];
  const kept: ConcreteMixPropagationChange[] = [];
  for (const key of Object.keys(to) as (keyof ConcreteReportSpecColumn)[]) {
    if (same(from[key], to[key])) continue;
    const entry = { field: `projectSpec.${key}`, before: projectSpec[key], proposed: to[key] };
    if (!same(projectSpec[key], from[key])) kept.push(entry);
    else changes.push(entry);
  }
  const revisionChanged =
    snapshot.revisionId !== target.revisionId ||
    snapshot.revisionState !== 'approved' ||
    !same(snapshot.spec, target.spec);
  if (revisionChanged) {
    changes.push({
      field: 'mixRevision',
      before: snapshot.revisionNumber,
      proposed: target.revisionNumber,
    });
  }
  return { changes, kept, affected: revisionChanged };
}

/** The state of a report that blocks propagation to it, or null for a draft. */
export function concreteMixPropagationReportBlock(report: {
  workflowState: string;
  issueCount: number;
}): ConcreteMixPropagationIneligible | null {
  if (report.issueCount > 0) return 'report_issued';
  switch (report.workflowState) {
    case 'draft':
      return null;
    case 'ready_to_submit':
      return 'report_ready_to_submit';
    case 'submitted':
      return 'report_submitted';
    case 'returned':
      return 'report_returned';
    default:
      return 'report_reviewed';
  }
}

/**
 * One specimen of a set created from an older revision's test ages: the age at its position in
 * the set's saved schedule, its age now, and the newer revision's age at that position. Null when
 * nothing would change (no newer age at that position, or the age already matches).
 */
export function concreteMixPropagationSpecimenChange(input: {
  savedAge: ConcreteSpecimenAge | null;
  currentAge: ConcreteSpecimenAge | null;
  proposedAge: ConcreteSpecimenAge | null;
}): {
  change: ConcreteMixPropagationChange;
  block: Extract<ConcreteMixPropagationIneligible, 'manually_edited' | 'hold_specimen'> | null;
} | null {
  const { savedAge, currentAge, proposedAge } = input;
  if (proposedAge === null || savedAge === null || same(savedAge, proposedAge)) return null;
  if (same(currentAge, proposedAge)) return null;
  const change = { field: 'assignedAge', before: currentAge, proposed: proposedAge };
  if (!same(currentAge, savedAge)) return { change, block: 'manually_edited' };
  if (currentAge === CONCRETE_HOLD_AGE || proposedAge === CONCRETE_HOLD_AGE) {
    return { change, block: 'hold_specimen' };
  }
  return { change, block: null };
}

/** The display label of a changed field. */
export const CONCRETE_MIX_PROPAGATION_FIELD_LABEL: Record<string, string> = {
  mixRevision: 'Mix revision',
  assignedAge: 'Test age',
  'projectSpec.specifiedStrengthMpa': 'Specified strength (MPa)',
  'projectSpec.specifiedStrengthAgeDays': 'Strength age (days)',
  'projectSpec.slumpTargetMm': 'Slump target (mm)',
  'projectSpec.slumpToleranceMm': 'Slump tolerance (mm)',
  'projectSpec.airMinPercent': 'Air minimum (%)',
  'projectSpec.airMaxPercent': 'Air maximum (%)',
  'projectSpec.maxAggregateSizeMm': 'Max aggregate (mm)',
  'projectSpec.cementType': 'Cement type',
  'projectSpec.admixtures': 'Admixtures',
};
