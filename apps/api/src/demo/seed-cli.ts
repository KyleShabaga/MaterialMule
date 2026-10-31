// `npm run db:seed:demo -- [--url http://127.0.0.1:3000]`
// Loads a richer fictional demo dataset for manual testing into a RUNNING development API: more
// projects, test holes, locations, receipts (buckets, Shelby tubes, a bulk sample), moves, lab
// programs in every test status, review returns, acceptance, retention holds/extensions/requests
// and disposal. Everything goes through the real HTTP endpoints as the seeded test identities
// (seed/dev.sql), so every permission, rule and audit event is the app's own.
//
// Needs the API started with ENABLE_TEST_AUTH=true (never available in production) and the dev
// fixtures loaded (npm run db:seed:dev). Received dates are relative to today, so retention and
// "recently received" always have something to show. Refuses to run twice: start over with
// `npm run db:rebuild:dev -- --disposable <db>`.
import { randomUUID } from 'node:crypto';
import { parseArgs } from '../bench/cli-args.js';

const CSRF = { 'x-materialmule-csrf': '1' };

/** Fixture users from seed/dev.sql. */
const USER = {
  pe: '00000000-0000-4000-8000-000000000101', // Pat Example, project engineer
  at: '00000000-0000-4000-8000-000000000102', // Alex Tester, technician
  admin: '00000000-0000-4000-8000-000000000103',
  lab: '00000000-0000-4000-8000-000000000104', // Lab Manager
  de: '00000000-0000-4000-8000-000000000105', // Dana Example, engineer
  'js-tech': '00000000-0000-4000-8000-000000000106', // Jordan Smith, technologist
  'js-eng': '00000000-0000-4000-8000-000000000107', // Jamie Song, engineer
} as const;
type FixtureKey = keyof typeof USER;

const SOILS = '00000000-0000-4000-8000-00000000c101';
const ADVANCED_SOILS = '00000000-0000-4000-8000-00000000c102';
const MARKER_PROJECT = 'DEMO-2610';

class ApiError extends Error {
  override name = 'ApiError';
}

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** One signed-in test identity with its own session cookie. */
class Actor {
  private cookie = '';
  constructor(
    private readonly base: string,
    readonly key: FixtureKey,
  ) {}

  async signIn(): Promise<this> {
    const response = await fetch(`${this.base}/api/auth/test/sign-in`, {
      method: 'POST',
      headers: { ...CSRF, 'content-type': 'application/json' },
      body: JSON.stringify({ fixtureKey: this.key }),
    });
    if (response.status === 404) {
      throw new ApiError(
        'Test sign-in is not available: start the API with ENABLE_TEST_AUTH=true (development).',
      );
    }
    if (response.status !== 204) {
      throw new ApiError(`Test sign-in as ${this.key} failed: HTTP ${response.status}`);
    }
    this.cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    return this;
  }

  async send(method: string, path: string, body?: unknown, expect = [200, 201, 204]) {
    const response = await fetch(`${this.base}/api${path}`, {
      method,
      headers: {
        ...CSRF,
        cookie: this.cookie,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await response.text();
    if (!expect.includes(response.status)) {
      throw new ApiError(`${this.key}: ${method} ${path} → HTTP ${response.status} ${text}`);
    }
    return (text ? JSON.parse(text) : {}) as Json;
  }

  get = (path: string) => this.send('GET', path);
  post = (path: string, body: unknown = {}) => this.send('POST', path, body);
}

/** YYYY-MM-DD `days` before today in the business time zone. */
function daysAgo(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' }).format(
    new Date(),
  );
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - days);
  return date.toISOString().slice(0, 10);
}

const key = () => randomUUID();
const log = (message: string) => process.stdout.write(`${message}\n`);

// ---- Data -------------------------------------------------------------------------------------

const LOCATIONS = [
  { code: 'LAB-S1', name: 'Soils lab bench 1', kind: 'lab', area: 'Soils lab' },
  { code: 'LAB-S2', name: 'Soils lab bench 2', kind: 'lab', area: 'Soils lab' },
  { code: 'LAB-ADV', name: 'Advanced soils lab', kind: 'lab', area: 'Advanced lab' },
  { code: 'STG-A', name: 'Staging rack A', kind: 'staging', area: 'Receiving bay' },
  { code: 'WH-C1', name: 'Warehouse C1', kind: 'warehouse', area: 'Warehouse C' },
  { code: 'WH-C3', name: 'Warehouse C3', kind: 'warehouse', area: 'Warehouse C' },
  { code: 'WH-D1', name: 'Warehouse D1 (long-term)', kind: 'warehouse', area: 'Warehouse D' },
  { code: 'COLD-1', name: 'Cold room shelf 1', kind: 'other', area: 'Cold room' },
] as const;

/**
 * Demo sample ID tag settings (MM-T69), fictional: moisture content and VI need no tag, sieve and
 * hydrometer share a "Grain size" tag, everything else keeps its own tag. The real settings are
 * the Lab Manager's to enter.
 */
const NO_TAG_DEV_TESTS = ['DEMO-MC', 'DEMO-VI'];

const TEST_TYPES: {
  group: string;
  code: string;
  name: string;
  description: string;
  sampleTagMode?: 'shared';
  sampleTagGroup?: string;
}[] = [
  {
    group: SOILS,
    code: 'DEMO-SA',
    name: 'Sieve Analysis (demo)',
    description: 'Particle size by sieve - fictional',
    sampleTagMode: 'shared',
    sampleTagGroup: 'Grain size',
  },
  {
    group: SOILS,
    code: 'DEMO-HYD',
    name: 'Hydrometer (demo)',
    description: 'Fines distribution - fictional',
    sampleTagMode: 'shared',
    sampleTagGroup: 'Grain size',
  },
  {
    group: SOILS,
    code: 'DEMO-PR',
    name: 'Standard Proctor (demo)',
    description: 'Moisture-density - fictional',
  },
  {
    group: ADVANCED_SOILS,
    code: 'DEMO-UCS',
    name: 'Unconfined Compression (demo)',
    description: 'UCS of a tube sample - fictional',
  },
  {
    group: ADVANCED_SOILS,
    code: 'DEMO-CON',
    name: 'Consolidation (demo)',
    description: 'One-dimensional consolidation - fictional',
  },
];

interface ProjectSpec {
  number: string;
  name: string;
  client: string;
  lead: FixtureKey | null;
  holes: string[];
  team: FixtureKey[];
}

const PROJECTS: ProjectSpec[] = [
  {
    number: 'DEMO-2610',
    name: 'North Ridge subdivision',
    client: 'Example Homes Ltd',
    lead: 'pe',
    holes: ['TH26-01', 'TH26-02', 'TH26-03', 'TH26-04'],
    team: ['at', 'js-tech'],
  },
  {
    number: 'DEMO-2611',
    name: 'Highway 12 widening',
    client: 'Sample Roads Ltd',
    lead: 'de',
    holes: ['BH26-01', 'BH26-02', 'BH26-03'],
    team: ['at'],
  },
  {
    number: 'DEMO-2612',
    name: 'Lakeside water treatment plant',
    client: 'Example Utilities',
    lead: 'js-eng',
    holes: ['BH26-101', 'BH26-102'],
    team: ['js-tech'],
  },
  {
    number: 'DEMO-2613',
    name: 'Downtown parkade',
    client: 'Fictional Developments Inc.',
    lead: 'pe',
    holes: ['TH25-01', 'TH25-02', 'TH25-03'],
    team: [],
  },
  {
    number: 'DEMO-2614',
    name: 'Airport apron rehabilitation',
    client: 'Example Airport Authority',
    lead: 'de',
    holes: ['TP26-01', 'TP26-02', 'TP26-03', 'TP26-04', 'TP26-05'],
    team: ['at', 'js-tech'],
  },
  // No confirmed lead: a pending nomination for an administrator to decide.
  {
    number: 'DEMO-2615',
    name: 'Rural culvert replacements',
    client: 'Sample County',
    lead: null,
    holes: ['TH26-01'],
    team: [],
  },
];

// ---- Steps ------------------------------------------------------------------------------------

interface Project {
  id: string;
  spec: ProjectSpec;
  holes: Record<string, string>;
}

interface Unit {
  id: string;
  suNumber: string;
}

async function findProject(actor: Actor, projectNumber: string): Promise<Json | undefined> {
  const found = (await actor.get(
    `/projects/search?q=${encodeURIComponent(projectNumber)}`,
  )) as unknown as Json[];
  return found.find((project) => project.projectNumber === projectNumber);
}

async function createProjects(as: Record<FixtureKey, Actor>): Promise<Record<string, Project>> {
  const projects: Record<string, Project> = {};
  for (const spec of PROJECTS) {
    // Reuses a project an interrupted earlier run already created.
    const id =
      (await findProject(as.admin, spec.number))?.id ??
      ((
        await as.admin.post('/projects', {
          projectNumber: spec.number,
          name: spec.name,
          client: spec.client,
          leadNomineeUserId: USER[spec.lead ?? 'de'],
          nominationNote: spec.lead ? 'Demo data' : 'Demo data: awaiting confirmation',
        })
      ).id as string);
    if (spec.lead) {
      const nominations = await as.admin.get(`/projects/${id}/lead-nominations`);
      if (nominations.pending) {
        await as.admin.post(`/projects/${id}/lead-nominations/${nominations.pending.id}/confirm`, {
          reason: 'Demo data: confirmed lead',
        });
      }
    }
    const detail = await as.admin.get(`/projects/${id}`);
    const holes: Record<string, string> = Object.fromEntries(
      (detail.testHoles as Json[]).map((hole) => [hole.name, hole.id]),
    );
    for (const name of spec.holes) {
      holes[name] ??= (await as.admin.post(`/projects/${id}/test-holes`, { name })).id as string;
    }
    if (spec.lead) {
      const team = await as[spec.lead].get(`/projects/${id}/team-members`);
      const members = new Set((team.active as Json[]).map((m) => m.person.userId));
      for (const member of spec.team.filter((m) => !members.has(USER[m]))) {
        await as[spec.lead].post(`/projects/${id}/team-members`, {
          userId: USER[member],
          reason: 'Demo data: project team',
          idempotencyKey: key(),
        });
      }
    }
    projects[spec.number] = { id, spec, holes };
    log(`  ${spec.number} ${spec.name} (${spec.holes.length} test holes)`);
  }
  return projects;
}

type UnitInput = Json;

const all = (testHoleId: string) => ({ testHoleId, type: 'all' });
const samples = (testHoleId: string, sampleFrom: string, sampleTo: string) => ({
  testHoleId,
  type: 'sample_range',
  sampleFrom,
  sampleTo,
});
const depths = (testHoleId: string, depthFrom: number, depthTo: number, depthUnit: 'ft' | 'm') => ({
  testHoleId,
  type: 'depth_range',
  depthFrom,
  depthTo,
  depthUnit,
});
const custom = (testHoleId: string, customText: string) => ({
  testHoleId,
  type: 'custom',
  customText,
});
const bucket = (...holeSummaries: Json[]): UnitInput => ({ unitType: 'bucket', holeSummaries });
const tube = (
  testHoleId: string,
  sampleReference: string,
  depthFrom: number,
  depthTo: number,
): UnitInput => ({
  unitType: 'shelby_tube',
  sample: {
    sourceType: 'test_hole',
    testHoleId,
    sampleReference,
    depthFrom,
    depthTo,
    depthUnit: 'ft',
  },
});

/** Confirms a receipt, or returns the units of the one an interrupted earlier run confirmed. */
async function receive(
  actor: Actor,
  project: Project,
  receivedDaysAgo: number,
  receiver: FixtureKey,
  description: string,
  units: UnitInput[],
  bulkGroups?: Json[],
): Promise<Unit[]> {
  const existing = await actor.get(`/receipts?projectId=${project.id}`);
  for (const item of existing.items as Json[]) {
    const receipt = await actor.get(`/receipts/${item.id}`);
    if (receipt.description === description) {
      return (receipt.units as Json[]).map((u) => ({ id: u.id, suNumber: u.readableId }));
    }
  }
  const body = await actor.post('/receipts', {
    idempotencyKey: key(),
    projectId: project.id,
    receivedDate: daysAgo(receivedDaysAgo),
    receiverUserId: USER[receiver],
    description,
    units: units.map((unit, i) => ({ clientRowId: `row-${i + 1}`, ...unit })),
    ...(bulkGroups ? { bulkGroups } : {}),
  });
  return (body.units as Json[]).map((u) => ({ id: u.storageUnitId, suNumber: u.suNumber }));
}

async function receiveAll(as: Record<FixtureKey, Actor>, p: Record<string, Project>) {
  const r = as.at;
  const nr = p['DEMO-2610']!;
  const hw = p['DEMO-2611']!;
  const wtp = p['DEMO-2612']!;
  const pk = p['DEMO-2613']!;
  const ap = p['DEMO-2614']!;
  const cv = p['DEMO-2615']!;
  const h = (project: Project, name: string) => project.holes[name]!;

  const units = {
    // Downtown parkade: received over a year ago, so retention has lapsed (disposal candidates).
    parkade: await receive(r, pk, 430, 'at', 'Parkade investigation - spring program', [
      bucket(samples(h(pk, 'TH25-01'), 'G1', 'G8')),
      bucket(samples(h(pk, 'TH25-01'), 'G9', 'S14')),
      bucket(all(h(pk, 'TH25-02'))),
      bucket(depths(h(pk, 'TH25-03'), 0, 3, 'm')),
      bucket(depths(h(pk, 'TH25-03'), 3, 6.5, 'm')),
      bucket(custom(h(pk, 'TH25-02'), 'Fill material, east wall')),
    ]),
    parkadeTubes: await receive(r, pk, 425, 'js-tech', 'Parkade Shelby tubes', [
      tube(h(pk, 'TH25-01'), 'T1', 10, 12),
      tube(h(pk, 'TH25-03'), 'T2', 15, 17),
    ]),
    // North Ridge: the main active project.
    northRidge1: await receive(r, nr, 75, 'at', 'North Ridge phase 1 drilling', [
      bucket(samples(h(nr, 'TH26-01'), 'G1', 'G6')),
      bucket(samples(h(nr, 'TH26-01'), 'G7', 'S12'), all(h(nr, 'TH26-02'))),
      bucket(samples(h(nr, 'TH26-02'), 'G1', 'G10')),
      bucket(all(h(nr, 'TH26-03'))),
    ]),
    northRidge2: await receive(r, nr, 40, 'js-tech', 'North Ridge phase 2 drilling', [
      bucket(samples(h(nr, 'TH26-04'), 'G1', 'G5')),
      bucket(samples(h(nr, 'TH26-04'), 'G6', 'G11')),
      tube(h(nr, 'TH26-03'), 'T3', 7.5, 9.5),
      tube(h(nr, 'TH26-04'), 'T1', 5, 7),
    ]),
    northRidgeBulk: await receive(
      r,
      nr,
      30,
      'at',
      'North Ridge road subgrade bulk sample',
      [
        { unitType: 'bucket', bulkGroup: { newGroupKey: 'subgrade' } },
        { unitType: 'bucket', bulkGroup: { newGroupKey: 'subgrade' } },
        { unitType: 'bucket', bulkGroup: { newGroupKey: 'subgrade' } },
      ],
      [
        {
          key: 'subgrade',
          sourceType: 'test_hole',
          testHoleId: h(nr, 'TH26-01'),
          sampleReference: 'B1',
          depthFrom: 0.3,
          depthTo: 1.2,
          depthUnit: 'm',
          description: 'Subgrade clay for Proctor',
        },
      ],
    ),
    // Highway 12.
    highway: await receive(r, hw, 55, 'js-tech', 'Highway 12 boreholes', [
      bucket(depths(h(hw, 'BH26-01'), 0, 10, 'ft')),
      bucket(depths(h(hw, 'BH26-01'), 10, 25, 'ft')),
      bucket(depths(h(hw, 'BH26-02'), 0, 15, 'ft')),
      bucket(all(h(hw, 'BH26-03'))),
      tube(h(hw, 'BH26-02'), 'T4', 20, 22),
    ]),
    // Water treatment plant.
    wtp: await receive(r, wtp, 18, 'at', 'WTP clarifier foundation', [
      bucket(samples(h(wtp, 'BH26-101'), 'SS1', 'SS8')),
      bucket(samples(h(wtp, 'BH26-102'), 'SS1', 'SS6')),
      tube(h(wtp, 'BH26-101'), 'ST2', 12, 14),
      tube(h(wtp, 'BH26-102'), 'ST1', 8, 10),
    ]),
    // Airport: recent, mostly still at receiving.
    airport: await receive(r, ap, 6, 'js-tech', 'Apron test pits, day 1', [
      bucket(all(h(ap, 'TP26-01'))),
      bucket(all(h(ap, 'TP26-02'))),
      bucket(all(h(ap, 'TP26-03'))),
    ]),
    airport2: await receive(r, ap, 2, 'at', 'Apron test pits, day 2', [
      bucket(all(h(ap, 'TP26-04'))),
      bucket(all(h(ap, 'TP26-05')), custom(h(ap, 'TP26-03'), 'Extra base course from TP26-03')),
    ]),
    // Culvert project with no lead yet.
    culvert: await receive(r, cv, 1, 'js-tech', 'Culvert site grab samples', [
      bucket(samples(h(cv, 'TH26-01'), 'G1', 'G4')),
    ]),
  };
  const count = Object.values(units).reduce((n, list) => n + list.length, 0);
  log(`  ${count} storage units in ${Object.keys(units).length} receipts`);
  return units;
}

async function createLocations(admin: Actor): Promise<Record<string, string>> {
  const existing = (await admin.get('/locations')) as unknown as Json[];
  const ids: Record<string, string> = Object.fromEntries(existing.map((l) => [l.code, l.id]));
  for (const location of LOCATIONS) {
    ids[location.code] ??= (await admin.post('/locations', location)).id as string;
  }
  log(`  ${LOCATIONS.length} locations`);
  return ids;
}

const STATION_ID = randomUUID();

/** Moves a unit through `codes` in order, unless it is already at the last one. */
async function moveAlong(actor: Actor, unit: Unit, codes: string[], loc: Record<string, string>) {
  if ((await actor.get(`/storage-units/${unit.suNumber}`)).location.id === loc[codes.at(-1)!]) {
    return 0;
  }
  for (const code of codes) {
    const detail = await actor.get(`/storage-units/${unit.suNumber}`);
    await actor.post('/moves', {
      clientMoveId: key(),
      storageUnitId: unit.id,
      toLocationId: loc[code]!,
      baseVersion: detail.version,
      scannedAt: new Date().toISOString(),
      capturedOffline: false,
      captureContext: { stationId: STATION_ID, accountId: USER[actor.key] },
    });
  }
  return codes.length;
}

async function createTestTypes(lab: Actor): Promise<Record<string, string>> {
  const existing = new Set(
    ((await lab.get('/test-types')) as unknown as Json[]).map((t) => t.code),
  );
  for (const type of TEST_TYPES.filter((t) => !existing.has(t.code))) {
    await lab.post('/test-types', {
      groupId: type.group,
      code: type.code,
      name: type.name,
      description: type.description,
      sampleTagMode: type.sampleTagMode,
      sampleTagGroup: type.sampleTagGroup,
    });
  }
  // The dev fixtures predate tag settings; give them theirs once, never overriding a change.
  for (const test of (await lab.get('/test-types')) as unknown as Json[]) {
    if (NO_TAG_DEV_TESTS.includes(test.code as string) && test.sampleTagMode === 'own') {
      await lab.send('PATCH', `/test-types/${test.id as string}`, {
        version: test.version,
        sampleTagMode: 'none',
      });
    }
  }
  const list = (await lab.get('/test-types')) as unknown as Json[];
  return Object.fromEntries(list.map((t) => [t.code, t.id]));
}

interface LineSpec {
  holeId: string;
  tests: string[];
}

/**
 * The project's submitted program, creating and submitting it (with every covered unit) when the
 * project has none yet. Each demo project has at most one submitted program.
 */
async function ensureProgram(
  requester: Actor,
  project: Project,
  types: Record<string, string>,
  lines: LineSpec[],
  notes: string,
): Promise<Json> {
  const list = await requester.get(`/lab-programs?projectId=${project.id}`);
  const existing = (list.items as Json[]).find((program) => program.status !== 'draft');
  if (existing) return requester.get(`/lab-programs/${existing.id}`);
  const draft = await requester.post('/lab-programs', {
    projectId: project.id,
    idempotencyKey: key(),
    notes,
    lines: lines.map((line) => ({
      source: { kind: 'test_hole', id: line.holeId },
      scope: 'all',
      testTypeIds: line.tests.map((code) => types[code]!),
    })),
  });
  const review = await requester.get(`/lab-programs/${draft.id}/review`);
  return requester.post(`/lab-programs/${draft.id}/submit`, {
    version: draft.version,
    idempotencyKey: key(),
    coverage: (review.lines as Json[]).map((l) => ({
      lineId: l.lineId,
      unitIds: (l.coverage as Json[]).map((c) => c.storageUnitId),
    })),
  });
}

type Target = 'requested' | 'in_progress' | 'completed' | 'review' | 'returned' | 'accepted';
const PROGRESS = ['requested', 'in_progress', 'completed', 'review'];

interface Crew {
  tech: Actor;
  reviewer: Actor;
  lead: Actor;
}

/**
 * Brings one test (line `lineIndex`, test `code`) from its current status to `target`, so a rerun
 * only does what is left. Completing a test that covers Shelby tubes or bulk-sample buckets names
 * the first such unit as the one tested.
 */
async function bringTo(
  program: Json,
  lineIndex: number,
  code: string,
  target: Target,
  crew: Crew,
  returnComment = 'Tare weight missing on sheet 2',
) {
  const line = (program.lines as Json[])[lineIndex]!;
  const test = (line.requests as Json[]).find((r) => r.code === code)!;
  const startedAt = test.status as string;
  if (startedAt === 'accepted' || startedAt === 'cancelled') return;
  const goal = target === 'returned' || target === 'accepted' ? 'review' : target;
  let version = test.version as number;
  for (const step of PROGRESS.slice(PROGRESS.indexOf(startedAt) + 1, PROGRESS.indexOf(goal) + 1)) {
    const special = (line.coverage as Json[]).find(
      (unit) => unit.included && unit.unitType !== 'bucket',
    );
    version = (
      await crew.tech.post(`/test-requests/${test.id}/status`, {
        to: step,
        version,
        idempotencyKey: key(),
        ...(step === 'completed' && special
          ? { testedStorageUnitIds: [special.storageUnitId] }
          : {}),
      })
    ).version as number;
  }
  // A test already in review before this run has had its review decision.
  if (startedAt === 'review' || target === goal) return;
  if (target === 'returned') {
    await crew.reviewer.post(`/test-requests/${test.id}/review`, {
      action: 'return',
      comment: returnComment,
      version,
      idempotencyKey: key(),
    });
    return;
  }
  version = (
    await crew.reviewer.post(`/test-requests/${test.id}/review`, {
      action: 'complete',
      version,
      idempotencyKey: key(),
    })
  ).version as number;
  await crew.lead.post(`/test-requests/${test.id}/accept`, { version, idempotencyKey: key() });
}

// ---- Main -------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const base = (args.get('url') ?? 'http://127.0.0.1:3000').replace(/\/$/, '');
  log(`Demo data → ${base}`);

  const as = {} as Record<FixtureKey, Actor>;
  for (const k of Object.keys(USER) as FixtureKey[]) {
    as[k] = await new Actor(base, k).signIn();
  }

  // Every step reuses what an earlier (interrupted) run made; the last step marks completion.
  const marker = await findProject(as.admin, MARKER_PROJECT);
  if (marker && (await as.admin.get(`/projects/${marker.id}/retention`)).holds.length > 0) {
    throw new ApiError(
      `Demo data is already loaded (${MARKER_PROJECT} has a retention hold). To start over: ` +
        'npm run db:rebuild:dev -- --disposable <database>, then run this again.',
    );
  }

  log('Locations');
  const loc = await createLocations(as.admin);
  log('Projects');
  const p = await createProjects(as);
  log('Receipts');
  const u = await receiveAll(as, p);

  log('Moves');
  const moves: [Unit[], string[]][] = [
    [u.parkade, ['WH-D1']],
    [u.parkadeTubes, ['COLD-1']],
    // A second hop so some units have a longer movement history.
    [u.northRidge1.slice(0, 1), ['LAB-S1', 'WH-C1']],
    [u.northRidge1.slice(1, 2), ['LAB-S1']],
    [u.northRidge1.slice(2), ['WH-C1']],
    [u.northRidge2.slice(0, 2), ['LAB-S2']],
    [u.northRidge2.slice(2), ['COLD-1']],
    [u.northRidgeBulk, ['LAB-S1']],
    [u.highway.slice(0, 3), ['WH-C3']],
    [u.highway.slice(3, 4), ['STG-A', 'WH-C3']],
    [u.highway.slice(4), ['LAB-ADV']],
    [u.wtp.slice(0, 2), ['STG-A']],
    [u.wtp.slice(2), ['LAB-ADV']],
    [u.airport.slice(0, 1), ['STG-A']],
  ];
  let moved = 0;
  for (const [units, codes] of moves) {
    for (const unit of units) moved += await moveAlong(as.at, unit, codes, loc);
  }
  log(`  ${moved} moves`);

  log('Lab test catalogue');
  const types = await createTestTypes(as.lab);
  log(`  ${TEST_TYPES.length} demo test types`);

  log('Lab programs');
  const nr = p['DEMO-2610']!;
  const hw = p['DEMO-2611']!;
  const wtp = p['DEMO-2612']!;
  const pk = p['DEMO-2613']!;
  const ap = p['DEMO-2614']!;

  // North Ridge: tests in every stage, one returned for correction (a Lab Manager action item).
  const nrCrew = { tech: as.at, reviewer: as['js-tech'], lead: as.pe };
  const nrProgram = await ensureProgram(
    as.pe,
    nr,
    types,
    [
      { holeId: nr.holes['TH26-01']!, tests: ['DEMO-MC', 'DEMO-VI', 'DEMO-ATT'] },
      { holeId: nr.holes['TH26-02']!, tests: ['DEMO-MC', 'DEMO-SA'] },
      { holeId: nr.holes['TH26-04']!, tests: ['DEMO-MC', 'DEMO-HYD'] },
    ],
    'Phase 1 classification testing',
  );
  await bringTo(nrProgram, 0, 'DEMO-MC', 'accepted', nrCrew);
  await bringTo(nrProgram, 0, 'DEMO-VI', 'accepted', nrCrew);
  await bringTo(nrProgram, 0, 'DEMO-ATT', 'review', nrCrew);
  await bringTo(nrProgram, 1, 'DEMO-MC', 'completed', nrCrew);
  await bringTo(nrProgram, 1, 'DEMO-SA', 'in_progress', nrCrew);
  await bringTo(nrProgram, 2, 'DEMO-MC', 'returned', nrCrew);
  if (((await as.at.get(`/lab-programs/${nrProgram.id}/work`)).comments ?? []).length === 0) {
    await as.at.post(`/lab-programs/${nrProgram.id}/comments`, {
      body: 'Started TH26-01 moisture contents today.',
      idempotencyKey: key(),
    });
  }
  log(`  ${nrProgram.programNumber}: North Ridge, tests in every stage`);

  // Highway 12: urgent, one test started.
  const hwProgram = await ensureProgram(
    as.de,
    hw,
    types,
    [
      { holeId: hw.holes['BH26-01']!, tests: ['DEMO-MC', 'DEMO-SA'] },
      { holeId: hw.holes['BH26-02']!, tests: ['DEMO-MC', 'DEMO-ATT'] },
    ],
    'Pavement design inputs - client needs results Friday',
  );
  if (hwProgram.priority !== 'urgent') {
    await as.lab.send('PATCH', `/lab-programs/${hwProgram.id}/priority`, {
      priority: 'urgent',
      version: (await as.lab.get(`/lab-programs/${hwProgram.id}`)).version,
      idempotencyKey: key(),
    });
  }
  await bringTo(hwProgram, 0, 'DEMO-MC', 'in_progress', { ...nrCrew, lead: as.de });
  log(`  ${hwProgram.programNumber}: Highway 12, urgent`);

  // Parkade: every test accepted and the program closed.
  const pkProgram = await ensureProgram(
    as.pe,
    pk,
    types,
    [{ holeId: pk.holes['TH25-02']!, tests: ['DEMO-MC', 'DEMO-VI'] }],
    'Fill characterisation',
  );
  await bringTo(pkProgram, 0, 'DEMO-MC', 'accepted', nrCrew);
  await bringTo(pkProgram, 0, 'DEMO-VI', 'accepted', nrCrew);
  const pkDetail = await as.pe.get(`/lab-programs/${pkProgram.id}`);
  if (pkDetail.status !== 'closed') {
    await as.pe.post(`/lab-programs/${pkProgram.id}/close`, {
      version: pkDetail.version,
      idempotencyKey: key(),
    });
  }
  log(`  ${pkProgram.programNumber}: Parkade, accepted and closed`);

  // Water treatment plant: submitted, nothing started.
  const wtpProgram = await ensureProgram(
    as['js-eng'],
    wtp,
    types,
    [{ holeId: wtp.holes['BH26-101']!, tests: ['DEMO-MC', 'DEMO-VI'] }],
    'Clarifier foundation classification',
  );
  log(`  ${wtpProgram.programNumber}: Water treatment plant, requested`);

  // Airport: an unsubmitted draft.
  const apPrograms = await as.de.get(`/lab-programs?projectId=${ap.id}`);
  if ((apPrograms.items as Json[]).length === 0) {
    await as.de.post('/lab-programs', {
      projectId: ap.id,
      idempotencyKey: key(),
      notes: 'Draft - waiting on test pit logs',
      lines: [
        {
          source: { kind: 'test_hole', id: ap.holes['TP26-01']! },
          scope: 'all',
          testTypeIds: [types['DEMO-PR']!],
        },
      ],
    });
  }
  log('  Airport: draft program');

  log('Disposal');
  // Parkade units past retention (received over a year ago): approve three, dispose one.
  const toApprove = [u.parkade[3]!, u.parkade[4]!, u.parkade[5]!];
  const statuses = await Promise.all(
    toApprove.map(async (unit) => (await as.pe.get(`/storage-units/${unit.suNumber}`)).status),
  );
  if (statuses.every((status) => status === 'in_stock')) {
    await as.pe.post('/disposal/approvals', {
      unitIds: toApprove.map((unit) => unit.id),
      idempotencyKey: key(),
    });
  }
  if (statuses[0] !== 'disposed') {
    await as.at.post('/disposal/remove', {
      suNumber: toApprove[0]!.suNumber,
      idempotencyKey: key(),
    });
  }
  log('  3 approved for disposal, 1 of them disposed');

  log('Retention');
  // A pending request from a technician (an action item for Dana), an extension, and a hold.
  const hwRetention = await as.de.get(`/projects/${hw.id}/retention`);
  if ((hwRetention.requests as Json[]).length === 0) {
    await as.at.post('/retention/requests', {
      kind: 'hold',
      projectId: hw.id,
      scope: 'units',
      unitIds: [u.highway[0]!.id],
      reason: 'Engineer may want to retest this bucket',
      idempotencyKey: key(),
    });
  }
  const pkRetention = await as.pe.get(`/projects/${pk.id}/retention`);
  if ((pkRetention.extensions as Json[]).length === 0) {
    await as.pe.post('/retention/extensions', {
      projectId: pk.id,
      scope: 'units',
      unitIds: [u.parkade[1]!.id, u.parkadeTubes[0]!.id],
      extendMonths: 12,
      reason: 'Client asked to keep these another year',
      idempotencyKey: key(),
    });
  }
  // Last: its presence marks the dataset as complete.
  await as.pe.post('/retention/holds', {
    projectId: nr.id,
    scope: 'units',
    unitIds: [u.northRidge1[2]!.id],
    reason: 'Possible settlement claim - keep until resolved',
    idempotencyKey: key(),
  });
  log('  1 hold, 1 extension, 1 pending request');

  log('Done. Sign in as any test identity (admin, lab, at, pe, de, js-tech, js-eng) to explore.');
}

main().catch((error: unknown) => {
  process.stderr.write(`${(error as Error).message}\n`);
  process.exit(1);
});
