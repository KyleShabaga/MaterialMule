import {
  layoutStickerV1,
  TEMPLATE_VERSION,
  type LabelLayout,
  type StickerInput,
} from './template-v1.js';

/** The ^FH hex indicator used in every text field. */
const HEX_INDICATOR = '_';

/**
 * Makes untrusted text safe inside `^FH_^FD…^FS`. The ZPL control characters (`^`, `~`), the
 * hex indicator itself and every byte outside printable ASCII are written as `_XX` hex escapes
 * of their UTF-8 bytes (^CI28), so the printer shows them literally and no text can start a
 * command or end the field early.
 */
export function escapeZplText(value: string): string {
  let out = '';
  for (const char of value) {
    const code = char.codePointAt(0)!;
    const printable = code >= 0x20 && code <= 0x7e;
    if (printable && char !== '^' && char !== '~' && char !== HEX_INDICATOR) {
      out += char;
    } else {
      for (const byte of Buffer.from(char, 'utf8')) {
        out += HEX_INDICATOR + byte.toString(16).toUpperCase().padStart(2, '0');
      }
    }
  }
  return out;
}

export interface RenderedZpl {
  zpl: string;
  warnings: string[];
  templateVersion: typeof TEMPLATE_VERSION;
}

/**
 * ZPL for one sticker. Deterministic: the same input and template version always give the same
 * bytes. Printer settings (darkness, speed, media type, quantity) belong to the print queue (T15).
 */
export function renderZpl(
  input: StickerInput,
  templateVersion: string = TEMPLATE_VERSION,
): RenderedZpl {
  if (templateVersion !== TEMPLATE_VERSION) {
    throw new RangeError(`Unknown sticker template version: ${templateVersion}`);
  }
  const layout = layoutStickerV1(input);
  return {
    zpl: zplForLayout(layout),
    warnings: layout.warnings,
    templateVersion: TEMPLATE_VERSION,
  };
}

/**
 * The ZPL for a positioned label (sticker or location label, MM-T37). Symbol data is validated
 * by each template to A–Z, 0–9 and '-', so it needs no escaping; text fields are always escaped.
 */
export function zplForLayout(layout: LabelLayout): string {
  const { code128, qr } = layout;
  const lines = [
    '^XA',
    `^FX Material Mule ${layout.templateVersion}^FS`,
    '^CI28',
    `^PW${layout.widthDots}`,
    `^LL${layout.heightDots}`,
    '^LH0,0',
    ...layout.texts.map(
      (text) =>
        `^FO${text.x},${text.y}^A0N,${text.height},${text.height}` +
        `^FH${HEX_INDICATOR}^FD${escapeZplText(text.text)}^FS`,
    ),
    `^FO${code128.x},${code128.y}^BY${code128.moduleWidth}` +
      `^BCN,${code128.barHeight},N,N,N,A^FD${layout.symbolData}^FS`,
    `^FO${qr.x},${qr.y}^BQN,2,${qr.magnification},${qr.errorCorrection},7` +
      `^FD${qr.errorCorrection}A,${layout.symbolData}^FS`,
    '^XZ',
  ];
  return lines.join('\n') + '\n';
}
