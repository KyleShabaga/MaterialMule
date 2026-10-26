import { inventoryQuerySchema } from '@trapezoid/shared';
import { describe, expect, it } from 'vitest';
import { buildInventoryQuery } from './inventory-query.js';

const PROJECT = '00000000-0000-4000-8000-000000000201';
const HOLE = '00000000-0000-4000-8000-000000000301';
const LOCATION = '00000000-0000-4000-8000-000000000401';

const build = (input: Record<string, string>) =>
  buildInventoryQuery(inventoryQuerySchema.parse(input));

describe('inventory query builder (TRP-T12 T1)', () => {
  it('defaults to Current stock, newest first, ID as tie-breaker, first page of 25', () => {
    const sql = build({});
    expect(sql.params).toEqual([]);
    expect(sql.fromWhere).toContain(`su.status <> 'disposed'`);
    expect(sql.fromWhere).not.toContain('storage_unit_search');
    expect(sql.orderBy).toBe('su.received_date DESC, su.readable_id COLLATE "C" DESC');
    expect(sql).toMatchObject({ limit: 25, offset: 0 });
  });

  it('turns each search word into its own contains-match (AND across words), escaped', () => {
    const sql = build({ search: '  TH26-01  Warehouse 100%_x ' });
    expect(sql.params).toEqual(['%th26-01%', '%warehouse%', '%100\\%\\_x%']);
    expect(sql.fromWhere).toContain('JOIN storage_unit_search s ON s.storage_unit_id = su.id');
    expect(sql.fromWhere.match(/s\.document LIKE \$\d/g)).toEqual([
      's.document LIKE $1',
      's.document LIKE $2',
      's.document LIKE $3',
    ]);
  });

  it('combines every filter with AND, values only as parameters', () => {
    const sql = build({
      search: 'bkt',
      projectId: PROJECT,
      testHoleId: HOLE,
      type: 'bucket',
      locationId: LOCATION,
      status: 'disposed',
      receivedFrom: '2026-10-01',
      receivedTo: '2026-10-23',
      sort: 'id',
      dir: 'desc',
      page: '3',
      pageSize: '50',
    });
    expect(sql.params).toEqual([
      '%bkt%',
      PROJECT,
      HOLE,
      'bucket',
      LOCATION,
      'disposed',
      '2026-10-01',
      '2026-10-23',
    ]);
    const conditions = sql.fromWhere
      .slice(sql.fromWhere.indexOf('WHERE ') + 'WHERE '.length)
      .split('\n  AND ');
    expect(conditions).toHaveLength(8);
    expect(sql.fromWhere).toContain('su.received_date >= $7::date');
    expect(sql.fromWhere).toContain('su.received_date <= $8::date');
    expect(sql.fromWhere).toContain('h.test_hole_id = $3');
    expect(sql.orderBy).toBe('su.readable_id COLLATE "C" DESC');
    expect(sql).toMatchObject({ limit: 50, offset: 100 });
    // No user value is ever spliced into the SQL text.
    for (const value of [PROJECT, 'bucket', 'disposed', '2026-10-01']) {
      expect(sql.fromWhere).not.toContain(value);
    }
  });

  it('applies no status condition for All statuses', () => {
    expect(build({ status: 'all' }).fromWhere).not.toContain('status');
    expect(build({ status: 'in_stock' }).params).toEqual(['in_stock']);
  });

  it('sorts by ID ascending by default and received date ascending when asked', () => {
    expect(build({ sort: 'id' }).orderBy).toBe('su.readable_id COLLATE "C" ASC');
    expect(build({ sort: 'received', dir: 'asc' }).orderBy).toBe(
      'su.received_date ASC, su.readable_id COLLATE "C" ASC',
    );
  });
});
