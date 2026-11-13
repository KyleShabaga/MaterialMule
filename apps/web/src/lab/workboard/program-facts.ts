import { testProgress, type WorklistItem } from '@materialmule/shared';
import { openAge } from '../format';

// STRATA-88: what a Workboard card and list row show for one program.

/** The program page, and its Review and Units to pull sections (anchors on the program page). */
export const programHref = (item: WorklistItem, section?: 'review' | 'units-to-pull') =>
  `/lab-testing/programs/${encodeURIComponent(item.programId)}${section ? `#${section}` : ''}`;

/** "3 of 8 tests": done (completed, in review, accepted) of the tests not cancelled. */
export function progressOf(item: WorklistItem) {
  const p = testProgress(item.counts);
  const total = p.done + p.inProgress + p.notStarted;
  return { done: p.done, total, percent: total === 0 ? 0 : Math.round((p.done / total) * 100) };
}

export function oldestOpenText(item: WorklistItem): string {
  return item.oldestOpenSeconds === null
    ? 'Nothing open'
    : `Oldest open ${openAge(item.oldestOpenSeconds)}`;
}
