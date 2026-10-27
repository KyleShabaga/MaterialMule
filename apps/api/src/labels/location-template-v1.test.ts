import { describe, expect, it } from 'vitest';
import {
  LOCATION_LABEL_GEOMETRY,
  LOCATION_TEMPLATE_VERSION,
  layoutLocationLabelV1,
  renderLocationLabelPreview,
  renderLocationLabelZpl,
} from './location-template-v1.js';
import { code128Pattern, qrMatrix } from './preview.js';
import { measureText } from './text-fit.js';

// MM-T37: the location label is its own template; both symbols carry exactly LOC-<CODE>.

describe('location label template v1 (MM-T37)', () => {
  it('encodes LOC-<CODE> in both symbols and shows the name and code', () => {
    const zpl = renderLocationLabelZpl({ code: 'wh-c1', name: 'Warehouse C1' });
    expect(zpl).toContain(`^FX Material Mule ${LOCATION_TEMPLATE_VERSION}^FS`);
    expect(zpl).toContain('^FDLOC-WH-C1^FS');
    expect(zpl).toContain('^FDMA,LOC-WH-C1^FS');
    expect(zpl).toContain('^FDLOCATION^FS');
    expect(zpl).toContain('^FDWarehouse C1^FS');
    expect(zpl).toContain('^FDWH-C1^FS');
    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    const preview = renderLocationLabelPreview({ code: 'WH-C1', name: 'Warehouse C1' });
    expect(preview.payload).toBe('LOC-WH-C1');
    expect(preview.svg).toContain(`data-template-version="${LOCATION_TEMPLATE_VERSION}"`);
  });

  it('is deterministic and refuses unknown versions or invalid codes', () => {
    const input = { code: 'LAB-B1', name: 'Lab Bench 1' };
    expect(renderLocationLabelZpl(input)).toBe(renderLocationLabelZpl(input));
    expect(() => renderLocationLabelZpl(input, 'location-v0')).toThrow(RangeError);
    expect(() => renderLocationLabelZpl({ code: 'A', name: 'x' })).toThrow(RangeError);
    expect(() => renderLocationLabelZpl({ code: 'WH C1', name: 'x' })).toThrow(RangeError);
    expect(() => renderLocationLabelZpl({ code: 'WH-C1', name: '   ' })).toThrow(RangeError);
  });

  it('escapes ZPL control characters in names so nothing can inject commands', () => {
    const zpl = renderLocationLabelZpl({ code: 'WH-C1', name: 'Shelf ^XZ~JA_x' });
    expect(zpl).toContain('^FDShelf _5EXZ_7EJA_5Fx^FS');
    expect(zpl.match(/\^XZ/g)).toHaveLength(1);
  });

  it('fits the worst-case code: symbols inside their reserved space, code never shortened', () => {
    const code = 'W'.repeat(20);
    const layout = layoutLocationLabelV1({ code, name: 'Warehouse' });
    const modules = code128Pattern(layout.symbolData).reduce((sum, width) => sum + width, 0);
    expect(modules).toBeLessThanOrEqual(LOCATION_LABEL_GEOMETRY.code128.maxModules);
    expect(qrMatrix(layout.symbolData).length).toBeLessThanOrEqual(
      LOCATION_LABEL_GEOMETRY.qr.maxModules,
    );
    const { code128, qr, textColumn, width, height } = LOCATION_LABEL_GEOMETRY;
    // Code 128 with both quiet zones stays on the label.
    expect(
      code128.x + (code128.maxModules + code128.quietZoneModules) * code128.moduleWidth,
    ).toBeLessThanOrEqual(width);
    expect(code128.x - code128.quietZoneModules * code128.moduleWidth).toBeGreaterThanOrEqual(0);
    expect(code128.y + code128.barHeight).toBeLessThanOrEqual(height);
    // QR quiet zone ends above the Code 128.
    expect(qr.y + (qr.maxModules + qr.quietZoneModules) * qr.magnification).toBeLessThanOrEqual(
      code128.y,
    );
    const codeText = layout.texts.find((text) => text.text === code)!;
    expect(codeText).toBeDefined();
    for (const text of layout.texts) {
      expect(text.x + text.width, text.text).toBeLessThanOrEqual(
        textColumn.x + textColumn.maxWidth,
      );
      expect(text.y + text.height, text.text).toBeLessThanOrEqual(code128.y);
    }
    expect(measureText(code, codeText.height)).toBeLessThanOrEqual(textColumn.maxWidth);
  });

  it('wraps a long name onto two lines and warns when it still has to shorten', () => {
    const two = layoutLocationLabelV1({ code: 'WH-C1', name: 'Warehouse C1 north wall shelf' });
    expect(two.texts.map((text) => text.text)).toEqual([
      'LOCATION',
      'Warehouse C1 north wall',
      'shelf',
      'WH-C1',
    ]);
    expect(two.warnings).toEqual([]);
    const long = layoutLocationLabelV1({ code: 'WH-C1', name: 'Warehouse '.repeat(10).trim() });
    expect(long.warnings).toEqual(['Location name shortened to fit']);
    expect(long.texts).toHaveLength(4);
  });
});
