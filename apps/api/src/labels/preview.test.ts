import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { Resvg } from '@resvg/resvg-js';
import { beforeAll, describe, expect, it } from 'vitest';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';
import { renderPreviewSvg } from './preview.js';
import { LABEL_WIDTH_DOTS, TEMPLATE_VERSION } from './template-v1.js';
import { ID_PER_PREFIX, STANDARD_UNIT, WORST_CASE_UNIT } from './test-data.js';
import { renderZpl } from './zpl.js';

beforeAll(async () => {
  // Load the reader's WebAssembly from node_modules instead of the default CDN download.
  const require = createRequire(import.meta.url);
  const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
  const wasmBinary = (await readFile(wasmPath)).buffer;
  await prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
});

/** Rasterises the preview SVG at its real size (300 dpi) and decodes every symbol on it. */
async function decodePreview(svg: string) {
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
  return results.filter((result) => result.isValid);
}

describe('renderPreviewSvg', () => {
  it('returns a real-size SVG, the template version and the same warnings as the ZPL', () => {
    const preview = renderPreviewSvg(WORST_CASE_UNIT);
    expect(preview.templateVersion).toBe(TEMPLATE_VERSION);
    expect(preview.svg).toContain('width="3.5in" height="1.5in" viewBox="0 0 1050 450"');
    expect(preview.warnings).toEqual(renderZpl(WORST_CASE_UNIT).warnings);
    expect(preview.warnings).toContain('Project name shortened to fit');
  });

  it('is deterministic', () => {
    expect(renderPreviewSvg(STANDARD_UNIT).svg).toBe(renderPreviewSvg({ ...STANDARD_UNIT }).svg);
  });

  it('escapes markup in names', () => {
    const { svg } = renderPreviewSvg({ ...STANDARD_UNIT, projectName: '<script>&"x"' });
    expect(svg).toContain('&lt;script&gt;&amp;&quot;x&quot;');
    expect(svg).not.toContain('<script>');
  });

  // T4 / AC1 / AC7: rasterise the preview and decode both symbols with ZXing.
  it.each(ID_PER_PREFIX)(
    '%s: Code 128 and QR in the preview both decode to the storage unit ID',
    async (id) => {
      const { svg } = renderPreviewSvg({ ...WORST_CASE_UNIT, storageUnitId: id });
      const decoded = await decodePreview(svg);
      expect(decoded.map((result) => [result.format, result.text]).sort()).toEqual([
        ['Code128', id],
        ['QRCode', id],
      ]);
    },
  );
});
