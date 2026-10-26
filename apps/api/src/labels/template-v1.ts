import { z } from 'zod';
import { measureText, truncateToWidth, wrapList } from './text-fit.js';

/**
 * Storage-unit sticker, template v1 (MM-T14): Zebra ZD621, 300 dpi, 3.5 × 1.5 in stock.
 * One layout definition drives both the ZPL and the preview, so they can't drift apart.
 * Any change to positions, sizes or fit rules needs a new template version: prints record the
 * version so reprints are reproducible (T15).
 *
 *   ┌────────────────────────────────────────────┬──────────────┐
 *   │ BKT-2026-000014                            │  ▄▄▄▄▄▄▄▄▄▄  │
 *   │ DEMO-2601                                  │  █  QR    █  │
 *   │ Project name...                            │  █        █  │
 *   │ TH26-01, TH26-02, ...                      │  ▀▀▀▀▀▀▀▀▀▀  │
 *   │ (up to 3 lines, then "+N more")            │              │
 *   │ ║│║║│║│║║│║ Code 128 ║│║║│║║│║             │ RECEIVED     │
 *   │                                            │ 2026-10-26   │
 *   └────────────────────────────────────────────┴──────────────┘
 *
 * Confirmed sticker fields only (App Idea §5): Code 128, QR, readable storage unit ID, project
 * number, project name, received date and test-hole/field-location names. Never add SAMPLE#/DEPTH
 * summaries, notes, location or URLs.
 */
export const TEMPLATE_VERSION = 'sticker-v1';

export const LABEL_WIDTH_DOTS = 1050; // 3.5 in at 300 dpi
export const LABEL_HEIGHT_DOTS = 450; // 1.5 in at 300 dpi
export const DOTS_PER_INCH = 300;

const MARGIN = 20;

/** Code 128: 3-dot (10 mil) modules, 100-dot bars, quiet zone of 10 modules each side. */
export const CODE128 = {
  moduleWidth: 3,
  barHeight: 100,
  quietZoneModules: 10,
  x: MARGIN + 10 * 3,
  y: 320,
  /**
   * Widest possible symbol for an ID: every character in subset B, i.e. (start + 15 data +
   * check) × 11 modules + 13-module stop. The printer picks subsets itself (^BC auto mode), so
   * reserving the worst case keeps the right-hand quiet zone clear whatever it chooses.
   */
  maxModules: (1 + 15 + 1) * 11 + 13,
} as const;

/** QR: model 2, error correction M, 8-dot modules, quiet zone of 4 modules. */
export const QR = {
  magnification: 8,
  errorCorrection: 'M',
  quietZoneModules: 4,
  x: LABEL_WIDTH_DOTS - MARGIN - 4 * 8 - 21 * 8,
  y: MARGIN + 4 * 8,
  /** Every issued ID fits in a version 1 symbol (21 × 21) at level M (alphanumeric, ≤ 20). */
  maxModules: 21,
} as const;

/** Left text column: from the margin to just before the QR quiet zone. */
const TEXT_X = MARGIN;
const TEXT_MAX_WIDTH = QR.x - QR.quietZoneModules * QR.magnification - 18 - TEXT_X;

/** Received date block, to the right of the Code 128 quiet zone. */
const DATE_X =
  CODE128.x + (CODE128.maxModules + CODE128.quietZoneModules) * CODE128.moduleWidth + 20;
const DATE_MAX_WIDTH = LABEL_WIDTH_DOTS - MARGIN - DATE_X;

export const TEST_HOLE_MAX_LINES = 3;

const TEXT_STYLE = {
  storageUnitId: { y: 20, height: 64 },
  projectNumber: { y: 94, height: 44 },
  projectName: { y: 146, height: 36 },
  testHoles: { y: 194, height: 30, lineSpacing: 36 },
  receivedLabel: { y: 336, height: 28 },
  receivedDate: { y: 370, height: 44 },
} as const;

/** Issued storage unit IDs: PREFIX-YYYY-NNNNNN (owner amendment 2026-10-25). */
export const STORAGE_UNIT_ID_PATTERN = /^(BKT|ST|CRE|CT)-\d{4}-\d{6}$/;

function isCalendarDate(value: string) {
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

/** Control and invisible formatting characters become spaces; runs of space collapse to one. */
function cleanText(value: string) {
  return value
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const text = z.string().transform(cleanText);

export const stickerInputSchema = z.object({
  storageUnitId: z.string().regex(STORAGE_UNIT_ID_PATTERN, 'Expected PREFIX-YYYY-NNNNNN'),
  projectNumber: text.pipe(z.string().min(1)),
  projectName: text,
  /** Printed as YYYY-MM-DD (owner decision 2026-10-25). */
  receivedDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .refine(isCalendarDate, 'Not a calendar date'),
  /** Test-hole / field-location names, in display order. */
  testHoles: z.array(text).transform((names) => names.filter((name) => name.length > 0)),
});

/** The unit's current values; a reprint after a correction passes the corrected values. */
export type StickerInput = z.input<typeof stickerInputSchema>;

export interface TextField {
  x: number;
  y: number;
  /** Font height (and width) in dots. */
  height: number;
  text: string;
  /** Measured width in dots (≤ the field's maximum width). */
  width: number;
}

export interface StickerLayout {
  templateVersion: typeof TEMPLATE_VERSION;
  widthDots: number;
  heightDots: number;
  /** What both symbols encode: exactly the readable storage unit ID. */
  symbolData: string;
  texts: TextField[];
  code128: typeof CODE128;
  qr: typeof QR;
  /** Plain-language fit problems, shown before printing. */
  warnings: string[];
}

function field(x: number, y: number, height: number, value: string): TextField {
  return { x, y, height, text: value, width: measureText(value, height) };
}

/** Positions every element of the v1 sticker and reports anything shortened to fit. */
export function layoutStickerV1(input: StickerInput): StickerLayout {
  const unit = stickerInputSchema.parse(input);
  const warnings: string[] = [];
  const texts: TextField[] = [];

  const { storageUnitId: idStyle } = TEXT_STYLE;
  texts.push(field(TEXT_X, idStyle.y, idStyle.height, unit.storageUnitId));

  const numberStyle = TEXT_STYLE.projectNumber;
  const projectNumber = truncateToWidth(unit.projectNumber, TEXT_MAX_WIDTH, numberStyle.height);
  if (projectNumber.truncated) warnings.push('Project number shortened to fit');
  texts.push(field(TEXT_X, numberStyle.y, numberStyle.height, projectNumber.text));

  const nameStyle = TEXT_STYLE.projectName;
  if (unit.projectName) {
    const projectName = truncateToWidth(unit.projectName, TEXT_MAX_WIDTH, nameStyle.height);
    if (projectName.truncated) warnings.push('Project name shortened to fit');
    texts.push(field(TEXT_X, nameStyle.y, nameStyle.height, projectName.text));
  }

  const holeStyle = TEXT_STYLE.testHoles;
  const holes = wrapList(unit.testHoles, TEXT_MAX_WIDTH, holeStyle.height, TEST_HOLE_MAX_LINES);
  holes.lines.forEach((line, index) => {
    texts.push(field(TEXT_X, holeStyle.y + index * holeStyle.lineSpacing, holeStyle.height, line));
  });
  if (holes.shortenedCount > 0) {
    warnings.push(
      holes.shortenedCount === 1
        ? 'A test-hole name was shortened to fit'
        : `${holes.shortenedCount} test-hole names were shortened to fit`,
    );
  }
  if (holes.hiddenCount > 0) {
    warnings.push(
      `${holes.hiddenCount} test ${holes.hiddenCount === 1 ? 'hole' : 'holes'} not shown; ` +
        `the sticker says "+${holes.hiddenCount} more"`,
    );
  }

  const { receivedLabel, receivedDate } = TEXT_STYLE;
  texts.push(field(DATE_X, receivedLabel.y, receivedLabel.height, 'RECEIVED'));
  texts.push(field(DATE_X, receivedDate.y, receivedDate.height, unit.receivedDate));

  return {
    templateVersion: TEMPLATE_VERSION,
    widthDots: LABEL_WIDTH_DOTS,
    heightDots: LABEL_HEIGHT_DOTS,
    symbolData: unit.storageUnitId,
    texts,
    code128: CODE128,
    qr: QR,
    warnings,
  };
}

/** Maximum widths, exported for tests that check nothing crosses into a quiet zone. */
export const TEXT_LIMITS = {
  textColumn: { x: TEXT_X, maxWidth: TEXT_MAX_WIDTH },
  dateBlock: { x: DATE_X, maxWidth: DATE_MAX_WIDTH },
} as const;
