import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { inflateSync } from 'node:zlib';
import { Resvg } from '@resvg/resvg-js';
import { prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

// Reads the barcodes in a PDF that Chromium printed (TRP-T39). Chromium (Skia) writes the label's
// SVG as vector paths in each page's content stream, so this turns each page's filled paths back
// into an SVG, rasterises it at 300 dpi with resvg and decodes it with ZXing, as the T14 label
// tests do. Text is skipped: only the barcodes matter here. Supports exactly the operators Skia
// emits for the label (q/Q, cm, m/l/h/re, f, rg); anything else is ignored.

export interface PdfPage {
  /** Page size in inches, from the MediaBox. */
  widthIn: number;
  heightIn: number;
  /** The page's filled paths as an SVG in PDF points. */
  svg: string;
}

type Matrix = [number, number, number, number, number, number];

const multiply = (m: Matrix, n: Matrix): Matrix => [
  m[0] * n[0] + m[1] * n[2],
  m[0] * n[1] + m[1] * n[3],
  m[2] * n[0] + m[3] * n[2],
  m[2] * n[1] + m[3] * n[3],
  m[4] * n[0] + m[5] * n[2] + n[4],
  m[4] * n[1] + m[5] * n[3] + n[5],
];

function findObject(pdf: string, id: string): { start: number; body: string } {
  const start = pdf.search(new RegExp(`(^|\\s)${id} 0 obj\\b`));
  if (start < 0) throw new Error(`PDF object ${id} not found`);
  return { start, body: pdf.slice(start, pdf.indexOf('endobj', start)) };
}

function streamOf(bytes: Buffer, pdf: string, id: string): string {
  const { start: offset, body } = findObject(pdf, id);
  const marker = body.match(/stream\r?\n/);
  if (!marker || marker.index === undefined) throw new Error(`PDF object ${id} has no stream`);
  const start = offset + marker.index + marker[0].length;
  const end = pdf.indexOf('endstream', start);
  const raw = bytes.subarray(start, end);
  return (body.includes('/FlateDecode') ? inflateSync(raw) : raw).toString('latin1');
}

/** Filled paths of one content stream, mapped to PDF user space (y down, for SVG). */
function contentToSvg(content: string, width: number, height: number): string {
  const tokens = content
    .replace(/BT[\s\S]*?ET/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const stack: Matrix[] = [];
  let ctm: Matrix = [1, 0, 0, 1, 0, 0];
  let fill = '#000';
  let path = '';
  const paths: string[] = [];
  const operands: number[] = [];
  const point = (x: number, y: number) => {
    const px = ctm[0] * x + ctm[2] * y + ctm[4];
    const py = ctm[1] * x + ctm[3] * y + ctm[5];
    return `${px.toFixed(3)} ${(height - py).toFixed(3)}`;
  };
  for (const token of tokens) {
    const value = Number(token);
    if (!Number.isNaN(value)) {
      operands.push(value);
      continue;
    }
    const a = operands.splice(0);
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        ctm = stack.pop() ?? [1, 0, 0, 1, 0, 0];
        break;
      case 'cm':
        ctm = multiply(a as Matrix, ctm);
        break;
      case 'rg': {
        const [r, g, b] = a.map((c) => Math.round(c * 255));
        fill = `rgb(${r},${g},${b})`;
        break;
      }
      case 'm':
        path += `M${point(a[0]!, a[1]!)}`;
        break;
      case 'l':
        path += `L${point(a[0]!, a[1]!)}`;
        break;
      case 'h':
        path += 'Z';
        break;
      case 're': {
        const [x, y, w, h] = a as [number, number, number, number];
        path += `M${point(x, y)}L${point(x + w, y)}L${point(x + w, y + h)}L${point(x, y + h)}Z`;
        break;
      }
      case 'f':
      case 'f*':
        paths.push(
          `<path fill="${fill}" fill-rule="${token === 'f' ? 'nonzero' : 'evenodd'}" d="${path}"/>`,
        );
        path = '';
        break;
      case 'n':
        path = '';
        break;
      default:
        break;
    }
  }
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" ` +
    `viewBox="0 0 ${width} ${height}" shape-rendering="crispEdges">` +
    `<rect width="${width}" height="${height}" fill="#fff"/>${paths.join('')}</svg>`
  );
}

/** Pages in order, with their size and filled paths. */
export function readPdfPages(bytes: Buffer): PdfPage[] {
  const pdf = bytes.toString('latin1');
  const root = pdf.match(/\/Type\s*\/Pages\b[\s\S]*?\/Kids\s*\[([^\]]*)\]/);
  if (!root) throw new Error('PDF has no page tree');
  const pageIds = [...root[1]!.matchAll(/(\d+)\s+0\s+R/g)].map((match) => match[1]!);
  return pageIds.map((id) => {
    const page = findObject(pdf, id).body;
    const box = page
      .match(/\/MediaBox\s*\[\s*([\d.\s-]+)\]/)![1]!
      .trim()
      .split(/\s+/)
      .map(Number);
    const [x0, y0, x1, y1] = box as [number, number, number, number];
    const contents = page.match(/\/Contents\s*(\[[^\]]*\]|\d+\s+0\s+R)/)![1]!;
    const content = [...contents.matchAll(/(\d+)\s+0\s+R/g)]
      .map((match) => streamOf(bytes, pdf, match[1]!))
      .join('\n');
    const width = x1 - x0;
    const height = y1 - y0;
    return {
      widthIn: width / 72,
      heightIn: height / 72,
      svg: contentToSvg(content, width, height),
    };
  });
}

let zxingReady: Promise<unknown> | null = null;

/** Rasterises a page at 300 dpi and returns every valid Code 128 / QR symbol on it. */
export function decodePdfPage(page: PdfPage): Promise<[string, string][]> {
  return decodeSvg(page.svg, page.widthIn);
}

/** Rasterises an SVG `widthIn` inches wide at 300 dpi and decodes its Code 128 / QR symbols. */
export async function decodeSvg(svg: string, widthIn: number): Promise<[string, string][]> {
  zxingReady ??= (async () => {
    // Playwright runs from the repository root; zxing-wasm is an API dev dependency.
    const require = createRequire(resolve('apps/api/package.json'));
    const wasmPath = require.resolve('zxing-wasm/reader/zxing_reader.wasm');
    const wasmBinary = (await readFile(wasmPath)).buffer;
    return prepareZXingModule({ overrides: { wasmBinary }, fireImmediately: true });
  })();
  await zxingReady;
  const png = new Resvg(svg, {
    fitTo: { mode: 'width', value: Math.round(widthIn * 300) },
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
