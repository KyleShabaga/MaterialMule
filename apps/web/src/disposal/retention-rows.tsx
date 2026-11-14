import type { RetentionBand, RetentionPipelineUnit, StageKey } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { relativeDays } from '../projects/project-format';

// STRATA-90 row words and tags for the Retention page (DESIGN.md › Round 6, › Dates).

type Row = RetentionPipelineUnit;

export const BAND_INFO: Record<RetentionBand, { title: string; stage: StageKey }> = {
  overdue: { title: 'Overdue', stage: 'danger' },
  month: { title: 'Within 30 days', stage: 'due' },
  later: { title: 'Within 90 days', stage: 'storage' },
};

/**
 * STRATA-110 (Kyle 2026-11-13, "show in both"): the tags an Overdue row carries about disposal.
 * The server's one eligibility rule decides `eligible` (the same rule as the Eligible tab); an
 * Overdue unit with an open program says so instead. Other bands carry neither.
 */
export function disposalTags(row: Row): string[] {
  if (row.band !== 'overdue') return [];
  if (row.eligible) return ['Eligible'];
  if (row.programOpen) return ['Program open'];
  return [];
}

/** Neutral outline tags: holds, extensions, waiting requests (stage colours mean stage only). */
export function rowTags(row: Row): string[] {
  const tags = [...disposalTags(row)];
  if (row.hold) tags.push('Hold');
  if (row.extensionCount > 0) tags.push(`Extended ${row.extensionCount}×`);
  if (row.requestWaiting) tags.push('Request waiting');
  return tags;
}

/** "Retention ends 2026-11-18 · in 7 days", "Retention ended … · 7 days ago", or the hold. */
export function retentionWords(row: Row, today: string): ReactNode {
  if (row.hold) {
    return (
      <>
        On hold {row.hold.holdUntil ? 'until ' : 'until released'}
        {row.hold.holdUntil ? <span className="font-mono">{row.hold.holdUntil}</span> : null}
        <span className="text-muted-foreground">
          {' '}
          · retention ends <span className="font-mono">{row.effectiveRetainUntil}</span>
        </span>
      </>
    );
  }
  const ended = row.effectiveRetainUntil <= today;
  return (
    <>
      Retention {ended ? 'ended' : 'ends'}{' '}
      <span className="font-mono">{row.effectiveRetainUntil}</span>
      <span className="text-muted-foreground">
        {' '}
        · {relativeDays(today, row.effectiveRetainUntil)}
      </span>
    </>
  );
}
