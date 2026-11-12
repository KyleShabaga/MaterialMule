import {
  LINE_SCOPE_LABEL,
  formatLineDepth,
  type LabLine,
  type TestProgress,
  type TestRequest,
} from '@materialmule/shared';
import type { CountedCellState } from '../components/app-ui';

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
