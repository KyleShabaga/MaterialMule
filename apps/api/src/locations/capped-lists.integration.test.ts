import {
  LIST_TOTAL_HEADER,
  LOCATION_LIST_LIMIT,
  locationListSchema,
  STAFF_LIST_LIMIT,
  staffListResponseSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, type LabHarness } from '../test-support/lab-harness.js';

// BUG-007: staff and location lists never cut silently. The body keeps its shape (a plain array,
// for existing callers); LIST_TOTAL_HEADER says how many match, and screens that need every
// location ask for `all`. Fictional data only: zones ZZ-n, people "Example Person n".
describe.runIf(testDatabaseUrl)('capped staff and location lists (BUG-007)', () => {
  let h: LabHarness;
  const EXTRA = 510;

  beforeAll(async () => {
    h = await createLabHarness();
    await h.db.pool.query(
      `INSERT INTO location (code, name, kind)
       SELECT 'ZZ-' || g, 'Zone ' || lpad(g::text, 4, '0'), 'warehouse'
       FROM generate_series(1, $1::int) g`,
      [EXTRA],
    );
    await h.db.pool.query(
      `INSERT INTO app_user (display_name, account_type, status)
       SELECT 'Example Person ' || lpad(g::text, 4, '0'), 'personal', 'active'
       FROM generate_series(1, $1::int) g`,
      [EXTRA],
    );
  });

  afterAll(async () => {
    await h?.close();
  });

  it('locations: the browse list says how many match, and all=true returns every one', async () => {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM location WHERE active',
    );
    const browse = await h.get('/api/locations', 'tech');
    expect(browse.status).toBe(200);
    expect(locationListSchema.parse(browse.body)).toHaveLength(LOCATION_LIST_LIMIT);
    expect(browse.headers[LIST_TOTAL_HEADER]).toBe(String(rows[0]!.n));

    // A narrower search fits and says so.
    const narrow = await h.get('/api/locations?search=zone%2005', 'tech');
    const found = locationListSchema.parse(narrow.body);
    expect(found.length).toBeLessThan(LOCATION_LIST_LIMIT);
    expect(narrow.headers[LIST_TOTAL_HEADER]).toBe(String(found.length));

    const all = await h.get('/api/locations?includeRetired=true&all=true', 'tech');
    const every = locationListSchema.parse(all.body);
    const { rows: total } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM location',
    );
    expect(every).toHaveLength(total[0]!.n);
    expect(every.map((l) => l.code)).toContain(`ZZ-${EXTRA}`);
    expect(all.headers[LIST_TOTAL_HEADER]).toBe(String(total[0]!.n));
  });

  it('staff: the list says how many match beyond the cap', async () => {
    const { rows } = await h.db.pool.query<{ n: number }>(
      'SELECT count(*)::int AS n FROM app_user',
    );
    const response = await h.get('/api/staff', 'admin');
    expect(response.status, JSON.stringify(response.body)).toBe(200);
    expect(staffListResponseSchema.parse(response.body)).toHaveLength(STAFF_LIST_LIMIT);
    expect(response.headers[LIST_TOTAL_HEADER]).toBe(String(rows[0]!.n));

    const one = await h.get('/api/staff?search=Example%20Person%200510', 'admin');
    expect(staffListResponseSchema.parse(one.body).map((m) => m.displayName)).toEqual([
      'Example Person 0510',
    ]);
    expect(one.headers[LIST_TOTAL_HEADER]).toBe('1');
  });
});
