import { applyTemplate, testCatalogueSchema, testTemplateSchema } from '@materialmule/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runSeed } from '../db/seed.js';
import { testDatabaseUrl } from '../test-support/database.js';
import { createLabHarness, type LabHarness } from '../test-support/lab-harness.js';

const SOILS = '00000000-0000-4000-8000-00000000c101';
const ADVANCED = '00000000-0000-4000-8000-00000000c102';
const STARTER_TEMPLATE = '00000000-0000-4000-8000-00000000c111';

// MM-T23 catalogue and templates. Fictional entries only: the owner's workbook rows are not
// seeded until they are extracted and reconciled.
describe.runIf(testDatabaseUrl)('lab test catalogue API (MM-T23)', () => {
  let h: LabHarness;

  beforeAll(async () => {
    h = await createLabHarness();
  });

  afterAll(async () => {
    await h?.close();
  });

  it('seeds only the Soils and Advanced Soils groups and the empty starter template, repeatably', async () => {
    await runSeed(h.db.pool, 'reference', 'test');
    const catalogue = testCatalogueSchema.parse((await h.get('/api/test-catalogue', 'lab')).body);
    expect(catalogue.groups.map((g) => g.name)).toEqual(['Soils', 'Advanced Soils']);
    const templates = (await h.get('/api/test-templates', 'tech')).body;
    expect(templates).toEqual([
      expect.objectContaining({
        id: STARTER_TEMPLATE,
        name: 'Geotechnical – VI + Moisture Content',
        items: [],
      }),
    ]);

    // A Lab Manager's rename survives re-seeding (no duplicate, no overwrite).
    const renamed = await h.send(
      'patch',
      `/api/test-groups/${ADVANCED}`,
      { version: 1, name: 'Advanced soils testing' },
      'lm',
    );
    expect(renamed.status, JSON.stringify(renamed.body)).toBe(200);
    await runSeed(h.db.pool, 'reference', 'test');
    const after = testCatalogueSchema.parse((await h.get('/api/test-catalogue', 'lab')).body);
    expect(after.groups.map((g) => g.name)).toEqual(['Soils', 'Advanced soils testing']);
  });

  it('keeps exact codes and full descriptions, enforces subgroup-in-group and rejects duplicate codes', async () => {
    const sub = await h.send(
      'post',
      '/api/test-subgroups',
      { groupId: SOILS, name: 'Atterberg limits' },
      'lm',
    );
    expect(sub.status).toBe(201);
    const otherSub = await h.send(
      'post',
      '/api/test-subgroups',
      { groupId: ADVANCED, name: 'Consolidation' },
      'admin',
    );
    expect(otherSub.status).toBe(201);

    const description =
      'Liquid limit, plastic limit and plasticity index of soils, multipoint method (fictional, kept in full).';
    const created = await h.send(
      'post',
      '/api/test-types',
      { groupId: SOILS, subgroupId: sub.body.id, code: '  LAB_MAT-att_01 ', description },
      'lm',
    );
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    expect(created.body).toMatchObject({
      code: 'LAB_MAT-att_01',
      name: null,
      description,
      groupName: 'Soils',
      subgroupName: 'Atterberg limits',
      active: true,
    });

    const duplicate = await h.send(
      'post',
      '/api/test-types',
      { groupId: ADVANCED, code: 'LAB_MAT-att_01', description: 'Another' },
      'lm',
    );
    expect(duplicate.status).toBe(409);
    expect(duplicate.body.code).toBe('test_code_exists');

    const mismatch = await h.send(
      'post',
      '/api/test-types',
      { groupId: SOILS, subgroupId: otherSub.body.id, code: 'DEMO-X1', description: 'x' },
      'lm',
    );
    expect(mismatch.status).toBe(422);
    expect(mismatch.body.code).toBe('subgroup_not_in_group');

    // The database enforces it too.
    await expect(
      h.db.pool.query(
        `INSERT INTO test_type (group_id, subgroup_id, code, description)
         VALUES ($1, $2, 'DEMO-X2', 'x')`,
        [SOILS, otherSub.body.id],
      ),
    ).rejects.toMatchObject({ code: '23503' });

    // Moving to another group without naming a subgroup drops the old one.
    const moved = await h.send(
      'patch',
      `/api/test-types/${created.body.id}`,
      { version: created.body.version, groupId: ADVANCED },
      'lm',
    );
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ groupName: 'Advanced soils testing', subgroupId: null });
    const stale = await h.send(
      'patch',
      `/api/test-types/${created.body.id}`,
      { version: created.body.version, name: 'Atterberg' },
      'lm',
    );
    expect(stale.status).toBe(409);
    expect(stale.body).toMatchObject({ code: 'version_conflict', current: { groupId: ADVANCED } });

    const history = await h.db.pool.query(
      `SELECT action FROM audit_event WHERE entity_id = $1 ORDER BY occurred_at, id`,
      [created.body.id],
    );
    expect(history.rows.map((r) => r.action)).toEqual(['test_type.added', 'test_type.updated']);
  });

  it('templates: no duplicates, no new retired tests, and applying one flags retired tests instead of hiding them', async () => {
    const a = await h.testType('DEMO-T1', 'First fictional test');
    const b = await h.testType('DEMO-T2', 'Second fictional test', 'Second');
    const dup = await h.send(
      'post',
      '/api/test-templates',
      { name: 'Dup', testTypeIds: [a.id, a.id] },
      'lm',
    );
    expect(dup.status).toBe(400);

    const created = await h.send(
      'post',
      '/api/test-templates',
      { name: 'Demo pair', testTypeIds: [a.id, b.id] },
      'lm',
    );
    expect(created.status).toBe(201);
    await h.send('post', `/api/test-types/${b.id}/retire`, { version: b.version }, 'lm');

    const template = testTemplateSchema.parse(
      (await h.get('/api/test-templates', 'lab')).body.find(
        (t: { id: string }) => t.id === created.body.id,
      ),
    );
    expect(applyTemplate(template)).toEqual({
      add: [a.id],
      retired: [expect.objectContaining({ code: 'DEMO-T2', displayName: 'Second', active: false })],
    });

    const c = await h.testType('DEMO-T3', 'Third fictional test');
    await h.send('post', `/api/test-types/${c.id}/retire`, { version: c.version }, 'lm');
    const addRetired = await h.send(
      'patch',
      `/api/test-templates/${template.id}`,
      { version: template.version, testTypeIds: [a.id, b.id, c.id] },
      'lm',
    );
    expect(addRetired.status).toBe(422);
    expect(addRetired.body.code).toBe('retired_tests');

    const retired = await h.send(
      'post',
      `/api/test-templates/${template.id}/retire`,
      { version: template.version },
      'lm',
    );
    expect(retired.status).toBe(200);
    expect(retired.body.active).toBe(false);
    const restored = await h.send(
      'post',
      `/api/test-templates/${template.id}/restore`,
      { version: retired.body.version },
      'lm',
    );
    expect(restored.body.active).toBe(true);
  });

  it('T5: only Lab Managers and admins change the catalogue; LAB and technicians read it', async () => {
    for (const as of ['tech', 'pe', 'lab'] as const) {
      expect((await h.get('/api/test-catalogue', as)).status).toBe(200);
      const add = await h.send(
        'post',
        '/api/test-types',
        { groupId: SOILS, code: 'NOPE', description: 'x' },
        as,
      );
      expect(add.status, as).toBe(403);
      const template = await h.send(
        'post',
        '/api/test-templates',
        { name: 'Nope', testTypeIds: [] },
        as,
      );
      expect(template.status, as).toBe(403);
    }
    const { rows } = await h.db.pool.query(`SELECT 1 FROM test_type WHERE code = 'NOPE'`);
    expect(rows).toHaveLength(0);
  });

  it('MISC-04: admins and Lab Managers manage tests and templates; LAB and technicians are refused', async () => {
    for (const as of ['admin', 'lm'] as const) {
      const code = `MISC04-${as.toUpperCase()}`;
      const add = await h.send(
        'post',
        '/api/test-types',
        { groupId: SOILS, code, description: 'Fictional MISC-04 test' },
        as,
      );
      expect(add.status, as).toBe(201);
      const template = await h.send(
        'post',
        '/api/test-templates',
        { name: `MISC-04 ${as}`, testTypeIds: [add.body.id] },
        as,
      );
      expect(template.status, as).toBe(201);
    }
    const { body: templates } = await h.get('/api/test-templates', 'tech');
    const target = (templates as { id: string; name: string; version: number }[]).find(
      (t) => t.name === 'MISC-04 admin',
    )!;
    for (const as of ['tech', 'lab'] as const) {
      const rename = await h.send(
        'patch',
        `/api/test-templates/${target.id}`,
        { version: target.version, name: 'Renamed' },
        as,
      );
      expect(rename.status, as).toBe(403);
      const retire = await h.send(
        'post',
        `/api/test-templates/${target.id}/retire`,
        { version: target.version },
        as,
      );
      expect(retire.status, as).toBe(403);
    }
  });
});
