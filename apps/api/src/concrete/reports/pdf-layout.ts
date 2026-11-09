import { PDFDocument, StandardFonts, rgb, type PDFFont, type PDFPage, type RGB } from 'pdf-lib';

// MM-V2-C32: a small flowing layout over pdf-lib for the concrete reports (design section 1):
// US Letter, the company header and title line on every page, a footer with "Page x of y", the
// template name and revision, "Results relate only to the items tested." and "Provisional
// template" while the revision is provisional. Standard Helvetica (no font files, no native
// code: suitable for the Windows service). Output is deterministic for the same input, so the
// preview a person sees is byte-for-byte what issuing stores.

export const MISSING = '—';
const LETTER: [number, number] = [612, 792];
const MARGIN = 40;
const HEADER_HEIGHT = 62;
const FOOTER_HEIGHT = 34;
const BLACK = rgb(0, 0, 0);
const MUTED = rgb(0.35, 0.35, 0.35);
const RULE = rgb(0.6, 0.6, 0.6);
const SHADE = rgb(0.92, 0.92, 0.92);
const TIME_ZONE = 'America/Edmonton';

export interface ReportHeaderText {
  companyName: string;
  address: string | null;
  phone: string | null;
}

export interface ReportFrame {
  header: ReportHeaderText;
  title: string;
  /** Null on a preview (not numbered). */
  reportNumber: string | null;
  revisionNo: number;
  /** Null on a preview. */
  issuedAt: Date | null;
  templateLabel: string;
  provisional: boolean;
  orientation: 'portrait' | 'landscape';
}

/** One table cell: text, optionally marked out of range (⚠ drawn as a vector marker). */
export type Cell = string | { text: string; warn?: boolean; bold?: boolean };

export interface Column {
  header: string;
  /** Share of the content width. */
  width: number;
  align?: 'left' | 'right';
}

// ---- Formatting -----------------------------------------------------------------------------------

const dateFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});
const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: TIME_ZONE,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});

/** YYYY-MM-DD in America/Edmonton; "—" when missing. */
export function formatDate(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = typeof value === 'string' ? new Date(value) : value;
  return Number.isNaN(date.getTime()) ? MISSING : dateFormat.format(date);
}

/** YYYY-MM-DD HH:mm in America/Edmonton; "—" when missing. */
export function formatDateTime(value: Date | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return MISSING;
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return MISSING;
  return `${dateFormat.format(date)} ${timeFormat.format(date)}`;
}

/** A recorded number with its unit; "—" when missing (never 0). */
export function formatNumber(value: number | null | undefined, unit = ''): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return MISSING;
  return unit ? `${value} ${unit}` : String(value);
}

/** Recorded text; "—" when blank. */
export function formatText(value: string | null | undefined): string {
  return value === null || value === undefined || value.trim() === '' ? MISSING : value;
}

/** A recorded yes/no; "—" when not answered (never "No" for missing). */
export function formatYesNo(value: boolean | null | undefined): string {
  return value === null || value === undefined ? MISSING : value ? 'Yes' : 'No';
}

// ---- Document ------------------------------------------------------------------------------------

export class ReportPdf {
  private readonly pages: PDFPage[] = [];
  private page!: PDFPage;
  private y = 0;
  private readonly width: number;
  private readonly height: number;
  private readonly supported: Set<number>;
  private warned = false;

  private constructor(
    private readonly doc: PDFDocument,
    private readonly font: PDFFont,
    private readonly bold: PDFFont,
    private readonly frame: ReportFrame,
  ) {
    [this.width, this.height] = frame.orientation === 'portrait' ? LETTER : [LETTER[1], LETTER[0]];
    this.supported = new Set([...font.getCharacterSet(), ...bold.getCharacterSet()]);
    this.newPage();
  }

  static async create(frame: ReportFrame): Promise<ReportPdf> {
    const doc = await PDFDocument.create({ updateMetadata: false });
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const bold = await doc.embedFont(StandardFonts.HelveticaBold);
    const fixed = frame.issuedAt ?? new Date(0);
    doc.setTitle(
      this.clean(
        `${frame.title}${frame.reportNumber ? ` ${frame.reportNumber}` : ' (preview)'} Rev ${frame.revisionNo}`,
      ),
    );
    doc.setProducer('Material Mule');
    doc.setCreator('Material Mule');
    doc.setCreationDate(fixed);
    doc.setModificationDate(fixed);
    return new ReportPdf(doc, font, bold, frame);
  }

  /** Strip what a metadata string can't hold. */
  private static clean(text: string): string {
    return text.replace(/[^\x20-\x7e]/g, ' ');
  }

  get contentWidth(): number {
    return this.width - 2 * MARGIN;
  }

  /** Whether any ⚠ marker was drawn (the caller prints the legend). */
  get anyWarning(): boolean {
    return this.warned;
  }

  /** Characters the standard font can't encode print as "?" (stored text is never changed). */
  private text(value: string): string {
    let out = '';
    for (const char of value.replace(/\t/g, ' ')) {
      const code = char.codePointAt(0)!;
      out += this.supported.has(code) ? char : '?';
    }
    return out;
  }

  private newPage() {
    this.page = this.doc.addPage([this.width, this.height]);
    this.pages.push(this.page);
    this.drawHeader();
    this.y = this.height - MARGIN - HEADER_HEIGHT;
  }

  private ensure(height: number) {
    if (this.y - height < MARGIN + FOOTER_HEIGHT) this.newPage();
  }

  private draw(
    text: string,
    x: number,
    y: number,
    size: number,
    font: PDFFont = this.font,
    color: RGB = BLACK,
  ) {
    this.page.drawText(this.text(text), { x, y, size, font, color });
  }

  private textWidth(text: string, size: number, font: PDFFont = this.font): number {
    return font.widthOfTextAtSize(this.text(text), size);
  }

  private drawHeader() {
    const top = this.height - MARGIN;
    const { header, title, reportNumber, revisionNo, issuedAt } = this.frame;
    this.draw(header.companyName, MARGIN, top - 12, 13, this.bold);
    let line = top - 25;
    for (const part of [header.address, header.phone]) {
      if (!part) continue;
      for (const row of part.split(/\r?\n/).slice(0, 3)) {
        this.draw(row, MARGIN, line, 8, this.font, MUTED);
        line -= 10;
      }
    }
    const right = this.width - MARGIN;
    const lines: [string, number, PDFFont][] = [
      [title, 12, this.bold],
      [reportNumber ?? 'PREVIEW — not numbered, not issued', 9, this.bold],
      [`Rev ${revisionNo}`, 9, this.font],
      [issuedAt ? `Issued ${formatDate(issuedAt)}` : 'Not issued', 9, this.font],
    ];
    let y = top - 12;
    for (const [text, size, font] of lines) {
      this.draw(text, right - this.textWidth(text, size, font), y, size, font);
      y -= size + 3;
    }
    const ruleY = top - HEADER_HEIGHT + 8;
    this.page.drawLine({
      start: { x: MARGIN, y: ruleY },
      end: { x: right, y: ruleY },
      thickness: 0.8,
      color: BLACK,
    });
  }

  private wrap(text: string, size: number, width: number, font: PDFFont = this.font): string[] {
    const lines: string[] = [];
    for (const paragraph of this.text(text).split(/\r?\n/)) {
      let current = '';
      for (const word of paragraph.split(/ +/)) {
        const candidate = current ? `${current} ${word}` : word;
        if (font.widthOfTextAtSize(candidate, size) <= width) {
          current = candidate;
          continue;
        }
        if (current) lines.push(current);
        // A word longer than the line is broken by character.
        let rest = word;
        while (font.widthOfTextAtSize(rest, size) > width && rest.length > 1) {
          let cut = rest.length - 1;
          while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
          lines.push(rest.slice(0, cut));
          rest = rest.slice(cut);
        }
        current = rest;
      }
      lines.push(current);
    }
    return lines;
  }

  /** The ⚠ marker: an outlined triangle with "!" (vector, so any printer shows it). */
  private marker(x: number, baseline: number, size: number) {
    const h = size * 0.95;
    const w = h * 1.1;
    this.page.drawSvgPath(`M ${w / 2} 0 L ${w} ${h} L 0 ${h} Z`, {
      x,
      y: baseline + h - 1,
      borderColor: BLACK,
      borderWidth: 0.7,
    });
    const bang = this.font.widthOfTextAtSize('!', size * 0.7);
    this.page.drawText('!', {
      x: x + w / 2 - bang / 2,
      y: baseline,
      size: size * 0.7,
      font: this.bold,
      color: BLACK,
    });
    this.warned = true;
    return w + 3;
  }

  // ---- Blocks -------------------------------------------------------------------------------------

  section(title: string) {
    // Keep the heading with at least two lines of what follows.
    this.ensure(56);
    this.y -= 10;
    this.draw(title, MARGIN, this.y - 10, 10.5, this.bold);
    this.y -= 14;
    this.page.drawLine({
      start: { x: MARGIN, y: this.y },
      end: { x: this.width - MARGIN, y: this.y },
      thickness: 0.4,
      color: RULE,
    });
    this.y -= 4;
  }

  /** Label / value pairs in `columns` columns. */
  fields(pairs: [string, string][], columns = 2) {
    const size = 8.5;
    const lineHeight = size + 3;
    const colWidth = this.contentWidth / columns;
    const labelWidth = Math.min(110, colWidth * 0.42);
    for (let i = 0; i < pairs.length; i += columns) {
      const row = pairs.slice(i, i + columns);
      const wrapped = row.map(([label, value]) => ({
        label: this.wrap(label, size, labelWidth - 4, this.bold),
        value: this.wrap(value, size, colWidth - labelWidth - 8),
      }));
      const lines = Math.max(...wrapped.map((w) => Math.max(w.label.length, w.value.length)));
      this.ensure(lines * lineHeight + 3);
      wrapped.forEach((cell, c) => {
        const x = MARGIN + c * colWidth;
        cell.label.forEach((t, l) =>
          this.draw(t, x, this.y - size - l * lineHeight, size, this.bold),
        );
        cell.value.forEach((t, l) =>
          this.draw(t, x + labelWidth, this.y - size - l * lineHeight, size),
        );
      });
      this.y -= lines * lineHeight + 3;
    }
  }

  paragraph(text: string, opts: { size?: number; muted?: boolean; bold?: boolean } = {}) {
    const size = opts.size ?? 8.5;
    const lineHeight = size + 3;
    const font = opts.bold ? this.bold : this.font;
    for (const line of this.wrap(text, size, this.contentWidth, font)) {
      this.ensure(lineHeight);
      this.draw(line, MARGIN, this.y - size, size, font, opts.muted ? MUTED : BLACK);
      this.y -= lineHeight;
    }
    this.y -= 2;
  }

  /** The ⚠ legend line. */
  legend(text: string) {
    const size = 8;
    this.ensure(size + 6);
    const offset = this.marker(MARGIN, this.y - size, size);
    this.draw(text, MARGIN + offset, this.y - size, size, this.font, MUTED);
    this.y -= size + 6;
  }

  table(columns: Column[], rows: Cell[][], opts: { size?: number; empty?: string } = {}) {
    const size = opts.size ?? 7.5;
    const lineHeight = size + 2.5;
    const total = columns.reduce((sum, c) => sum + c.width, 0);
    const widths = columns.map((c) => (c.width / total) * this.contentWidth);
    const pad = 3;
    const drawHead = () => {
      const heads = columns.map((c, i) =>
        this.wrap(c.header, size, widths[i]! - 2 * pad, this.bold),
      );
      const lines = Math.max(...heads.map((h) => h.length));
      const h = lines * lineHeight + 2 * pad;
      this.ensure(h + lineHeight + 2 * pad);
      this.page.drawRectangle({
        x: MARGIN,
        y: this.y - h,
        width: this.contentWidth,
        height: h,
        color: SHADE,
      });
      let x = MARGIN;
      heads.forEach((head, i) => {
        head.forEach((t, l) =>
          this.draw(t, x + pad, this.y - pad - size - l * lineHeight, size, this.bold),
        );
        x += widths[i]!;
      });
      this.y -= h;
    };
    drawHead();
    if (rows.length === 0) {
      this.paragraph(opts.empty ?? 'None recorded.', { size, muted: true });
      return;
    }
    for (const row of rows) {
      const cells = row.map((cell, i) => {
        const c = typeof cell === 'string' ? { text: cell } : cell;
        const markerWidth = c.warn ? size * 1.05 + 3 : 0;
        return {
          ...c,
          markerWidth,
          lines: this.wrap(
            c.text === '' ? MISSING : c.text,
            size,
            widths[i]! - 2 * pad - markerWidth,
            c.bold ? this.bold : this.font,
          ),
        };
      });
      const lines = Math.max(...cells.map((c) => c.lines.length));
      const h = lines * lineHeight + 2 * pad;
      if (this.y - h < MARGIN + FOOTER_HEIGHT) {
        this.newPage();
        drawHead();
      }
      let x = MARGIN;
      cells.forEach((cell, i) => {
        const font = cell.bold ? this.bold : this.font;
        const right = columns[i]!.align === 'right';
        let tx = x + pad;
        if (cell.warn && !right) tx += this.marker(tx, this.y - pad - size, size);
        cell.lines.forEach((t, l) => {
          const lx = right ? x + widths[i]! - pad - this.textWidth(t, size, font) : tx;
          // Right-aligned: the marker sits just before the value.
          if (cell.warn && right && l === 0) {
            this.marker(lx - cell.markerWidth, this.y - pad - size, size);
          }
          this.draw(t, lx, this.y - pad - size - l * lineHeight, size, font);
        });
        x += widths[i]!;
      });
      this.y -= h;
      this.page.drawLine({
        start: { x: MARGIN, y: this.y },
        end: { x: this.width - MARGIN, y: this.y },
        thickness: 0.3,
        color: RULE,
      });
    }
    this.y -= 4;
  }

  /** The sign-off block (last page): reviewed by and issued by, names and dates only. */
  signOff(entries: [string, string, string][]) {
    const size = 9;
    this.ensure(26 + entries.length * 30);
    this.section('Sign-off');
    const col = this.contentWidth / entries.length;
    entries.forEach(([role, name, date], i) => {
      const x = MARGIN + i * col;
      this.draw(role, x, this.y - size, size, this.bold);
      this.draw(name, x, this.y - size - 13, size);
      this.draw(date, x, this.y - size - 26, size, this.font, MUTED);
    });
    this.y -= 40;
  }

  /** Footers on every page, then the bytes. */
  async finish(): Promise<Uint8Array> {
    const count = this.pages.length;
    this.pages.forEach((page, index) => {
      this.page = page;
      const y = MARGIN - 4;
      page.drawLine({
        start: { x: MARGIN, y: y + 22 },
        end: { x: this.width - MARGIN, y: y + 22 },
        thickness: 0.4,
        color: RULE,
      });
      const size = 7.5;
      const pageText = `Page ${index + 1} of ${count}`;
      this.draw(pageText, MARGIN, y + 12, size);
      const template = this.frame.templateLabel;
      this.draw(template, (this.width - this.textWidth(template, size)) / 2, y + 12, size);
      const status = [
        this.frame.reportNumber === null ? 'Preview' : null,
        this.frame.provisional ? 'Provisional template' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      if (status) {
        this.draw(
          status,
          this.width - MARGIN - this.textWidth(status, size, this.bold),
          y + 12,
          size,
          this.bold,
        );
      }
      const note = 'Results relate only to the items tested.';
      this.draw(note, MARGIN, y + 2, size, this.font, MUTED);
    });
    return this.doc.save({ useObjectStreams: false });
  }
}
