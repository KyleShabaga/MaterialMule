import { describe, expect, it } from 'vitest';
import {
  compareConcreteTestingRows,
  concreteTestEntryComplete,
  concreteTestingTableQuerySchema,
  parseConcreteReadings,
} from './concrete-testing-table';

// MM-V2-C23 T1: the testing table's sort order (numeric set counter, then letter), the entry
// completeness rule and readings parsing. Fictional IDs only.

type SortRow = Parameters<typeof compareConcreteTestingRows>[0];

const numbered = (n: number, letter: string, setId = `set-${String(n).padStart(3, '0')}`) =>
  ({
    permanentNumber: n,
    identity: { permanentId: `26-${String(n).padStart(2, '0')}${letter}`, temporaryId: null },
    setId,
    letter,
  }) satisfies SortRow;

const unnumbered = (tmp: string, letter: string, setId: string) =>
  ({
    permanentNumber: null,
    identity: { permanentId: null, temporaryId: `${tmp}${letter}` },
    setId,
    letter,
  }) satisfies SortRow;

const label = (row: SortRow) => row.identity.permanentId ?? row.identity.temporaryId;

describe('compareConcreteTestingRows (T1)', () => {
  it('orders numbered sets by their counter numerically, not as text', () => {
    const rows = [numbered(10, 'A'), numbered(2, 'B'), numbered(100, 'A'), numbered(2, 'A')];
    expect(rows.sort(compareConcreteTestingRows).map(label)).toEqual([
      '26-02A',
      '26-02B',
      '26-10A',
      '26-100A',
    ]);
  });

  it('orders letters within a set, then unnumbered sets after numbered ones', () => {
    const rows = [
      unnumbered('TMP-AT-10', 'A', 'z'),
      numbered(3, 'C'),
      unnumbered('TMP-AT-9', 'B', 'y'),
      numbered(3, 'B'),
      unnumbered('TMP-AT-9', 'A', 'y'),
    ];
    expect(rows.sort(compareConcreteTestingRows).map(label)).toEqual([
      '26-03B',
      '26-03C',
      'TMP-AT-9A',
      'TMP-AT-9B',
      'TMP-AT-10A',
    ]);
  });

  it('falls back to the set and letter when nothing else separates rows', () => {
    const rows = [
      {
        permanentNumber: null,
        identity: { permanentId: null, temporaryId: null },
        setId: 'b',
        letter: 'A',
      },
      {
        permanentNumber: null,
        identity: { permanentId: null, temporaryId: null },
        setId: 'a',
        letter: 'B',
      },
      {
        permanentNumber: null,
        identity: { permanentId: null, temporaryId: null },
        setId: 'a',
        letter: 'A',
      },
    ];
    expect(rows.sort(compareConcreteTestingRows).map((r) => `${r.setId}${r.letter}`)).toEqual([
      'aA',
      'aB',
      'bA',
    ]);
  });
});

describe('concreteTestEntryComplete', () => {
  const full = {
    testedOn: '2026-11-09',
    tester: { userId: 'u', initials: 'TB', name: 'Taylor Bench' },
    maxLoad: 412.5,
    heightReadings: [203.2],
    diameterReadings: [101.6],
  };

  it('counts a row only when every entry field is filled', () => {
    expect(concreteTestEntryComplete(full)).toBe(true);
    expect(concreteTestEntryComplete(null)).toBe(false);
    expect(concreteTestEntryComplete({ ...full, testedOn: null })).toBe(false);
    expect(concreteTestEntryComplete({ ...full, tester: null })).toBe(false);
    expect(concreteTestEntryComplete({ ...full, maxLoad: null })).toBe(false);
    expect(concreteTestEntryComplete({ ...full, heightReadings: [] })).toBe(false);
    expect(concreteTestEntryComplete({ ...full, diameterReadings: [] })).toBe(false);
  });
});

describe('parseConcreteReadings', () => {
  it('reads one or more readings separated by spaces or commas', () => {
    expect(parseConcreteReadings('')).toEqual([]);
    expect(parseConcreteReadings(' 101.6 ')).toEqual([101.6]);
    expect(parseConcreteReadings('101.6, 101.8;101.7')).toEqual([101.6, 101.8, 101.7]);
  });

  it('refuses anything that is not a positive number', () => {
    expect(parseConcreteReadings('abc')).toBeNull();
    expect(parseConcreteReadings('0')).toBeNull();
    expect(parseConcreteReadings('-5')).toBeNull();
    expect(parseConcreteReadings('1e3')).toBeNull();
  });
});

describe('concreteTestingTableQuerySchema', () => {
  it('defaults to today only and reads includeOverdue', () => {
    expect(concreteTestingTableQuerySchema.parse({})).toEqual({ includeOverdue: false });
    expect(concreteTestingTableQuerySchema.parse({ includeOverdue: 'true' }).includeOverdue).toBe(
      true,
    );
    expect(concreteTestingTableQuerySchema.safeParse({ includeOverdue: 'yes' }).success).toBe(
      false,
    );
    expect(concreteTestingTableQuerySchema.safeParse({ other: '1' }).success).toBe(false);
  });
});
