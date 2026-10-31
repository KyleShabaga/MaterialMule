import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import type { INestApplication } from '@nestjs/common';
import { Resvg } from '@resvg/resvg-js';
import { labelPreviewSchema, receiptLabelPreviewsSchema } from '@materialmule/shared';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { SESSION_COOKIE } from '../auth/session-cookie.js';
import { SessionService } from '../auth/session.service.js';
import { loadConfig } from '../config/env.js';
import { createApp } from '../create-app.js';
import {
  createMigratedSchema,
  databaseUrlForSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertSummary,
  insertTestHole,
  receivingLabId,
} from '../test-support/fixtures.js';
import { renderPreviewSvg } from './preview.js';
import { LABEL_WIDTH_DOTS, TEMPLATE_VERSION } from './template-v1.js';
import { WORST_CASE_UNIT } from './test-data.js';

/** One issued ID per prefix, with holder kinds the schema accepts for each. */
const UNITS = [
  { readableId: 'BKT-2026-000014' },
  { readableId: 'ST-2026-000003', issuedHolderKind: 'shelby_tube', unitType: 'shelby_tube' },
  {
    readableId: 'CRE-2026-000001',
    issuedHolderKind: 'core_box',
    unitType: 'bulk_container',
    holderKind: 'generic',
  },
  { readableId: 'CT-2026-000120', issuedHolderKind: 'generic', unitType: 'bulk_container' },
] as const;

async function decode(svg: string) {
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: LABEL_WIDTH_DOTS },
    font: { loadSystemFonts: false },
  })
    .render()
    .asPng();
  const results = await readBarcodes(new Uint8Array(png), {
    formats: ['Code128', 'QRCode'],
    maxNumberOfSymbols: 4,
    tryHarder: true,
  });
  return results
    .filter((result) => result.isValid)
    .map((result) => [result.format, result.text])
    .sort();
}

describe.runIf(testDatabaseUrl)('label preview API (MM-T39)', () => {
  let db: TestSchema;
  let app: INestApplication;
  const cookies: Record<string, string> = {};
  const unitIds: Record<string, string> = {};
  let receiptId: string;
  let longReceiptUnit: string;

  const http = () => request(app.getHttpServer());
  const get = (path: string, who?: string) =>
    who ? http().get(path).set('Cookie', cookies[who]!) : http().get(path);

  async function counts() {
    const { rows } = await db.pool.query<{ jobs: number; audits: number; versions: string }>(
      `SELECT (SELECT count(*)::int FROM print_job) AS jobs,
              (SELECT count(*)::int FROM audit_event) AS audits,
              (SELECT string_agg(readable_id || ':' || version || ':' || updated_at, ','
                                 ORDER BY readable_id) FROM storage_unit) AS versions`,
    );
    return rows[0];
  }

  beforeAll(async () => {
    db = await createMigratedSchema();
    const userIds: Record<string, string> = {};
    for (const [key, accountType, status] of [
      ['tech', 'personal', 'active'],
      ['lab', 'shared_lab', 'active'],
      ['pend', 'personal', 'pending'],
    ] as const) {
      const { rows } = await db.pool.query<{ id: string }>(
        `INSERT INTO app_user (display_name, official_initials, account_type, status)
         VALUES ($1, $2, $3, $4) RETURNING id`,
        [`User ${key}`, key.toUpperCase(), accountType, status],
      );
      userIds[key] = rows[0]!.id;
    }

    const locationId = await receivingLabId(db.pool);
    const projectId = await insertProject(db.pool, 'DEMO-2601', userIds.tech!);
    const holes = [
      await insertTestHole(db.pool, projectId, 'TH26-02'),
      await insertTestHole(db.pool, projectId, 'TH26-01'),
    ];
    receiptId = await insertReceipt(db.pool, projectId, userIds.tech!, UNITS.length);
    // Receipt order is receipt_line, deliberately not the readable-ID order.
    const lines = [3, 1, 4, 2];
    for (const [index, unit] of UNITS.entries()) {
      const id = await insertStorageUnit(db.pool, { projectId, receiptId, locationId }, unit);
      await db.pool.query('UPDATE storage_unit SET receipt_line = $2 WHERE id = $1', [
        id,
        lines[index],
      ]);
      for (const testHoleId of holes) {
        await insertSummary(db.pool, { storageUnitId: id, projectId, testHoleId }, { type: 'all' });
      }
      unitIds[unit.readableId] = id;
    }

    // AC6: a long project name and many holes, as in T14's worst case.
    const longProjectId = await insertProject(db.pool, 'DEMO-2602', userIds.tech!);
    await db.pool.query('UPDATE project SET name = $2 WHERE id = $1', [
      longProjectId,
      WORST_CASE_UNIT.projectName,
    ]);
    const longReceipt = await insertReceipt(db.pool, longProjectId, userIds.tech!, 1);
    longReceiptUnit = await insertStorageUnit(
      db.pool,
      { projectId: longProjectId, receiptId: longReceipt, locationId },
      { readableId: 'BKT-2026-000099' },
    );
    for (const name of WORST_CASE_UNIT.testHoles) {
      const testHoleId = await insertTestHole(db.pool, longProjectId, name);
      await insertSummary(
        db.pool,
        { storageUnitId: longReceiptUnit, projectId: longProjectId, testHoleId },
        { type: 'all' },
      );
    }

    app = await createApp(
      loadConfig({
        APP_ENV: 'test',
        DATABASE_URL: databaseUrlForSchema(db.schema),
        SESSION_SECRET: 'test-session-secret-0123456789abcdef',
        LOG_LEVEL: 'silent',
      }),
    );
    await app.init();
    const sessions = app.get(SessionService);
    for (const [key, id] of Object.entries(userIds)) {
      const accountType = key === 'lab' ? 'shared_lab' : 'personal';
      cookies[key] = `${SESSION_COOKIE}=${(await sessions.create(id, accountType)).token}`;
    }

    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    const wasmBinary = (await readFile(wasmPath)).buffer;
    await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  });

  afterAll(async () => {
    await app?.close();
    await db?.drop();
  });

  // T1 / AC1: every prefix, by readable ID (any case) and by UUID; both symbols decode to the ID.
  it.each(UNITS.map((unit) => unit.readableId))(
    '%s: returns the T14 SVG whose barcodes encode exactly the ID',
    async (readableId) => {
      const response = await get(
        `/api/storage-units/${readableId.toLowerCase()}/label/preview`,
        'tech',
      );
      expect(response.status).toBe(200);
      const preview = labelPreviewSchema.parse(response.body);
      expect(preview).toMatchObject({
        storageUnitId: unitIds[readableId],
        readableId,
        templateVersion: TEMPLATE_VERSION,
        warnings: [],
      });
      // Same layout data as the print worker: current values, holes in name order.
      expect(preview.svg).toBe(
        renderPreviewSvg({
          storageUnitId: readableId,
          projectNumber: 'DEMO-2601',
          projectName: 'Fictional project',
          receivedDate: '2026-10-23',
          testHoles: ['TH26-01', 'TH26-02'],
        }).svg,
      );
      expect(await decode(preview.svg)).toEqual([
        ['Code128', readableId],
        ['QRCode', readableId],
      ]);

      const byUuid = await get(`/api/storage-units/${unitIds[readableId]}/label/preview`, 'lab');
      expect(byUuid.status).toBe(200);
      expect(byUuid.body).toEqual(preview);
    },
  );

  it('404s unknown storage units and receipts', async () => {
    for (const path of [
      '/api/storage-units/BKT-2026-999999/label/preview',
      '/api/storage-units/00000000-0000-4000-8000-000000000000/label/preview',
      '/api/receipts/00000000-0000-4000-8000-000000000000/labels/preview',
      '/api/receipts/not-a-uuid/labels/preview',
    ]) {
      expect((await get(path, 'tech')).status, path).toBe(404);
    }
  });

  // AC4: LAB and personal accounts preview; signed out 401; pending 403.
  it('requires an active session with inventory.read', async () => {
    const path = '/api/storage-units/BKT-2026-000014/label/preview';
    expect((await get(path, 'tech')).status).toBe(200);
    expect((await get(path, 'lab')).status).toBe(200);
    expect((await get(path, 'pend')).status).toBe(403);
    const signedOut = await get(path);
    expect(signedOut.status).toBe(401);
    expect(JSON.stringify(signedOut.body)).not.toContain('svg');
    expect((await get(`/api/receipts/${receiptId}/labels/preview`)).status).toBe(401);
    expect((await get(`/api/receipts/${receiptId}/labels/preview`, 'pend')).status).toBe(403);
  });

  // AC3: one response holds every label of the receipt, in receipt order.
  it('returns all labels of a receipt in receipt order', async () => {
    const response = await get(`/api/receipts/${receiptId}/labels/preview`, 'lab');
    expect(response.status).toBe(200);
    const body = receiptLabelPreviewsSchema.parse(response.body);
    expect(body.receiptId).toBe(receiptId);
    expect(body.labels.map((label) => label.readableId)).toEqual([
      'ST-2026-000003',
      'CT-2026-000120',
      'BKT-2026-000014',
      'CRE-2026-000001',
    ]);
  });

  // MTR-48: a disposed unit's label is only ever served watermarked DISPOSED.
  it('serves a disposed unit only as a DISPOSED-watermarked, flagged preview', async () => {
    const { rows } = await db.pool.query<{
      project_id: string;
      current_location_id: string;
      receiver_user_id: string;
    }>(
      `SELECT su.project_id, su.current_location_id, r.receiver_user_id
       FROM storage_unit su JOIN receipt r ON r.id = su.receipt_id WHERE su.id = $1`,
      [unitIds['BKT-2026-000014']],
    );
    const ids = {
      projectId: rows[0]!.project_id,
      locationId: rows[0]!.current_location_id,
      receiptId: await insertReceipt(db.pool, rows[0]!.project_id, rows[0]!.receiver_user_id, 2),
    };
    const kept = await insertStorageUnit(db.pool, ids, { readableId: 'BKT-2026-000201' });
    const gone = await insertStorageUnit(db.pool, ids, { readableId: 'BKT-2026-000202' });
    await db.pool.query(
      `UPDATE storage_unit SET status = 'disposed', disposed_at = now() WHERE id = $1`,
      [gone],
    );

    const disposed = labelPreviewSchema.parse(
      (await get('/api/storage-units/BKT-2026-000202/label/preview', 'tech')).body,
    );
    expect(disposed.disposed).toBe(true);
    expect(disposed.svg).toContain('data-watermark="DISPOSED"');
    const current = labelPreviewSchema.parse(
      (await get(`/api/storage-units/${kept}/label/preview`, 'tech')).body,
    );
    expect(current.disposed).toBe(false);
    expect(current.svg).not.toContain('data-watermark');

    const receipt = receiptLabelPreviewsSchema.parse(
      (await get(`/api/receipts/${ids.receiptId}/labels/preview`, 'lab')).body,
    );
    expect(
      receipt.labels.map((label) => [
        label.readableId,
        label.disposed,
        label.svg.includes('data-watermark="DISPOSED"'),
      ]),
    ).toEqual([
      ['BKT-2026-000201', false, false],
      ['BKT-2026-000202', true, true],
    ]);
  });

  // AC6: the same fit warnings as T14.
  it('reports the same fit warnings as the T14 renderer', async () => {
    const response = await get(`/api/storage-units/${longReceiptUnit}/label/preview`, 'tech');
    const preview = labelPreviewSchema.parse(response.body);
    const expected = renderPreviewSvg({
      ...WORST_CASE_UNIT,
      storageUnitId: 'BKT-2026-000099',
      projectNumber: 'DEMO-2602',
      receivedDate: '2026-10-23',
      testHoles: [...WORST_CASE_UNIT.testHoles].sort(),
    });
    expect(preview.warnings).toEqual(expected.warnings);
    expect(preview.warnings).toContain('Project name shortened to fit');
    expect(preview.warnings.some((warning) => warning.includes('not shown'))).toBe(true);
  });

  // AC5: previewing creates no print job, changes no unit and writes no audit event.
  it('never creates a print job, an audit event or a unit change', async () => {
    const before = await counts();
    await get('/api/storage-units/BKT-2026-000014/label/preview', 'tech');
    await get(`/api/receipts/${receiptId}/labels/preview`, 'lab');
    expect(await counts()).toEqual(before);
  });
});
