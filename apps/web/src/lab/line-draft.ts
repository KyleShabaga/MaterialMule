import {
  lineSubmitProblems,
  type DraftLineInputValue,
  type FieldError,
  type LabProgram,
  type LabSourceRef,
  type LineScope,
} from '@materialmule/shared';

// A testing line as the person edits it: program entry (MM-T23, STRATA-86 Lines and Grid views)
// and lines added by an amendment (MM-T83). Numbers stay text until sent, so a half-typed depth
// isn't lost. The source keeps its exact identity (test hole, standalone Shelby tube or
// standalone bulk group); the depth belongs to a Specific sample only.

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

/** A copy for "Duplicate line": same source, sample and tests; a new line on the server. */
export function duplicateLine(line: LineDraft): LineDraft {
  return {
    ...line,
    key: newKey(),
    id: undefined,
    testTypeIds: [...line.testTypeIds],
    unitIds: [...line.unitIds],
    acknowledgedDepths: [],
  };
}

/** The editor's lines from a saved draft (the server's line IDs become the keys). */
export function linesFromProgram(program: Pick<LabProgram, 'lines'>): LineDraft[] {
  return program.lines.map((line) => ({
    key: line.id,
    id: line.id,
    source: line.source ? { kind: line.source.kind, id: line.source.id } : null,
    scope: line.scope,
    sampleLabel: line.sampleLabel ?? '',
    depthMode: line.depthMode ?? 'point',
    depthFrom: line.depthFrom === null ? '' : String(line.depthFrom),
    depthTo: line.depthTo === null ? '' : String(line.depthTo),
    depthUnit: line.depthUnit ?? 'ft',
    testTypeIds: line.tests.map((test) => test.testTypeId),
    unitIds: line.unitIds,
    acknowledgedDepths: line.acknowledgedDepths,
  }));
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

/** What keeps this line from being submitted, worded for the line itself. */
export function lineProblems(line: LineDraft): FieldError[] {
  const specific = line.scope === 'specific';
  const from = numberOrNull(line.depthFrom);
  const to = numberOrNull(line.depthTo);
  const problems = lineSubmitProblems({
    source: line.source,
    scope: line.scope,
    sampleLabel: specific && line.sampleLabel.trim() ? line.sampleLabel.trim() : null,
    depthMode: specific ? line.depthMode : null,
    depthFrom: specific ? from : null,
    depthTo: specific && line.depthMode === 'interval' ? to : null,
    depthUnit: specific ? line.depthUnit : null,
    testCount: line.testTypeIds.length,
  }).map((problem) =>
    problem.field === 'testTypeIds' ? { ...problem, message: 'Add a test to this line.' } : problem,
  );
  if (specific) {
    if (line.depthFrom.trim() !== '' && Number.isNaN(from)) {
      problems.push({
        field: 'depthFrom',
        code: 'invalid',
        message: 'Enter the depth as a number.',
      });
    }
    if (line.depthMode === 'interval' && line.depthTo.trim() !== '' && Number.isNaN(to)) {
      problems.push({ field: 'depthTo', code: 'invalid', message: 'Enter the depth as a number.' });
    } else if (line.depthMode === 'interval' && from !== null && to !== null && to < from) {
      problems.push({
        field: 'depthTo',
        code: 'depth_range_reversed',
        message: 'The interval must end below where it starts.',
      });
    }
  }
  return problems;
}
