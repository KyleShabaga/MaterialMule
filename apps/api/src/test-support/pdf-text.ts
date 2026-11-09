import { inflateSync } from 'node:zlib';

// MM-V2-C32 tests: the text drawn on each page of a PDF made by pdf-layout.ts (pdf-lib writes
// each string as a hex `<…> Tj` in WinAnsi). Good enough to assert what a report prints; not a
// general PDF parser.

const WIN_ANSI_EXTRA: Record<number, string> = { 0x97: '—', 0x96: '–', 0x80: '€' };

function decode(hex: string): string {
  let out = '';
  for (let i = 0; i < hex.length; i += 2) {
    const code = parseInt(hex.slice(i, i + 2), 16);
    out += WIN_ANSI_EXTRA[code] ?? String.fromCharCode(code);
  }
  return out;
}

/** Every content stream's drawn strings, joined by newlines, in drawing order. */
export function pdfText(bytes: Uint8Array): string {
  const buffer = Buffer.from(bytes);
  const text: string[] = [];
  let from = 0;
  for (;;) {
    const start = buffer.indexOf('stream', from, 'latin1');
    if (start < 0) break;
    const dataStart = start + (buffer[start + 6] === 0x0d ? 8 : 7);
    const end = buffer.indexOf('endstream', dataStart, 'latin1');
    if (end < 0) break;
    const dict = buffer.subarray(Math.max(0, start - 300), start).toString('latin1');
    let data = buffer.subarray(dataStart, end);
    if (/FlateDecode/.test(dict.slice(dict.lastIndexOf('<<')))) {
      try {
        data = inflateSync(data);
      } catch {
        from = end + 9;
        continue;
      }
    }
    const content = data.toString('latin1');
    for (const match of content.matchAll(/<([0-9A-Fa-f]*)>\s*Tj/g)) text.push(decode(match[1]!));
    from = end + 9;
  }
  return text.join('\n');
}

/** Page count from the page tree. */
export function pdfPageCount(bytes: Uint8Array): number {
  const match = /\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/.exec(Buffer.from(bytes).toString('latin1'));
  return match ? Number(match[1]) : 0;
}
