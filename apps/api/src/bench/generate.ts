import type { PoolClient } from 'pg';
import { SeededRandom } from './random.js';

/**
 * Fictional benchmark dataset (MM-T19). Sizes come from the owner-approved projection
 * (2026-10-25): ten years of about 20,000 storage units, 5,000 projects, 15,000 test holes,
 * 30,000 SAMPLE#/DEPTH summaries, 250,000 audit events and 25,000 print jobs; the stress case has
 * 5x the units and audit events (summaries follow the units, at 1.5 per unit).
 *
 * Everything is derived from the seed and the as-of date, so the same command produces the same
 * rows, IDs and UUIDs on any machine. Names, clients and people are invented.
 */
export interface BenchProfile {
  name: string;
  years: number;
  units: number;
  projects: number;
  testHoles: number;
  /** Average SAMPLE#/DEPTH summaries per unit (each unit has 1 or 2). */
  summariesPerUnit: number;
  auditEvents: number;
  printJobs: number;
  staff: number;
}

export const BENCH_PROFILES: Readonly<Record<string, BenchProfile>> = {
  'ten-year': {
    name: 'ten-year',
    years: 10,
    units: 20_000,
    projects: 5_000,
    testHoles: 15_000,
    summariesPerUnit: 1.5,
    auditEvents: 250_000,
    printJobs: 25_000,
    staff: 60,
  },
  stress: {
    name: 'stress',
    years: 10,
    units: 100_000,
    projects: 5_000,
    testHoles: 15_000,
    summariesPerUnit: 1.5,
    auditEvents: 1_250_000,
    printJobs: 25_000,
    staff: 60,
  },
  /** Small enough for an integration test. */
  tiny: {
    name: 'tiny',
    years: 3,
    units: 300,
    projects: 40,
    testHoles: 120,
    summariesPerUnit: 1.5,
    auditEvents: 2_000,
    printJobs: 100,
    staff: 12,
  },
};

/** Fixed so a later run reproduces the same rows: the date the targets were approved. */
export const DEFAULT_AS_OF = '2026-10-25';

export interface GenerateOptions {
  profile: BenchProfile;
  seed: number;
  /** Last business date in the dataset (YYYY-MM-DD). Fixed by default so runs are comparable. */
  asOf: string;
  log?: (message: string) => void;
}

export interface GeneratedCounts {
  staff: number;
  locations: number;
  projects: number;
  testHoles: number;
  receipts: number;
  units: number;
  summaries: number;
  printJobs: number;
  auditEvents: number;
}

const BATCH_ROWS = 5_000;
const LAB_ACCOUNT_ID = '00000000-0000-4000-8000-000000000001';

// Invented vocabulary. None of these is a real client, project or person.
export const PLACES = [
  'Aspen',
  'Birch',
  'Cedar',
  'Willow',
  'Riverbank',
  'Prairie',
  'Ridge',
  'Lakeview',
  'Coulee',
  'Spruce',
  'Poplar',
  'Tamarack',
  'Meadow',
  'Badger',
  'Heron',
  'Fox',
  'Granite',
  'Sandstone',
  'Pine',
  'Elm',
  'Juniper',
  'Larch',
  'Maple',
  'Clover',
] as const;
const FEATURES = [
  'Creek',
  'Hill',
  'Crossing',
  'Park',
  'Heights',
  'Flats',
  'Bend',
  'Point',
  'Valley',
  'Landing',
] as const;
const WORK = [
  'geotechnical investigation',
  'pavement evaluation',
  'slope stability review',
  'foundation investigation',
  'materials testing',
  'bridge borehole program',
  'pipeline crossing study',
  'subdivision grading',
  'culvert replacement',
  'reservoir berm',
] as const;
const CLIENT_WORDS = [
  'Example',
  'Sample',
  'Demo',
  'Placeholder',
  'Fictional',
  'Testbed',
  'Mock',
  'Specimen',
] as const;
const CLIENT_KINDS = [
  'Developments Ltd',
  'Municipal District',
  'Homes Inc',
  'Engineering Corp',
  'Utilities',
  'County',
  'Pipelines Ltd',
  'Builders',
] as const;
const GIVEN = [
  'Avery',
  'Blake',
  'Casey',
  'Devon',
  'Emery',
  'Finley',
  'Harper',
  'Jordan',
  'Kai',
  'Logan',
  'Morgan',
  'Noel',
  'Parker',
  'Quinn',
  'Reese',
  'Sage',
  'Taylor',
  'Rowan',
  'Skyler',
  'Ellis',
] as const;
const SURNAMES = [
  'Example',
  'Sample',
  'Tester',
  'Demo',
  'Placeholder',
  'Mockford',
  'Fixture',
  'Stub',
  'Dummy',
  'Specimen',
  'Trial',
  'Pilot',
] as const;
const UNIT_NOTES = [
  'Lid cracked',
  'Double-bagged',
  'Wax sealed',
  'Heavy - two-person lift',
  'Label faded',
  'Frozen on arrival',
  'Leaking - bagged',
  'Split spoon samples',
] as const;
const CUSTOM_SUMMARIES = [
  'Bags 1-4 only',
  'Bulk bag, west side',
  'Grab samples',
  'Cuttings',
] as const;
const HOLE_PREFIXES = ['TH', 'BH', 'TP', 'MW'] as const;

type Holder = 'bucket' | 'shelby_tube' | 'generic';
const PREFIX: Record<Holder, string> = { bucket: 'BKT', shelby_tube: 'ST', generic: 'CT' };
const UNIT_TYPE: Record<Holder, string> = {
  bucket: 'bucket',
  shelby_tube: 'shelby_tube',
  generic: 'bulk_container',
};

interface Staff {
  id: string;
  name: string;
  initials: string;
  position: 'technician' | 'engineer' | 'project_engineer' | 'lab_manager';
}
interface Location {
  id: string;
  kind: string;
}
interface Project {
  id: string;
  number: string;
  year: number;
  holes: string[];
}
interface Receipt {
  id: string;
  projectId: string;
  receivedDate: string;
  confirmedAt: string;
  receiver: Staff;
  accountUserId: string;
  units: Unit[];
}
interface Unit {
  id: string;
  readableId: string;
  holder: Holder;
  projectId: string;
  receiptId: string;
  receiptLine: number;
  receivedDate: string;
  confirmedAt: string;
  status: string;
  locationId: string;
  note: string | null;
}

/** Column name and PostgreSQL array type for an unnest()-based batch insert. */
type Column = [name: string, type: string];

/** Inserts rows in batches with one `INSERT … SELECT FROM unnest(…)` per batch. */
async function insertRows(
  client: PoolClient,
  table: string,
  columns: Column[],
  rows: unknown[][],
): Promise<void> {
  for (let start = 0; start < rows.length; start += BATCH_ROWS) {
    const batch = rows.slice(start, start + BATCH_ROWS);
    const arrays = columns.map((_, index) => batch.map((row) => row[index] ?? null));
    const names = columns.map(([name]) => name).join(', ');
    const unnest = columns.map(([, type], index) => `$${index + 1}::${type}[]`).join(', ');
    await client.query(`INSERT INTO ${table} (${names}) SELECT * FROM unnest(${unnest})`, arrays);
  }
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return isoDate(d);
}

function daysBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${to}T00:00:00Z`).getTime() - new Date(`${from}T00:00:00Z`).getTime()) / 86_400_000,
  );
}

/** A local business-hours timestamp on `date` in America/Edmonton (UTC-7/-6; -6 is close enough). */
function businessTimestamp(date: string, random: SeededRandom): string {
  const hour = random.int(8, 16);
  const minute = random.int(0, 59);
  return `${date}T${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}:00-06:00`;
}

/**
 * Generates the dataset into the caller's (migrated, reference-seeded) schema, inside the caller's
 * transaction. The search-document triggers are switched off during the bulk load and the
 * documents rebuilt once at the end, which is equivalent and much faster.
 */
export async function generateBenchData(
  client: PoolClient,
  options: GenerateOptions,
): Promise<GeneratedCounts> {
  const { profile, seed, asOf } = options;
  const log = options.log ?? (() => undefined);
  // Separate streams per table, so a change to one generator never reshuffles the others.
  const stream = (offset: number) => new SeededRandom(seed + offset * 7919);
  const endYear = Number(asOf.slice(0, 4));
  const startYear = endYear - profile.years + 1;

  // --- Staff -----------------------------------------------------------------------------------
  const staffRandom = stream(1);
  const staff: Staff[] = [];
  for (let i = 0; i < profile.staff; i++) {
    const given = staffRandom.pick(GIVEN);
    const surname = staffRandom.pick(SURNAMES);
    const position = (['technician', 'technician', 'engineer', 'project_engineer'] as const)[
      i % 4
    ]!;
    staff.push({
      id: staffRandom.uuid(),
      name: `${given} ${surname} ${String(i + 1).padStart(2, '0')}`,
      initials: `${given[0]}${surname[0]}`,
      position,
    });
  }
  await insertRows(
    client,
    'app_user',
    [
      ['id', 'uuid'],
      ['display_name', 'text'],
      ['official_initials', 'text'],
      ['position', 'text'],
      ['account_type', 'text'],
      ['status', 'text'],
    ],
    staff.map((s) => [s.id, s.name, s.initials, s.position, 'personal', 'active']),
  );
  const pmPool = staff.filter((s) => s.position === 'project_engineer');
  const receivers = staff.filter((s) => s.position === 'technician');

  // --- Locations -------------------------------------------------------------------------------
  const locationRandom = stream(2);
  const { rows: receivingRows } = await client.query<{ id: string }>(
    `SELECT id FROM location WHERE code_normalized = 'RECEIVING'`,
  );
  const receiving: Location = { id: receivingRows[0]!.id, kind: 'receiving_lab' };
  const newLocations: [string, string, string, string][] = [];
  const addLocations = (prefix: string, label: string, kind: string, count: number) => {
    for (let i = 1; i <= count; i++) {
      const code = `B${prefix}-${String(i).padStart(2, '0')}`;
      newLocations.push([locationRandom.uuid(), code, `${label} ${i}`, kind]);
    }
  };
  addLocations('LAB', 'Bench lab shelf', 'lab', 10);
  addLocations('STG', 'Bench staging bay', 'staging', 5);
  addLocations('WH', 'Bench warehouse rack', 'warehouse', 24);
  await insertRows(
    client,
    'location',
    [
      ['id', 'uuid'],
      ['code', 'text'],
      ['name', 'text'],
      ['kind', 'text'],
    ],
    newLocations,
  );
  const byKind = (kind: string): Location[] =>
    newLocations.filter((l) => l[3] === kind).map((l) => ({ id: l[0], kind }));
  const labs = byKind('lab');
  const staging = byKind('staging');
  const warehouse = byKind('warehouse');

  // --- Projects and test holes -----------------------------------------------------------------
  const projectRandom = stream(3);
  const projects: Project[] = [];
  const projectRows: unknown[][] = [];
  const holeRows: unknown[][] = [];
  const perYear = new Map<number, number>();
  const holesPerProject = profile.testHoles / profile.projects;
  for (let i = 0; i < profile.projects; i++) {
    const year = startYear + Math.floor((i * profile.years) / profile.projects);
    const sequence = (perYear.get(year) ?? 0) + 1;
    perYear.set(year, sequence);
    const yy = String(year % 100).padStart(2, '0');
    const number = `B${yy}-${String(sequence).padStart(4, '0')}`;
    const id = projectRandom.uuid();
    const name = `${projectRandom.pick(PLACES)} ${projectRandom.pick(FEATURES)} ${projectRandom.pick(WORK)}`;
    const client_ = `${projectRandom.pick(CLIENT_WORDS)} ${projectRandom.pick(PLACES)} ${projectRandom.pick(CLIENT_KINDS)}`;
    const holeCount = Math.max(1, Math.round(holesPerProject + projectRandom.int(-2, 2)));
    const holePrefix = projectRandom.pick(HOLE_PREFIXES);
    const holes: string[] = [];
    for (let h = 1; h <= holeCount; h++) {
      const holeId = projectRandom.uuid();
      holes.push(holeId);
      holeRows.push([holeId, id, `${holePrefix}${yy}-${String(h).padStart(2, '0')}`]);
    }
    projects.push({ id, number, year, holes });
    projectRows.push([
      id,
      number,
      name,
      client_,
      projectRandom.pick(pmPool).id,
      `${year}-01-15T09:00:00-07:00`,
    ]);
  }
  await insertRows(
    client,
    'project',
    [
      ['id', 'uuid'],
      ['project_number', 'text'],
      ['name', 'text'],
      ['client', 'text'],
      ['lead_project_engineer_user_id', 'uuid'],
      ['created_at', 'timestamptz'],
    ],
    projectRows,
  );
  await insertRows(
    client,
    'test_hole',
    [
      ['id', 'uuid'],
      ['project_id', 'uuid'],
      ['name', 'text'],
    ],
    holeRows,
  );
  log(`projects ${projects.length}, test holes ${holeRows.length}`);
  const projectsByYear = new Map<number, Project[]>();
  for (const project of projects) {
    const list = projectsByYear.get(project.year) ?? [];
    list.push(project);
    projectsByYear.set(project.year, list);
  }

  // --- Receipts and storage units --------------------------------------------------------------
  const unitRandom = stream(4);
  // Continue after any IDs already issued (the dev fixtures hold a few 2024 IDs).
  const { rows: issued } = await client.query<{ prefix: string; year: number; last: number }>(
    `SELECT id_prefix AS prefix, issued_year AS year,
            max(substring(readable_id from '[0-9]{6}$')::int) AS last
     FROM storage_unit GROUP BY 1, 2`,
  );
  const counters = new Map<string, number>(issued.map((r) => [`${r.prefix}-${r.year}`, r.last]));
  const receipts: Receipt[] = [];
  const units: Unit[] = [];
  const unitsPerYear = Math.floor(profile.units / profile.years);
  for (let year = startYear; year <= endYear; year++) {
    const target = year === endYear ? profile.units - units.length : unitsPerYear;
    const lastDay = year === endYear ? asOf : `${year}-12-31`;
    const span = daysBetween(`${year}-01-01`, lastDay);
    const candidates = [
      ...(projectsByYear.get(year) ?? []),
      ...(projectsByYear.get(year - 1) ?? []),
    ];
    const yearReceipts: Receipt[] = [];
    let made = 0;
    while (made < target) {
      const quantity = Math.min(unitRandom.int(1, 4), target - made);
      const receivedDate = addDays(`${year}-01-01`, unitRandom.int(0, span));
      const receiver = unitRandom.pick(receivers);
      const receipt: Receipt = {
        id: unitRandom.uuid(),
        projectId: unitRandom.pick(candidates).id,
        receivedDate,
        confirmedAt: businessTimestamp(receivedDate, unitRandom),
        receiver,
        accountUserId: unitRandom.chance(0.4) ? LAB_ACCOUNT_ID : receiver.id,
        units: [],
      };
      yearReceipts.push(receipt);
      made += quantity;
      for (let line = 1; line <= quantity; line++) {
        const roll = unitRandom.next();
        const holder: Holder = roll < 0.7 ? 'bucket' : roll < 0.9 ? 'shelby_tube' : 'generic';
        receipt.units.push({
          id: unitRandom.uuid(),
          readableId: '',
          holder,
          projectId: receipt.projectId,
          receiptId: receipt.id,
          receiptLine: line,
          receivedDate,
          confirmedAt: receipt.confirmedAt,
          status: 'in_stock',
          locationId: receiving.id,
          note: unitRandom.chance(0.15) ? unitRandom.pick(UNIT_NOTES) : null,
        });
      }
    }
    // IDs are issued in confirmation order, as the live counter would have issued them.
    yearReceipts.sort((a, b) => a.confirmedAt.localeCompare(b.confirmedAt));
    for (const receipt of yearReceipts) {
      for (const unit of receipt.units) {
        const key = `${PREFIX[unit.holder]}-${year}`;
        const next = (counters.get(key) ?? 0) + 1;
        counters.set(key, next);
        unit.readableId = `${key}-${String(next).padStart(6, '0')}`;
        const age = daysBetween(unit.receivedDate, asOf);
        if (age < 120) {
          unit.locationId = unitRandom.chance(0.5) ? receiving.id : unitRandom.pick(labs).id;
        } else if (age < 730) {
          const roll = unitRandom.next();
          unit.status =
            roll < 0.85 ? 'in_stock' : roll < 0.95 ? 'approved_for_disposal' : 'disposed';
          unit.locationId = unitRandom.pick([...labs, ...staging, ...warehouse]).id;
        } else {
          const roll = unitRandom.next();
          unit.status =
            roll < 0.3 ? 'in_stock' : roll < 0.35 ? 'approved_for_disposal' : 'disposed';
          unit.locationId = unitRandom.pick(warehouse).id;
        }
        units.push(unit);
      }
      receipts.push(receipt);
    }
  }

  await insertRows(
    client,
    'receipt',
    [
      ['id', 'uuid'],
      ['project_id', 'uuid'],
      ['received_date', 'date'],
      ['receiver_user_id', 'uuid'],
      ['receiver_initials_snapshot', 'text'],
      ['receiver_name_snapshot', 'text'],
      ['account_user_id', 'uuid'],
      ['quantity', 'int'],
      ['idempotency_key', 'uuid'],
      ['request_hash', 'text'],
      ['confirmed_at', 'timestamptz'],
    ],
    receipts.map((r) => [
      r.id,
      r.projectId,
      r.receivedDate,
      r.receiver.id,
      r.receiver.initials,
      r.receiver.name,
      r.accountUserId,
      r.units.length,
      unitRandom.uuid(),
      'bench-seed',
      r.confirmedAt,
    ]),
  );

  await client.query('ALTER TABLE storage_unit DISABLE TRIGGER storage_unit_search_unit');
  await client.query(
    'ALTER TABLE storage_unit_hole_summary DISABLE TRIGGER storage_unit_search_summary',
  );
  await insertRows(
    client,
    'storage_unit',
    [
      ['id', 'uuid'],
      ['readable_id', 'text'],
      ['id_prefix', 'text'],
      ['issued_year', 'int'],
      ['issued_holder_kind', 'text'],
      ['receipt_id', 'uuid'],
      ['project_id', 'uuid'],
      ['unit_type', 'text'],
      ['holder_kind', 'text'],
      ['note', 'text'],
      ['current_location_id', 'uuid'],
      ['status', 'text'],
      ['received_date', 'date'],
      ['receipt_line', 'int'],
      ['created_at', 'timestamptz'],
    ],
    units.map((u) => [
      u.id,
      u.readableId,
      PREFIX[u.holder],
      Number(u.readableId.split('-')[1]),
      u.holder,
      u.receiptId,
      u.projectId,
      UNIT_TYPE[u.holder],
      u.holder,
      u.note,
      u.locationId,
      u.status,
      u.receivedDate,
      u.receiptLine,
      u.confirmedAt,
    ]),
  );
  await insertRows(
    client,
    'storage_unit_annual_counter',
    [
      ['prefix', 'text'],
      ['year', 'int'],
      ['last_value', 'int'],
    ],
    [...counters].map(([key, last]) => [key.split('-')[0], Number(key.split('-')[1]), last]),
  );
  log(`receipts ${receipts.length}, storage units ${units.length}`);

  // --- SAMPLE#/DEPTH summaries -----------------------------------------------------------------
  const summaryRandom = stream(5);
  const holesOf = new Map(projects.map((p) => [p.id, p.holes]));
  const summaryRows: unknown[][] = [];
  // Only units of projects with two or more holes can have a second summary; scale for that.
  const multiHoleShare =
    units.filter((u) => holesOf.get(u.projectId)!.length > 1).length / units.length;
  const secondChance = Math.min(1, (profile.summariesPerUnit - 1) / multiHoleShare);
  for (const unit of units) {
    const holes = holesOf.get(unit.projectId)!;
    const first = summaryRandom.int(0, holes.length - 1);
    const chosen = [holes[first]!];
    if (holes.length > 1 && summaryRandom.chance(secondChance)) {
      chosen.push(holes[(first + 1) % holes.length]!);
    }
    for (const holeId of chosen) {
      const roll = summaryRandom.next();
      const note = summaryRandom.chance(0.05) ? 'Partial recovery' : null;
      const base = [summaryRandom.uuid(), unit.id, unit.projectId, holeId];
      if (roll < 0.5) {
        const from = summaryRandom.int(1, 20);
        const to = from + summaryRandom.int(0, 12);
        const kind = summaryRandom.pick(['G', 'S', 'SS', 'ST']);
        summaryRows.push([
          ...base,
          'sample_range',
          `${kind}${from}`,
          `${kind}${to}`,
          null,
          null,
          null,
          null,
          note,
        ]);
      } else if (roll < 0.8) {
        const from = summaryRandom.int(0, 40) / 2;
        const to = from + summaryRandom.int(1, 10) / 2;
        const depthUnit = summaryRandom.chance(0.6) ? 'm' : 'ft';
        summaryRows.push([...base, 'depth_range', null, null, from, to, depthUnit, null, note]);
      } else if (roll < 0.95) {
        summaryRows.push([...base, 'all', null, null, null, null, null, null, note]);
      } else {
        summaryRows.push([
          ...base,
          'custom',
          null,
          null,
          null,
          null,
          null,
          summaryRandom.pick(CUSTOM_SUMMARIES),
          note,
        ]);
      }
    }
  }
  await insertRows(
    client,
    'storage_unit_hole_summary',
    [
      ['id', 'uuid'],
      ['storage_unit_id', 'uuid'],
      ['project_id', 'uuid'],
      ['test_hole_id', 'uuid'],
      ['summary_type', 'text'],
      ['sample_from', 'text'],
      ['sample_to', 'text'],
      ['depth_from', 'numeric'],
      ['depth_to', 'numeric'],
      ['depth_unit', 'text'],
      ['custom_text', 'text'],
      ['note', 'text'],
    ],
    summaryRows,
  );
  log(`summaries ${summaryRows.length}`);

  // Rebuild every search document once, then put the triggers back (same transaction).
  await client.query('SELECT refresh_storage_unit_search(ARRAY(SELECT id FROM storage_unit))');
  await client.query('ALTER TABLE storage_unit ENABLE TRIGGER storage_unit_search_unit');
  await client.query(
    'ALTER TABLE storage_unit_hole_summary ENABLE TRIGGER storage_unit_search_summary',
  );

  // --- Print jobs ------------------------------------------------------------------------------
  // A disabled printer with an invented host: the print worker never sends anything.
  await client.query(
    `INSERT INTO printer (key, name, host, port, enabled, is_default, check_status)
     VALUES ('bench-receiving', 'Bench printer (never used)', 'printer.example.test', 9100,
             false, false, false)`,
  );
  const printRandom = stream(6);
  const jobRows: unknown[][] = [];
  const itemRows: unknown[][] = [];
  const printAudit: unknown[][] = [];
  for (let i = 0; i < profile.printJobs; i++) {
    const receipt = printRandom.pick(receipts);
    const id = printRandom.uuid();
    const createdAt = new Date(
      new Date(receipt.confirmedAt).getTime() + printRandom.int(1, 600) * 60_000,
    ).toISOString();
    const roll = printRandom.next();
    const status = roll < 0.92 ? 'sent' : roll < 0.97 ? 'failed' : 'uncertain';
    const confirmed = status !== 'failed' && printRandom.chance(0.6);
    jobRows.push([
      id,
      i % 7 === 0 ? 'reprint' : 'initial',
      'bench-receiving',
      'zpl-v1',
      receipt.accountUserId,
      receipt.accountUserId === LAB_ACCOUNT_ID ? null : receipt.receiver.initials,
      receipt.accountUserId === LAB_ACCOUNT_ID ? 'LAB' : receipt.receiver.name,
      receipt.receiver.id,
      receipt.receiver.initials,
      receipt.receiver.name,
      status,
      status === 'failed' ? 3 : 1,
      status === 'failed' ? 'Connection refused' : null,
      status === 'sent' ? createdAt : null,
      confirmed ? createdAt : null,
      confirmed ? receipt.receiver.id : null,
      confirmed ? receipt.receiver.initials : null,
      confirmed ? receipt.receiver.name : null,
      createdAt,
      createdAt,
    ]);
    receipt.units.forEach((unit, index) => itemRows.push([id, unit.id, index + 1]));
    printAudit.push([
      printRandom.uuid(),
      createdAt,
      i % 7 === 0 ? 'label.reprint_requested' : 'label.print_requested',
      'print_job',
      id,
      receipt.accountUserId,
      receipt.accountUserId === LAB_ACCOUNT_ID ? 'shared_lab' : 'personal',
      receipt.accountUserId === LAB_ACCOUNT_ID ? null : receipt.receiver.initials,
      receipt.accountUserId === LAB_ACCOUNT_ID ? 'LAB' : receipt.receiver.name,
      receipt.receiver.id,
      receipt.receiver.initials,
      receipt.receiver.name,
      null,
      null,
      JSON.stringify({ printerKey: 'bench-receiving', unitCount: receipt.units.length }),
    ]);
  }
  await insertRows(
    client,
    'print_job',
    [
      ['id', 'uuid'],
      ['kind', 'text'],
      ['printer_key', 'text'],
      ['template_version', 'text'],
      ['requested_by_user_id', 'uuid'],
      ['requested_by_initials_snapshot', 'text'],
      ['requested_by_name_snapshot', 'text'],
      ['receiver_user_id', 'uuid'],
      ['receiver_initials_snapshot', 'text'],
      ['receiver_name_snapshot', 'text'],
      ['status', 'text'],
      ['attempts', 'int'],
      ['last_error', 'text'],
      ['sent_at', 'timestamptz'],
      ['physically_confirmed_at', 'timestamptz'],
      ['physically_confirmed_by_user_id', 'uuid'],
      ['confirmed_by_initials_snapshot', 'text'],
      ['confirmed_by_name_snapshot', 'text'],
      ['created_at', 'timestamptz'],
      ['updated_at', 'timestamptz'],
    ],
    jobRows,
  );
  await insertRows(
    client,
    'print_job_item',
    [
      ['print_job_id', 'uuid'],
      ['storage_unit_id', 'uuid'],
      ['position', 'int'],
    ],
    itemRows,
  );
  log(`print jobs ${jobRows.length}`);

  // --- Audit events ----------------------------------------------------------------------------
  const auditRandom = stream(7);
  const auditColumns: Column[] = [
    ['id', 'uuid'],
    ['occurred_at', 'timestamptz'],
    ['action', 'text'],
    ['entity_type', 'text'],
    ['entity_id', 'uuid'],
    ['actor_user_id', 'uuid'],
    ['actor_account_type', 'text'],
    ['actor_initials_snapshot', 'text'],
    ['actor_name_snapshot', 'text'],
    ['receiver_user_id', 'uuid'],
    ['receiver_initials_snapshot', 'text'],
    ['receiver_name_snapshot', 'text'],
    ['reason', 'text'],
    ['before_values', 'jsonb'],
    ['after_values', 'jsonb'],
  ];
  let auditCount = 0;
  let pending: unknown[][] = [];
  const flush = async (force = false) => {
    if (pending.length >= BATCH_ROWS * 4 || (force && pending.length > 0)) {
      await insertRows(client, 'audit_event', auditColumns, pending);
      auditCount += pending.length;
      pending = [];
    }
  };
  const actorOf = (receipt: Receipt) =>
    receipt.accountUserId === LAB_ACCOUNT_ID
      ? [LAB_ACCOUNT_ID, 'shared_lab', null, 'LAB']
      : [receipt.receiver.id, 'personal', receipt.receiver.initials, receipt.receiver.name];

  for (const receipt of receipts) {
    pending.push([
      auditRandom.uuid(),
      receipt.confirmedAt,
      'receipt.confirmed',
      'receipt',
      receipt.id,
      ...actorOf(receipt),
      receipt.receiver.id,
      receipt.receiver.initials,
      receipt.receiver.name,
      null,
      null,
      JSON.stringify({
        receivedDate: receipt.receivedDate,
        unitCount: receipt.units.length,
        readableIds: receipt.units.map((u) => u.readableId),
      }),
    ]);
    for (const unit of receipt.units) {
      pending.push([
        auditRandom.uuid(),
        receipt.confirmedAt,
        'storage_unit.created',
        'storage_unit',
        unit.id,
        ...actorOf(receipt),
        receipt.receiver.id,
        receipt.receiver.initials,
        receipt.receiver.name,
        null,
        null,
        JSON.stringify({ readableId: unit.readableId, receiptId: receipt.id }),
      ]);
    }
    await flush();
  }
  for (const row of printAudit) {
    pending.push(row);
    await flush();
  }
  // About one unit in twenty was corrected later (D45-D47).
  for (const unit of units) {
    if (!auditRandom.chance(0.05)) continue;
    const corrector = auditRandom.pick(staff);
    pending.push([
      auditRandom.uuid(),
      addDays(unit.receivedDate, auditRandom.int(1, 30)) + 'T12:00:00-06:00',
      'storage_unit.corrected',
      'storage_unit',
      unit.id,
      corrector.id,
      'personal',
      corrector.initials,
      corrector.name,
      null,
      null,
      null,
      'Bench: note corrected',
      JSON.stringify({ note: unit.note }),
      JSON.stringify({ note: 'Corrected note' }),
    ]);
    await flush();
  }
  // The rest are sign-ins, by far the most common event over ten years.
  const already = auditCount + pending.length;
  const signIns = Math.max(0, profile.auditEvents - already);
  const totalDays = daysBetween(`${startYear}-01-01`, asOf);
  for (let i = 0; i < signIns; i++) {
    const person = auditRandom.pick(staff);
    const date = addDays(`${startYear}-01-01`, auditRandom.int(0, totalDays));
    pending.push([
      auditRandom.uuid(),
      businessTimestamp(date, auditRandom),
      'auth.sign_in',
      'session',
      auditRandom.uuid(),
      person.id,
      'personal',
      person.initials,
      person.name,
      null,
      null,
      null,
      null,
      null,
      JSON.stringify({ provider: 'microsoft' }),
    ]);
    await flush();
  }
  await flush(true);
  log(`audit events ${auditCount}`);

  return {
    staff: staff.length,
    locations: newLocations.length,
    projects: projects.length,
    testHoles: holeRows.length,
    receipts: receipts.length,
    units: units.length,
    summaries: summaryRows.length,
    printJobs: jobRows.length,
    auditEvents: auditCount,
  };
}
