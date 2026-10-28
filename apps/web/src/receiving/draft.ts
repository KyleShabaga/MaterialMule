import {
  bulkGroupOptionLabel,
  confirmReceiptRequestSchema,
  toFieldErrors,
  type BulkGroupSummary,
  type ConfirmReceiptRequestInput,
  type FieldError,
  type HoleSummaryType,
  type ProjectSummary,
  type ReceiptUnitType,
  type ReceiverOption,
  type SamplingSourceType,
  type TestHole,
} from '@materialmule/shared';

// The receiving wizard's draft (MM-T10): one object holding everything entered, so moving
// between steps never loses a value and MM-T11 can persist it as is. Receiving is per storage
// unit with one SAMPLE#/DEPTH summary per test hole; there is no individual sample inventory.

export interface SummaryDraft {
  testHole: TestHole;
  /** Empty until the receiver chooses; there is no default summary type. */
  type: HoleSummaryType | '';
  sampleFrom: string;
  sampleTo: string;
  /** Kept as typed; converted to a number only for the request. Never converted between units. */
  depthFrom: string;
  depthTo: string;
  /** Required for a depth range, with no default. */
  depthUnit: 'ft' | 'm' | '';
  customText: string;
  note: string;
}

/**
 * A sampling source with optional sample reference and depth (MM-T36): a Shelby tube's own, or a
 * new bulk sample's. The source is a test hole of the project or a standalone sampling location
 * typed as free text on this row (no directory of locations).
 */
export interface SampleDraft {
  /** Empty until chosen; there is no default source type. */
  sourceType: SamplingSourceType | '';
  testHole: TestHole | null;
  holeQuery: string;
  locationReference: string;
  /** e.g. T5 for a tube, B1 for a bulk sample (a convention, never forced). */
  sampleReference: string;
  /** Kept as typed, like hole summaries; never converted between units. */
  depthFrom: string;
  depthTo: string;
  depthUnit: 'ft' | 'm' | '';
}

export interface BulkIdentityDraft extends SampleDraft {
  description: string;
}

/**
 * Which bulk sample a bulk soil bucket holds: a new one described on this row, the same new one
 * as an earlier row of this receipt, or an existing one of the project as it was shown (its
 * version goes with the request, so a correction made since is caught).
 */
export type BulkChoice =
  | { kind: 'new'; identity: BulkIdentityDraft }
  | { kind: 'same_as'; clientRowId: string }
  | { kind: 'existing'; group: BulkGroupSummary };

export interface UnitDraft {
  clientRowId: string;
  /** Physical holder: Bucket (default) or Shelby tube (MM-T36). */
  unitType: ReceiptUnitType;
  note: string;
  holeQuery: string;
  /** Ordinary buckets: one SAMPLE#/DEPTH summary per test hole. */
  summaries: SummaryDraft[];
  /** Buckets only: holds a bulk soil sample, whose identity replaces hole summaries. */
  bulk: boolean;
  bulkChoice: BulkChoice;
  /** Shelby tubes only. */
  tube: SampleDraft;
}

export interface ReceiptDraft {
  /** Created with the draft; every confirmation attempt for this draft reuses it (MM-T09). */
  idempotencyKey: string;
  projectQuery: string;
  project: ProjectSummary | null;
  receivedDate: string;
  receiver: ReceiverOption | null;
  description: string;
  units: UnitDraft[];
}

/**
 * Random v4 UUID. crypto.randomUUID() needs a secure context, and phones reach the office PC
 * over plain http on the LAN, so build it from getRandomValues (available everywhere).
 */
export function newUuid(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Today's date in the lab's time zone, as YYYY-MM-DD. */
export function todayInEdmonton(now = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Edmonton',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(now);
}

export function newSummary(testHole: TestHole): SummaryDraft {
  return {
    testHole,
    type: '',
    sampleFrom: '',
    sampleTo: '',
    depthFrom: '',
    depthTo: '',
    depthUnit: '',
    customText: '',
    note: '',
  };
}

export function emptySample(): SampleDraft {
  return {
    sourceType: '',
    testHole: null,
    holeQuery: '',
    locationReference: '',
    sampleReference: '',
    depthFrom: '',
    depthTo: '',
    depthUnit: '',
  };
}

export function newBulkChoice(): BulkChoice {
  return { kind: 'new', identity: { ...emptySample(), description: '' } };
}

export function newUnit(): UnitDraft {
  return {
    clientRowId: newUuid(),
    unitType: 'bucket',
    note: '',
    holeQuery: '',
    summaries: [],
    bulk: false,
    bulkChoice: newBulkChoice(),
    tube: emptySample(),
  };
}

/**
 * Fills in what a draft saved before MM-T36 lacks (every row was an ordinary bucket), and repairs
 * anything unreadable, so an old draft opens exactly as it was saved.
 */
export function normalizeUnit(unit: Partial<UnitDraft> & { clientRowId: string }): UnitDraft {
  const blank = newUnit();
  const sample = (value: unknown): SampleDraft =>
    value && typeof value === 'object'
      ? { ...emptySample(), ...(value as SampleDraft) }
      : emptySample();
  const choice = unit.bulkChoice;
  return {
    ...blank,
    ...unit,
    unitType: unit.unitType === 'shelby_tube' ? 'shelby_tube' : 'bucket',
    note: typeof unit.note === 'string' ? unit.note : '',
    holeQuery: typeof unit.holeQuery === 'string' ? unit.holeQuery : '',
    summaries: Array.isArray(unit.summaries) ? unit.summaries : [],
    bulk: unit.unitType !== 'shelby_tube' && unit.bulk === true,
    bulkChoice:
      choice?.kind === 'new'
        ? {
            kind: 'new',
            identity: {
              ...sample(choice.identity),
              description: choice.identity?.description ?? '',
            },
          }
        : choice?.kind === 'same_as' || choice?.kind === 'existing'
          ? choice
          : blank.bulkChoice,
    tube: sample(unit.tube),
  };
}

/**
 * Changes the holder or contents. What the old choice entered is dropped, never kept hidden: a
 * bulk soil bucket's identity replaces hole summaries, and a tube's source replaces both.
 */
export function withUnitKind(unit: UnitDraft, kind: 'bucket' | 'bulk' | 'shelby_tube'): UnitDraft {
  const current = unit.unitType === 'shelby_tube' ? 'shelby_tube' : unit.bulk ? 'bulk' : 'bucket';
  if (current === kind) return unit;
  return {
    ...unit,
    unitType: kind === 'shelby_tube' ? 'shelby_tube' : 'bucket',
    bulk: kind === 'bulk',
    holeQuery: '',
    summaries: [],
    bulkChoice: newBulkChoice(),
    tube: emptySample(),
  };
}

/**
 * A copy of a unit with its own row ID. A copy of a bulk soil bucket holds the same bulk sample
 * (the usual second bucket); everything else is copied as entered.
 */
export function duplicateUnit(unit: UnitDraft): UnitDraft {
  const bulkChoice: BulkChoice =
    unit.bulk && unit.bulkChoice.kind === 'new'
      ? { kind: 'same_as', clientRowId: unit.clientRowId }
      : unit.bulkChoice;
  return {
    ...unit,
    clientRowId: newUuid(),
    holeQuery: '',
    summaries: unit.summaries.map((summary) => ({ ...summary })),
    bulkChoice,
    tube: { ...unit.tube, holeQuery: '' },
  };
}

/** The row whose new bulk sample this bulk row holds, or the existing group; null if broken. */
export function resolveBulkChoice(
  draft: Pick<ReceiptDraft, 'units'>,
  unit: UnitDraft,
):
  | { kind: 'new'; owner: UnitDraft; identity: BulkIdentityDraft }
  | { kind: 'existing'; group: BulkGroupSummary }
  | null {
  let choice = unit.bulkChoice;
  let owner = unit;
  // Follow "same as" links (a copy of a copy); a loop or a removed row ends unresolved.
  for (let hops = 0; hops <= draft.units.length; hops++) {
    if (choice.kind === 'new') return { kind: 'new', owner, identity: choice.identity };
    if (choice.kind === 'existing') return { kind: 'existing', group: choice.group };
    const target = draft.units.find(
      (u) => u.clientRowId === (choice as { clientRowId: string }).clientRowId,
    );
    if (!target || !target.bulk || target.unitType !== 'bucket') return null;
    owner = target;
    choice = target.bulkChoice;
  }
  return null;
}

/** "TH26-21", "Embankment Location 03" or "" while not chosen. */
function sampleSourceText(sample: SampleDraft): string {
  if (sample.sourceType === 'test_hole') return sample.testHole?.name ?? '';
  if (sample.sourceType === 'standalone_location') return sample.locationReference.trim();
  return '';
}

/** "TH26-21: B1 at 1.5–2 m" from what is typed (blank parts left out). */
export function formatSampleDraft(sample: SampleDraft): string {
  // Depths exactly as typed, like formatDepth shows saved ones.
  const depthFrom = sample.depthFrom.trim();
  const depthTo = sample.depthTo.trim();
  const depth =
    depthFrom === ''
      ? ''
      : `${depthTo === '' ? depthFrom : `${depthFrom}–${depthTo}`} ${sample.depthUnit || '(ft or m?)'}`;
  const details = [sample.sampleReference.trim(), depth].filter(Boolean).join(' at ');
  const source = sampleSourceText(sample) || 'source not chosen';
  return details ? `${source}: ${details}` : source;
}

/** What a bulk row holds, as review and the unit band show it. */
export function bulkChoiceText(draft: Pick<ReceiptDraft, 'units'>, unit: UnitDraft): string {
  const resolved = resolveBulkChoice(draft, unit);
  if (!resolved) return 'bulk sample not chosen';
  if (resolved.kind === 'existing') return bulkGroupOptionLabel(resolved.group).split(' — ')[0]!;
  return formatSampleDraft(resolved.identity);
}

/**
 * This receipt's bulk samples with their buckets, in the order first used: what review groups
 * by. A one-bucket bulk sample is valid.
 */
export function bulkSamplesInDraft(draft: Pick<ReceiptDraft, 'units'>): {
  key: string;
  text: string;
  existing: BulkGroupSummary | null;
  rows: { unit: UnitDraft; index: number }[];
}[] {
  const groups = new Map<
    string,
    {
      key: string;
      text: string;
      existing: BulkGroupSummary | null;
      rows: { unit: UnitDraft; index: number }[];
    }
  >();
  draft.units.forEach((unit, index) => {
    if (unit.unitType !== 'bucket' || !unit.bulk) return;
    const resolved = resolveBulkChoice(draft, unit);
    const key = !resolved
      ? `unresolved:${unit.clientRowId}`
      : resolved.kind === 'existing'
        ? `existing:${resolved.group.id}`
        : `new:${resolved.owner.clientRowId}`;
    const entry = groups.get(key) ?? {
      key,
      text: bulkChoiceText(draft, unit),
      existing: resolved?.kind === 'existing' ? resolved.group : null,
      rows: [],
    };
    entry.rows.push({ unit, index });
    groups.set(key, entry);
  });
  return [...groups.values()];
}

/** Keeps the summaries of holes still selected, adds a blank one for each newly chosen hole. */
export function withHoles(unit: UnitDraft, holes: TestHole[]): UnitDraft {
  const byHole = new Map(unit.summaries.map((summary) => [summary.testHole.id, summary]));
  return { ...unit, summaries: holes.map((hole) => byHole.get(hole.id) ?? newSummary(hole)) };
}

export function newDraft(receiver: ReceiverOption | null, today = todayInEdmonton()): ReceiptDraft {
  return {
    idempotencyKey: newUuid(),
    projectQuery: '',
    project: null,
    receivedDate: today,
    receiver,
    description: '',
    units: [newUnit()],
  };
}

/** "1 storage unit", "3 storage units" (D41: the quantity is the number of unit rows). */
export function formatUnitCount(count: number): string {
  return `${count} storage unit${count === 1 ? '' : 's'}`;
}

export const UNIT_TYPE_LABEL: Record<UnitDraft['unitType'], string> = {
  bucket: 'Bucket',
  shelby_tube: 'Shelby tube',
};

/** "Bucket", "Bucket · Bulk soil sample" or "Shelby tube". */
export function unitKindLabel(unit: UnitDraft): string {
  return unit.unitType === 'bucket' && unit.bulk
    ? 'Bucket · Bulk soil sample'
    : UNIT_TYPE_LABEL[unit.unitType];
}

export const SUMMARY_TYPE_LABEL: Record<HoleSummaryType, string> = {
  all: 'ALL',
  sample_range: 'Sample range',
  depth_range: 'Depth range',
  custom: 'Custom',
};

/** "G1–S12", "0–10.5 m", "ALL": depths exactly as entered, in the unit chosen. */
export function formatSummaryValue(summary: SummaryDraft): string {
  const or = (text: string) => text.trim() || '…';
  switch (summary.type) {
    case 'all':
      return 'ALL';
    case 'sample_range':
      return `${or(summary.sampleFrom)}–${or(summary.sampleTo)}`;
    case 'depth_range':
      return `${or(summary.depthFrom)}–${or(summary.depthTo)} ${summary.depthUnit || '(ft or m?)'}`;
    case 'custom':
      return or(summary.customText);
    default:
      return 'summary not chosen';
  }
}

export function unitName(index: number, unit: UnitDraft): string {
  return `${UNIT_TYPE_LABEL[unit.unitType]} ${index + 1}`;
}

/**
 * "Bucket 1 · TH26-01: G1–S12 · TH26-02: ALL", "Shelby tube 2 · TH26-21: T5" or
 * "Bucket 3 · Bulk soil sample · TH26-21: B1 at 1.5–2 m".
 */
export function unitHeadline(
  index: number,
  unit: UnitDraft,
  draft: Pick<ReceiptDraft, 'units'> = { units: [unit] },
): string {
  let parts: string[];
  if (unit.unitType === 'shelby_tube') {
    parts = [formatSampleDraft(unit.tube)];
  } else if (unit.bulk) {
    parts = ['Bulk soil sample', bulkChoiceText(draft, unit)];
  } else {
    parts = unit.summaries.map((s) => `${s.testHole.name}: ${formatSummaryValue(s)}`);
    if (parts.length === 0) parts = ['no test holes yet'];
  }
  return [unitName(index, unit), ...parts].join(' · ');
}

function depthValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** Source, reference and depth fields for the request: only those of the chosen source type. */
export function sampleFields(sample: SampleDraft) {
  return {
    sourceType: sample.sourceType as SamplingSourceType,
    ...(sample.sourceType === 'test_hole' ? { testHoleId: sample.testHole?.id ?? null } : {}),
    ...(sample.sourceType === 'standalone_location'
      ? { sourceLocationReference: sample.locationReference }
      : {}),
    sampleReference: sample.sampleReference,
    depthFrom: depthValue(sample.depthFrom),
    depthTo: depthValue(sample.depthTo),
    depthUnit: sample.depthUnit === '' ? null : sample.depthUnit,
  };
}

/** Rows that describe a new bulk sample, in order: `bulkGroups[n]` belongs to row `newBulkRows[n]`. */
function newBulkRows(draft: Pick<ReceiptDraft, 'units'>): number[] {
  const rows: number[] = [];
  draft.units.forEach((unit, index) => {
    if (unit.unitType === 'bucket' && unit.bulk && unit.bulkChoice.kind === 'new') rows.push(index);
  });
  return rows;
}

/** One unit's contents: hole summaries, a tube's sample, or a bulk bucket's group reference. */
function unitContents(draft: ReceiptDraft, unit: UnitDraft) {
  if (unit.unitType === 'shelby_tube') return { sample: sampleFields(unit.tube) };
  if (unit.bulk) {
    const resolved = resolveBulkChoice(draft, unit);
    return {
      bulkGroup: !resolved
        ? // A "same as" row whose bucket was removed or changed: the API names it unknown.
          { newGroupKey: `missing:${unit.clientRowId}` }
        : resolved.kind === 'existing'
          ? { existingId: resolved.group.id, version: resolved.group.version }
          : { newGroupKey: resolved.owner.clientRowId },
    };
  }
  return {
    holeSummaries: unit.summaries.map((s) => ({
      testHoleId: s.testHole.id,
      type: s.type as HoleSummaryType,
      note: s.note,
      ...(s.type === 'sample_range' ? { sampleFrom: s.sampleFrom, sampleTo: s.sampleTo } : {}),
      ...(s.type === 'depth_range'
        ? {
            depthFrom: depthValue(s.depthFrom),
            depthTo: depthValue(s.depthTo),
            depthUnit: s.depthUnit === '' ? null : s.depthUnit,
          }
        : {}),
      ...(s.type === 'custom' ? { customText: s.customText } : {}),
    })),
  };
}

/**
 * The request body for `POST /api/receipts`. Only the fields of the chosen holder, contents,
 * source and summary type are sent, so switching any of them never leaves stale values in the
 * payload. New bulk samples are declared once, keyed by the row that describes them.
 */
export function toConfirmRequest(draft: ReceiptDraft): ConfirmReceiptRequestInput {
  const bulkGroups = newBulkRows(draft).map((index) => {
    const unit = draft.units[index]!;
    const identity = (unit.bulkChoice as Extract<BulkChoice, { kind: 'new' }>).identity;
    return {
      key: unit.clientRowId,
      ...sampleFields(identity),
      description: identity.description,
    };
  });
  return {
    idempotencyKey: draft.idempotencyKey,
    projectId: draft.project?.id ?? '',
    receivedDate: draft.receivedDate,
    receiverUserId: draft.receiver?.id ?? '',
    description: draft.description,
    units: draft.units.map((unit) => ({
      clientRowId: unit.clientRowId,
      unitType: unit.unitType,
      note: unit.note,
      ...unitContents(draft, unit),
    })),
    // Left out when there are none, so a receipt of ordinary buckets hashes as before MM-T36.
    ...(bulkGroups.length > 0 ? { bulkGroups } : {}),
  };
}

/** One problem shown next to its field and in the step's error summary. */
export interface DraftProblem {
  /** Dotted request path, e.g. `units.0.holeSummaries.1.depthTo` (as the API reports it). */
  field: string;
  /** Where it is, e.g. "Bucket 1 · TH26-01"; empty for receipt-level fields. */
  where: string;
  message: string;
}

/** DOM id of the input (or wrapper) for a request path, used by error-summary links. */
export function fieldId(field: string): string {
  return `receipt-${field.replace(/\./g, '-')}`;
}

const FIELD_LABEL: Record<string, string> = {
  projectId: 'Project',
  receivedDate: 'Received date',
  receiverUserId: 'Received by',
  description: 'Description',
  units: 'Storage units',
  note: 'Note',
  holeSummaries: 'Test holes',
  testHoleId: 'Test hole',
  type: 'Summary type',
  sampleFrom: 'Sample from',
  sampleTo: 'Sample to',
  depthFrom: 'Depth from',
  depthTo: 'Depth to',
  depthUnit: 'Depth unit',
  customText: 'Custom summary',
  sample: 'Sampling source',
  sourceType: 'Sampling source',
  sourceLocationReference: 'Standalone sampling location',
  sampleReference: 'Sample reference',
  bulkGroup: 'Bulk sample',
};

/** Plain-language message for a T09 field error. */
function messageFor(error: FieldError): string {
  const key = error.field.split('.').at(-1) ?? error.field;
  const label =
    key === 'description' && error.field.includes('.bulkGroup.')
      ? 'Bulk sample description'
      : (FIELD_LABEL[key] ?? key);
  // MM-T36: bulk sample and sampling source problems.
  switch (error.code) {
    case 'bulk_group_changed':
      return 'This bulk sample was corrected since it was chosen. Choose it again.';
    case 'bulk_group_not_in_project':
      return 'That bulk sample isn’t part of this project. Choose one of this project’s.';
    case 'unknown_bulk_group':
      return 'The bucket this one shared a bulk sample with was changed or removed. Choose the bulk sample again.';
    case 'conflicting_source':
      return 'Use either a test hole or a standalone location, not both.';
  }
  if (/\.(sample|bulkGroup\.new)\.testHoleId$/.test(error.field)) {
    return error.code === 'test_hole_not_in_project'
      ? 'That test hole isn’t part of this project. Choose it again.'
      : 'Choose the test hole the sample came from.';
  }
  switch (key) {
    case 'sourceType':
      return 'Choose the sampling source: a test hole or a standalone sampling location.';
    case 'sourceLocationReference':
      return error.code === 'required'
        ? 'Enter the standalone sampling location.'
        : `${label} ${error.message}.`;
    case 'sampleReference':
      return error.code === 'required'
        ? 'Enter the sample reference (for example B1).'
        : `${label} ${error.message}.`;
    case 'bulkGroup':
      return 'Choose the bulk sample this bucket holds.';
    case 'projectId':
      if (error.code === 'not_found') return 'Project not found. Choose it again.';
      return 'Choose a project.';
    case 'receiverUserId':
      return error.code === 'invalid_format' || error.code === 'invalid_type'
        ? 'Choose who received the samples.'
        : `Received by ${error.message}.`;
    case 'receivedDate':
      if (error.code === 'in_future') return "Received date can't be in the future.";
      return 'Enter the received date.';
    case 'units':
      return error.code === 'too_small'
        ? 'Add at least one storage unit.'
        : `${label} ${error.message}.`;
    case 'holeSummaries':
      return error.code === 'not_allowed'
        ? 'This unit has a sampling source instead of test-hole summaries.'
        : 'Choose at least one test hole.';
    case 'depthFrom':
      if (error.code === 'required' && !error.field.includes('.holeSummaries.')) {
        return 'Enter the depth (or the top of the depth interval).';
      }
      break;
    case 'type':
      return 'Choose a summary type: ALL, Sample range, Depth range or Custom.';
    case 'depthUnit':
      return 'Choose ft or m.';
    case 'customText':
      return error.code === 'required'
        ? 'Describe the samples (Custom needs text).'
        : `${label} ${error.message}.`;
    case 'depthTo':
      if (error.code === 'depth_range_reversed') {
        return 'Depth to must be greater than or equal to depth from.';
      }
      break;
  }
  if (error.code === 'required') return `${label} is required.`;
  if (error.code === 'invalid_type' && /depth/.test(key)) return `${label} must be a number.`;
  return `${label} ${error.message}.`;
}

function whereFor(draft: ReceiptDraft, field: string): string {
  const [first, unitIndex, second, summaryIndex] = field.split('.');
  if (first !== 'units' || unitIndex === undefined) return '';
  const unit = draft.units[Number(unitIndex)];
  if (!unit) return '';
  const name = unitName(Number(unitIndex), unit);
  const hole = second === 'holeSummaries' ? unit.summaries[Number(summaryIndex)] : undefined;
  return hole ? `${name} · ${hole.testHole.name}` : name;
}

/**
 * Where a request path is edited (MM-T36): a new bulk sample's fields (`bulkGroups.N.x`) belong
 * to the row that describes it, and the bucket's group reference to its bulk sample picker.
 */
export function editorField(draft: Pick<ReceiptDraft, 'units'>, field: string): string {
  const group = /^bulkGroups\.(\d+)(?:\.(.+))?$/.exec(field);
  if (group) {
    const row = newBulkRows(draft)[Number(group[1])];
    if (row === undefined) return '';
    return group[2] && group[2] !== 'key'
      ? `units.${row}.bulkGroup.new.${group[2]}`
      : `units.${row}.bulkGroup`;
  }
  const ref = /^(units\.\d+\.bulkGroup)\.(existingId|version|newGroupKey)$/.exec(field);
  return ref ? ref[1]! : field;
}

/** Field errors (from the shared schema or the API) as problems located in the draft. */
export function describeErrors(draft: ReceiptDraft, errors: FieldError[]): DraftProblem[] {
  const seen = new Set<string>();
  const problems: DraftProblem[] = [];
  for (const raw of errors) {
    const error = { ...raw, field: editorField(draft, raw.field) };
    // Rows' own IDs and the key are generated, never typed; report them on the receipt.
    const field = /(^idempotencyKey$|clientRowId$)/.test(error.field) ? '' : error.field;
    const message =
      field === '' ? 'Something in this draft is invalid. Start a new receipt.' : messageFor(error);
    const key = `${field}|${message}`;
    if (seen.has(key)) continue;
    seen.add(key);
    problems.push({ field, where: whereFor(draft, field), message });
  }
  return problems;
}

/**
 * Validates the draft with the same shared schema `POST /api/receipts` uses (MM-T09), plus the
 * server's future-date check, so problems show before any API call.
 */
export function validateDraft(draft: ReceiptDraft, today = todayInEdmonton()): DraftProblem[] {
  const parsed = confirmReceiptRequestSchema.safeParse(toConfirmRequest(draft));
  // A new bulk sample's problems belong to the row that describes it (MM-T36).
  const errors = (parsed.success ? [] : toFieldErrors(parsed.error)).map((error) => ({
    ...error,
    field: editorField(draft, error.field),
  }));
  if (/^\d{4}-\d{2}-\d{2}$/.test(draft.receivedDate) && draft.receivedDate > today) {
    errors.push({ field: 'receivedDate', code: 'in_future', message: "can't be in the future" });
  }
  // Report problems in the order fields appear on screen: receipt fields, then unit by unit.
  const order = ['projectId', 'receivedDate', 'receiverUserId', 'description', 'units'];
  const rank = (field: string) => {
    const [first, unitIndex] = field.split('.');
    const index = order.indexOf(first!);
    return (index === -1 ? order.length : index) * 1000 + (Number(unitIndex) || 0);
  };
  errors.sort((a, b) => rank(a.field) - rank(b.field));
  return describeErrors(draft, errors);
}
