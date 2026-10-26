import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { renderPreviewSvg } from '../labels/preview.js';
import { LABEL_WIDTH_DOTS } from '../labels/template-v1.js';
import { ID_PER_PREFIX, STANDARD_UNIT } from '../labels/test-data.js';
import {
  createMigratedSchema,
  testDatabaseUrl,
  type TestSchema,
} from '../test-support/database.js';
import {
  insertProject,
  insertReceipt,
  insertStorageUnit,
  insertUser,
  receivingLabId,
} from '../test-support/fixtures.js';
import { lookupStorageUnit } from './storage-units.service.js';

// TRP-T16 AC1/AC2 without the handheld: decode both symbols of a rendered label (T14's real-size
// preview, the same symbol data as the ZPL) and feed each decoded text to T12's lookup, exactly
// as the DS3678-XR would type it. Fictional data only.

beforeAll(async () => {
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  const wasmBinary = (await readFile(wasmPath)).buffer;
  await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
});

/** What a scanner reads from each symbol on the label: [format, text], sorted. */
async function scanLabel(svg: string): Promise<[string, string][]> {
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
    .map((result): [string, string] => [result.format, result.text])
    .sort();
}

const HOLDERS: Record<string, { issuedHolderKind: string; unitType: string; holderKind: string }> =
  {
    BKT: { issuedHolderKind: 'bucket', unitType: 'bucket', holderKind: 'bucket' },
    ST: { issuedHolderKind: 'shelby_tube', unitType: 'shelby_tube', holderKind: 'shelby_tube' },
    CRE: { issuedHolderKind: 'core_box', unitType: 'bulk_container', holderKind: 'generic' },
    CT: { issuedHolderKind: 'generic', unitType: 'bulk_container', holderKind: 'generic' },
  };

describe.runIf(testDatabaseUrl)('scanning a printed label opens its storage unit (TRP-T16)', () => {
  let db: TestSchema;
  const unitIds: Record<string, string> = {};
  let otherProjectId: string;

  beforeAll(async () => {
    db = await createMigratedSchema();
    const userId = await insertUser(db.pool);
    const projectId = await insertProject(db.pool, 'DEMO-2601', userId);
    otherProjectId = await insertProject(db.pool, 'DEMO-2602', userId);
    const receiptId = await insertReceipt(db.pool, projectId, userId, ID_PER_PREFIX.length);
    const locationId = await receivingLabId(db.pool);
    for (const readableId of ID_PER_PREFIX) {
      unitIds[readableId] = await insertStorageUnit(
        db.pool,
        { projectId, receiptId, locationId },
        { readableId, ...HOLDERS[readableId.split('-')[0]!]! },
      );
    }
  });

  afterAll(async () => {
    await db?.drop();
  });

  it.each(ID_PER_PREFIX)('AC1 %s: Code 128 and QR both open the same unit', async (readableId) => {
    const { svg } = renderPreviewSvg({ ...STANDARD_UNIT, storageUnitId: readableId });
    const scans = await scanLabel(svg);
    expect(scans).toEqual([
      ['Code128', readableId],
      ['QRCode', readableId],
    ]);
    for (const [, text] of scans) {
      expect(await lookupStorageUnit(db.pool, text)).toEqual({
        id: unitIds[readableId],
        readableId,
      });
    }
  });

  it('AC2: a label reprinted after a correction still opens the same unit', async () => {
    const readableId = 'BKT-2026-000014';
    // A correction (D45) changes the current type, project and date, never the issued ID.
    await db.pool.query(
      `UPDATE storage_unit SET unit_type = 'bulk_container', project_id = $2,
                               received_date = '2026-10-24'
       WHERE id = $1`,
      [unitIds[readableId], otherProjectId],
    );
    const { svg } = renderPreviewSvg({
      ...STANDARD_UNIT,
      storageUnitId: readableId,
      projectNumber: 'DEMO-2602',
      projectName: 'Hillside bridge',
      receivedDate: '2026-10-24',
      testHoles: ['TH26-03'],
    });
    for (const [, text] of await scanLabel(svg)) {
      expect(await lookupStorageUnit(db.pool, text)).toEqual({
        id: unitIds[readableId],
        readableId,
      });
    }
  });

  it('AC3: unknown and malformed codes find nothing', async () => {
    for (const code of ['BKT-1999-000001', 'SU-2026-000001', 'hello', '', 'X'.repeat(200)]) {
      expect(await lookupStorageUnit(db.pool, code), code).toBeNull();
    }
  });
});
