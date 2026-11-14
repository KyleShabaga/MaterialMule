import { z } from 'zod';
import { disposalApprovalSchema, disposalBlockerSchema } from './disposal';
import { personSnapshotSchema } from './lab-programs';

// STRATA-90/91: the Retention page's pipeline tabs and the decision drawer. The server decides
// every band, count, eligibility and permission; these shapes only carry the results.
//
// Tabs, in the order the work flows (each counted by the server):
// - coming:   units in stock, not tested-exempt, not on the disposal list, retention ending within
//             90 days or already ended, in three bands (overdue, within 30 days, within 90 days);
// - eligible: the server's one eligibility rule (STRATA-110, Kyle 2026-11-13): in stock, not
//             tested-exempt, not on the list, retain-until reached, no hold, programs closed, no
//             open location conflict. An Overdue unit that qualifies also shows in its band,
//             tagged Eligible;
// - list:     on the disposal list, waiting for a lead's approval;
// - approved: approved, waiting for the disposal scan;
// - disposed: read-only history.
// Tested units (retention exempt) never sit in the bands: they are listed apart and removed with
// "Confirm removal after testing".

export const RETENTION_TABS = ['coming', 'eligible', 'list', 'approved', 'disposed'] as const;
export type RetentionTab = (typeof RETENTION_TABS)[number];

export const RETENTION_BANDS = ['overdue', 'month', 'later'] as const;
export type RetentionBand = (typeof RETENTION_BANDS)[number];

/** Days after today that close the "Within 30 days" and "Within 90 days" bands. */
export const RETENTION_BAND_DAYS = { month: 30, later: 90 } as const;

export const RETENTION_PIPELINE_FILTERS = [
  'mine',
  'overdue',
  'month',
  'later',
  'hold',
  'extension',
] as const;
export type RetentionPipelineFilter = (typeof RETENTION_PIPELINE_FILTERS)[number];

export const RETENTION_PIPELINE_SORTS = ['retain_until', 'project', 'id'] as const;
export type RetentionPipelineSort = (typeof RETENTION_PIPELINE_SORTS)[number];

export const RETENTION_PIPELINE_PAGE_SIZE = 100;
/** Tested units shown under the bands (with a total). */
export const RETENTION_TESTED_LIMIT = 50;

const blankToUndefined = (value: unknown) =>
  value === '' || value === null || value === undefined ? undefined : value;

/** `GET /api/retention/pipeline?tab=&search=&filter=&sort=&dir=&page=` */
export const retentionPipelineQuerySchema = z.object({
  tab: z.preprocess(blankToUndefined, z.enum(RETENTION_TABS).default('coming')),
  search: z.preprocess(blankToUndefined, z.string().trim().max(100).optional()),
  /** One project (links such as "Approve in project" and the project page). */
  projectId: z.preprocess(blankToUndefined, z.uuid({ error: 'must be an ID' }).optional()),
  /** Repeated (`filter=mine&filter=hold`) or comma separated. */
  filter: z.preprocess(
    (value) => {
      const list = Array.isArray(value) ? value : value === undefined ? [] : [value];
      return list
        .flatMap((v) => String(v).split(','))
        .map((v) => v.trim())
        .filter(Boolean);
    },
    z.array(z.enum(RETENTION_PIPELINE_FILTERS)).max(10),
  ),
  sort: z.preprocess(blankToUndefined, z.enum(RETENTION_PIPELINE_SORTS).default('retain_until')),
  dir: z.preprocess(blankToUndefined, z.enum(['asc', 'desc']).default('asc')),
  page: z.preprocess(
    blankToUndefined,
    z.coerce.number({ error: 'must be a number' }).int().min(1).max(100_000).default(1),
  ),
});
export type RetentionPipelineQuery = z.output<typeof retentionPipelineQuerySchema>;

export const retentionPipelineUnitSchema = z.object({
  storageUnitId: z.string(),
  readableId: z.string(),
  unitType: z.string(),
  status: z.enum(['in_stock', 'approved_for_disposal', 'disposed']),
  /** Changes with every change to the unit; the decision drawer sends it back. */
  version: z.number().int(),
  project: z.object({
    id: z.string(),
    projectNumber: z.string(),
    name: z.string(),
    lead: personSnapshotSchema.nullable(),
  }),
  /** Test hole names (summaries, a tube's source, a bulk group's source). */
  holes: z.array(z.string()),
  location: z.object({ code: z.string(), name: z.string() }),
  receivedDate: z.string(),
  /** Received date + 1 year (STRATA-113, Kyle 2026-11-13). */
  minimumRetainUntil: z.string(),
  /** With extensions; never earlier than the minimum. */
  effectiveRetainUntil: z.string(),
  /** Coming up only: which band its effective retain-until falls in. */
  band: z.enum(RETENTION_BANDS).nullable(),
  /** Active holds: how many, the latest date one is meant to last until (null = until released). */
  hold: z
    .object({ count: z.number().int(), holdUntil: z.string().nullable(), reason: z.string() })
    .nullable(),
  /** Active extensions. */
  extensionCount: z.number().int(),
  /** An open retention request names this unit (or its whole project). */
  requestWaiting: z.boolean(),
  /** The server's one eligibility rule (see the Eligible tab). */
  eligible: z.boolean(),
  /** A lab program covering it is still open. */
  programOpen: z.boolean(),
  retentionExempt: z.boolean(),
  /** List and Approved: what would stop its approval or its disposal scan now. */
  blockers: z.array(disposalBlockerSchema),
  listEntry: z
    .object({
      id: z.string(),
      addedBy: personSnapshotSchema,
      addedAt: z.string(),
      reason: z.string(),
    })
    .nullable(),
  approval: disposalApprovalSchema.nullable(),
  disposal: z
    .object({
      disposedAt: z.string().nullable(),
      disposedBy: personSnapshotSchema.nullable(),
      route: z.enum(['standard', 'tested']),
    })
    .nullable(),
  /** The viewer may extend, hold or put it on the disposal list (`retention.manage`). */
  canDecide: z.boolean(),
  /** The viewer may approve, revoke or take it off the list (`disposal.approve`). */
  canApprove: z.boolean(),
});
export type RetentionPipelineUnit = z.infer<typeof retentionPipelineUnitSchema>;

export const retentionPipelineCountsSchema = z.object({
  coming: z.number().int(),
  eligible: z.number().int(),
  list: z.number().int(),
  approved: z.number().int(),
  disposed: z.number().int(),
  /** Tested units in stock (listed under the bands). */
  tested: z.number().int(),
});
export type RetentionPipelineCounts = z.infer<typeof retentionPipelineCountsSchema>;

export const retentionPipelineSchema = z.object({
  asOf: z.string(),
  tab: z.enum(RETENTION_TABS),
  /** Every tab's count, unfiltered: what is in each stage now. */
  counts: retentionPipelineCountsSchema,
  /** Coming up: each band's count under the current search and filters. */
  bandCounts: z.object({
    overdue: z.number().int(),
    month: z.number().int(),
    later: z.number().int(),
  }),
  rows: z.array(retentionPipelineUnitSchema),
  /** Rows matching the search and filters across all pages. */
  total: z.number().int(),
  page: z.number().int(),
  pageSize: z.number().int(),
  /** Coming up only: tested units in stock (first RETENTION_TESTED_LIMIT). */
  tested: z.array(retentionPipelineUnitSchema),
  /** The viewer may send retention requests. */
  canRequest: z.boolean(),
});
export type RetentionPipeline = z.infer<typeof retentionPipelineSchema>;

// ---- Decision drawer (STRATA-91) ----

export const DECISION_UNITS_MAX = 500;

/** `GET /api/retention/decision-units?ids=a,b` or `?projectId=` (every current unit). */
export const retentionDecisionUnitsQuerySchema = z
  .object({
    ids: z.preprocess(
      (value) => {
        if (value === undefined || value === '') return undefined;
        const list = Array.isArray(value) ? value : [value];
        return list.flatMap((v) => String(v).split(',')).filter(Boolean);
      },
      z
        .array(z.uuid({ error: 'must be an ID' }))
        .max(DECISION_UNITS_MAX)
        .optional(),
    ),
    projectId: z.preprocess(blankToUndefined, z.uuid({ error: 'must be an ID' }).optional()),
  })
  .refine((v) => (v.ids !== undefined && v.ids.length > 0) !== (v.projectId !== undefined), {
    message: 'Give unit IDs or a project',
    path: ['ids'],
  });
export type RetentionDecisionUnitsQuery = z.output<typeof retentionDecisionUnitsQuerySchema>;

export const retentionDecisionUnitSchema = retentionPipelineUnitSchema.extend({
  /** Why it can't go on the disposal list now (empty when it can). */
  listBlockers: z.array(disposalBlockerSchema),
});
export type RetentionDecisionUnit = z.infer<typeof retentionDecisionUnitSchema>;

export const retentionDecisionUnitsSchema = z.object({
  asOf: z.string(),
  units: z.array(retentionDecisionUnitSchema),
  /** Set for a whole-project decision. */
  projectId: z.string().nullable(),
  canRequest: z.boolean(),
});
export type RetentionDecisionUnits = z.infer<typeof retentionDecisionUnitsSchema>;

export const RETENTION_DECISION_ACTIONS = ['extend', 'hold', 'dispose'] as const;
export type RetentionDecisionAction = (typeof RETENTION_DECISION_ACTIONS)[number];

const reasonField = z
  .string({ error: 'is required' })
  .trim()
  .min(1, { error: 'A reason is required' })
  .max(2000, { error: 'must be at most 2000 characters' });

/**
 * `POST /api/retention/decisions`: one decision for the ticked units (or, for extend and hold, a
 * whole project). Leads and Lab Managers only; others send a retention request instead.
 */
export const retentionDecisionSchema = z
  .strictObject({
    action: z.enum(RETENTION_DECISION_ACTIONS),
    /** Units with the version last read; each is rechecked and may fail on its own. */
    units: z
      .array(z.strictObject({ id: z.uuid({ error: 'must be an ID' }), version: z.number().int() }))
      .max(DECISION_UNITS_MAX, { error: `at most ${DECISION_UNITS_MAX} units` })
      .optional(),
    /** Whole project (extend or hold only), instead of units. */
    projectId: z.uuid({ error: 'must be an ID' }).optional(),
    retainUntil: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).optional(),
    extendMonths: z.number().int().min(1).max(600).optional(),
    holdUntil: z.iso.date({ error: 'must be a date (YYYY-MM-DD)' }).optional(),
    reason: reasonField,
    idempotencyKey: z.uuid({ error: 'must be an ID' }),
  })
  .superRefine((v, ctx) => {
    const hasUnits = v.units !== undefined && v.units.length > 0;
    if (hasUnits === (v.projectId !== undefined)) {
      ctx.addIssue({ code: 'custom', path: ['units'], message: 'Choose units or a project' });
    }
    if (v.action === 'dispose' && v.projectId !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['projectId'], message: 'Choose the units' });
    }
    if (v.action === 'extend') {
      if ((v.retainUntil === undefined) === (v.extendMonths === undefined)) {
        ctx.addIssue({
          code: 'custom',
          path: ['retainUntil'],
          message: 'Give a new retain-until date or a number of months',
        });
      }
    } else if (v.retainUntil !== undefined || v.extendMonths !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['retainUntil'], message: 'only for an extension' });
    }
    if (v.action !== 'hold' && v.holdUntil !== undefined) {
      ctx.addIssue({ code: 'custom', path: ['holdUntil'], message: 'only for a hold' });
    }
  });
export type RetentionDecision = z.output<typeof retentionDecisionSchema>;

export const RETENTION_DECISION_FAILURES = [
  /** The unit changed after the drawer read it. */
  'changed',
  'not_found',
  'disposed',
  /** Extend: the new date is earlier than its current retain-until (STRATA-113). */
  'retain_until_too_early',
  /** Dispose: not eligible now (see blockers). */
  'not_eligible',
  'already_on_list',
] as const;
export type RetentionDecisionFailure = (typeof RETENTION_DECISION_FAILURES)[number];

export const retentionDecisionResultSchema = z.object({
  action: z.enum(RETENTION_DECISION_ACTIONS),
  done: z.array(z.object({ storageUnitId: z.string(), readableId: z.string() })),
  /** For a whole-project hold or extension: what was placed (one per project). */
  created: z.array(z.object({ id: z.string(), projectId: z.string() })),
  failed: z.array(
    z.object({
      storageUnitId: z.string(),
      readableId: z.string().nullable(),
      code: z.enum(RETENTION_DECISION_FAILURES),
      message: z.string(),
    }),
  ),
});
export type RetentionDecisionResult = z.infer<typeof retentionDecisionResultSchema>;

/** `POST /api/disposal/list/remove`: take units off the disposal list (reason required). */
export const removeFromDisposalListSchema = z.strictObject({
  unitIds: z
    .array(z.uuid({ error: 'must be an ID' }))
    .min(1, { error: 'Choose at least one unit' })
    .max(DECISION_UNITS_MAX),
  reason: reasonField,
  idempotencyKey: z.uuid({ error: 'must be an ID' }),
});
export type RemoveFromDisposalList = z.output<typeof removeFromDisposalListSchema>;

export const removeFromDisposalListResultSchema = z.object({
  removed: z.array(z.object({ storageUnitId: z.string(), readableId: z.string() })),
  /** Not on the list any more (approved meanwhile, or already taken off). */
  notOnList: z.array(z.object({ storageUnitId: z.string(), readableId: z.string() })),
});
export type RemoveFromDisposalListResult = z.infer<typeof removeFromDisposalListResultSchema>;
