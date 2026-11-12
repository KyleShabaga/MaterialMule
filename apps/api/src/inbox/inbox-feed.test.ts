import type { InboxItem } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { comparator, countsOf, inTab, type FeedEntry } from './inbox-feed.js';

// STRATA-55 counts and the fixed order, without a database. Fictional data only.

const base = {
  sourceId: 'x',
  task: 'Retention',
  title: 'Hold requested for DEMO-2601 · whole project',
  projectId: 'p',
  jobNumber: 'DEMO-2601',
  record: null,
  from: null,
  stage: 'due',
  domain: 'retention',
  href: '/projects/p',
} as const;

function request(key: string, unread: boolean, waitingOnMe: boolean, open = true): FeedEntry {
  const item: InboxItem = {
    ...base,
    key,
    type: 'request',
    kind: 'retention_request',
    receivedAt: '2026-11-01T00:00:00.000Z',
    unread,
    status: open ? 'open' : 'resolved',
    resolution: null,
    waitingOnMe,
    raisedByMe: !waitingOnMe,
    reason: 'Fictional',
  };
  return { item, receivedKey: item.receivedAt, haystack: '' };
}

function update(key: string, unread: boolean, dismissed = false, at = '2026-11-01'): FeedEntry {
  const item: InboxItem = {
    ...base,
    key,
    type: 'update',
    kind: 'action_request.decided',
    receivedAt: `${at}T00:00:00.000Z`,
    unread,
    dismissed,
    aboutMyRequest: true,
    linkedRequestStatus: 'resolved',
  };
  return { item, receivedKey: item.receivedAt, haystack: '' };
}

describe('Inbox counts (STRATA-55)', () => {
  const feed = [
    request('request:a', true, true),
    request('request:b', false, true),
    request('request:c', true, false), // raised by me, marked unread
    request('request:d', true, true, false), // resolved: Done, never counted
    update('update:e', true),
    update('update:f', false),
    update('update:g', false, true), // dismissed: Done
  ];

  it('badge = unread requests waiting on me + unread updates when badgeUpdates is on', () => {
    expect(countsOf(feed, true)).toEqual({
      badge: 2,
      unread: 3,
      unreadRequests: 2,
      unreadUpdates: 1,
      openRequests: 2,
    });
  });

  it('badge leaves updates out when badgeUpdates is off; unread still counts them', () => {
    expect(countsOf(feed, false)).toMatchObject({ badge: 1, unread: 3, unreadUpdates: 1 });
  });

  it('tabs split open and done', () => {
    expect(feed.filter((e) => inTab(e.item, 'done')).map((e) => e.item.key)).toEqual([
      'request:d',
      'update:g',
    ]);
  });

  it('equal values fall back to received time, then key', () => {
    const sorted = [
      update('update:b', true),
      update('update:a', true),
      update('update:c', true, false, '2026-11-02'),
    ]
      .sort(comparator('title_asc'))
      .map((e) => e.item.key);
    expect(sorted).toEqual(['update:c', 'update:a', 'update:b']);
  });
});
