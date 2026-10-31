import {
  STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH,
  type FieldError,
  type HoleSummaryType,
} from '@materialmule/shared';
import type { SummaryDraft } from '../receiving/draft';

// Request shapes and plain-language field errors shared by the correction forms (MM-T13,
// MM-T82): Correct details and the bulk sample's "Make it an ordinary bucket".

function depthValue(text: string): number | null {
  const trimmed = text.trim();
  return trimmed === '' ? null : Number(trimmed);
}

/** The request shape of one summary: only the chosen type's fields. */
export function summaryPayload(s: SummaryDraft) {
  return {
    testHoleId: s.testHole.id,
    type: s.type as HoleSummaryType,
    note: s.note.trim(),
    ...(s.type === 'sample_range'
      ? { sampleFrom: s.sampleFrom.trim(), sampleTo: s.sampleTo.trim() }
      : {}),
    ...(s.type === 'depth_range'
      ? {
          depthFrom: depthValue(s.depthFrom),
          depthTo: depthValue(s.depthTo),
          depthUnit: s.depthUnit === '' ? null : s.depthUnit,
        }
      : {}),
    ...(s.type === 'custom' ? { customText: s.customText.trim() } : {}),
  };
}

const FIELD_LABEL: Record<string, string> = {
  reason: 'Reason',
  unitType: 'Type',
  receivedDate: 'Received date',
  projectId: 'Project',
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
  sourceLocationReference: 'Location reference',
  sampleReference: 'Sample reference',
};

export function messageFor(error: FieldError): string {
  const key = error.field.split('.').at(-1) ?? error.field;
  // MM-T82 (owner decision 2026-10-30): test evidence rests on the unit's source.
  if (error.code === 'storage_unit_tested') {
    return 'This unit was used in a completed test: its sampling source and bulk sample can’t change.';
  }
  if (key === 'reason') {
    return `Enter a reason (at least ${STORAGE_UNIT_CORRECTION_REASON_MIN_LENGTH} characters).`;
  }
  if (key === 'changes' && error.code === 'no_changes') return 'Change at least one value.';
  if (key === 'receivedDate' && error.code === 'in_future') {
    return "Received date can't be in the future.";
  }
  if (key === 'projectId') {
    return error.code === 'not_found'
      ? 'Project not found. Choose it again.'
      : 'Choose the new project, or keep the current one.';
  }
  if (key === 'holeSummaries') return 'Choose at least one test hole in the project.';
  if (key === 'type') return 'Choose a summary type: ALL, Sample range, Depth range or Custom.';
  if (key === 'depthUnit') return 'Choose ft or m.';
  if (key === 'depthTo' && error.code === 'depth_range_reversed') {
    return 'Depth to must be greater than or equal to depth from.';
  }
  if (error.code === 'storage_unit_disposed') {
    return 'This storage unit is disposed: its type, project, sampling source and test holes can’t change.';
  }
  if (error.code === 'test_hole_not_in_project') return 'This test hole isn’t in the project.';
  const label = FIELD_LABEL[key] ?? key;
  if (error.code === 'required') return `${label} is required.`;
  return `${label} ${error.message}.`;
}
