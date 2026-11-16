import { describe, expect, it } from 'vitest';
import {
  describeSort,
  EMPTY_TABLE_QUERY,
  nextHeadingSort,
  readTableQuery,
  writeTableQuery,
  type SortOption,
} from './table-query';

const params = (s: string) => new URLSearchParams(s);

describe('readTableQuery', () => {
  it('reads an empty query from no parameters', () => {
    expect(readTableQuery(params(''))).toEqual(EMPTY_TABLE_QUERY);
  });

  it('reads search, filters in order, sort and view', () => {
    expect(
      readTableQuery(
        params('search=TH26&filter=holds&filter=unread&sort=title&dir=desc&view=table'),
      ),
    ).toEqual({
      search: 'TH26',
      filters: ['holds', 'unread'],
      sort: { key: 'title', dir: 'desc' },
      view: 'table',
    });
  });

  it('dedupes filters and drops empty ones', () => {
    expect(
      readTableQuery(params('filter=holds&filter=&filter=holds&filter=unread')).filters,
    ).toEqual(['holds', 'unread']);
  });

  it('reads a missing or invalid dir as ascending, and a dir without a sort as no sort', () => {
    expect(readTableQuery(params('sort=title')).sort).toEqual({ key: 'title', dir: 'asc' });
    expect(readTableQuery(params('sort=title&dir=sideways')).sort).toEqual({
      key: 'title',
      dir: 'asc',
    });
    expect(readTableQuery(params('dir=desc')).sort).toBeNull();
  });

  it('keeps prefixed tables apart', () => {
    const p = params('search=a&a.search=b&a.filter=holds&filter=unread');
    expect(readTableQuery(p).search).toBe('a');
    expect(readTableQuery(p).filters).toEqual(['unread']);
    expect(readTableQuery(p, 'a.').search).toBe('b');
    expect(readTableQuery(p, 'a.').filters).toEqual(['holds']);
  });
});

describe('writeTableQuery', () => {
  it('keeps unrelated parameters such as open', () => {
    const next = writeTableQuery(params('open=BKT-2026-000001&tab=history'), {
      ...EMPTY_TABLE_QUERY,
      search: 'TH26-01',
    });
    expect(next.get('open')).toBe('BKT-2026-000001');
    expect(next.get('tab')).toBe('history');
    expect(next.get('search')).toBe('TH26-01');
  });

  it('does not change the input parameters', () => {
    const before = params('page=3');
    writeTableQuery(before, { ...EMPTY_TABLE_QUERY, search: 'x' });
    expect(before.toString()).toBe('page=3');
  });

  it('removes parameters for empty values', () => {
    const next = writeTableQuery(
      params('search=a&filter=holds&sort=title&dir=asc&view=table&open=1'),
      EMPTY_TABLE_QUERY,
    );
    expect(next.toString()).toBe('open=1');
  });

  it('resets page when search, filters or sort change', () => {
    const start = params('page=3&search=a&filter=holds');
    const base = readTableQuery(start);
    expect(writeTableQuery(start, { ...base, search: 'ab' }).get('page')).toBeNull();
    expect(
      writeTableQuery(start, { ...base, filters: ['holds', 'unread'] }).get('page'),
    ).toBeNull();
    expect(
      writeTableQuery(start, { ...base, sort: { key: 'title', dir: 'asc' } }).get('page'),
    ).toBeNull();
  });

  it('keeps page when the rows are the same: a view change or an unchanged query', () => {
    const start = params('page=3&search=a&filter=holds&sort=title&dir=desc');
    const base = readTableQuery(start);
    expect(writeTableQuery(start, { ...base, view: 'table' }).get('page')).toBe('3');
    expect(writeTableQuery(start, base).get('page')).toBe('3');
  });

  it('writes filters in order and round-trips through readTableQuery', () => {
    const query = {
      search: 'DEMO-2601',
      filters: ['unread', 'holds'],
      sort: { key: 'received', dir: 'desc' as const },
      view: 'table',
    };
    const next = writeTableQuery(params(''), query);
    expect(next.getAll('filter')).toEqual(['unread', 'holds']);
    expect(readTableQuery(next)).toEqual(query);
  });

  it('only touches its own prefix', () => {
    const next = writeTableQuery(
      params('search=a&page=2&b.page=4'),
      { ...EMPTY_TABLE_QUERY, search: 'z' },
      'b.',
    );
    expect(next.get('search')).toBe('a');
    expect(next.get('page')).toBe('2');
    expect(next.get('b.search')).toBe('z');
    expect(next.get('b.page')).toBeNull();
  });
});

describe('nextHeadingSort', () => {
  it('cycles one column ascending, descending, then default', () => {
    const asc = nextHeadingSort(null, 'title');
    expect(asc).toEqual({ key: 'title', dir: 'asc' });
    const desc = nextHeadingSort(asc, 'title');
    expect(desc).toEqual({ key: 'title', dir: 'desc' });
    expect(nextHeadingSort(desc, 'title')).toBeNull();
  });

  it('starts a different column at ascending', () => {
    expect(nextHeadingSort({ key: 'title', dir: 'desc' }, 'received')).toEqual({
      key: 'received',
      dir: 'asc',
    });
  });
});

describe('describeSort', () => {
  const options: SortOption[] = [
    { label: 'Newest first', sort: null },
    { label: 'Oldest first', sort: { key: 'received', dir: 'asc' } },
  ];
  const labels = { title: { asc: 'Title A–Z', desc: 'Title Z–A' } };

  it('uses the menu entry first', () => {
    expect(describeSort(null, options, labels)).toBe('Newest first');
    expect(describeSort({ key: 'received', dir: 'asc' }, options, labels)).toBe('Oldest first');
  });

  it('then the column labels, then a plain fallback', () => {
    expect(describeSort({ key: 'title', dir: 'desc' }, options, labels)).toBe('Title Z–A');
    expect(describeSort({ key: 'received', dir: 'desc' }, options, labels)).toBe(
      'received descending',
    );
  });

  it('calls null "Default order" when there is no menu', () => {
    expect(describeSort(null)).toBe('Default order');
  });
});
