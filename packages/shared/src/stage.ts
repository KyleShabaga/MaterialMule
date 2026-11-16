import { z } from 'zod';

// STRATA-58: the stage list (DESIGN.md › Lifecycle) is the one vocabulary for colour across the
// app. Every work item and list row the API returns carries a stage key derived on the server from
// the record's real state; screens never guess it from wording. Colour is never the only signal:
// tags always carry words.
//
// Two kinds of tag (Kyle, 2026-11-12):
// - work-item tags read "<Stage> · <domain>" (Today, Inbox, program and receipt tags), e.g.
//   "Due · Retention", "Draft · Receipt";
// - a record's own tag uses its record status words (a storage unit reads In lab, Short-term,
//   Long-term, Retention due, Retention overdue, Disposed or Location conflict). Colours still
//   come from the stage list.
//
// The stage hue is separate from the storage term (short- or long-term, a location fact) and from
// the lifecycle step (the five-segment track).

export const STAGE_KEYS = ['draft', 'storage', 'lab', 'due', 'danger', 'closed'] as const;
export type StageKey = (typeof STAGE_KEYS)[number];
export const stageKeySchema = z.enum(STAGE_KEYS);

/** The six words a work-item tag starts with. `danger` reads Urgent: red means act now. */
export const STAGE_WORDS: Record<StageKey, string> = {
  draft: 'Draft',
  storage: 'Stored',
  lab: 'In lab',
  due: 'Due',
  danger: 'Urgent',
  closed: 'Closed',
};

/** The domain half of a work-item tag ("Due · Retention"). */
export const WORK_DOMAINS = [
  'receipt',
  'storage',
  'retention',
  'disposal',
  'lab',
  'review',
  'correction',
  'concrete',
  'project',
  'access',
  /** Concrete HOLDs ("Urgent · Hold"). */
  'hold',
  /** Concrete breaks ("In lab · Breaks"). */
  'breaks',
  /** STRATA-104: Help & Feedback in an administrator's Inbox ("Due · Feedback"). */
  'feedback',
] as const;
export type WorkDomain = (typeof WORK_DOMAINS)[number];
export const workDomainSchema = z.enum(WORK_DOMAINS);

export const WORK_DOMAIN_LABELS: Record<WorkDomain, string> = {
  receipt: 'Receipt',
  storage: 'Storage',
  retention: 'Retention',
  disposal: 'Disposal',
  lab: 'Lab',
  review: 'Review',
  correction: 'Correction',
  concrete: 'Concrete',
  project: 'Project',
  access: 'Access',
  hold: 'Hold',
  breaks: 'Breaks',
  feedback: 'Feedback',
};

/** "Due · Retention": the visible text of a work-item tag. */
export function workStageLabel(stage: StageKey, domain: WorkDomain): string {
  return `${STAGE_WORDS[stage]} · ${WORK_DOMAIN_LABELS[domain]}`;
}

/** Stage and domain together, as the API sends them on a work item. */
export const workStageSchema = z.object({ stage: stageKeySchema, domain: workDomainSchema });
export type WorkStage = z.infer<typeof workStageSchema>;

// ---------------------------------------------------------------------------------------------
// Storage term (STRATA-106): a location fact, separate from the stage colour.

export const STORAGE_TERMS = ['short_term', 'long_term'] as const;
export type StorageTerm = (typeof STORAGE_TERMS)[number];
export const storageTermSchema = z.enum(STORAGE_TERMS);

export const STORAGE_TERM_LABELS: Record<StorageTerm, string> = {
  short_term: 'Short-term storage',
  long_term: 'Long-term storage',
};

/**
 * Where a location's effective storage term comes from: its own setting (`own`: a warehouse's
 * default or a bay/shelf override), the nearest ancestor that has one (`inherited`), or nowhere
 * yet (`unset`, an explicit configuration state; never guessed from the name).
 */
export const STORAGE_TERM_SOURCES = ['own', 'inherited', 'unset'] as const;
export type StorageTermSource = (typeof STORAGE_TERM_SOURCES)[number];
export const storageTermSourceSchema = z.enum(STORAGE_TERM_SOURCES);

/** A location's effective storage term, as every read surface returns it (one server resolver). */
export const effectiveStorageTermSchema = z.object({
  term: storageTermSchema.nullable(),
  source: storageTermSourceSchema,
  /** The location the term comes from (itself or an ancestor); null when unset. */
  fromLocation: z.object({ id: z.string(), code: z.string(), name: z.string() }).nullable(),
});
export type EffectiveStorageTerm = z.infer<typeof effectiveStorageTermSchema>;

// ---------------------------------------------------------------------------------------------
// Storage units: record status words and their stage.

/**
 * A storage unit's record status, derived on the server:
 * - `received`: confirmed (ID issued) but not yet put away; shown in the draft hue (STRATA-58).
 * - `in_lab`: checked out to the lab.
 * - `short_term` / `long_term`: on a shelf; the term follows the location's storage term.
 * - `retention_due` / `retention_overdue`: stored and past (or at) its retain-until date.
 * - `disposed`: keeps its ID and history.
 * - `location_conflict`: the saved location has an open conflict someone must confirm.
 */
export const STORAGE_UNIT_RECORD_STATUSES = [
  'received',
  'in_lab',
  'short_term',
  'long_term',
  'retention_due',
  'retention_overdue',
  'disposed',
  'location_conflict',
] as const;
export type StorageUnitRecordStatus = (typeof STORAGE_UNIT_RECORD_STATUSES)[number];
export const storageUnitRecordStatusSchema = z.enum(STORAGE_UNIT_RECORD_STATUSES);

export const STORAGE_UNIT_RECORD_STATUS_LABELS: Record<StorageUnitRecordStatus, string> = {
  received: 'Received',
  in_lab: 'In lab',
  short_term: 'Short-term',
  long_term: 'Long-term',
  retention_due: 'Retention due',
  retention_overdue: 'Retention overdue',
  disposed: 'Disposed',
  location_conflict: 'Location conflict',
};

/** Shorter words for shelf cells, where space is tight. */
export const STORAGE_UNIT_SHELF_CELL_LABELS: Record<StorageUnitRecordStatus, string> = {
  ...STORAGE_UNIT_RECORD_STATUS_LABELS,
  retention_overdue: 'Overdue',
  location_conflict: 'Conflict',
};

export const STORAGE_UNIT_RECORD_STATUS_STAGE: Record<StorageUnitRecordStatus, StageKey> = {
  received: 'draft',
  in_lab: 'lab',
  short_term: 'storage',
  long_term: 'storage',
  retention_due: 'due',
  retention_overdue: 'danger',
  disposed: 'closed',
  location_conflict: 'danger',
};

/** Facts the server already has about a unit; the order of the checks is the rule. */
export interface StorageUnitStatusFacts {
  disposed: boolean;
  openConflict: boolean;
  /** Checked out to the lab (its saved location is a lab location or it is in a lab program). */
  inLab: boolean;
  /** Confirmed but not yet put away (still at the receiving location). */
  awaitingPutAway: boolean;
  /**
   * The location's effective storage term (STRATA-106: set on a warehouse, inherited by its bays
   * and shelves, overridable on a bay or shelf). Null while no location in the chain has one: the
   * unit then reads Short-term (DESIGN.md › Choices made) and the location shows "not set".
   */
  storageTerm: StorageTerm | null;
  /** Retention applies and the effective retain-until date is today or earlier. */
  retentionDue: boolean;
  /** Retention applies and the retain-until date has passed by more than the grace period. */
  retentionOverdue: boolean;
}

/**
 * The one rule for a storage unit's record status. Disposed wins; then an open location conflict
 * (someone must act); then retention (overdue before due); then where it physically is.
 */
export function storageUnitRecordStatus(facts: StorageUnitStatusFacts): StorageUnitRecordStatus {
  if (facts.disposed) return 'disposed';
  if (facts.openConflict) return 'location_conflict';
  if (facts.retentionOverdue) return 'retention_overdue';
  if (facts.retentionDue) return 'retention_due';
  if (facts.inLab) return 'in_lab';
  if (facts.awaitingPutAway) return 'received';
  return facts.storageTerm === 'long_term' ? 'long_term' : 'short_term';
}

/**
 * The five lifecycle track steps (DESIGN.md › Lifecycle, Kyle 2026-11-12): Received, In lab,
 * Short-term storage, Long-term storage, Disposed. Retention and location conflicts are overlays
 * on the record status and never create or move a step.
 */
export const STORAGE_UNIT_LIFECYCLE_STEPS = [
  'received',
  'in_lab',
  'short_term',
  'long_term',
  'disposed',
] as const;
export type StorageUnitLifecycleStep = (typeof STORAGE_UNIT_LIFECYCLE_STEPS)[number];
export const storageUnitLifecycleStepSchema = z.enum(STORAGE_UNIT_LIFECYCLE_STEPS);

/** The one rule for the lifecycle step; the same facts as the record status. */
export function storageUnitLifecycleStep(facts: StorageUnitStatusFacts): StorageUnitLifecycleStep {
  if (facts.disposed) return 'disposed';
  if (facts.inLab) return 'in_lab';
  if (facts.awaitingPutAway) return 'received';
  return facts.storageTerm === 'long_term' ? 'long_term' : 'short_term';
}

/** A record status and its stage, as the API sends them on a list row. */
export const storageUnitStageSchema = z.object({
  recordStatus: storageUnitRecordStatusSchema,
  stage: stageKeySchema,
});
export type StorageUnitStage = z.infer<typeof storageUnitStageSchema>;

export function storageUnitStage(facts: StorageUnitStatusFacts): StorageUnitStage {
  const recordStatus = storageUnitRecordStatus(facts);
  return { recordStatus, stage: STORAGE_UNIT_RECORD_STATUS_STAGE[recordStatus] };
}

// ---------------------------------------------------------------------------------------------
// Other records.

/** Lab program status → stage (draft, in progress, closed). */
export const LAB_PROGRAM_STATUS_STAGE = {
  draft: 'draft',
  submitted: 'lab',
  closed: 'closed',
} as const satisfies Record<'draft' | 'submitted' | 'closed', StageKey>;

/**
 * Projects have no closed state in the app yet, so every project is an active one (`storage`).
 * When projects gain a closed state it maps to `closed` here, in one place.
 */
export const PROJECT_STAGE: StageKey = 'storage';
