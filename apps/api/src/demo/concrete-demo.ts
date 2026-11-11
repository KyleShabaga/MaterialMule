// Concrete (V2) part of `npm run db:seed:demo`: a fictional concrete project, DEMO-2616, with
// field reports and cylinder sets in every stage, through the real HTTP endpoints as the seeded
// test identities. One step can't go through HTTP yet: a set's permanent number comes from C18's
// allocator, which isn't built, so `SetNumbers` attaches it with SQL (as the E2E specs do), on
// the database named by the API's env file. Dates are relative to today (America/Edmonton).
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseEnv } from 'node:util';
import {
  CONCRETE_HOLD_AGE,
  calibrationInEffect,
  type CalibrationForRule,
} from '@materialmule/shared';
import pg from 'pg';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

export interface DemoActor {
  readonly key: string;
  get(path: string): Promise<Json>;
  post(path: string, body?: unknown): Promise<Json>;
  send(method: string, path: string, body?: unknown, expect?: number[]): Promise<Json>;
}

export type ConcreteCrew = Record<'admin' | 'lab' | 'pe' | 'at' | 'js-tech' | 'lt', DemoActor>;
type FindProject = (projectNumber: string) => Promise<Json | undefined>;

export const CONCRETE_PROJECT = 'DEMO-2616';
const USER = {
  pe: '00000000-0000-4000-8000-000000000101',
  at: '00000000-0000-4000-8000-000000000102',
  'js-tech': '00000000-0000-4000-8000-000000000106',
};

const key = () => randomUUID();
const log = (message: string) => process.stdout.write(`${message}\n`);
const list = (body: Json): Json[] => (Array.isArray(body) ? body : (body.items as Json[]));

/** YYYY-MM-DD `days` from today (negative = past) in the business time zone. */
function day(days: number): string {
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Edmonton' }).format(
    new Date(),
  );
  const date = new Date(`${today}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** `hhmm` on `date` (YYYY-MM-DD), Mountain Standard Time. */
const at = (date: string, hhmm: string) =>
  new Date(`${date}T${hhmm.slice(0, 2)}:${hhmm.slice(2)}:00-07:00`).toISOString();

// ---- Set numbering stand-in (C18) -------------------------------------------------------------

/** The API's database, from its env file. Refuses a production env file. */
function databaseUrl(envFile: string): string {
  const env = parseEnv(readFileSync(envFile, 'utf8'));
  if (env.APP_ENV === 'production') {
    throw new Error(`${envFile} is a production env file: demo data is development only.`);
  }
  if (!env.DATABASE_URL) throw new Error(`${envFile} has no DATABASE_URL`);
  return env.DATABASE_URL;
}

/** The SQL the set-numbering stand-in needs; a `pg.Client` in real runs. */
export interface DemoSql {
  query<R extends Json = Json>(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: R[]; rowCount: number | null }>;
  end(): Promise<void>;
}

const MISMATCHED_DATABASE =
  "Set numbering went to a different database than the API's: pass the API's env file " +
  'with --env-file (default .env).';

/** Opens the API's database, from its env file. */
export async function openDemoSql(envFile: string): Promise<DemoSql> {
  const client = new pg.Client({ connectionString: databaseUrl(envFile) });
  await client.connect();
  return client as unknown as DemoSql;
}

class SetNumbers {
  constructor(private readonly sql: DemoSql) {}

  /**
   * Fails unless the SQL connection sees the project the API issued: run before the first pour,
   * so a mismatched env file creates nothing that a corrected rerun would trip over.
   */
  async checkProject(projectId: string): Promise<void> {
    const { rows } = await this.sql.query('SELECT id FROM project WHERE id = $1', [projectId]);
    if (rows.length !== 1) throw new Error(MISMATCHED_DATABASE);
  }

  /**
   * Attaches the project's next number (YY from the cast date), unless the set has one, and
   * returns the set's permanent ID. Fails when the set isn't in this database.
   */
  async number(setId: string, castDate: string): Promise<string> {
    await this.sql.query(
      `UPDATE concrete_specimen_set s
          SET permanent_number = n.next,
              permanent_id = $2 || '-' || lpad(n.next::text, 2, '0')
         FROM (SELECT coalesce(max(permanent_number), 0) + 1 AS next
                 FROM concrete_specimen_set
                WHERE project_id = (SELECT project_id FROM concrete_specimen_set WHERE id = $1)) n
        WHERE s.id = $1 AND s.permanent_number IS NULL`,
      [setId, castDate.slice(2, 4)],
    );
    const { rows } = await this.sql.query<{ permanent_id: string | null }>(
      'SELECT permanent_id FROM concrete_specimen_set WHERE id = $1',
      [setId],
    );
    const permanentId = rows[0]?.permanent_id;
    if (!permanentId) throw new Error(MISMATCHED_DATABASE);
    return permanentId;
  }

  close = () => this.sql.end();
}

// ---- Reference data, project and mix ----------------------------------------------------------

const SUPPLIER = 'Example Ready-Mix';
const MIX_NUMBER = 'ER-32-20';
const SPEC = {
  specifiedStrengthMpa: 32,
  specifiedStrengthAgeDays: 28,
  slumpTargetMm: 80,
  slumpToleranceMm: 30,
  airMinPercent: 5,
  airMaxPercent: 8,
  maxAggregateSizeMm: 20,
  cementType: 'GU',
};

/** The header the demo fills in, and the migration default it replaces (0031). */
export const DEMO_HEADER = {
  companyName: 'Example Materials Testing Ltd',
  address: '100 Sample Street\nExample City AB',
  phone: '555-0100',
};
const DEFAULT_HEADER_NAME = 'Material Mule Testing Laboratory';

const isDefaultHeader = (header: Json) =>
  header.version === 1 &&
  header.companyName === DEFAULT_HEADER_NAME &&
  header.address == null &&
  header.phone == null;

/** The oldest demo date that uses equipment (the first pour). */
const OLDEST_POUR_DAYS_AGO = 35;

/**
 * Records the demo calibration on a device unless one already covers every demo date, from the
 * first pour to today (existing entries are kept). `route` is the device kind's manage route.
 */
async function ensureCalibration(
  lab: DemoActor,
  route: 'air-meters' | 'testing-machine',
  id: string,
  result: string,
): Promise<void> {
  const detail = await lab.get(`/concrete/equipment/${id}`);
  const calibrations = (detail.calibrations ?? []) as CalibrationForRule[];
  const covered = [day(-OLDEST_POUR_DAYS_AGO), day(0)].every((date) => {
    const entry = calibrationInEffect(calibrations, date);
    return entry !== null && entry.nextDueOn > date;
  });
  if (covered) return;
  await lab.post(`/concrete/${route}/${id}/calibrations`, {
    calibratedOn: day(-200),
    nextDueOn: day(165),
    performedBy: 'Example Calibration Services',
    result,
    idempotencyKey: key(),
  });
}

async function referenceData(as: ConcreteCrew): Promise<string> {
  // The header is global: fill it in only while it is still the untouched migration default,
  // never over one someone has set (other projects' reports print it).
  const header = await as.admin.get('/concrete/report-header');
  if (isDefaultHeader(header)) {
    await as.admin.send('PUT', '/concrete/report-header', {
      version: header.version,
      ...DEMO_HEADER,
    });
  }

  const suppliers = list(await as.lab.get('/concrete/suppliers?includeInactive=true'));
  if (!suppliers.some((s) => s.name === SUPPLIER)) {
    await as.lab.post('/concrete/suppliers', {
      name: SUPPLIER,
      plantNames: ['North Plant', 'South Plant'],
    });
  }

  const holidays = list(await as.admin.get('/concrete/holidays'));
  const year = day(0).slice(0, 4);
  for (const holiday of [
    { holidayOn: `${year}-12-25`, name: 'Christmas Day' },
    { holidayOn: `${year}-12-26`, name: 'Boxing Day' },
  ]) {
    if (!holidays.some((h) => h.holidayOn === holiday.holidayOn)) {
      await as.admin.post('/concrete/holidays', holiday);
    }
  }

  const equipment = list(await as.lab.get('/concrete/equipment'));
  // Creating a device and recording its calibration are separate requests: resolve each device,
  // then check its calibration on its own, so a run stopped in between finishes the job.
  const meter =
    equipment.find((e) => e.kind === 'air_meter' && e.identifier === 'AM-07') ??
    (await as.lab.post('/concrete/air-meters', {
      kind: 'air_meter',
      identifier: 'AM-07',
      make: 'Example Instruments',
      model: 'Type B 7 L',
      assignedUserId: USER.at,
      idempotencyKey: key(),
    }));
  await ensureCalibration(as.lab, 'air-meters', meter.id as string, 'Within tolerance');
  // One testing machine (the route is singular): the existing one, whatever its identifier.
  const machine =
    equipment.find((e) => e.kind === 'testing_machine') ??
    (await as.lab.post('/concrete/testing-machine', {
      kind: 'testing_machine',
      identifier: 'CM-1',
      description: 'Compression machine, concrete lab',
      make: 'Example Test Systems',
      model: '2000 kN',
      idempotencyKey: key(),
    }));
  await ensureCalibration(as.lab, 'testing-machine', machine.id as string, 'Class A');
  log('  report header, 1 supplier, 2 holidays, an air meter and the testing machine');
  return meter.id as string;
}

async function ensureProject(as: ConcreteCrew, findProject: FindProject): Promise<string> {
  const id =
    (await findProject(CONCRETE_PROJECT))?.id ??
    ((
      await as.admin.post('/projects', {
        projectNumber: CONCRETE_PROJECT,
        name: 'Riverside apartments - concrete testing',
        client: 'Example Developments Ltd',
        leadNomineeUserId: USER.pe,
        nominationNote: 'Demo data',
      })
    ).id as string);
  const nominations = await as.admin.get(`/projects/${id}/lead-nominations`);
  if (nominations.pending) {
    await as.admin.post(`/projects/${id}/lead-nominations/${nominations.pending.id}/confirm`, {
      reason: 'Demo data: confirmed lead',
    });
  }
  const team = await as.pe.get(`/projects/${id}/team-members`);
  const members = new Set((team.active as Json[]).map((m) => m.person.userId));
  for (const userId of [USER.at, USER['js-tech']].filter((u) => !members.has(u))) {
    await as.pe.post(`/projects/${id}/team-members`, {
      userId,
      reason: 'Demo data: project team',
      idempotencyKey: key(),
    });
  }
  return id;
}

/**
 * The demo mix (exact supplier and mix number), approved. Creates it when missing and finishes
 * the approval of a draft an interrupted run created, so no pour names an unapproved mix.
 */
async function ensureMix(pe: DemoActor, projectId: string): Promise<string> {
  const mixes = list(
    await pe.get(
      `/projects/${projectId}/concrete-mixes?search=${encodeURIComponent(MIX_NUMBER)}&pageSize=100`,
    ),
  );
  const found = mixes.find((m) => m.supplierName === SUPPLIER && m.mixNumber === MIX_NUMBER);
  const mix = found
    ? await pe.get(`/concrete-mixes/${found.id as string}`)
    : await pe.post(`/projects/${projectId}/concrete-mixes`, {
        idempotencyKey: key(),
        spec: { supplierName: SUPPLIER, mixNumber: MIX_NUMBER, ...SPEC },
      });
  if (mix.status === 'unapproved') {
    if (!mix.draftRevision) {
      throw new Error(`${CONCRETE_PROJECT} mix ${MIX_NUMBER} has no draft to approve.`);
    }
    await pe.post(`/concrete-mixes/${mix.id as string}/approve`, {
      idempotencyKey: key(),
      version: mix.version,
      revisionId: mix.draftRevision.id,
    });
  }
  return mix.id as string;
}

// ---- Pours: field reports and cylinder sets ---------------------------------------------------

/** How far each demo pour has gone. */
type Stage =
  | 'draft' // today: the technician is still filling it in
  | 'submitted' // field report awaiting review; cylinders picked up, not yet at the lab
  | 'received' // field report issued, cylinders in the lab, the 7 d break due today
  | 'strength_review' // 7 d break entered, strength report awaiting review
  | 'strength_issued'; // 7 d and 28 d breaks, strength report issued (CS number)

interface Pour {
  castDaysAgo: number;
  ticket: string;
  truck: string;
  element: string;
  location: string;
  load: number;
  slump: number;
  air: number;
  concreteTemp: number;
  ambientTemp: number;
  stage: Stage;
  /** Max load (kN) per age on 100 x 200 mm cylinders, in specimen order. */
  breaks?: { 7?: number[]; 28?: number[] };
}

const POURS: Pour[] = [
  {
    castDaysAgo: 35,
    ticket: 'T-104511',
    truck: '12',
    element: 'Footing',
    location: 'Grid A-1 to A-4 strip footings',
    load: 8,
    slump: 90,
    air: 6.1,
    concreteTemp: 17,
    ambientTemp: 9,
    stage: 'strength_issued',
    breaks: { 7: [187.4], 28: [296.3, 301.8] },
  },
  {
    castDaysAgo: 30,
    ticket: 'T-104733',
    truck: '7',
    element: 'Wall',
    location: 'Parkade wall, grid B-2 to B-6',
    load: 7.5,
    slump: 100,
    air: 5.6,
    concreteTemp: 18,
    ambientTemp: 4,
    stage: 'strength_issued',
    // One 28 d cylinder well below the other: the 28 d average sits under 32 MPa.
    breaks: { 7: [176.9], 28: [228.1, 262.7] },
  },
  {
    castDaysAgo: 10,
    ticket: 'T-105390',
    truck: '3',
    element: 'Slab on grade',
    location: 'Level P1 slab, pour 1',
    load: 9,
    slump: 85,
    air: 6.4,
    concreteTemp: 15,
    ambientTemp: -2,
    stage: 'strength_review',
    breaks: { 7: [191.2] },
  },
  {
    castDaysAgo: 7,
    ticket: 'T-105612',
    truck: '12',
    element: 'Column',
    location: 'Columns C-3, C-4, C-5',
    load: 4,
    slump: 95,
    air: 5.9,
    concreteTemp: 16,
    ambientTemp: -5,
    stage: 'received',
  },
  {
    castDaysAgo: 2,
    ticket: 'T-105980',
    truck: '9',
    element: 'Slab on grade',
    location: 'Level P1 slab, pour 2',
    load: 9,
    // Slump and air outside the spec: exceptions for the reviewer.
    slump: 120,
    air: 8.4,
    concreteTemp: 14,
    ambientTemp: -8,
    stage: 'submitted',
  },
  {
    castDaysAgo: 0,
    ticket: 'T-106204',
    truck: '7',
    element: 'Wall',
    location: 'Stair core walls, level 1',
    load: 6,
    slump: 80,
    air: 6,
    concreteTemp: 17,
    ambientTemp: -3,
    stage: 'draft',
  },
];

function reportFields(pour: Pour, mixId: string, airMeterId: string) {
  const date = day(-pour.castDaysAgo);
  return {
    reportDate: date,
    contractorName: 'Example Builders Inc.',
    locationElements: [pour.element],
    locationDescription: pour.location,
    mixId,
    supplierName: SUPPLIER,
    mixNumber: MIX_NUMBER,
    ticketNumber: pour.ticket,
    truckNumber: pour.truck,
    plantName: 'North Plant',
    batchedAt: at(date, '0815'),
    loadVolumeM3: pour.load,
    cumulativeVolumeM3: pour.load * 3,
    projectSpec: SPEC,
    ticketSpec: SPEC,
    arrivedAt: at(date, '0840'),
    sampledAt: at(date, '0850'),
    testedAt: at(date, '0855'),
    castAt: at(date, '0910'),
    timeLimitExceeded: false,
    loadRejected: false,
    loadDecisionByName: 'Sam Example',
    loadDecisionByCompany: 'Example Builders Inc.',
    samplingLocation: 'chute',
    placementMethods: ['pump'],
    material: 'concrete',
    superplasticizerAdded: 'none',
    concreteTempC: pour.concreteTemp,
    ambientTempC: pour.ambientTemp,
    waterAdded: false,
    specimensCast: true,
    airMeterEquipmentId: airMeterId,
    resultsReportedToName: 'Sam Example',
    resultsReportedToCompany: 'Example Builders Inc.',
    readings: [
      { id: key(), test: 'slump', context: 'initial', value: pour.slump },
      { id: key(), test: 'air', context: 'initial', value: pour.air },
    ],
    attachmentRefs: [{ id: key(), kind: 'ticket_photo', fileName: `${pour.ticket}.jpg` }],
  };
}

/** The lead documents every exception on the submitted version, marks it reviewed and issues it. */
async function reviewAndIssueFieldReport(pe: DemoActor, reportId: string) {
  const path = `/concrete/field-reports/${reportId}`;
  let report = await pe.get(path);
  const versionNo = report.lifecycle.latestVersion.versionNo as number;
  const version = await pe.get(`${path}/versions/${versionNo}`);
  for (const warning of (version.snapshot?.warnings ?? []) as Json[]) {
    await pe.post(`${path}/versions/${versionNo}/exception-notes`, {
      code: warning.code,
      field: warning.field ?? null,
      note: 'Discussed with the contractor on site; noted for the record.',
    });
  }
  report = await pe.post(`${path}/review`, { idempotencyKey: key(), version: report.version });
  await pe.post(`${path}/issue`, { idempotencyKey: key(), version: report.version });
}

/** Submitted by the technician who entered the breaks; reviewed and issued by the lead. */
async function strengthReport(as: ConcreteCrew, setId: string, issue: boolean) {
  const path = `/concrete/specimen-sets/${setId}/strength-report`;
  let report = await as.lt.post(`${path}/submit`, { idempotencyKey: key(), version: 0 });
  if (!issue) return;
  report = await as.pe.post(`${path}/review`, { idempotencyKey: key(), version: report.version });
  await as.pe.post(`${path}/issue`, { idempotencyKey: key(), version: report.version });
}

async function pourOne(
  as: ConcreteCrew,
  numbers: SetNumbers,
  projectId: string,
  pour: Pour,
  mixId: string,
  airMeterId: string,
) {
  const castDate = day(-pour.castDaysAgo);
  const created = await as.at.post(`/concrete/projects/${projectId}/field-reports`, {
    idempotencyKey: key(),
    ...reportFields(pour, mixId, airMeterId),
  });
  const reportPath = `/concrete/field-reports/${created.id as string}`;
  const set = await as.at.post(`${reportPath}/specimen-sets`, {
    idempotencyKey: key(),
    specimenType: 'cylinder',
    mouldSize: '100x200',
    specimens: [7, 28, 28, CONCRETE_HOLD_AGE].map((age) => ({ id: key(), age })),
  });
  const setId = set.id as string;
  if (pour.stage === 'draft') return;

  // Numbered, and the number read back, before the report is submitted.
  await numbers.number(setId, castDate);
  const report = await as.at.get(reportPath);
  await as.at.post(`${reportPath}/submit`, { idempotencyKey: key(), version: report.version });

  const specimens = (await as.lt.get(`/concrete/specimen-sets/${setId}`)).specimens as Json[];
  if (!specimens[0]?.identity?.permanentId) throw new Error(MISMATCHED_DATABASE);
  // The lab technician collects the cylinders from site the next morning.
  const nextDay = day(-pour.castDaysAgo + 1);
  await as.lt.post(`/concrete/specimen-sets/${setId}/pickup`, {
    idempotencyKey: key(),
    specimens: specimens.map((s) => ({ id: s.id, version: null })),
    complete: true,
    collectedAt: at(nextDay, '0730'),
    curingMinC: 16,
    curingMaxC: 24,
    curingBox: 'Curing box 2',
    curingLocation: 'Site trailer',
  });
  if (pour.stage === 'submitted') return;

  await reviewAndIssueFieldReport(as.pe, created.id as string);
  for (const [i, specimen] of specimens.entries()) {
    await as.lt.post(`/concrete/specimens/${specimen.id as string}/receipt`, {
      idempotencyKey: key(),
      receivedAt: at(nextDay, '0815'),
      massG: 3650 + i * 15,
    });
  }
  if (pour.stage === 'received') return;

  for (const age of [7, 28] as const) {
    const ofAge = specimens.filter((s) => (s.age ?? s.assignedAge) === age);
    for (const [i, maxLoad] of (pour.breaks?.[age] ?? []).entries()) {
      await as.lt.send(
        'PUT',
        `/concrete/specimens/${ofAge[i]!.id as string}/test-results/${key()}`,
        {
          idempotencyKey: key(),
          version: 0,
          testedOn: day(-pour.castDaysAgo + age),
          maxLoad,
          heightReadings: [200.2],
          diameterReadings: [100.1],
        },
      );
    }
  }
  await strengthReport(as, setId, pour.stage === 'strength_issued');
}

/**
 * Seeds DEMO-2616 unless a finished run already did (its summary report is the last step). A run
 * interrupted after the first field report can't be resumed: rebuild the database. `envFile` is
 * the running API's env file, for the set-numbering stand-in (`openSql` opens it; tests pass a
 * simulated client).
 */
export async function seedConcreteDemo(
  as: ConcreteCrew,
  findProject: FindProject,
  envFile: string,
  openSql: (envFile: string) => Promise<DemoSql> = openDemoSql,
): Promise<void> {
  const existing = await findProject(CONCRETE_PROJECT);
  if (existing) {
    const id = existing.id as string;
    if (list(await as.pe.get(`/concrete/projects/${id}/summary-reports`)).length > 0) {
      log(`  ${CONCRETE_PROJECT} already has its concrete data; skipped`);
      return;
    }
    if (list(await as.pe.get(`/concrete/projects/${id}/field-reports`)).length > 0) {
      // Issued reports can't be undone, so a half-made project isn't resumed.
      throw new Error(
        `${CONCRETE_PROJECT} has concrete data from an interrupted run. To start over: ` +
          'npm run db:rebuild:dev -- --disposable <database>, then run this again.',
      );
    }
  }
  const numbers = new SetNumbers(await openSql(envFile));
  let projectId: string;
  try {
    const airMeterId = await referenceData(as);
    projectId = await ensureProject(as, findProject);
    // Before any pour: a pour made against the wrong database can't be resumed.
    await numbers.checkProject(projectId);
    const mixId = await ensureMix(as.pe, projectId);
    log(`  ${CONCRETE_PROJECT} Riverside apartments, approved mix ${MIX_NUMBER} (32 MPa)`);
    for (const pour of POURS) await pourOne(as, numbers, projectId, pour, mixId, airMeterId);
  } finally {
    await numbers.close();
  }
  log(
    '  6 field reports: 2 strength reports issued, 1 awaiting strength review, 1 with its 7 d ' +
      'break due today, 1 awaiting field review (cylinders in transit), 1 draft',
  );

  await as.pe.post(`/concrete/projects/${projectId}/summary-reports`, {
    idempotencyKey: key(),
    filters: {},
  });
  log('  project summary report issued');
}
