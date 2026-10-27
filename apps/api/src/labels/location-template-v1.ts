import {
  LOCATION_CODE_PATTERN,
  locationPayload,
  normalizeLocationCode,
} from '@materialmule/shared';
import { svgForLayout } from './preview.js';
import {
  DOTS_PER_INCH,
  cleanText,
  field,
  type LabelLayout,
  type TextField,
} from './template-v1.js';
import { measureText, truncateToWidth } from './text-fit.js';
import { zplForLayout } from './zpl.js';

/**
 * Location label, template v1 (MM-T37): same ZD621 300 dpi 3.5 × 1.5 in stock as the
 * storage-unit sticker, but a separate layout so the two can't be confused.
 *
 *   ┌────────────────────────────────────────────┬──────────────┐
 *   │ LOCATION                                   │  ▄▄▄▄▄▄▄▄▄▄  │
 *   │ Warehouse C1                               │  █  QR    █  │
 *   │ (second line if the name needs it)         │  █        █  │
 *   │ WH-C1                                      │  ▀▀▀▀▀▀▀▀▀▀  │
 *   │ ║│║║│║│║║│║║│║║│║ Code 128 ║│║║│║║│║║│║║│║║│║               │
 *   └───────────────────────────────────────────────────────────┘
 *
 * Fields: the word LOCATION, the readable name and code, and Code 128 + QR that both carry
 * exactly `LOC-<CODE>` (owner approval 2026-10-25). Never a URL, never storage-unit data.
 */
export const LOCATION_TEMPLATE_VERSION = 'location-v1';

const WIDTH = 1050;
const HEIGHT = 450;
const MARGIN = 20;

/**
 * Code 128 across the bottom: 3-dot modules, 110-dot bars, 10-module quiet zones. The longest
 * payload (LOC- + 20 characters, all subset B) is (start + 24 + check) × 11 + 13 modules.
 */
const CODE128 = {
  moduleWidth: 3,
  barHeight: 110,
  quietZoneModules: 10,
  x: MARGIN + 10 * 3,
  y: 310,
  maxModules: (1 + 24 + 1) * 11 + 13,
} as const;

/** QR top right: model 2, level M, 8-dot modules, 4-module quiet zone; ≤ version 2 (25 × 25). */
const QR = {
  magnification: 8,
  errorCorrection: 'M',
  quietZoneModules: 4,
  x: WIDTH - MARGIN - 4 * 8 - 25 * 8,
  y: MARGIN + 4 * 8,
  maxModules: 25,
} as const;

const TEXT_X = MARGIN;
const TEXT_MAX_WIDTH = QR.x - QR.quietZoneModules * QR.magnification - 18 - TEXT_X;

const STYLE = {
  heading: { y: 20, height: 28 },
  name: { y: 58, height: 56, lineSpacing: 62 },
  code: { y: 194, height: 64 },
} as const;

export interface LocationLabelInput {
  code: string;
  name: string;
}

export interface LocationLabelLayout extends LabelLayout {
  templateVersion: typeof LOCATION_TEMPLATE_VERSION;
}

/** Up to two lines of name, split on spaces; anything left over is shortened with "...". */
function nameLines(name: string): { lines: string[]; truncated: boolean } {
  const { height } = STYLE.name;
  if (measureText(name, height) <= TEXT_MAX_WIDTH) return { lines: [name], truncated: false };
  const words = name.split(' ');
  let first = '';
  let used = 0;
  for (const word of words) {
    const candidate = first ? `${first} ${word}` : word;
    if (measureText(candidate, height) > TEXT_MAX_WIDTH) break;
    first = candidate;
    used++;
  }
  if (used === 0) {
    // One very long word: shorten it on a single line.
    const only = truncateToWidth(name, TEXT_MAX_WIDTH, height);
    return { lines: [only.text], truncated: only.truncated };
  }
  const second = truncateToWidth(words.slice(used).join(' '), TEXT_MAX_WIDTH, height);
  return { lines: [first, second.text], truncated: second.truncated };
}

/** Positions every element of the v1 location label and reports anything shortened to fit. */
export function layoutLocationLabelV1(input: LocationLabelInput): LocationLabelLayout {
  const code = normalizeLocationCode(input.code);
  if (!LOCATION_CODE_PATTERN.test(code)) {
    throw new RangeError('Location code must be 2–20 letters, digits or hyphens');
  }
  const name = cleanText(input.name);
  if (!name) throw new RangeError('Location name is required');

  const warnings: string[] = [];
  const texts: TextField[] = [];
  texts.push(field(TEXT_X, STYLE.heading.y, STYLE.heading.height, 'LOCATION'));
  const lines = nameLines(name);
  if (lines.truncated) warnings.push('Location name shortened to fit');
  lines.lines.forEach((line, index) => {
    texts.push(
      field(TEXT_X, STYLE.name.y + index * STYLE.name.lineSpacing, STYLE.name.height, line),
    );
  });
  // A 20-character code at this height is wider than the column: step down until it fits, so
  // the readable code is never shortened.
  let codeHeight: number = STYLE.code.height;
  while (codeHeight > 32 && measureText(code, codeHeight) > TEXT_MAX_WIDTH) codeHeight -= 4;
  texts.push(field(TEXT_X, STYLE.code.y, codeHeight, code));

  return {
    templateVersion: LOCATION_TEMPLATE_VERSION,
    widthDots: WIDTH,
    heightDots: HEIGHT,
    symbolData: locationPayload(code),
    texts,
    code128: CODE128,
    qr: QR,
    warnings,
  };
}

function checkVersion(templateVersion: string) {
  if (templateVersion !== LOCATION_TEMPLATE_VERSION) {
    throw new RangeError(`Unknown location label template version: ${templateVersion}`);
  }
}

/** ZPL for one location label (the print worker). Deterministic for the same input and version. */
export function renderLocationLabelZpl(
  input: LocationLabelInput,
  templateVersion: string = LOCATION_TEMPLATE_VERSION,
): string {
  checkVersion(templateVersion);
  return zplForLayout(layoutLocationLabelV1(input));
}

export interface LocationLabelPreview {
  svg: string;
  payload: string;
  warnings: string[];
  templateVersion: typeof LOCATION_TEMPLATE_VERSION;
}

/** Real-size SVG preview from the same layout as the ZPL. Never queues or audits anything. */
export function renderLocationLabelPreview(input: LocationLabelInput): LocationLabelPreview {
  const layout = layoutLocationLabelV1(input);
  return {
    svg: svgForLayout(layout),
    payload: layout.symbolData,
    warnings: layout.warnings,
    templateVersion: LOCATION_TEMPLATE_VERSION,
  };
}

/** Exported for tests that check nothing crosses into a quiet zone. */
export const LOCATION_LABEL_GEOMETRY = {
  width: WIDTH,
  height: HEIGHT,
  dotsPerInch: DOTS_PER_INCH,
  textColumn: { x: TEXT_X, maxWidth: TEXT_MAX_WIDTH },
  code128: CODE128,
  qr: QR,
} as const;
