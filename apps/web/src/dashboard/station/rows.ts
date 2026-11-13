import type { StationRow, StationToday } from '@materialmule/shared';
import type { StoredDraft } from '../../receiving/drafts/record';

// The "At this station" rows (DESIGN.md › Today on a LAB station): their words and where each
// goes. Counts come from GET /api/station/today, plus this browser's own drafts.

export interface StationRowInfo {
  title: string;
  /** The plain line when something is waiting. */
  line: string;
  href: string;
}

export const STATION_ROW_INFO: Record<StationRow, StationRowInfo> = {
  drafts: {
    title: 'Draft receipts to finish',
    line: 'Started here, not confirmed yet. IDs are issued on confirm.',
    // Receive samples lists the drafts on this computer.
    href: '/receiving-log/new',
  },
  breaks_due: {
    title: 'Breaks due today',
    line: 'Concrete sets due for breaking today.',
    href: '/lab-testing/concrete?view=today',
  },
  labels_to_print: {
    title: 'Labels to print',
    line: 'Received units whose labels haven’t printed.',
    href: '/receiving-log',
  },
};

/** What a row shows at zero (the row stays). */
export const NOTHING_WAITING = 'Nothing waiting.';

/**
 * Draft receipts to finish: the server's LAB draft registry plus this browser's LAB drafts the
 * registry doesn't know about yet. A local draft with `registeredAt` set is already in the
 * server count, so only unregistered ones (offline at their first save, or legacy) are added.
 * null when the server count couldn't be read.
 */
export function stationDraftCount(
  serverCount: number | null,
  localDrafts: readonly Pick<StoredDraft, 'registeredAt'>[],
): number | null {
  if (serverCount === null) return null;
  return serverCount + localDrafts.filter((draft) => !draft.registeredAt).length;
}

/** The count a row shows, or null when its source couldn't be read. */
export function rowCount(
  row: StationRow,
  today: StationToday,
  localDrafts: readonly Pick<StoredDraft, 'registeredAt'>[],
): number | null {
  switch (row) {
    case 'drafts':
      return stationDraftCount(today.draftReceipts, localDrafts);
    case 'breaks_due':
      return today.breaksDueToday;
    case 'labels_to_print':
      return today.labelsToPrint;
  }
}

/** "2 rows are hidden on this station." */
export function hiddenRowsNote(hidden: number): string | null {
  if (hidden <= 0) return null;
  return hidden === 1
    ? '1 row is hidden on this station.'
    : `${hidden} rows are hidden on this station.`;
}

/** "Set up by Sam Sample. Only a Lab Manager can change this station." */
export function lockLine(config: { updatedBy: { name: string } | null } | null): string {
  const only = 'Only a Lab Manager can change this station.';
  return config?.updatedBy ? `Set up by ${config.updatedBy.name}. ${only}` : only;
}

export const CONFLICT_MESSAGE =
  'Someone else changed this station just now. This is their version; make your change again.';
export const SAVE_FAILED_MESSAGE = 'Couldn’t save. Check the connection and try again.';
