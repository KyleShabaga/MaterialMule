import type { DraftLineInputValue, LabSourceRef, LineScope } from '@materialmule/shared';

// A testing line as the person edits it: program entry (MM-T23) and lines added by an
// amendment (MM-T83). Numbers stay text until sent, so a half-typed depth isn't lost.

export interface LineDraft {
  key: string;
  id?: string;
  source: LabSourceRef | null;
  scope: LineScope;
  sampleLabel: string;
  depthMode: 'point' | 'interval';
  depthFrom: string;
  depthTo: string;
  depthUnit: 'ft' | 'm';
  testTypeIds: string[];
  unitIds: string[];
  acknowledgedDepths: string[];
}

const newKey = () => crypto.randomUUID();

export function emptyLine(): LineDraft {
  return {
    key: newKey(),
    source: null,
    scope: 'all',
    sampleLabel: '',
    depthMode: 'point',
    depthFrom: '',
    depthTo: '',
    depthUnit: 'ft',
    testTypeIds: [],
    unitIds: [],
    acknowledgedDepths: [],
  };
}

export const numberOrNull = (text: string) => (text.trim() === '' ? null : Number(text));

export function toInput(line: LineDraft): DraftLineInputValue {
  const specific = line.scope === 'specific';
  return {
    id: line.id,
    source: line.source,
    scope: line.scope,
    sampleLabel: specific ? line.sampleLabel : null,
    depthMode: specific ? line.depthMode : null,
    depthFrom: specific ? numberOrNull(line.depthFrom) : null,
    depthTo: specific && line.depthMode === 'interval' ? numberOrNull(line.depthTo) : null,
    depthUnit: specific ? line.depthUnit : null,
    testTypeIds: line.testTypeIds,
    unitIds: line.scope === 'all' ? [] : line.unitIds,
    acknowledgedDepths: specific ? line.acknowledgedDepths : [],
  };
}
