import {
  assignedAirMeterSchema,
  concreteEquipmentDetailSchema,
  concreteEquipmentListSchema,
  concreteEquipmentUseSchema,
  concreteEquipmentVersionConflictResponseSchema,
} from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CSRF_HEADER } from '../auth/auth.guard.js';
import { testDatabaseUrl } from '../test-support/database.js';
import {
  createLabHarness,
  newKey,
  type LabHarness,
  type PersonKey,
} from '../test-support/lab-harness.js';
import { evaluateEquipmentUse, testingMachineSnapshot } from './concrete-equipment.service.js';

// MM-V2-C27 T2: the concrete equipment register through the API (card AC1–AC3). Real PostgreSQL.
// Fictional data only: invented people from the lab harness (Lee Manager `lm`, Alex Tester `tech`,
// Pat Example `pe`, Admin Example `admin`, the LAB station) and invented equipment IDs.
describe.runIf(testDatabaseUrl)('concrete equipment register (MM-V2-C27)', () => {
  let h: LabHarness;
  const cookies: Record<string, string> = {};
  type Caller = PersonKey | 'lab' | 'anonymous';

  const get = async (url: string, as: Caller) => {
    const req = h.http().get(url);
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req;
  };
  const send = async (method: 'post' | 'patch', url: string, body: unknown, as: Caller) => {
    const req = h.http()[method](url).set(CSRF_HEADER, '1');
    if (as !== 'anonymous') req.set('Cookie', cookies[as]!);
    return req.send(body as object);
  };

  async function counts() {
    const { rows } = await h.db.pool.query(
      `SELECT (SELECT count(*)::int FROM concrete_equipment) AS equipment,
              (SELECT coalesce(sum(version), 0)::int FROM concrete_equipment) AS versions,
              (SELECT count(*)::int FROM concrete_equipment_calibration) AS calibrations,
              (SELECT count(*)::int FROM concrete_equipment_calibration
               WHERE voided_at IS NOT NULL) AS voided,
              (SELECT count(*)::int FROM audit_event) AS audit`,
    );
    return rows[0];
  }

  const calibrationBody = (calibratedOn: string, nextDueOn: string, key = newKey()) => ({
    calibratedOn,
    nextDueOn,
    performedBy: 'Example Calibration Co.',
    result: 'Within tolerance',
    idempotencyKey: key,
  });

  let machineId: string;

  beforeAll(async () => {
    h = await createLabHarness();
    for (const key of ['tech', 'lm', 'admin', 'pe', 'js', 'lab', 'disabled'] as const) {
      cookies[key] = await h.cookie(key);
    }
  }, 60_000);

  afterAll(async () => {
    await h?.close();
  });

  it('every active session reads the register, LAB included; it starts empty', async () => {
    for (const caller of ['lab', 'tech', 'lm', 'pe', 'admin'] as const) {
      const response = await get('/api/concrete/equipment', caller);
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const list = concreteEquipmentListSchema.parse(response.body);
      expect(list.items).toEqual([]);
      expect(list.today).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(list.canManage).toEqual({
        testing_machine: caller === 'lm',
        air_meter: caller === 'lm',
      });
    }
    expect((await get('/api/concrete/equipment', 'anonymous')).status).toBe(401);
    expect((await get('/api/concrete/equipment', 'disabled')).status).toBe(401);
    expect((await get('/api/concrete/equipment/not-a-uuid', 'tech')).status).toBe(404);
  });

  it('AC3: nobody but a Lab Manager registers or edits the testing machine (403, nothing written)', async () => {
    const before = await counts();
    for (const caller of ['tech', 'admin', 'pe', 'lab'] as const) {
      for (const body of [
        { kind: 'testing_machine', make: 'Example', idempotencyKey: newKey() },
        { bogus: true },
      ]) {
        const response = await send('post', '/api/concrete/testing-machine', body, caller);
        expect(response.status, `${caller} ${JSON.stringify(response.body)}`).toBe(403);
        expect(response.body.code).toBe('forbidden');
      }
    }
    expect((await send('post', '/api/concrete/testing-machine', {}, 'anonymous')).status).toBe(401);
    expect(await counts()).toEqual(before);
  });

  it('the Lab Manager registers the one testing machine; retries replay; a second is refused', async () => {
    const key = newKey();
    const body = {
      kind: 'testing_machine',
      identifier: 'TM-TEST-1',
      make: 'Example Instruments',
      model: 'Compression 3000',
      description: 'Lab compression machine',
      idempotencyKey: key,
    };
    const first = await send('post', '/api/concrete/testing-machine', body, 'lm');
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const machine = concreteEquipmentDetailSchema.parse(first.body);
    machineId = machine.id;
    expect(machine).toMatchObject({
      kind: 'testing_machine',
      make: 'Example Instruments',
      model: 'Compression 3000',
      status: 'in_service',
      version: 1,
      currentCalibration: null,
      flagsToday: ['no_calibration_recorded'],
      canManage: true,
      calibrations: [],
      historyTotal: 1,
    });
    expect(machine.history[0]).toMatchObject({
      action: 'concrete_equipment.registered',
      changedBy: { userId: h.users.lm, name: 'Lee Manager' },
    });

    const before = await counts();
    const replay = await send('post', '/api/concrete/testing-machine', body, 'lm');
    expect(replay.status).toBe(201);
    expect(replay.body.id).toBe(machineId);
    const reused = await send(
      'post',
      '/api/concrete/testing-machine',
      { ...body, make: 'Other' },
      'lm',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    const second = await send(
      'post',
      '/api/concrete/testing-machine',
      { kind: 'testing_machine', idempotencyKey: newKey() },
      'lm',
    );
    expect(second.status).toBe(409);
    expect(second.body.code).toBe('testing_machine_exists');
    // An air meter can't come in through the machine's route.
    const wrongKind = await send(
      'post',
      '/api/concrete/testing-machine',
      { kind: 'air_meter', identifier: 'AM-X', idempotencyKey: newKey() },
      'lm',
    );
    expect(wrongKind.status).toBe(400);
    expect(await counts()).toEqual(before);
  });

  it('edits carry the version; only changed fields are audited with before and after', async () => {
    const saved = await send(
      'patch',
      `/api/concrete/testing-machine/${machineId}`,
      { version: 1, model: 'Compression 3000X', make: 'Example Instruments', reason: 'Nameplate' },
      'lm',
    );
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    const machine = concreteEquipmentDetailSchema.parse(saved.body);
    expect(machine.version).toBe(2);
    expect(machine.history[0]).toMatchObject({
      action: 'concrete_equipment.updated',
      reason: 'Nameplate',
      before: { model: 'Compression 3000' },
      after: { model: 'Compression 3000X' },
    });
    expect(Object.keys(machine.history[0]!.after)).toEqual(['model']);

    const before = await counts();
    const stale = await send(
      'patch',
      `/api/concrete/testing-machine/${machineId}`,
      { version: 1, model: 'Other' },
      'lm',
    );
    expect(stale.status).toBe(409);
    expect(concreteEquipmentVersionConflictResponseSchema.parse(stale.body).current.version).toBe(
      2,
    );
    // AC3 for edits: refused before the body, and nothing written.
    for (const caller of ['tech', 'admin', 'pe', 'lab'] as const) {
      const refused = await send(
        'patch',
        `/api/concrete/testing-machine/${machineId}`,
        { version: 2, model: 'Hacked' },
        caller,
      );
      expect(refused.status, caller).toBe(403);
    }
    // An unchanged save changes nothing.
    const same = await send(
      'patch',
      `/api/concrete/testing-machine/${machineId}`,
      { version: 2, model: 'Compression 3000X' },
      'lm',
    );
    expect(same.status).toBe(200);
    expect(same.body.version).toBe(2);
    expect(await counts()).toEqual(before);
  });

  it('AC2: a calibration update keeps every earlier entry in the history; voiding keeps the entry', async () => {
    const first = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2024-03-01', '2025-03-01'),
      'lm',
    );
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    const key = newKey();
    const second = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2025-02-25', '2099-02-25', key),
      'lm',
    );
    expect(second.status).toBe(201);
    const machine = concreteEquipmentDetailSchema.parse(second.body);
    expect(machine.calibrations.map((c) => [c.entryNumber, c.calibratedOn, c.nextDueOn])).toEqual([
      [2, '2025-02-25', '2099-02-25'],
      [1, '2024-03-01', '2025-03-01'],
    ]);
    expect(machine.currentCalibration).toMatchObject({ entryNumber: 2, nextDueOn: '2099-02-25' });
    expect(machine.flagsToday).toEqual([]);
    expect(machine.version).toBe(2);

    // A retry replays; a reused key for another entry is refused.
    const before = await counts();
    const replay = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2025-02-25', '2099-02-25', key),
      'lm',
    );
    expect(replay.status).toBe(201);
    expect(replay.body.calibrations).toHaveLength(2);
    const reused = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2025-02-26', '2099-02-25', key),
      'lm',
    );
    expect(reused.status).toBe(409);
    expect(reused.body.code).toBe('idempotency_key_reused');
    const badDates = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2025-02-25', '2025-02-25'),
      'lm',
    );
    expect(badDates.status).toBe(400);
    for (const caller of ['tech', 'admin', 'pe', 'lab'] as const) {
      const refused = await send(
        'post',
        `/api/concrete/testing-machine/${machineId}/calibrations`,
        calibrationBody('2025-03-01', '2099-03-01'),
        caller,
      );
      expect(refused.status, caller).toBe(403);
    }
    expect(await counts()).toEqual(before);

    // Void the newer entry: it stays listed, and the earlier one is in effect again.
    const newest = machine.calibrations[0]!;
    const voidPath = `/api/concrete/testing-machine/${machineId}/calibrations/${newest.id}/void`;
    expect((await send('post', voidPath, {}, 'lm')).status).toBe(400);
    expect((await send('post', voidPath, { reason: 'Wrong year' }, 'tech')).status).toBe(403);
    const voided = await send('post', voidPath, { reason: 'Wrong certificate' }, 'lm');
    expect(voided.status, JSON.stringify(voided.body)).toBe(200);
    const after = concreteEquipmentDetailSchema.parse(voided.body);
    expect(after.calibrations).toHaveLength(2);
    expect(after.calibrations[0]).toMatchObject({
      entryNumber: 2,
      voided: true,
      voidReason: 'Wrong certificate',
      voidedBy: { userId: h.users.lm },
    });
    expect(after.currentCalibration?.entryNumber).toBe(1);
    expect(after.flagsToday).toEqual(['calibration_overdue']);
    expect((await send('post', voidPath, { reason: 'Again' }, 'lm')).body.code).toBe(
      'calibration_already_voided',
    );
    expect(after.history.map((event) => event.action).slice(0, 3)).toEqual([
      'concrete_equipment.calibration_voided',
      'concrete_equipment.calibration_recorded',
      'concrete_equipment.calibration_recorded',
    ]);

    // Record the replacement entry for later tests.
    const fixed = await send(
      'post',
      `/api/concrete/testing-machine/${machineId}/calibrations`,
      calibrationBody('2025-02-25', '2099-02-24'),
      'lm',
    );
    expect(fixed.body.calibrations.map((c: { entryNumber: number }) => c.entryNumber)).toEqual([
      3, 2, 1,
    ]);
  });

  it('AC1: a past next-due date flags the use; the check never blocks or writes', async () => {
    const before = await counts();
    // Before the first certificate: nothing recorded for that date.
    const early = await get(`/api/concrete/equipment/${machineId}/use-check?on=2024-01-10`, 'lab');
    expect(early.status).toBe(200);
    expect(concreteEquipmentUseSchema.parse(early.body)).toMatchObject({
      useDate: '2024-01-10',
      calibrationId: null,
      flags: ['no_calibration_recorded'],
    });
    // Within the first certificate: no flag.
    const within = await get(
      `/api/concrete/equipment/${machineId}/use-check?on=2025-02-10`,
      'tech',
    );
    expect(within.body).toMatchObject({ nextDueOn: '2025-03-01', flags: [] });
    // The server helper the using records call (C04/C23): same answer.
    expect(await evaluateEquipmentUse(h.db.pool, machineId, '2025-02-10')).toMatchObject({
      nextDueOn: '2025-03-01',
      flags: [],
    });
    expect((await get(`/api/concrete/equipment/${machineId}/use-check?on=x`, 'tech')).status).toBe(
      400,
    );
    // For issued reports (C32): the machine and calibration as they stood on the use date.
    expect(await testingMachineSnapshot(h.db.pool, '2026-06-01')).toMatchObject({
      equipmentId: machineId,
      make: 'Example Instruments',
      model: 'Compression 3000X',
      calibratedOn: '2025-02-25',
      nextDueOn: '2099-02-24',
      use: { flags: [] },
    });
    expect(await counts()).toEqual(before);
  });

  describe('air meters', () => {
    let meterId: string;

    it('the Lab Manager registers a meter assigned to a technician; the assignee must be active staff', async () => {
      const before = await counts();
      for (const assignedUserId of [h.users.lab, h.users.disabled]) {
        const refused = await send(
          'post',
          '/api/concrete/air-meters',
          { kind: 'air_meter', identifier: 'AM-TEST-01', assignedUserId, idempotencyKey: newKey() },
          'lm',
        );
        expect(refused.status, JSON.stringify(refused.body)).toBe(422);
        expect(refused.body.code).toBe('invalid_recipient');
      }
      const noId = await send(
        'post',
        '/api/concrete/air-meters',
        { kind: 'air_meter', idempotencyKey: newKey() },
        'lm',
      );
      expect(noId.status).toBe(400);
      for (const caller of ['tech', 'admin', 'pe', 'lab'] as const) {
        const refused = await send(
          'post',
          '/api/concrete/air-meters',
          { kind: 'air_meter', identifier: 'AM-TEST-01', idempotencyKey: newKey() },
          caller,
        );
        expect(refused.status, caller).toBe(403);
      }
      expect(await counts()).toEqual(before);

      const created = await send(
        'post',
        '/api/concrete/air-meters',
        {
          kind: 'air_meter',
          identifier: 'AM-TEST-01',
          description: 'Type B pressure meter',
          assignedUserId: h.users.tech,
          idempotencyKey: newKey(),
        },
        'lm',
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      meterId = created.body.id;
      expect(created.body.assignedTo).toEqual({
        userId: h.users.tech,
        initials: 'AT',
        name: 'Alex Tester',
      });
      const duplicate = await send(
        'post',
        '/api/concrete/air-meters',
        { kind: 'air_meter', identifier: 'am-test-01', idempotencyKey: newKey() },
        'lm',
      );
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.code).toBe('equipment_identifier_exists');
    });

    it('the field-report autofill offers the technician’s meter with what using it flags', async () => {
      await send(
        'post',
        `/api/concrete/air-meters/${meterId}/calibrations`,
        calibrationBody('2026-01-05', '2026-07-05'),
        'lm',
      );
      const response = await get(
        `/api/concrete/air-meters/assigned?technicianUserId=${h.users.tech}&on=2026-08-01`,
        'lab',
      );
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      const autofill = assignedAirMeterSchema.parse(response.body);
      expect(autofill).toMatchObject({
        assignedCount: 1,
        meter: { id: meterId, identifier: 'AM-TEST-01' },
        // AC1: overdue on the day used, still offered (flags never block).
        use: { nextDueOn: '2026-07-05', flags: ['calibration_overdue'] },
      });
      const nobody = await get(
        `/api/concrete/air-meters/assigned?technicianUserId=${h.users.pe}`,
        'tech',
      );
      expect(nobody.body).toMatchObject({ assignedCount: 0, meter: null, use: null });

      // Two meters: no guess; the optional field stays for the technician.
      const second = await send(
        'post',
        '/api/concrete/air-meters',
        {
          kind: 'air_meter',
          identifier: 'AM-TEST-02',
          assignedUserId: h.users.tech,
          idempotencyKey: newKey(),
        },
        'lm',
      );
      expect(second.status).toBe(201);
      const ambiguous = await get(
        `/api/concrete/air-meters/assigned?technicianUserId=${h.users.tech}`,
        'tech',
      );
      expect(ambiguous.body).toMatchObject({ assignedCount: 2, meter: null });
      const unassigned = await send(
        'patch',
        `/api/concrete/air-meters/${second.body.id}`,
        { version: 1, assignedUserId: null },
        'lm',
      );
      expect(unassigned.status).toBe(200);
      expect(unassigned.body.history[0]).toMatchObject({
        before: { assignedTo: { userId: h.users.tech } },
        after: { assignedTo: null },
      });
    });

    it('out of service says why and flags use; retiring unassigns and is final', async () => {
      const noNote = await send(
        'patch',
        `/api/concrete/air-meters/${meterId}`,
        { version: 1, status: 'out_of_service' },
        'lm',
      );
      expect(noNote.status).toBe(400);
      const out = await send(
        'patch',
        `/api/concrete/air-meters/${meterId}`,
        { version: 1, status: 'out_of_service', statusNote: 'Needle sticks' },
        'lm',
      );
      expect(out.status, JSON.stringify(out.body)).toBe(200);
      const check = await get(`/api/concrete/equipment/${meterId}/use-check?on=2026-03-01`, 'tech');
      expect(check.body.flags).toEqual(['equipment_out_of_service']);

      const back = await send(
        'patch',
        `/api/concrete/air-meters/${meterId}`,
        { version: 2, status: 'in_service' },
        'lm',
      );
      expect(back.body).toMatchObject({ status: 'in_service', statusNote: null, version: 3 });

      const retired = await send(
        'patch',
        `/api/concrete/air-meters/${meterId}`,
        { version: 3, status: 'retired', statusNote: 'Replaced' },
        'lm',
      );
      expect(retired.status).toBe(200);
      expect(retired.body).toMatchObject({ status: 'retired', assignedTo: null });
      const again = await send(
        'patch',
        `/api/concrete/air-meters/${meterId}`,
        { version: 4, description: 'x' },
        'lm',
      );
      expect(again.status).toBe(409);
      expect(again.body.code).toBe('equipment_retired');
      const calibrate = await send(
        'post',
        `/api/concrete/air-meters/${meterId}/calibrations`,
        calibrationBody('2026-09-01', '2027-09-01'),
        'lm',
      );
      expect(calibrate.body.code).toBe('equipment_retired');
      // Retired equipment is listed only on request.
      const list = concreteEquipmentListSchema.parse(
        (await get('/api/concrete/equipment?kind=air_meter', 'tech')).body,
      );
      expect(list.items.map((item) => item.identifier)).toEqual(['AM-TEST-02']);
      const all = concreteEquipmentListSchema.parse(
        (await get('/api/concrete/equipment?kind=air_meter&includeRetired=true', 'tech')).body,
      );
      expect(all.items.map((item) => item.identifier)).toEqual(['AM-TEST-02', 'AM-TEST-01']);
    });

    it('an id of the other kind is not found through a route', async () => {
      const response = await send(
        'patch',
        `/api/concrete/air-meters/${machineId}`,
        { version: 2, description: 'x' },
        'lm',
      );
      expect(response.status).toBe(404);
      expect(response.body.code).toBe('equipment_not_found');
    });
  });

  it('a Lab Manager whose role was removed is refused at once', async () => {
    await h.db.pool.query(`DELETE FROM role_assignment WHERE user_id = $1`, [h.users.lm]);
    try {
      const refused = await send(
        'patch',
        `/api/concrete/testing-machine/${machineId}`,
        { version: 2, description: 'After role removal' },
        'lm',
      );
      expect(refused.status).toBe(403);
    } finally {
      await h.db.pool.query(
        `INSERT INTO role_assignment (user_id, role) VALUES ($1, 'lab_manager')`,
        [h.users.lm],
      );
    }
  });
});
