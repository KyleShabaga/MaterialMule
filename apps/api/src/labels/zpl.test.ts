import { describe, expect, it } from 'vitest';
import { measureText } from './text-fit.js';
import {
  CODE128,
  LABEL_HEIGHT_DOTS,
  LABEL_WIDTH_DOTS,
  layoutStickerV1,
  QR,
  TEMPLATE_VERSION,
  TEST_HOLE_MAX_LINES,
  TEXT_LIMITS,
  type StickerInput,
} from './template-v1.js';
import { ID_PER_PREFIX, STANDARD_UNIT, WORST_CASE_UNIT } from './test-data.js';
import { escapeZplText, renderZpl } from './zpl.js';

/** The data of every ^FD…^FS field, in order. */
function fieldData(zpl: string): string[] {
  return [...zpl.matchAll(/\^FD(.*?)\^FS/g)].map((match) => match[1]!);
}

/** Decodes ^FH_ hex escapes back to the text the printer shows. */
function unescapeHex(value: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === '_') {
      bytes.push(parseInt(value.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      bytes.push(value.charCodeAt(i));
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

describe('renderZpl (T1 snapshot, determinism)', () => {
  it('matches the stored snapshot for a standard unit', () => {
    const result = renderZpl(STANDARD_UNIT);
    expect(result.templateVersion).toBe(TEMPLATE_VERSION);
    expect(result.warnings).toEqual([]);
    expect(result.zpl).toMatchSnapshot();
  });

  it('is byte-identical for the same input and template version', () => {
    expect(renderZpl({ ...STANDARD_UNIT }).zpl).toBe(
      renderZpl(STANDARD_UNIT, TEMPLATE_VERSION).zpl,
    );
  });

  it('rejects an unknown template version', () => {
    expect(() => renderZpl(STANDARD_UNIT, 'sticker-v0')).toThrow(/Unknown sticker template/);
  });

  it('sets the 3.5 × 1.5 in label size at 300 dpi', () => {
    const { zpl } = renderZpl(STANDARD_UNIT);
    expect(zpl).toContain(`^PW${LABEL_WIDTH_DOTS}`);
    expect(zpl).toContain(`^LL${LABEL_HEIGHT_DOTS}`);
    expect(LABEL_WIDTH_DOTS).toBe(1050);
    expect(LABEL_HEIGHT_DOTS).toBe(450);
  });
});

describe('symbols carry exactly the storage unit ID (AC1, AC7)', () => {
  it.each(ID_PER_PREFIX)('%s: readable text, Code 128 and QR all use the issued ID', (id) => {
    const { zpl } = renderZpl({ ...STANDARD_UNIT, storageUnitId: id });
    expect(zpl).toContain(`^BCN,${CODE128.barHeight},N,N,N,A^FD${id}^FS`);
    expect(zpl).toContain(`^FDMA,${id}^FS`);
    expect(fieldData(zpl)).toContain(id);
    expect(zpl).not.toMatch(/\bSU-/);
  });

  it.each([
    'SU-2026-000001',
    'bkt-2026-000014',
    'BKT-2026-14',
    'https://example.test/u/BKT-2026-000014',
    'BKT-2026-000014^XZ',
  ])('refuses %s as a storage unit ID', (storageUnitId) => {
    expect(() => renderZpl({ ...STANDARD_UNIT, storageUnitId })).toThrow();
  });

  it.each(['2026-13-01', '2026-02-30', '26-10-2026', '2026/10/26'])(
    'refuses received date %s',
    (receivedDate) => {
      expect(() => renderZpl({ ...STANDARD_UNIT, receivedDate })).toThrow();
    },
  );
});

describe('escaping (T2, AC3)', () => {
  it('hex-escapes ^, ~ and the hex indicator', () => {
    expect(escapeZplText('A^B~C_D')).toBe('A_5EB_7EC_5FD');
  });

  it('hex-escapes non-ASCII and control characters as UTF-8 bytes', () => {
    expect(escapeZplText('Café')).toBe('Caf_C3_A9');
    expect(escapeZplText('a\u0000b')).toBe('a_00b');
  });

  it('keeps a hostile project name inside its field and prints it literally', () => {
    const projectName = 'X^XZ^XA^FDp^FS~JA_^';
    const { zpl } = renderZpl({ ...STANDARD_UNIT, projectName });

    expect(zpl.match(/\^XA/g)).toHaveLength(1);
    expect(zpl.match(/\^XZ/g)).toHaveLength(1);
    expect(zpl).not.toContain('~');
    expect(zpl.startsWith('^XA\n')).toBe(true);
    expect(zpl.endsWith('^XZ\n')).toBe(true);
    // Every field's data is free of command characters, and the name decodes back exactly.
    for (const data of fieldData(zpl)) expect(data).not.toMatch(/[\^~]/);
    expect(fieldData(zpl).map(unescapeHex)).toContain(projectName);
  });

  it('turns newlines in names into spaces rather than breaking the command stream', () => {
    const { zpl } = renderZpl({ ...STANDARD_UNIT, projectName: 'Line one\r\nLine two' });
    expect(fieldData(zpl)).toContain('Line one Line two');
    expect(zpl.split('\n').every((line) => line === '' || line.startsWith('^'))).toBe(true);
  });
});

describe('text fit (T3, AC2)', () => {
  it('uses a 120-character project name for the worst case', () => {
    expect(WORST_CASE_UNIT.projectName).toHaveLength(120);
  });

  it('shortens a 120-character project name with an ellipsis and warns', () => {
    const { warnings, zpl } = renderZpl({
      ...STANDARD_UNIT,
      projectName: WORST_CASE_UNIT.projectName,
    });
    expect(warnings).toEqual(['Project name shortened to fit']);
    const name = fieldData(zpl).find((data) => data.startsWith('Demonstration'));
    expect(name).toMatch(/\.\.\.$/);
  });

  it('wraps six long test-hole names to the line limit with "+N more" and warns', () => {
    const layout = layoutStickerV1({ ...STANDARD_UNIT, testHoles: WORST_CASE_UNIT.testHoles });
    const holeLines = layout.texts.filter((text) => /BH26|TP26|more$/.test(text.text));
    expect(holeLines).toHaveLength(TEST_HOLE_MAX_LINES);
    const more = holeLines.at(-1)!.text.match(/\+(\d+) more$/);
    expect(more).not.toBeNull();
    const hidden = Number(more![1]);
    expect(layout.warnings).toEqual([
      `${hidden} test ${hidden === 1 ? 'hole' : 'holes'} not shown; the sticker says "+${hidden} more"`,
    ]);
  });

  it('lists six short test-hole names in full without a warning', () => {
    const testHoles = ['TH26-01', 'TH26-02', 'TH26-03', 'TH26-04', 'TH26-05', 'TH26-06'];
    const layout = layoutStickerV1({ ...STANDARD_UNIT, testHoles });
    expect(layout.warnings).toEqual([]);
    expect(layout.texts.map((text) => text.text).join(', ')).toContain(testHoles.join(', '));
  });

  it('warns about a project number too long for its line', () => {
    const { warnings } = renderZpl({ ...STANDARD_UNIT, projectNumber: 'DEMO-'.repeat(30) });
    expect(warnings).toContain('Project number shortened to fit');
  });
});

describe('layout geometry (AC2: nothing overlaps the quiet zones)', () => {
  type Box = { x0: number; y0: number; x1: number; y1: number };
  const overlaps = (a: Box, b: Box) => a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;

  const code128Zone: Box = {
    x0: CODE128.x - CODE128.quietZoneModules * CODE128.moduleWidth,
    y0: CODE128.y,
    x1: CODE128.x + (CODE128.maxModules + CODE128.quietZoneModules) * CODE128.moduleWidth,
    y1: CODE128.y + CODE128.barHeight,
  };
  const qrQuiet = QR.quietZoneModules * QR.magnification;
  const qrZone: Box = {
    x0: QR.x - qrQuiet,
    y0: QR.y - qrQuiet,
    x1: QR.x + QR.maxModules * QR.magnification + qrQuiet,
    y1: QR.y + QR.maxModules * QR.magnification + qrQuiet,
  };

  it('keeps both symbols and their quiet zones on the label', () => {
    for (const zone of [code128Zone, qrZone]) {
      expect(zone.x0).toBeGreaterThanOrEqual(0);
      expect(zone.y0).toBeGreaterThanOrEqual(0);
      expect(zone.x1).toBeLessThanOrEqual(LABEL_WIDTH_DOTS);
      expect(zone.y1).toBeLessThanOrEqual(LABEL_HEIGHT_DOTS);
    }
    expect(overlaps(code128Zone, qrZone)).toBe(false);
  });

  it.each<[string, StickerInput]>([
    ['standard', STANDARD_UNIT],
    ['worst case', WORST_CASE_UNIT],
    ['wide characters', { ...WORST_CASE_UNIT, projectNumber: 'W'.repeat(80) }],
  ])('%s: no text box crosses a quiet zone or the label edge', (_name, input) => {
    const layout = layoutStickerV1(input);
    expect(layout.texts.length).toBeGreaterThan(0);
    for (const text of layout.texts) {
      const box = { x0: text.x, y0: text.y, x1: text.x + text.width, y1: text.y + text.height };
      expect(text.width).toBe(measureText(text.text, text.height));
      expect(overlaps(box, code128Zone), text.text).toBe(false);
      expect(overlaps(box, qrZone), text.text).toBe(false);
      expect(box.x1).toBeLessThanOrEqual(LABEL_WIDTH_DOTS);
      expect(box.y1).toBeLessThanOrEqual(LABEL_HEIGHT_DOTS);
      const limit =
        text.x === TEXT_LIMITS.dateBlock.x ? TEXT_LIMITS.dateBlock : TEXT_LIMITS.textColumn;
      expect(text.width, text.text).toBeLessThanOrEqual(limit.maxWidth);
    }
    for (let i = 0; i < layout.texts.length; i++) {
      for (let j = i + 1; j < layout.texts.length; j++) {
        const [a, b] = [layout.texts[i]!, layout.texts[j]!];
        const boxA = { x0: a.x, y0: a.y, x1: a.x + a.width, y1: a.y + a.height };
        const boxB = { x0: b.x, y0: b.y, x1: b.x + b.width, y1: b.y + b.height };
        expect(overlaps(boxA, boxB), `${a.text} / ${b.text}`).toBe(false);
      }
    }
  });
});

describe('confirmed sticker fields only (AC4, AC5)', () => {
  it('ignores summaries, notes, location and URLs passed alongside the sticker fields', () => {
    const withExtras = {
      ...STANDARD_UNIT,
      sampleSummary: 'SAMPLE# 1-12 DEPTH 0.5-6.0 m',
      notes: 'Fragile, keep cold',
      location: 'Shelf A3',
      url: 'https://materialmule.test/units/BKT-2026-000014',
    } as StickerInput;
    const { zpl } = renderZpl(withExtras);
    expect(zpl).toBe(renderZpl(STANDARD_UNIT).zpl);
    expect(zpl).not.toMatch(/SAMPLE|DEPTH|Fragile|Shelf|http/i);
  });

  it('prints only the six confirmed text values', () => {
    const texts = layoutStickerV1(STANDARD_UNIT).texts.map((text) => text.text);
    expect(texts).toEqual([
      'BKT-2026-000014',
      'DEMO-2601',
      'Demo Subdivision Phase 2',
      'TH26-01, TH26-02',
      'RECEIVED',
      '2026-10-26',
    ]);
  });

  it('shows a corrected received date with the same storage unit ID on reprint', () => {
    const corrected = renderZpl({ ...STANDARD_UNIT, receivedDate: '2026-10-24' });
    expect(fieldData(corrected.zpl)).toContain('2026-10-24');
    expect(fieldData(corrected.zpl)).not.toContain('2026-10-26');
    expect(corrected.zpl).toContain('^FDMA,BKT-2026-000014^FS');
  });
});
