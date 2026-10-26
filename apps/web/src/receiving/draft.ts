import {
  confirmReceiptRequestSchema,
  toFieldErrors,
  type ConfirmReceiptRequestInput,
  type FieldError,
  type HoleSummaryType,
  type ProjectSummary,
  type ReceiverOption,
  type TestHole,
} from '@trapezoid/shared';

// The receiving wizard's draft (TRP-T10): one object holding everything entered, so moving
// between steps never loses a value and TRP-T11 can persist it as is. Receiving is per storage
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

export interface UnitDraft {
  clientRowId: string;
  unitType: 'bucket';
  note: string;
  holeQuery: string;
  summaries: SummaryDraft[];
}

export interface ReceiptDraft {
  /** Created with the draft; every confirmation attempt for this draft reuses it (TRP-T09). */
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

export function newUnit(): UnitDraft {
  return { clientRowId: newUuid(), unitType: 'bucket', note: '', holeQuery: '', summaries: [] };
}

/** A copy of a unit (holes, summaries and note) with its own row ID. */
export function duplicateUnit(unit: UnitDraft): UnitDraft {
  return {
    ...unit,
    clientRowId: newUuid(),
    holeQuery: '',
    summaries: unit.summaries.map((summary) => ({ ...summary })),
  };
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

export const UNIT_TYPE_LABEL: Record<UnitDraft['unitType'], string> = { bucket: 'Bucket' };

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

/** "Bucket 1 · TH26-01: G1–S12 · TH26-02: ALL" */
export function unitHeadline(index: number, unit: UnitDraft): string {
  const parts = unit.summaries.map((s) => `${s.testHole.name}: ${formatSummaryValue(s)}`);
  return [unitName(index, unit), ...(parts.length > 0 ? parts : ['no test holes yet'])].join(' · ');
}

function depthValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/**
 * The request body for `POST /api/receipts`. Only the fields of the chosen summary type are
 * sent, so switching type in the editor never leaves stale values in the payload.
 */
export function toConfirmRequest(draft: ReceiptDraft): ConfirmReceiptRequestInput {
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
    })),
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
};

/** Plain-language message for a T09 field error. */
function messageFor(error: FieldError): string {
  const key = error.field.split('.').at(-1) ?? error.field;
  const label = FIELD_LABEL[key] ?? key;
  switch (key) {
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
      return 'Choose at least one test hole.';
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

/** Field errors (from the shared schema or the API) as problems located in the draft. */
export function describeErrors(draft: ReceiptDraft, errors: FieldError[]): DraftProblem[] {
  const seen = new Set<string>();
  const problems: DraftProblem[] = [];
  for (const error of errors) {
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
 * Validates the draft with the same shared schema `POST /api/receipts` uses (TRP-T09), plus the
 * server's future-date check, so problems show before any API call.
 */
export function validateDraft(draft: ReceiptDraft, today = todayInEdmonton()): DraftProblem[] {
  const parsed = confirmReceiptRequestSchema.safeParse(toConfirmRequest(draft));
  const errors = parsed.success ? [] : toFieldErrors(parsed.error);
  if (/^\d{4}-\d{2}-\d{2}$/.test(draft.receivedDate) && draft.receivedDate > today) {
    errors.push({ field: 'receivedDate', code: 'in_future', message: "can't be in the future" });
  }
  // Report problems in the order fields appear on screen.
  const order = ['projectId', 'receivedDate', 'receiverUserId', 'description', 'units'];
  const rank = (field: string) => {
    const index = order.indexOf(field.split('.')[0]!);
    return index === -1 ? order.length : index;
  };
  errors.sort((a, b) => rank(a.field) - rank(b.field));
  return describeErrors(draft, errors);
}
