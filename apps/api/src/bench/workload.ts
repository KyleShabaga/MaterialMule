import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { PLACES } from './generate.js';
import type { SeededRandom } from './random.js';

/**
 * The TRP-T19 workload (owner-approved 2026-10-25): 10 active users, 2 receiving stations and
 * 2 scanner sessions, plus a probe client that checks authorization keeps refusing. Each scenario
 * is one autocannon instance; every connection is one person or device.
 *
 * autocannon paces in whole requests per second per connection, so scanners send a lookup every
 * second (3x the agreed "every 3 s"), each user loads a page every second and each receiving
 * station confirms a 5-unit receipt every second: heavier than the agreed profile, never lighter.
 */
export interface BenchTargets {
  readableIds: string[];
  projects: { id: string; number: string; holes: { id: string; name: string }[] }[];
  locationIds: string[];
}

export interface PlannedRequest {
  kind: string;
  method: 'GET' | 'POST';
  path: string;
  body?: string;
  /** Send the scenario's session cookie (default true). */
  withSession?: boolean;
  /** Send the CSRF header on a POST (default true). */
  withCsrf?: boolean;
  /** Statuses that count as correct for this request. */
  expect: number[];
}

export interface Scenario {
  name: string;
  description: string;
  connections: number;
  /** Test sign-in fixture whose session the scenario uses. */
  account: 'at' | 'js-tech' | 'pe' | 'de' | 'js-eng' | 'lab';
  /** Agreed p95 target in ms, when the owner set one for this kind of request. */
  p95TargetMs?: number;
  /** Probe scenarios check refusals; a wrong status there is an authorization failure. */
  probe?: boolean;
  next(random: SeededRandom): PlannedRequest;
}

/** Fixture IDs from seed/dev.sql: Alex Tester (AT) is an active technician with initials. */
export const BENCH_RECEIVER_ID = '00000000-0000-4000-8000-000000000102';

/** Loads the IDs the workload draws from, in a fixed order so a seed picks the same rows. */
export async function loadTargets(pool: Pool): Promise<BenchTargets> {
  const units = await pool.query<{ readable_id: string }>(
    `SELECT readable_id FROM storage_unit ORDER BY readable_id COLLATE "C"`,
  );
  const projects = await pool.query<{
    id: string;
    number: string;
    holes: { id: string; name: string }[];
  }>(
    `SELECT p.id, p.project_number AS number,
            json_agg(json_build_object('id', th.id, 'name', th.name)
                     ORDER BY th.name_normalized) AS holes
     FROM project p JOIN test_hole th ON th.project_id = p.id
     GROUP BY p.id, p.project_number_normalized
     ORDER BY p.project_number_normalized COLLATE "C"`,
  );
  const locations = await pool.query<{ id: string }>(
    `SELECT id FROM location ORDER BY code_normalized COLLATE "C"`,
  );
  return {
    readableIds: units.rows.map((r) => r.readable_id),
    projects: projects.rows,
    locationIds: locations.rows.map((r) => r.id),
  };
}

const qs = (params: Record<string, string | number | undefined>) =>
  Object.entries(params)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => `${key}=${encodeURIComponent(String(value))}`)
    .join('&');

/** A random year-month window inside the dataset's ten years. */
function dateWindow(random: SeededRandom, endYear: number) {
  const year = random.int(endYear - 9, endYear);
  const month = random.int(1, 9);
  return {
    receivedFrom: `${year}-${String(month).padStart(2, '0')}-01`,
    receivedTo: `${year}-${String(month + 2).padStart(2, '0')}-28`,
  };
}

/**
 * One inventory page request: the search and filter combinations the Sample Storage screen sends.
 * Kinds are reported separately so a slow combination is visible.
 */
export type InventoryParams = Record<string, string | number | undefined>;

/** Every inventory combination, each with its parameters drawn from `random`. */
export function inventoryKinds(
  random: SeededRandom,
  targets: BenchTargets,
  endYear: number,
): [kind: string, params: () => InventoryParams][] {
  const project = random.pick(targets.projects);
  const hole = random.pick(project.holes);
  const unitId = random.pick(targets.readableIds);
  return [
    ['inventory: default view', () => ({})],
    ['inventory: default view, later page', () => ({ page: random.int(2, 10) })],
    ['inventory: search project number', () => ({ search: project.number })],
    ['inventory: search ID fragment', () => ({ search: unitId.slice(0, 12).toLowerCase() })],
    ['inventory: search test hole', () => ({ search: hole.name.toLowerCase() })],
    ['inventory: search one common word', () => ({ search: random.pick(PLACES).toLowerCase() })],
    [
      'inventory: search two words',
      () => ({ search: `${random.pick(PLACES)} ${random.pick(['creek', 'hill', 'park'])}` }),
    ],
    ['inventory: filter project', () => ({ projectId: project.id, status: 'all' })],
    [
      'inventory: filter project + test hole',
      () => ({ projectId: project.id, testHoleId: hole.id }),
    ],
    [
      'inventory: filter type + status',
      () => ({
        type: random.pick(['bucket', 'shelby_tube', 'bulk_container']),
        status: random.pick(['in_stock', 'approved_for_disposal', 'disposed']),
      }),
    ],
    ['inventory: filter location', () => ({ locationId: random.pick(targets.locationIds) })],
    ['inventory: filter received dates', () => ({ ...dateWindow(random, endYear), status: 'all' })],
    [
      'inventory: search + type + dates',
      () => ({
        search: random.pick(PLACES).toLowerCase(),
        type: 'bucket',
        ...dateWindow(random, endYear),
        status: 'all',
      }),
    ],
    [
      'inventory: all statuses by ID, deep page',
      () => ({ status: 'all', sort: 'id', dir: 'asc', page: random.int(20, 200) }),
    ],
  ];
}

export function inventoryRequest(
  random: SeededRandom,
  targets: BenchTargets,
  endYear: number,
): PlannedRequest {
  const [kind, params] = random.pick(inventoryKinds(random, targets, endYear));
  const query = qs(params());
  return { kind, method: 'GET', path: `/api/inventory${query ? `?${query}` : ''}`, expect: [200] };
}

/** Five buckets for one project, one SAMPLE#/DEPTH summary each, under a fresh idempotency key. */
export function receiptRequest(
  random: SeededRandom,
  targets: BenchTargets,
  receivedDate: string,
): PlannedRequest {
  const project = random.pick(targets.projects);
  const units = Array.from({ length: 5 }, (_, index) => {
    const from = random.int(1, 20);
    return {
      clientRowId: `row-${index + 1}`,
      unitType: 'bucket',
      holeSummaries: [
        {
          testHoleId: random.pick(project.holes).id,
          type: 'sample_range',
          sampleFrom: `S${from}`,
          sampleTo: `S${from + random.int(0, 10)}`,
        },
      ],
    };
  });
  return {
    kind: 'receipt: confirm 5 units',
    method: 'POST',
    path: '/api/receipts',
    // A random key, never a seeded one: a rerun against the same data must create, not replay.
    body: JSON.stringify({
      idempotencyKey: randomUUID(),
      projectId: project.id,
      receivedDate,
      receiverUserId: BENCH_RECEIVER_ID,
      description: 'Benchmark receipt (fictional)',
      units,
    }),
    expect: [201],
  };
}

export function buildScenarios(
  targets: BenchTargets,
  options: { endYear: number; receivedDate: string },
): Scenario[] {
  const unitPath = (random: SeededRandom) => encodeURIComponent(random.pick(targets.readableIds));
  return [
    {
      name: 'scanners',
      description: '2 scanner sessions: storage unit lookup',
      connections: 2,
      account: 'js-tech',
      p95TargetMs: 300,
      next: (random) => ({
        kind: 'lookup: scan storage unit ID',
        method: 'GET',
        // Scanners type the ID; the API trims and upper-cases.
        path: `/api/storage-units/lookup?code=${random.chance(0.5) ? unitPath(random) : unitPath(random).toLowerCase()}`,
        expect: [200],
      }),
    },
    {
      name: 'inventory',
      description: '5 users: inventory search, filters and paging',
      connections: 5,
      account: 'pe',
      p95TargetMs: 500,
      next: (random) => inventoryRequest(random, targets, options.endYear),
    },
    {
      name: 'detail',
      description: '3 users: storage unit detail page',
      connections: 3,
      account: 'de',
      next: (random) => ({
        kind: 'detail: storage unit',
        method: 'GET',
        path: `/api/storage-units/${unitPath(random)}`,
        expect: [200],
      }),
    },
    {
      name: 'detail-sections',
      description: '2 users: detail page history and print history',
      connections: 2,
      account: 'js-eng',
      next: (random) => {
        const history = random.chance(0.5);
        return {
          kind: history ? 'detail: history page 1' : 'detail: print history',
          method: 'GET',
          path: `/api/storage-units/${unitPath(random)}/${history ? 'history?page=1' : 'print-history'}`,
          expect: [200],
        };
      },
    },
    {
      name: 'receiving',
      description: '2 receiving stations: 5-unit receipt confirmation',
      connections: 2,
      account: 'at',
      p95TargetMs: 1000,
      next: (random) => receiptRequest(random, targets, options.receivedDate),
    },
    {
      name: 'auth-probes',
      description: '1 probe client: requests that must be refused',
      connections: 1,
      account: 'at',
      probe: true,
      next: (random) => {
        const probes: PlannedRequest[] = [
          {
            kind: 'probe: inventory without a session',
            method: 'GET',
            path: '/api/inventory',
            withSession: false,
            expect: [401],
          },
          {
            kind: 'probe: lookup without a session',
            method: 'GET',
            path: `/api/storage-units/lookup?code=${unitPath(random)}`,
            withSession: false,
            expect: [401],
          },
          {
            ...receiptRequest(random, targets, options.receivedDate),
            kind: 'probe: receipt without a session',
            withSession: false,
            expect: [401],
          },
          {
            ...receiptRequest(random, targets, options.receivedDate),
            kind: 'probe: receipt without the CSRF header',
            withCsrf: false,
            expect: [403],
          },
          {
            kind: 'probe: technician lists staff (admin only)',
            method: 'GET',
            path: '/api/staff',
            expect: [403],
          },
          {
            kind: 'probe: technician reads printers (admin only)',
            method: 'GET',
            path: '/api/admin/printers',
            expect: [403],
          },
        ];
        return random.pick(probes);
      },
    },
  ];
}
