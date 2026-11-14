import {
  NEEDS_YOU_SYSTEM_KINDS,
  type InboxRequestItem,
  type NeedsYouItem,
  type NeedsYouSystemKind,
  type StageKey,
} from '@materialmule/shared';

// STRATA-56: the pure parts of Today's "Needs you" (wording, dedupe, order), tested without a
// database. The sources live in today.service.ts.

/** How many IDs a detail line names before "and n more". */
export const DETAIL_IDS = 3;

/**
 * An Inbox request as a Needs you row: task, title, stage, domain and link word for word as the
 * Inbox feed built them (lane 1C's `loadFeed`), never a second wording.
 */
export function requestRow(item: InboxRequestItem): NeedsYouItem {
  const ids = [item.jobNumber, item.record?.kind === 'lab_program' ? item.record.label : null]
    .filter((id): id is string => Boolean(id))
    .filter((id, i, all) => all.indexOf(id) === i);
  return {
    key: item.key,
    source: 'request',
    task: item.task,
    title: item.title,
    detail: ids.length > 0 ? ids.join(' · ') : null,
    ids,
    stage: item.stage,
    domain: item.domain,
    action: 'Open',
    href: item.href,
    count: 1,
    since: item.receivedAt,
  };
}

/** "BKT-2026-000001, BKT-2026-000002 and 3 more": the IDs named, and the line. */
export function idLine(all: readonly string[], max = DETAIL_IDS): { ids: string[]; text: string } {
  const ids = [...new Set(all)].slice(0, max);
  const more = new Set(all).size - ids.length;
  return { ids, text: more > 0 ? `${ids.join(', ')} and ${more} more` : ids.join(', ') };
}

/** "1 unit" / "4 units". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Urgency rank: danger first, then due, then lab, then the rest. */
export function stageRank(stage: StageKey): number {
  if (stage === 'danger') return 0;
  if (stage === 'due') return 1;
  if (stage === 'lab') return 2;
  return 3;
}

function kindOf(item: NeedsYouItem): number {
  if (item.source === 'request') return -1;
  const kind = item.key.split(':')[1] as NeedsYouSystemKind;
  return NEEDS_YOU_SYSTEM_KINDS.indexOf(kind);
}

/**
 * The one order: by urgency rank; inside a rank requests before system work, then the oldest
 * `since` first (none last), then the system kinds' own order, then the key, so equal rows keep
 * one fixed order.
 */
export function compareNeedsYou(a: NeedsYouItem, b: NeedsYouItem): number {
  const rank = stageRank(a.stage) - stageRank(b.stage);
  if (rank !== 0) return rank;
  if (a.source !== b.source) return a.source === 'request' ? -1 : 1;
  if (a.since !== b.since) {
    if (a.since === null) return 1;
    if (b.since === null) return -1;
    const at = Date.parse(a.since);
    const bt = Date.parse(b.since);
    if (at !== bt) return at - bt;
  }
  const kind = kindOf(a) - kindOf(b);
  if (kind !== 0) return kind;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

/** A date (YYYY-MM-DD) as the instant it starts, for `since`. */
export function dateSince(date: string | null | undefined): string | null {
  return date ? `${date}T00:00:00.000Z` : null;
}
