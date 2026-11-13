import type { InboxRequestItem, NeedsYouItem } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { compareNeedsYou, dateSince, idLine, requestRow, stageRank } from './needs-you.js';

// STRATA-56: the pure parts of Needs you. Fictional records only (DEMO-2601, LP-001).

function system(kind: string, stage: NeedsYouItem['stage'], since: string | null): NeedsYouItem {
  return {
    key: `system:${kind}`,
    source: 'system',
    task: kind,
    title: kind,
    detail: null,
    ids: [],
    stage,
    domain: 'lab',
    action: 'Open',
    href: '/',
    count: 1,
    since,
  };
}

function request(id: string, stage: NeedsYouItem['stage'], since: string): NeedsYouItem {
  return { ...system('x', stage, since), key: `request:${id}`, source: 'request' };
}

describe('Needs you order (STRATA-56)', () => {
  it('ranks danger, then due, then lab, then the rest', () => {
    expect(
      ['closed', 'lab', 'danger', 'due', 'storage', 'draft'].map((s) => stageRank(s as never)),
    ).toEqual([3, 2, 0, 1, 3, 3]);
  });

  it('interleaves requests and system work by urgency; requests first inside a rank, then oldest', () => {
    const items = [
      system('program_finished', 'lab', null),
      system('retention_due', 'due', '2026-11-01T00:00:00.000Z'),
      request('b', 'due', '2026-11-05T00:00:00.000Z'),
      system('concrete_holds', 'danger', null),
      request('a', 'due', '2026-11-03T00:00:00.000Z'),
      system('breaks_due', 'lab', '2026-11-13T00:00:00.000Z'),
      request('c', 'danger', '2026-11-12T00:00:00.000Z'),
      system('location_conflicts', 'danger', null),
    ];
    expect(items.sort(compareNeedsYou).map((i) => i.key)).toEqual([
      'request:c',
      'system:concrete_holds',
      'system:location_conflicts',
      'request:a',
      'request:b',
      'system:retention_due',
      'system:breaks_due',
      'system:program_finished',
    ]);
  });
});

describe('Needs you wording (STRATA-56)', () => {
  it('names up to three IDs and how many more', () => {
    expect(idLine(['A', 'B'])).toEqual({ ids: ['A', 'B'], text: 'A, B' });
    expect(idLine(['A', 'B', 'C', 'D', 'E', 'A'])).toEqual({
      ids: ['A', 'B', 'C'],
      text: 'A, B, C and 2 more',
    });
  });

  it('keeps a request word for word as Inbox has it', () => {
    const item = {
      type: 'request',
      key: 'request:1',
      sourceId: '1',
      kind: 'closure_request',
      task: 'Close a program',
      title: 'Close LP-001 for DEMO-2601',
      projectId: 'p',
      jobNumber: 'DEMO-2601',
      record: { kind: 'lab_program', id: 'lp', label: 'LP-001' },
      from: null,
      receivedAt: '2026-11-12T16:00:00.000Z',
      unread: true,
      stage: 'due',
      domain: 'lab',
      href: '/lab-testing/programs/lp',
      status: 'open',
      resolution: null,
      waitingOnMe: true,
      raisedByMe: false,
      reason: 'Fictional',
    } satisfies InboxRequestItem;
    expect(requestRow(item)).toEqual({
      key: 'request:1',
      source: 'request',
      task: 'Close a program',
      title: 'Close LP-001 for DEMO-2601',
      detail: 'DEMO-2601 · LP-001',
      ids: ['DEMO-2601', 'LP-001'],
      stage: 'due',
      domain: 'lab',
      action: 'Open',
      href: '/lab-testing/programs/lp',
      count: 1,
      since: '2026-11-12T16:00:00.000Z',
    });
  });

  it('turns a date into the instant it starts', () => {
    expect(dateSince('2027-10-23')).toBe('2027-10-23T00:00:00.000Z');
    expect(dateSince(null)).toBeNull();
  });
});
