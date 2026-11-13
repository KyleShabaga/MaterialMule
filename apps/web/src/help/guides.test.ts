import { describe, expect, it } from 'vitest';
import { FEATURES } from '../features';
import {
  HELP_GROUPS,
  HELP_GUIDES,
  HELP_QUESTIONS,
  SHORTCUTS_ANCHOR,
  groupAnchor,
  pageHelp,
  searchGuides,
  visibleGroups,
} from './guides';

// Help content (STRATA-103): stable anchors, route → help for this page, search, and the rule
// that nothing gated is described as built.

const ALL_ON = FEATURES;
const ALL_OFF = Object.fromEntries(Object.keys(FEATURES).map((key) => [key, false])) as Record<
  keyof typeof FEATURES,
  boolean
>;

describe('help guides', () => {
  it('have unique anchors that never collide with group or shortcut anchors', () => {
    const anchors = [
      ...HELP_GUIDES.map((guide) => guide.id),
      ...HELP_GROUPS.map((group) => groupAnchor(group.id)),
      SHORTCUTS_ANCHOR,
    ];
    expect(new Set(anchors).size).toBe(anchors.length);
    for (const id of anchors) expect(id).toMatch(/^[a-z0-9-]+$/);
  });

  it('keep the anchors other pages link to', () => {
    const ids = HELP_GUIDES.map((guide) => guide.id);
    // The station picker ("How LAB stations work") and Customize sidebar ("How the sidebar works").
    expect(ids).toContain('lab-stations');
    expect(ids).toContain('sidebar');
    expect(HELP_GUIDES.find((g) => g.id === 'lab-stations')?.title).toBe('How LAB stations work');
    expect(HELP_GUIDES.find((g) => g.id === 'sidebar')?.title).toBe('How the sidebar works');
  });

  it('mark every guide as placeholder or kept, and every group exists', () => {
    for (const guide of HELP_GUIDES) {
      expect(typeof guide.placeholder, guide.id).toBe('boolean');
      expect(
        HELP_GROUPS.some((group) => group.id === guide.group),
        guide.id,
      ).toBe(true);
      expect(guide.body || guide.steps?.length, guide.id).toBeTruthy();
    }
    expect(HELP_GUIDES.some((guide) => guide.placeholder)).toBe(true);
  });

  it('groups follow the brief: Getting around, then the five groups', () => {
    expect(HELP_GROUPS.map((group) => group.label)).toEqual([
      'Getting around',
      'Receiving',
      'Shelves, labels and retention',
      'Lab tests',
      'Concrete',
      'Access and accounts',
    ]);
  });

  it('describe gated work only as an open item', () => {
    const text = [...HELP_GUIDES, ...HELP_QUESTIONS]
      .flatMap((entry) =>
        'q' in entry
          ? [entry.q, entry.a]
          : [entry.title, entry.body ?? '', entry.note ?? '', ...(entry.steps ?? [])],
      )
      .join('\n');
    expect(text).not.toMatch(/offline/i);
    expect(text).not.toMatch(/session (ends|expires|length)/i);
    const gated = HELP_GUIDES.filter((guide) => /final report|G2|G8/.test(guide.body ?? ''));
    expect(gated.length).toBeGreaterThan(0);
    for (const guide of gated) expect(guide.openItem, guide.id).toBe(true);
  });

  it('hide groups and guides whose feature is off', () => {
    const on = visibleGroups(ALL_ON).map(({ group }) => group.id);
    expect(on).toContain('lab-tests');
    const off = visibleGroups(ALL_OFF);
    expect(off.map(({ group }) => group.id)).not.toContain('lab-tests');
    expect(off.map(({ group }) => group.id)).not.toContain('concrete');
    const storage = off.find(({ group }) => group.id === 'storage')!;
    expect(storage.guides.map((guide) => guide.id)).not.toContain('dispose');
  });
});

describe('help for this page', () => {
  it('maps routes to their guides, the first one most useful', () => {
    expect(pageHelp('/sample-storage', ALL_ON)).toMatchObject({ heading: 'Help for Inventory' });
    expect(pageHelp('/sample-storage', ALL_ON).guides[0]?.id).toBe('find-unit');
    expect(pageHelp('/sample-storage/BKT-2026-000019', ALL_ON).heading).toBe('Help for Inventory');
    expect(pageHelp('/sample-storage/move', ALL_ON).guides[0]?.id).toBe('move');
    expect(pageHelp('/receiving-log/new', ALL_ON).guides[0]?.id).toBe('receive');
    expect(pageHelp('/lab-testing/concrete', ALL_ON).heading).toBe('Help for Breaks');
    expect(pageHelp('/lab-testing/programs', ALL_ON).heading).toBe('Help for Lab programs');
    expect(pageHelp('/', ALL_ON).heading).toBe('Help for Today');
  });

  it('falls back to Getting around', () => {
    expect(pageHelp('/search', ALL_ON)).toMatchObject({ heading: 'Getting around' });
    expect(pageHelp('/search', ALL_ON).guides.map((guide) => guide.id)).toEqual([
      'sidebar',
      'search',
      'inbox',
    ]);
    // A page whose guides are all behind a feature that is off.
    expect(pageHelp('/disposal-retention', ALL_OFF).heading).toBe('Getting around');
  });
});

describe('search', () => {
  it('finds guides by title, steps and group, in any case', () => {
    const ids = searchGuides('LABEL', ALL_ON).map((guide) => guide.id);
    expect(ids).toContain('reprint-label');
    expect(searchGuides('either order', ALL_ON).map((guide) => guide.id)).toEqual(
      expect.arrayContaining(['put-away', 'move']),
    );
    expect(searchGuides('invoice', ALL_ON)).toEqual([]);
    expect(searchGuides('   ', ALL_ON)).toEqual([]);
  });
});
