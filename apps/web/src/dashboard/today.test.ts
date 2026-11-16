import { formatClockTime, needsYouSummary, type ScopedActivityItem } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { FEATURES } from '../features';
import { NEW_PROJECT_PATH } from '../search/menu-items';
import {
  activitySentence,
  firstName,
  greetingText,
  monoParts,
  shortcutsFor,
  splitActivity,
  todayRole,
  unavailableNote,
  visibleNeeds,
  welcomeDate,
} from './today';

// Today with an own account: wording and rules. Fictional data only (Alex Tester, DEMO-2601).

const ALL_FEATURES = {
  ...FEATURES,
  labTesting: true,
  disposalRetention: true,
  concreteReview: true,
};

function activity(overrides: Partial<ScopedActivityItem> = {}): ScopedActivityItem {
  return {
    id: 'e1',
    occurredAt: '2026-11-13T16:42:00.000Z',
    action: 'receipt.confirmed',
    actorInitials: 'AT',
    actorName: 'Alex Tester',
    summary: 'AT received BKT-2026-000142 and 1 more for DEMO-2601',
    ref: 'DEMO-2601',
    href: null,
    byMe: false,
    ...overrides,
  };
}

describe('welcome', () => {
  const morning = new Date('2026-11-13T16:00:00Z'); // morning in Edmonton
  const afternoon = new Date('2026-11-13T21:00:00Z'); // afternoon
  const evening = new Date('2026-11-14T02:30:00Z'); // morning in Edmonton

  it('greets by first name, by the time of day in America/Edmonton', () => {
    expect(greetingText('Alex', morning)).toBe('Good morning, Alex');
    expect(greetingText('Alex', afternoon)).toBe('Good afternoon, Alex');
    expect(greetingText('Alex', evening)).toBe('Good evening, Alex');
    expect(greetingText(null, morning)).toBe('Good morning');
    expect(firstName('Dana Tester (Lab)')).toBe('Dana');
  });

  it('writes the date in the person’s Date format, on the lab’s calendar', () => {
    expect(welcomeDate(morning, 'iso')).toBe('Friday, 2026-11-13');
    expect(welcomeDate(evening, 'medium')).toBe('Friday, Nov 13, 2026');
  });

  it('summarises Needs you in one line', () => {
    expect(needsYouSummary(5, 3)).toBe('5 things need you. 3 are requests in your Inbox.');
    expect(needsYouSummary(1, 0)).toBe('1 thing needs you.');
    expect(needsYouSummary(0, 0)).toBe('Nothing needs you right now.');
  });
});

describe('which Today an account gets', () => {
  it('Lab Manager first, then lead of any project, then technician; never merged', () => {
    expect(todayRole({ roles: ['lab_manager', 'lab_technician'] }, true)).toBe('manager');
    expect(todayRole({ roles: ['lab_technician'] }, true)).toBe('lead');
    expect(todayRole({ roles: ['lab_technician'] }, false)).toBe('technician');
    expect(todayRole({ roles: [] }, false)).toBe('technician');
    expect(todayRole({ roles: ['admin'] }, true)).toBe('lead');
  });

  it('shows only the shortcuts this account can use', () => {
    const lead = shortcutsFor(
      'lead',
      { permissions: ['lab_program.manage', 'receipt.draft', 'project.create'] },
      ALL_FEATURES,
    );
    expect(lead.map((s) => [s.label, s.to])).toEqual([
      ['Request lab testing', '/lab-testing/programs/new'],
      ['Review concrete reports', '/concrete/review'],
      ['My projects', '/projects?tab=mine'],
      ['New project', NEW_PROJECT_PATH],
    ]);
    expect(shortcutsFor('lead', { permissions: [] }, ALL_FEATURES).map((s) => s.label)).toEqual([
      'Review concrete reports',
      'My projects',
    ]);
    expect(
      shortcutsFor(
        'manager',
        { permissions: ['lab_program.read', 'inventory.read', 'storage_unit.dispose_scan'] },
        { ...ALL_FEATURES, disposalRetention: false },
      ).map((s) => s.label),
    ).toEqual(['Workboard', 'Breaks due today']);
    expect(
      shortcutsFor(
        'technician',
        {
          permissions: [
            'receipt.draft',
            'storage_unit.move',
            'label.print',
            'inventory.read',
            'lab_program.read',
          ],
        },
        ALL_FEATURES,
      ).map((s) => [s.label, s.to]),
    ).toEqual([
      ['Receive', '/receiving-log/new'],
      ['Move storage units', '/sample-storage/move'],
      ['Print labels', '/sample-storage'],
      ['My tests', '/lab-testing'],
    ]);
  });
});

describe('Needs you', () => {
  it('shows the first six until Show all', () => {
    const items = Array.from({ length: 11 }, (_, i) => i);
    expect(visibleNeeds(items, false)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(visibleNeeds(items, true)).toHaveLength(11);
    expect(visibleNeeds([1, 2], false)).toEqual([1, 2]);
  });

  it('names the sources that couldn’t load', () => {
    expect(unavailableNote([])).toBeNull();
    expect(unavailableNote(['breaks_due'])).toBe(
      'Couldn’t load breaks due today. Everything else here is up to date.',
    );
    expect(unavailableNote(['breaks_due', 'retention_due', 'labels_failed'])).toBe(
      'Couldn’t load breaks due today, retention due and labels that didn’t print. Everything else here is up to date.',
    );
  });

  it('sets IDs in mono', () => {
    expect(monoParts('DEMO-2610 · BKT-2026-000143 and 3 more', ['DEMO-2610'])).toEqual([
      { text: 'DEMO-2610', mono: true },
      { text: ' · ', mono: false },
      { text: 'BKT-2026-000143', mono: true },
      { text: ' and 3 more', mono: false },
    ]);
    expect(monoParts('LP-7 on Riverbend lots', ['LP-7'])).toEqual([
      { text: 'LP-7', mono: true },
      { text: ' on Riverbend lots', mono: false },
    ]);
    expect(monoParts('Nothing here')).toEqual([{ text: 'Nothing here', mono: false }]);
  });
});

describe('Last 24 hours', () => {
  const now = new Date('2026-11-13T17:00:00Z'); // morning in Edmonton

  it('writes the person’s own rows in the second person', () => {
    expect(activitySentence(activity({ byMe: true }))).toBe(
      'You received BKT-2026-000142 and 1 more for DEMO-2601',
    );
    expect(activitySentence(activity())).toBe(
      'AT received BKT-2026-000142 and 1 more for DEMO-2601',
    );
    expect(
      activitySentence(
        activity({
          byMe: true,
          actorInitials: null,
          summary: 'Alex Tester moved ST-2026-000021 to A3',
        }),
      ),
    ).toBe('You moved ST-2026-000021 to A3');
    // Initials that only start a longer word are not the actor.
    expect(activitySentence(activity({ byMe: true, summary: 'ATX did it' }))).toBe('ATX did it');
  });

  it('puts lines before midnight under Yesterday and drops anything older than 24 hours', () => {
    const { today, yesterday } = splitActivity(
      [
        activity({ id: 'a', occurredAt: '2026-11-13T16:42:00Z' }), // today
        activity({ id: 'b', occurredAt: '2026-11-12T23:50:00Z', action: 'disposal.removed' }), // yesterday
        activity({ id: 'c', occurredAt: '2026-11-12T10:00:00Z' }), // older than 24 hours
      ],
      now,
    );
    expect(today.map((l) => [l.item.id, l.time, l.stage])).toEqual([
      ['a', formatClockTime('2026-11-13T16:42:00Z'), 'storage'],
    ]);
    expect(yesterday.map((l) => [l.item.id, l.time, l.stage])).toEqual([
      ['b', formatClockTime('2026-11-12T23:50:00Z'), 'closed'],
    ]);
  });
});
