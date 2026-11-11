import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CONCRETE_PROJECT,
  DEMO_HEADER,
  seedConcreteDemo,
  type ConcreteCrew,
  type DemoActor,
  type DemoSql,
} from './concrete-demo.js';

type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any

/** The rows the set-numbering stand-in touches, in one simulated database. */
interface FakeDatabase {
  projects: Set<string>;
  sets: Map<
    string,
    { projectId: string; permanentNumber: number | null; permanentId: string | null }
  >;
}

const newDatabase = (): FakeDatabase => ({ projects: new Set(), sets: new Map() });

/** A simulated SQL client for the queries `seedConcreteDemo` sends. */
function fakeSql(db: FakeDatabase): DemoSql {
  return {
    query: <R extends Json>(text: string, values: unknown[] = []) => {
      const [id, yy] = values as string[];
      const sql = text.trim();
      let rows: Json[] = [];
      let rowCount = 0;
      if (sql.startsWith('SELECT id FROM project')) {
        rows = db.projects.has(id!) ? [{ id }] : [];
      } else if (sql.startsWith('UPDATE concrete_specimen_set')) {
        const set = db.sets.get(id!);
        if (set && set.permanentNumber === null) {
          const next =
            Math.max(
              0,
              ...[...db.sets.values()]
                .filter((s) => s.projectId === set.projectId)
                .map((s) => s.permanentNumber ?? 0),
            ) + 1;
          set.permanentNumber = next;
          set.permanentId = `${yy}-${String(next).padStart(2, '0')}`;
          rowCount = 1;
        }
      } else if (sql.startsWith('SELECT permanent_id FROM concrete_specimen_set')) {
        const set = db.sets.get(id!);
        rows = set ? [{ permanent_id: set.permanentId }] : [];
      } else {
        throw new Error(`unexpected SQL ${sql.slice(0, 40)}`);
      }
      return Promise.resolve({ rows: rows as R[], rowCount: rowCount || rows.length });
    },
    end: () => Promise.resolve(),
  };
}

interface Calibration {
  id: string;
  entryNumber: number;
  calibratedOn: string;
  nextDueOn: string;
  voided: boolean;
}

/**
 * A simulated API for the routes `seedConcreteDemo` uses, on one `FakeDatabase`. Every request
 * is recorded in `calls` ("METHOD path"); `stopAfter(call)` lets the next matching request
 * succeed on the server and then fail, as an interrupted run would.
 */
class FakeConcreteApi {
  readonly db = newDatabase();
  readonly calls: { call: string; body: Json }[] = [];
  header: Json = {
    companyName: 'Material Mule Testing Laboratory',
    address: null,
    phone: null,
    version: 1,
  };
  readonly equipment: Json[] = [];
  readonly calibrations = new Map<string, Calibration[]>();
  readonly projects = new Map<string, Json>();
  readonly mixes: Json[] = [];
  readonly fieldReports: Json[] = [];
  readonly summaryReports: Json[] = [];
  private stopOn: string | null = null;

  stopAfter(call: string) {
    this.stopOn = call;
  }

  addEquipment(kind: string, identifier: string, calibrations: Omit<Calibration, 'id'>[] = []) {
    const id = randomUUID();
    this.equipment.push({ id, kind, identifier });
    this.calibrations.set(
      id,
      calibrations.map((c) => ({ ...c, id: randomUUID() })),
    );
    return id;
  }

  addMix(projectId: string, supplierName: string, mixNumber: string, approved: boolean) {
    const mix = {
      id: randomUUID(),
      projectId,
      supplierName,
      mixNumber,
      status: approved ? 'approved' : 'unapproved',
      draftRevision: approved ? null : { id: randomUUID() },
      version: 1,
    };
    this.mixes.push(mix);
    return mix;
  }

  /** Creates the project as an earlier run would have. */
  addProject() {
    const id = randomUUID();
    this.projects.set(CONCRETE_PROJECT, { id, projectNumber: CONCRETE_PROJECT });
    this.db.projects.add(id);
    return id;
  }

  count = (call: string | RegExp) =>
    this.calls.filter((c) => (typeof call === 'string' ? c.call === call : call.test(c.call)))
      .length;

  findProject = (number: string) => Promise.resolve(this.projects.get(number));

  crew(): ConcreteCrew {
    const actor = (key: string): DemoActor => ({
      key,
      get: (path) => this.handle('GET', path),
      post: (path, body) => this.handle('POST', path, body ?? {}),
      send: (method, path, body) => this.handle(method, path, body ?? {}),
    });
    return {
      admin: actor('admin'),
      lab: actor('lab'),
      pe: actor('pe'),
      at: actor('at'),
      'js-tech': actor('js-tech'),
      lt: actor('lt'),
    };
  }

  private handle(method: string, path: string, body: Json = {}): Promise<Json> {
    const call = `${method} ${path.split('?')[0]!.replace(/[0-9a-f-]{36}/g, ':id')}`;
    this.calls.push({ call, body });
    const result = this.route(method, path.split('?')[0]!, body);
    if (this.stopOn === call) {
      this.stopOn = null;
      return Promise.reject(new Error('interrupted'));
    }
    return Promise.resolve(result);
  }

  private route(method: string, path: string, body: Json): Json {
    const id = randomUUID();
    const parts = path.split('/');
    const match = (call: string) => call === this.calls.at(-1)!.call;

    if (match('GET /concrete/report-header')) return this.header;
    if (match('PUT /concrete/report-header')) {
      if (body.version !== this.header.version) throw new Error('409 header version');
      this.header = { ...this.header, ...body, version: this.header.version + 1 };
      return this.header;
    }
    if (match('GET /concrete/suppliers')) return { items: [] };
    if (match('GET /concrete/holidays')) return { items: [] };
    if (match('GET /concrete/equipment')) return { items: this.equipment };
    if (match('GET /concrete/equipment/:id')) {
      return { calibrations: this.calibrations.get(parts[3]!) ?? [] };
    }
    if (match('POST /concrete/air-meters') || match('POST /concrete/testing-machine')) {
      return { id: this.addEquipment(body.kind, body.identifier) };
    }
    if (
      match('POST /concrete/air-meters/:id/calibrations') ||
      match('POST /concrete/testing-machine/:id/calibrations')
    ) {
      const list = this.calibrations.get(parts[3]!)!;
      list.push({
        id,
        entryNumber: list.length + 1,
        calibratedOn: body.calibratedOn,
        nextDueOn: body.nextDueOn,
        voided: false,
      });
      return { id };
    }
    if (match('POST /projects')) {
      this.projects.set(body.projectNumber, { id, projectNumber: body.projectNumber });
      this.db.projects.add(id);
      return { id };
    }
    if (match('GET /projects/:id/lead-nominations')) return { pending: null };
    if (match('GET /projects/:id/team-members')) return { active: [] };
    if (match('GET /projects/:id/concrete-mixes')) {
      return { items: this.mixes.filter((m) => m.projectId === parts[2]) };
    }
    if (match('POST /projects/:id/concrete-mixes')) {
      return this.addMix(parts[2]!, body.spec.supplierName, body.spec.mixNumber, false);
    }
    if (match('GET /concrete-mixes/:id')) return this.mixes.find((m) => m.id === parts[2])!;
    if (match('POST /concrete-mixes/:id/approve')) {
      const mix = this.mixes.find((m) => m.id === parts[2])!;
      if (mix.version !== body.version || mix.draftRevision?.id !== body.revisionId) {
        throw new Error('409 mix');
      }
      Object.assign(mix, { status: 'approved', draftRevision: null, version: mix.version + 1 });
      return mix;
    }
    if (match('GET /concrete/projects/:id/summary-reports')) {
      return { items: this.summaryReports.filter((r) => r.projectId === parts[3]) };
    }
    if (match('POST /concrete/projects/:id/summary-reports')) {
      this.summaryReports.push({ id, projectId: parts[3] });
      return { id };
    }
    if (match('GET /concrete/projects/:id/field-reports')) {
      return { items: this.fieldReports.filter((r) => r.projectId === parts[3]) };
    }
    if (match('POST /concrete/projects/:id/field-reports')) {
      this.fieldReports.push({ id, projectId: parts[3], mixId: body.mixId });
      return { id, version: 1 };
    }
    if (match('POST /concrete/field-reports/:id/specimen-sets')) {
      const report = this.fieldReports.find((r) => r.id === parts[3])!;
      this.db.sets.set(id, {
        projectId: report.projectId,
        permanentNumber: null,
        permanentId: null,
      });
      return { id };
    }
    if (match('GET /concrete/field-reports/:id')) {
      return { id: parts[3], version: 1, lifecycle: { latestVersion: { versionNo: 1 } } };
    }
    if (match('GET /concrete/field-reports/:id/versions/1')) return { snapshot: { warnings: [] } };
    if (match('GET /concrete/specimen-sets/:id')) {
      const permanentId = this.db.sets.get(parts[3]!)?.permanentId ?? null;
      return {
        specimens: [7, 28, 28, 'hold'].map((age) => ({
          id: randomUUID(),
          age,
          identity: { permanentId },
        })),
      };
    }
    if (method === 'POST' || method === 'PUT') return { id, version: 1 };
    throw new Error(`unexpected ${method} ${path}`);
  }
}

const FIELD_REPORT = 'POST /concrete/projects/:id/field-reports';
const CALIBRATIONS = /^POST \/concrete\/(air-meters|testing-machine)\/:id\/calibrations$/;

let api: FakeConcreteApi;
const seed = (db: FakeDatabase = api.db) =>
  seedConcreteDemo(api.crew(), api.findProject, 'unused.env', () => Promise.resolve(fakeSql(db)));

beforeEach(() => {
  api = new FakeConcreteApi();
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
});
afterEach(() => vi.restoreAllMocks());

describe('demo seed: concrete project DEMO-2616', () => {
  it('seeds every pour and the summary report on an empty database', async () => {
    await seed();
    expect(api.count(FIELD_REPORT)).toBe(6);
    expect(api.count('POST /concrete/projects/:id/summary-reports')).toBe(1);
    expect([...api.db.sets.values()].filter((s) => s.permanentId)).toHaveLength(5);
  });

  describe('equipment calibration on a resumed run', () => {
    it('calibrates demo devices that exist without a calibration, before any pour', async () => {
      api.addEquipment('air_meter', 'AM-07');
      api.addEquipment('testing_machine', 'CM-1');
      await seed();
      expect(api.count('POST /concrete/air-meters')).toBe(0);
      expect(api.count('POST /concrete/testing-machine')).toBe(0);
      const order = api.calls.map((c) => c.call);
      expect(order.filter((c) => CALIBRATIONS.test(c))).toHaveLength(2);
      expect(order.findLastIndex((c) => CALIBRATIONS.test(c))).toBeLessThan(
        order.indexOf(FIELD_REPORT),
      );
    });

    for (const create of ['POST /concrete/air-meters', 'POST /concrete/testing-machine']) {
      it(`finishes after a run stopped right after ${create}`, async () => {
        api.stopAfter(create);
        await expect(seed()).rejects.toThrow('interrupted');
        await seed();
        expect(api.equipment).toHaveLength(2);
        for (const device of api.equipment) {
          expect(api.calibrations.get(device.id as string)).toHaveLength(1);
        }
      });
    }

    it('keeps an existing calibration that covers the demo dates', async () => {
      const covering = {
        entryNumber: 1,
        calibratedOn: '2000-01-01',
        nextDueOn: '2999-12-31',
        voided: false,
      };
      api.addEquipment('air_meter', 'AM-07', [covering]);
      api.addEquipment('testing_machine', 'CM-9', [covering]);
      await seed();
      expect(api.count(CALIBRATIONS)).toBe(0);
      expect(api.equipment).toHaveLength(2);
    });
  });

  describe('report header', () => {
    it('fills in the untouched default header', async () => {
      await seed();
      expect(api.header).toMatchObject({ ...DEMO_HEADER, version: 2 });
    });

    it('leaves a customized header alone', async () => {
      const custom = {
        companyName: 'Sample Labs Inc.',
        address: '1 Example Road',
        phone: '555-0199',
        version: 5,
      };
      api.header = { ...custom };
      await seed();
      expect(api.count('PUT /concrete/report-header')).toBe(0);
      expect(api.header).toEqual(custom);
    });

    it('leaves a header that was edited back to the default name alone', async () => {
      api.header = { ...api.header, version: 3 };
      await seed();
      expect(api.count('PUT /concrete/report-header')).toBe(0);
    });
  });

  describe('demo mix', () => {
    it('approves the demo draft a run stopped after creating, before any pour', async () => {
      api.stopAfter('POST /projects/:id/concrete-mixes');
      await expect(seed()).rejects.toThrow('interrupted');
      expect(api.mixes[0]).toMatchObject({ status: 'unapproved' });

      await seed();
      expect(api.mixes).toHaveLength(1);
      expect(api.mixes[0]).toMatchObject({ status: 'approved' });
      const order = api.calls.map((c) => c.call);
      expect(order.lastIndexOf('POST /concrete-mixes/:id/approve')).toBeLessThan(
        order.indexOf(FIELD_REPORT),
      );
      expect(api.calls.filter((c) => c.call === FIELD_REPORT).map((c) => c.body.mixId)).toEqual(
        Array(6).fill(api.mixes[0]!.id),
      );
    });

    it('ignores similarly named mixes and uses its exact supplier and mix number', async () => {
      const projectId = api.addProject();
      api.addMix(projectId, 'Other Concrete Co', 'ER-32-20', true);
      api.addMix(projectId, 'Example Ready-Mix', 'ER-32-200', true);
      await seed();
      const own = api.mixes.find(
        (m) => m.supplierName === 'Example Ready-Mix' && m.mixNumber === 'ER-32-20',
      )!;
      expect(own).toMatchObject({ status: 'approved' });
      expect(
        new Set(api.calls.filter((c) => c.call === FIELD_REPORT).map((c) => c.body.mixId)),
      ).toEqual(new Set([own.id]));
    });
  });

  describe('mismatched database', () => {
    it('creates no pour when the SQL connection is another database, and a corrected rerun succeeds', async () => {
      await expect(seed(newDatabase())).rejects.toThrow(/different database/);
      expect(api.count(FIELD_REPORT)).toBe(0);
      expect(api.count(/submit$/)).toBe(0);

      await seed();
      expect(api.count(FIELD_REPORT)).toBe(6);
      expect(api.count('POST /concrete/projects/:id/summary-reports')).toBe(1);
    });

    it('refuses to submit a field report whose set the SQL connection could not number', async () => {
      // Same project row, but the sets live elsewhere: numbering finds nothing.
      const other = newDatabase();
      other.projects = api.db.projects;
      await expect(seed(other)).rejects.toThrow(/different database/);
      expect(api.count(FIELD_REPORT)).toBe(1);
      expect(api.count('POST /concrete/field-reports/:id/submit')).toBe(0);
    });
  });
});
