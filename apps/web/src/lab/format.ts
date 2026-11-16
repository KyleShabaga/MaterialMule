import {
  LINE_SCOPE_LABEL,
  formatLineDepth,
  type LabLine,
  type StageKey,
  type TestProgress,
  type TestRequest,
  type TestRequestStatus,
} from '@materialmule/shared';
import type { CountedCellState } from '../components/app-ui';
import { labDate } from '../dashboard/format';

/** One line's heading: "TH26-01 · ALL" or "TH26-01 · G3 at 7.5 ft". */
export function lineTitle(line: LabLine): string {
  const source = line.source?.label ?? 'No source';
  if (line.scope !== 'specific') return `${source} · ${LINE_SCOPE_LABEL[line.scope]}`;
  const depth = formatLineDepth(line);
  return `${source} · ${line.sampleLabel ?? '?'}${depth ? ` at ${depth}` : ''}`;
}

export function requestName(request: Pick<TestRequest, 'code' | 'name' | 'description'>): string {
  return `${request.code} · ${request.name ?? request.description}`;
}

/** How long the oldest open test has waited: "under a minute", "4 h 5 min", "3 days". */
export function openAge(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  if (minutes < 1) return 'under a minute';
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours} h ${minutes % 60} min`;
  return `${Math.floor(hours / 24)} days`;
}

/** One counted cell per test (Field Ledger): done, then in progress, then not started. */
export function progressCells(progress: TestProgress): CountedCellState[] {
  return [
    ...Array<CountedCellState>(progress.done).fill('done'),
    ...Array<CountedCellState>(progress.inProgress).fill('current'),
    ...Array<CountedCellState>(progress.notStarted).fill('empty'),
  ];
}

export function progressLabel(progress: TestProgress): string {
  const total = progress.done + progress.inProgress + progress.notStarted;
  const cancelled = progress.cancelled > 0 ? `, ${progress.cancelled} cancelled` : '';
  return `${progress.done} of ${total} tests done, ${progress.inProgress} in progress, ${progress.notStarted} not started${cancelled}`;
}

// ---------------------------------------------------------------------------------------------
// Strata (STRATA-87): test states as record words on stage colours, record dates and times.

/** A test's state on a line: the record word, its stage colour and whether it shows a check. */
export interface TestStateWord {
  label: string;
  stage: StageKey;
  check?: boolean;
}

/**
 * Record words for each test status (DESIGN.md › Soils lab): Waiting (due), In testing (lab),
 * Done (closed, check: testing finished, review still to come), In review (due: waiting for
 * review and acceptance), Accepted (closed, check: resolved for closure), Cancelled (closed).
 */
export const TEST_STATE_WORDS: Record<TestRequestStatus, TestStateWord> = {
  requested: { label: 'Waiting', stage: 'due' },
  in_progress: { label: 'In testing', stage: 'lab' },
  completed: { label: 'Done', stage: 'closed', check: true },
  review: { label: 'In review', stage: 'due' },
  accepted: { label: 'Accepted', stage: 'closed', check: true },
  cancelled: { label: 'Cancelled', stage: 'closed' },
};

/** A draft's tests are not submitted yet. */
export const DRAFT_TEST_STATE: TestStateWord = { label: 'Not submitted', stage: 'draft' };

/** "n of m" with cancelled tests counted apart (the list and the program page agree). */
export function progressShort(progress: TestProgress): { done: number; total: number } {
  return {
    done: progress.done,
    total: progress.done + progress.inProgress + progress.notStarted,
  };
}

/** A record date in the lab's time zone: 2026-11-11 (DESIGN.md › Dates). */
export function recordDate(iso: string): string {
  return labDate(new Date(iso));
}

const CLOCK = new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/Edmonton',
  hour: 'numeric',
  minute: '2-digit',
});

/** Activity time: "Today 9:12 AM" within the lab's today, else "2026-11-10 3:40 PM". */
export function activityTime(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = labDate(at);
  return `${day === labDate(now) ? 'Today' : day} ${CLOCK.format(at)}`;
}
