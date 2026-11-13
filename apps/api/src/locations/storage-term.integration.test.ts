import { randomUUID } from 'node:crypto';
import {
  inventoryPageSchema,
  labProgramReviewSchema,
  locationDetailSchema,
  locationSchema,
  sidebarRecordListSchema,
  storageUnitDetailSchema,
  type MoveRequest,
  type StorageLocation,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { listAuditForEntity } from '../audit/audit.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, line, newKey, type LabHarness } from '../test-support/lab-harness.js';

// STRATA-106: storage term on locations (set on a warehouse, inherited by bays and shelves,
// overridable on either), shelf capacity, and the unit's lifecycle step from the same facts on
// every read surface. Real PostgreSQL, fictional data only (DEMO-2601, TH26-xx).
describe.runIf(testDatabaseUrl)(
  'location storage term and unit lifecycle step (STRATA-106)',
  () => {
    let h: LabHarness;
    const loc = {} as Record<'wh' | 'bay' | 'shelf' | 'bench', StorageLocation>;

    async function create(body: Record<string, unknown>, who = 'lm'): Promise<StorageLocation> {
      const response = await h.send('post', '/api/locations', { kind: 'warehouse', ...body }, who);
      expect(response.status, JSON.stringify(response.body)).toBe(201);
      return locationSchema.parse(response.body);
    }

    async function current(id: string): Promise<StorageLocation> {
      const response = await h.get(`/api/locations/${id}`, 'tech');
      expect(response.status).toBe(200);
      return locationDetailSchema.parse(response.body).location;
    }

    async function edit(id: string, body: Record<string, unknown>, who = 'lm') {
      const { version } = await current(id);
      return h.send('patch', `/api/locations/${id}`, { version, ...body }, who);
    }

    async function editOk(id: string, body: Record<string, unknown>): Promise<StorageLocation> {
      const response = await edit(id, body);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      return locationSchema.parse(response.body);
    }

    const term = async (id: string) => (await current(id)).effectiveStorageTerm;

    async function move(unitId: string, toLocationId: string) {
      const detail = storageUnitDetailSchema.parse(
        (await h.get(`/api/storage-units/${unitId}`, 'tech')).body,
      );
      const body: MoveRequest = {
        clientMoveId: randomUUID(),
        storageUnitId: unitId,
        toLocationId,
        baseVersion: detail.version,
        scannedAt: new Date().toISOString(),
        capturedOffline: false,
        captureContext: { stationId: randomUUID(), accountId: h.users.tech },
      };
      const response = await h.send('post', '/api/moves', body, 'tech');
      expect(response.status, JSON.stringify(response.body)).toBe(201);
    }

    /** The unit as the detail page, its Inventory/search row and a sidebar recent show it. */
    async function surfaces(readableId: string) {
      const detail = storageUnitDetailSchema.parse(
        (await h.get(`/api/storage-units/${readableId}`, 'tech')).body,
      );
      const page = inventoryPageSchema.parse(
        (await h.get(`/api/inventory?search=${readableId}&status=all&pageSize=10`, 'tech')).body,
      );
      const row = page.items.find((item) => item.readableId === readableId)!;
      const recents = await h.send(
        'post',
        '/api/me/recents',
        { kind: 'storage_unit', id: detail.id },
        'tech',
      );
      expect(recents.status, JSON.stringify(recents.body)).toBe(200);
      const recent = sidebarRecordListSchema
        .parse(recents.body)
        .items.find((item) => item.id === detail.id)!;
      // One derivation: the same status, stage and step everywhere.
      expect({ recordStatus: row.recordStatus, stage: row.stage, step: row.lifecycleStep }).toEqual(
        {
          recordStatus: detail.recordStatus,
          stage: detail.stage,
          step: detail.lifecycleStep,
        },
      );
      expect(recent.stage).toBe(detail.stage);
      return detail;
    }

    beforeAll(async () => {
      h = await createLabHarness();
      loc.wh = await create({ code: 'WH-T', name: 'Warehouse T', storageTerm: 'long_term' });
      loc.bay = await create({ code: 'WH-T-B1', name: 'Warehouse T · Bay 1', parentId: loc.wh.id });
      loc.shelf = await create({
        code: 'WH-T-B1-S1',
        name: 'Warehouse T · Bay 1 · Shelf 1',
        parentId: loc.bay.id,
        capacity: 16,
      });
      loc.bench = await create({ code: 'LAB-T1', name: 'Bench T1', kind: 'lab' });
    });

    afterAll(async () => {
      await h?.close();
    });

    it('a warehouse term is inherited by its bay and shelf; responses carry the new fields', async () => {
      expect(loc.wh).toMatchObject({
        parentId: null,
        storageTerm: 'long_term',
        capacity: null,
        effectiveStorageTerm: {
          term: 'long_term',
          source: 'own',
          fromLocation: { id: loc.wh.id, code: 'WH-T', name: 'Warehouse T' },
        },
      });
      expect(loc.shelf).toMatchObject({
        parentId: loc.bay.id,
        storageTerm: null,
        capacity: 16,
        effectiveStorageTerm: {
          term: 'long_term',
          source: 'inherited',
          fromLocation: { code: 'WH-T' },
        },
      });
      expect(loc.bench.effectiveStorageTerm).toEqual({
        term: null,
        source: 'unset',
        fromLocation: null,
      });
      const list = (await h.get('/api/locations?search=WH-T', 'lab')).body as StorageLocation[];
      expect(list.find((item) => item.id === loc.bay.id)?.effectiveStorageTerm).toMatchObject({
        term: 'long_term',
        source: 'inherited',
      });
      // Audit of the creation includes the configuration.
      const [created] = await listAuditForEntity(h.db.pool, 'location', loc.shelf.id);
      expect(created).toMatchObject({
        action: 'location.created',
        after: { parentId: loc.bay.id, storageTerm: null, capacity: 16 },
      });
    });

    it('overrides on a bay and a shelf, clears them, and follows warehouse changes and reparents', async () => {
      const moves = async () =>
        (await h.db.pool.query<{ n: number }>('SELECT count(*)::int AS n FROM movement_event'))
          .rows[0]!.n;
      const movesBefore = await moves();

      await editOk(loc.bay.id, { storageTerm: 'short_term' });
      expect(await term(loc.shelf.id)).toMatchObject({
        term: 'short_term',
        source: 'inherited',
        fromLocation: { code: 'WH-T-B1' },
      });
      await editOk(loc.shelf.id, { storageTerm: 'long_term' });
      expect(await term(loc.shelf.id)).toMatchObject({ term: 'long_term', source: 'own' });

      // Clearing both overrides falls back to the warehouse.
      await editOk(loc.shelf.id, { storageTerm: null });
      await editOk(loc.bay.id, { storageTerm: null });
      expect(await term(loc.shelf.id)).toMatchObject({
        term: 'long_term',
        fromLocation: { code: 'WH-T' },
      });

      // Changing the warehouse term changes every descendant at the next read.
      await editOk(loc.wh.id, { storageTerm: 'short_term' });
      expect((await term(loc.bay.id))?.term).toBe('short_term');
      expect((await term(loc.shelf.id))?.term).toBe('short_term');

      // Reparenting the bay under another warehouse takes that warehouse's term; at the top with
      // no term anywhere it is unset.
      const other = await create({ code: 'WH-U', name: 'Warehouse U', storageTerm: 'long_term' });
      await editOk(loc.bay.id, { parentId: other.id });
      expect(await term(loc.shelf.id)).toMatchObject({
        term: 'long_term',
        fromLocation: { code: 'WH-U' },
      });
      await editOk(loc.bay.id, { parentId: null });
      expect(await term(loc.shelf.id)).toEqual({
        term: null,
        source: 'unset',
        fromLocation: null,
      });
      await editOk(loc.bay.id, { parentId: loc.wh.id });
      await editOk(loc.wh.id, { storageTerm: 'long_term' });

      // Configuration audit with before and after; a reparent never writes a physical move.
      const events = await listAuditForEntity(h.db.pool, 'location', loc.bay.id);
      expect(events.map((event) => [event.before, event.after])).toEqual(
        expect.arrayContaining([
          [{ storageTerm: null }, { storageTerm: 'short_term' }],
          [{ storageTerm: 'short_term' }, { storageTerm: null }],
          [{ parentId: loc.wh.id }, { parentId: other.id }],
          [{ parentId: other.id }, { parentId: null }],
        ]),
      );
      expect(await moves()).toBe(movesBefore);

      // Capacity can be set, changed and cleared (unknown).
      expect((await editOk(loc.shelf.id, { capacity: 12 })).capacity).toBe(12);
      expect((await editOk(loc.shelf.id, { capacity: null })).capacity).toBeNull();
      expect((await editOk(loc.shelf.id, { capacity: 16 })).capacity).toBe(16);
    });

    it('refuses invalid hierarchies with 422 and out-of-range capacity with 400', async () => {
      const refuse = async (response: Awaited<ReturnType<typeof edit>>, code: string) => {
        expect(response.status, JSON.stringify(response.body)).toBe(422);
        expect(response.body.code).toBe(code);
      };
      await refuse(await edit(loc.wh.id, { parentId: loc.shelf.id }), 'location_parent_cycle');
      await refuse(await edit(loc.wh.id, { parentId: loc.wh.id }), 'location_parent_cycle');
      const fourth = await h.send(
        'post',
        '/api/locations',
        { code: 'WH-T-X', name: 'Too deep', kind: 'warehouse', parentId: loc.shelf.id },
        'lm',
      );
      await refuse(fourth, 'location_parent_depth');
      const inBench = await h.send(
        'post',
        '/api/locations',
        { code: 'WH-T-Y', name: 'In a bench', kind: 'warehouse', parentId: loc.bench.id },
        'lm',
      );
      await refuse(inBench, 'location_parent_kind');
      await refuse(
        await edit(loc.bench.id, { storageTerm: 'long_term' }),
        'location_lab_outside_hierarchy',
      );
      const unknownParent = await h.send(
        'post',
        '/api/locations',
        { code: 'WH-T-Z', name: 'Nowhere', kind: 'warehouse', parentId: randomUUID() },
        'lm',
      );
      await refuse(unknownParent, 'location_parent_not_found');

      const retired = await create({ code: 'WH-R', name: 'Retired warehouse' });
      const retire = await h.send(
        'post',
        `/api/locations/${retired.id}/retire`,
        { reason: 'Fictional closure', version: retired.version },
        'lm',
      );
      expect(retire.status).toBe(200);
      const intoRetired = await h.send(
        'post',
        '/api/locations',
        { code: 'WH-R-B1', name: 'Bay', kind: 'warehouse', parentId: retired.id },
        'lm',
      );
      await refuse(intoRetired, 'location_parent_retired');

      // The system Receiving lab: only its name changes.
      const receiving = (await h.get('/api/locations?search=RECEIVING', 'lm'))
        .body as StorageLocation[];
      const lab = receiving.find((item) => item.isSystem)!;
      await refuse(await edit(lab.id, { storageTerm: 'short_term' }), 'system_location');

      for (const capacity of [0, 201, 2.5]) {
        expect((await edit(loc.shelf.id, { capacity })).status, String(capacity)).toBe(400);
      }
      expect((await current(loc.wh.id)).parentId).toBeNull();
    });

    it('non-managers get 403 on every configuration write and nothing changes', async () => {
      const before = await current(loc.shelf.id);
      for (const who of ['tech', 'lab', 'pe']) {
        const attempts = [
          await h.send(
            'post',
            '/api/locations',
            { code: 'WH-T-N', name: 'No', kind: 'warehouse', parentId: loc.bay.id },
            who,
          ),
          await h.send(
            'patch',
            `/api/locations/${loc.shelf.id}`,
            { storageTerm: 'short_term', capacity: 3, parentId: null, version: before.version },
            who,
          ),
        ];
        for (const response of attempts) expect(response.status, who).toBe(403);
      }
      expect(await current(loc.shelf.id)).toEqual(before);
    });

    it('concurrent saves from the same version: one wins, the other gets 409 with the current', async () => {
      const { version } = await current(loc.bay.id);
      const [a, b] = await Promise.all([
        h.send(
          'patch',
          `/api/locations/${loc.bay.id}`,
          { storageTerm: 'short_term', version },
          'lm',
        ),
        h.send('patch', `/api/locations/${loc.bay.id}`, { capacity: 40, version }, 'admin'),
      ]);
      expect([a.status, b.status].sort()).toEqual([200, 409]);
      const loser = a.status === 409 ? a : b;
      expect(loser.body).toMatchObject({
        code: 'version_conflict',
        current: { version: version + 1 },
      });
      // Put the bay back to inheriting for the unit checks below.
      const after = await current(loc.bay.id);
      await editOk(loc.bay.id, { storageTerm: null, capacity: null, version: after.version });
    });

    it('shows the same effective term and lifecycle step on unit detail, Inventory, search and the sidebar', async () => {
      // Received: still at the Receiving lab (outside the hierarchy, so the term is unset).
      const received = await h.bucket({ hole: h.holes.a1 });
      expect(await surfaces(received.readableId)).toMatchObject({
        recordStatus: 'received',
        stage: 'draft',
        lifecycleStep: 'received',
        storageTerm: { term: null, source: 'unset' },
        neverTested: true,
      });

      // Stored on the shelf: inherits Long-term from WH-T.
      const stored = await h.bucket({ hole: h.holes.a1 });
      await move(stored.id, loc.shelf.id);
      expect(await surfaces(stored.readableId)).toMatchObject({
        recordStatus: 'long_term',
        stage: 'storage',
        lifecycleStep: 'long_term',
        storageTerm: { term: 'long_term', source: 'inherited', fromLocation: { code: 'WH-T' } },
        neverTested: true,
      });
      // A shelf override moves the step with no move of the unit; clearing it moves it back.
      await editOk(loc.shelf.id, { storageTerm: 'short_term' });
      expect(await surfaces(stored.readableId)).toMatchObject({
        recordStatus: 'short_term',
        lifecycleStep: 'short_term',
        storageTerm: { term: 'short_term', source: 'own', fromLocation: { code: 'WH-T-B1-S1' } },
      });
      await editOk(loc.shelf.id, { storageTerm: null });
      expect((await surfaces(stored.readableId)).lifecycleStep).toBe('long_term');

      // In lab: at a lab location.
      const inLab = await h.bucket({ hole: h.holes.a2 });
      await move(inLab.id, loc.bench.id);
      expect(await surfaces(inLab.readableId)).toMatchObject({
        recordStatus: 'in_lab',
        stage: 'lab',
        lifecycleStep: 'in_lab',
        storageTerm: { term: null, source: 'unset' },
      });

      // Disposed: keeps its ID; the step is Disposed whatever the shelf's term.
      const disposed = await h.bucket({ hole: h.holes.a1 });
      await move(disposed.id, loc.shelf.id);
      await h.db.pool.query(`UPDATE storage_unit SET status = 'disposed' WHERE id = $1`, [
        disposed.id,
      ]);
      expect(await surfaces(disposed.readableId)).toMatchObject({
        recordStatus: 'disposed',
        stage: 'closed',
        lifecycleStep: 'disposed',
        storageTerm: { term: 'long_term' },
      });

      // Retention due on a stored unit: the sidebar shows the same Due stage as Inventory; the step
      // stays the storage step (retention never moves a step).
      const old = await h.bucket({ hole: h.holes.a1, receivedDate: '2024-01-15' });
      await move(old.id, loc.shelf.id);
      const due = await surfaces(old.readableId);
      expect(due.recordStatus).toMatch(/^retention_(due|overdue)$/);
      expect(due.lifecycleStep).toBe('long_term');
    });

    it('neverTested is false once a submitted lab program covered the unit', async () => {
      const moisture = (await h.testType('DEMO-MC-T', 'Moisture content (fictional)')).id;
      const { rows } = await h.db.pool.query<{ id: string }>(
        `INSERT INTO test_hole (project_id, name) VALUES ($1, 'TH26-41') RETURNING id`,
        [h.projects.a],
      );
      const unit = await h.bucket({ hole: rows[0]!.id });
      await move(unit.id, loc.shelf.id);
      const created = await h.send(
        'post',
        '/api/lab-programs',
        {
          projectId: h.projects.a,
          idempotencyKey: newKey(),
          lines: [line({ kind: 'test_hole', id: rows[0]!.id }, 'all', [moisture])],
        },
        'tech',
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      // A draft covers nothing yet.
      expect((await surfaces(unit.readableId)).neverTested).toBe(true);
      const review = labProgramReviewSchema.parse(
        (await h.get(`/api/lab-programs/${created.body.id}/review`, 'tech')).body,
      );
      const submitted = await h.send(
        'post',
        `/api/lab-programs/${created.body.id}/submit`,
        {
          version: created.body.version,
          idempotencyKey: newKey(),
          coverage: review.lines.map((l) => ({
            lineId: l.lineId,
            unitIds: l.coverage.map((c) => c.storageUnitId),
          })),
        },
        'tech',
      );
      expect(submitted.status, JSON.stringify(submitted.body)).toBe(200);
      expect(await surfaces(unit.readableId)).toMatchObject({
        neverTested: false,
        // Covered but still on its shelf: not in the lab yet.
        lifecycleStep: 'long_term',
      });
    });
  },
);
