import type { LabProgramReview, LabSource } from '@materialmule/shared';
import { duplicateLine, emptyLine, lineProblems, type LineDraft } from '../line-draft';

// One program-edit state and one validator (STRATA-86) feeding both the Lines and the Grid view:
// switching views only changes how the same lines are shown, never what they hold.

export interface ProgramEditState {
  notes: string;
  lines: LineDraft[];
  /** Bumped by every edit; a save or review belongs to the revision it was made from. */
  revision: number;
}

export type EditAction =
  | { type: 'change-line'; key: string; change: Partial<LineDraft> }
  | { type: 'add-line' }
  | { type: 'duplicate-line'; key: string }
  | { type: 'remove-line'; key: string }
  /** Tick or untick one test on one line (a Grid cell, a chip's remove). */
  | { type: 'set-test'; key: string; testTypeId: string; on: boolean }
  /** Add tests to one line, keeping its order (Add test, a template). */
  | { type: 'add-tests'; key: string; testTypeIds: string[] }
  /** A Grid column heading: the test on every line, or on none. */
  | { type: 'set-test-everywhere'; testTypeId: string; on: boolean }
  /** "Choose a template" for the whole program: its tests on every line. */
  | { type: 'add-tests-everywhere'; testTypeIds: string[] }
  | { type: 'notes'; notes: string }
  /** The server's line IDs after a save, by client key. Not an edit. */
  | { type: 'learn-ids'; ids: Record<string, string> }
  /** A newer saved version replaces what is here (Reload). */
  | { type: 'replace'; notes: string; lines: LineDraft[] };

const addMissing = (current: string[], ids: string[]) => [
  ...current,
  ...ids.filter((id, i) => !current.includes(id) && ids.indexOf(id) === i),
];

export function initialEditState(notes: string, lines: LineDraft[]): ProgramEditState {
  return { notes, lines: lines.length > 0 ? lines : [emptyLine()], revision: 0 };
}

export function editReducer(state: ProgramEditState, action: EditAction): ProgramEditState {
  const edit = (lines: LineDraft[], notes = state.notes): ProgramEditState => ({
    notes,
    lines,
    revision: state.revision + 1,
  });
  const mapLine = (key: string, fn: (line: LineDraft) => LineDraft) =>
    edit(state.lines.map((line) => (line.key === key ? fn(line) : line)));
  switch (action.type) {
    case 'change-line':
      return mapLine(action.key, (line) => ({ ...line, ...action.change }));
    case 'add-line':
      return edit([...state.lines, emptyLine()]);
    case 'duplicate-line': {
      const index = state.lines.findIndex((line) => line.key === action.key);
      if (index < 0) return state;
      const lines = [...state.lines];
      lines.splice(index + 1, 0, duplicateLine(state.lines[index]!));
      return edit(lines);
    }
    case 'remove-line': {
      const lines = state.lines.filter((line) => line.key !== action.key);
      return edit(lines.length > 0 ? lines : [emptyLine()]);
    }
    case 'set-test':
      return mapLine(action.key, (line) => ({
        ...line,
        testTypeIds: action.on
          ? addMissing(line.testTypeIds, [action.testTypeId])
          : line.testTypeIds.filter((id) => id !== action.testTypeId),
      }));
    case 'add-tests':
      return mapLine(action.key, (line) => ({
        ...line,
        testTypeIds: addMissing(line.testTypeIds, action.testTypeIds),
      }));
    case 'set-test-everywhere':
      return edit(
        state.lines.map((line) => ({
          ...line,
          testTypeIds: action.on
            ? addMissing(line.testTypeIds, [action.testTypeId])
            : line.testTypeIds.filter((id) => id !== action.testTypeId),
        })),
      );
    case 'add-tests-everywhere':
      return edit(
        state.lines.map((line) => ({
          ...line,
          testTypeIds: addMissing(line.testTypeIds, action.testTypeIds),
        })),
      );
    case 'notes':
      return edit(state.lines, action.notes);
    case 'learn-ids':
      return {
        ...state,
        lines: state.lines.map((line) =>
          action.ids[line.key] ? { ...line, id: action.ids[line.key] } : line,
        ),
      };
    case 'replace':
      return {
        notes: action.notes,
        lines: action.lines.length > 0 ? action.lines : [emptyLine()],
        revision: state.revision + 1,
      };
  }
}

/** Every test request the program would make: "3 lines · 5 tests". */
export function testCount(lines: LineDraft[]): number {
  return lines.reduce((sum, line) => sum + line.testTypeIds.length, 0);
}

export function countsText(lines: LineDraft[]): string {
  const tests = testCount(lines);
  return `${lines.length} line${lines.length === 1 ? '' : 's'} · ${tests} test${tests === 1 ? '' : 's'}`;
}

/** The tests the Grid shows as columns: every test on any line, in first-use order. */
export function gridTests(lines: LineDraft[], extra: string[] = []): string[] {
  const ids: string[] = [];
  for (const line of lines) for (const id of line.testTypeIds) if (!ids.includes(id)) ids.push(id);
  for (const id of extra) if (!ids.includes(id)) ids.push(id);
  return ids;
}

export interface EditorProblem {
  /** The line it belongs to (client key); none for the program. */
  lineKey?: string;
  lineNumber?: number;
  field: string;
  /** Shown on the line. */
  message: string;
  /** Shown in the sticky bar, where it must say which line. */
  barMessage: string;
}

export interface ProblemContext {
  hasProject: boolean;
  /** A LAB station that hasn't chosen Requested by. */
  personMissing: boolean;
  /** The review made from the current revision, if there is one. */
  review: LabProgramReview | null;
}

/**
 * The one validator: what keeps this program from going to the lab. The same list is drawn on
 * each line and in the sticky bar (so problems on lines a filter hides still show there).
 */
export function programProblems(state: ProgramEditState, context: ProblemContext): EditorProblem[] {
  const problems: EditorProblem[] = [];
  const program = (field: string, message: string) =>
    problems.push({ field, message, barMessage: message });
  if (!context.hasProject) program('project', 'Choose a project first.');
  if (context.personMissing) program('requestedBy', 'Choose who this program is requested by.');
  state.lines.forEach((line, index) => {
    const lineNumber = index + 1;
    const local = lineProblems(line);
    for (const problem of local) {
      problems.push({
        lineKey: line.key,
        lineNumber,
        field: problem.field,
        message: problem.message,
        barMessage:
          problem.field === 'testTypeIds'
            ? `Add a test to line ${lineNumber}.`
            : `Line ${lineNumber}: ${problem.message}`,
      });
    }
    // The server's review adds what only it can know (retired tests, depths to check).
    const reviewed = line.id
      ? context.review?.lines.find((other) => other.lineId === line.id)
      : undefined;
    for (const problem of reviewed?.problems ?? []) {
      if (local.some((other) => other.field === problem.field)) continue;
      problems.push({
        lineKey: line.key,
        lineNumber,
        field: problem.field,
        message: problem.message,
        barMessage: `Line ${lineNumber}: ${problem.message}`,
      });
    }
  });
  return problems;
}

export const LONG_PROGRAM_LINES = 12;

export interface LineFilterOption {
  /** "all", "standalone" or a test hole's source ID. */
  id: string;
  label: string;
  count: number;
}

const isStandalone = (line: LineDraft) => line.source !== null && line.source.kind !== 'test_hole';

/** Show: All / each test hole / Standalone, with counts (long programs, Kyle 2026-11-12). */
export function lineFilterOptions(lines: LineDraft[], sources: LabSource[]): LineFilterOption[] {
  const holes = new Map<string, number>();
  let standalone = 0;
  for (const line of lines) {
    if (line.source?.kind === 'test_hole') {
      holes.set(line.source.id, (holes.get(line.source.id) ?? 0) + 1);
    } else if (isStandalone(line)) standalone += 1;
  }
  const options: LineFilterOption[] = [{ id: 'all', label: 'All', count: lines.length }];
  for (const [id, count] of holes) {
    const label = sources.find((source) => source.id === id)?.label ?? 'Test hole';
    options.push({ id, label, count });
  }
  if (standalone > 0) options.push({ id: 'standalone', label: 'Standalone', count: standalone });
  return options;
}

export function lineMatchesFilter(line: LineDraft, filter: string): boolean {
  if (filter === 'all') return true;
  if (filter === 'standalone') return isStandalone(line);
  return line.source?.kind === 'test_hole' && line.source.id === filter;
}
