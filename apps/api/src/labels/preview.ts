import bwipjs from 'bwip-js';
import {
  DOTS_PER_INCH,
  layoutStickerV1,
  TEMPLATE_VERSION,
  type LabelLayout,
  type StickerInput,
} from './template-v1.js';

export interface StickerPreview {
  /** Real-size SVG (3.5in × 1.5in) in printer dots (viewBox 1050 × 450). */
  svg: string;
  warnings: string[];
  templateVersion: typeof TEMPLATE_VERSION;
}

/** Bar/space widths (in modules) of the Code 128 symbol, starting with a bar. */
export function code128Pattern(data: string): number[] {
  const [symbol] = bwipjs.raw({ bcid: 'code128', text: data }) as Array<{ sbs: number[] }>;
  if (!symbol) throw new Error('Code 128 encoder returned no symbol');
  return symbol.sbs;
}

/** Dark (1) / light (0) modules of the QR symbol at error correction M, row by row. */
export function qrMatrix(data: string): number[][] {
  const [symbol] = bwipjs.raw('qrcode', data, 'eclevel=M') as Array<{
    pixs: number[];
    pixx: number;
    pixy: number;
  }>;
  if (!symbol) throw new Error('QR encoder returned no symbol');
  const rows: number[][] = [];
  for (let y = 0; y < symbol.pixy; y++) {
    rows.push(symbol.pixs.slice(y * symbol.pixx, (y + 1) * symbol.pixx));
  }
  return rows;
}

function escapeXml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function code128Path(layout: LabelLayout): string {
  const { x, y, moduleWidth, barHeight, maxModules } = layout.code128;
  const pattern = code128Pattern(layout.symbolData);
  const modules = pattern.reduce((sum, width) => sum + width, 0);
  if (modules > maxModules) {
    throw new Error(`Code 128 symbol is ${modules} modules; the layout reserves ${maxModules}`);
  }
  let cursor = x;
  let d = '';
  pattern.forEach((width, index) => {
    const w = width * moduleWidth;
    if (index % 2 === 0) d += `M${cursor} ${y}h${w}v${barHeight}h${-w}z`;
    cursor += w;
  });
  return d;
}

function qrPath(layout: LabelLayout): string {
  const { x, y, magnification, maxModules } = layout.qr;
  const matrix = qrMatrix(layout.symbolData);
  if (matrix.length > maxModules) {
    throw new Error(`QR symbol is ${matrix.length} modules; the layout reserves ${maxModules}`);
  }
  let d = '';
  matrix.forEach((row, rowIndex) => {
    // One rectangle per horizontal run of dark modules keeps the path short.
    for (let start = 0; start < row.length; start++) {
      if (!row[start]) continue;
      let end = start;
      while (row[end + 1]) end++;
      const w = (end - start + 1) * magnification;
      d += `M${x + start * magnification} ${y + rowIndex * magnification}h${w}v${magnification}h${-w}z`;
      start = end;
    }
  });
  return d;
}

/**
 * Real-size SVG preview built from the same layout as the ZPL. Text is drawn at exactly the
 * width the layout measured, so the preview shows the space each field reserves; the physical
 * ZD621 print remains the final check of font rendering.
 */
export function renderPreviewSvg(
  input: StickerInput,
  options: { disposed?: boolean } = {},
): StickerPreview {
  const layout = layoutStickerV1(input);
  return {
    svg: svgForLayout(layout, options.disposed ? DISPOSED_WATERMARK : undefined),
    warnings: layout.warnings,
    templateVersion: TEMPLATE_VERSION,
  };
}

/** MTR-48: a disposed unit's preview is never a printable label. */
const DISPOSED_WATERMARK = 'DISPOSED';

/**
 * Real-size SVG of any positioned label (sticker or location label, MM-T37). A `watermark`
 * (fixed text, never user data) is drawn across the label and both barcodes are struck through,
 * so the image can't pass for a printable label.
 */
export function svgForLayout(layout: LabelLayout, watermark?: string): string {
  const { widthDots, heightDots } = layout;
  const texts = layout.texts.map(
    (text) =>
      // ZPL positions a field by the top of its character cell; SVG by the baseline.
      `<text x="${text.x}" y="${text.y + Math.round(text.height * 0.8)}" ` +
      `font-size="${text.height}" textLength="${text.width}" lengthAdjust="spacingAndGlyphs">` +
      `${escapeXml(text.text)}</text>`,
  );
  const svg = [
    `<svg xmlns="http://www.w3.org/2000/svg" ` +
      `width="${widthDots / DOTS_PER_INCH}in" height="${heightDots / DOTS_PER_INCH}in" ` +
      `viewBox="0 0 ${widthDots} ${heightDots}" shape-rendering="crispEdges" ` +
      `data-template-version="${layout.templateVersion}">`,
    `<rect width="${widthDots}" height="${heightDots}" fill="#fff"/>`,
    `<g font-family="'Arial Narrow', 'Roboto Condensed', Arial, sans-serif" font-weight="700" fill="#000">`,
    ...texts,
    '</g>',
    `<path data-symbol="code128" fill="#000" d="${code128Path(layout)}"/>`,
    `<path data-symbol="qr" fill="#000" d="${qrPath(layout)}"/>`,
    ...(watermark ? watermarkSvg(widthDots, heightDots, watermark) : []),
    '</svg>',
  ];
  return svg.join('\n') + '\n';
}

function watermarkSvg(width: number, height: number, text: string): string[] {
  const size = Math.round(height * 0.38);
  return [
    `<g data-watermark="${escapeXml(text)}" pointer-events="none">`,
    `<rect width="${width}" height="${height}" fill="#fff" fill-opacity="0.45"/>`,
    `<line x1="0" y1="0" x2="${width}" y2="${height}" stroke="#b00020" stroke-width="${Math.round(height * 0.03)}"/>`,
    `<line x1="0" y1="${height}" x2="${width}" y2="0" stroke="#b00020" stroke-width="${Math.round(height * 0.03)}"/>`,
    `<text x="${width / 2}" y="${height / 2}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="Arial, sans-serif" font-weight="700" font-size="${size}" fill="#b00020" ` +
      `fill-opacity="0.85" stroke="#fff" stroke-width="${Math.round(size * 0.04)}" ` +
      `transform="rotate(-12 ${width / 2} ${height / 2})">${escapeXml(text)}</text>`,
    '</g>',
  ];
}
