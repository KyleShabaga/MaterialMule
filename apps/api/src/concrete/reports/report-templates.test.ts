import { createHash } from 'node:crypto';
import {
  formatConcreteReportNumber,
  parseConcreteReportNumber,
  type ConcreteStrengthReportSnapshot,
} from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import {
  fieldRenderInput,
  FIELD_SNAPSHOT,
  STRENGTH_SNAPSHOT,
  SUMMARY_SNAPSHOT,
} from '../../test-support/concrete-report-fixtures.js';
import { pdfPageCount, pdfText } from '../../test-support/pdf-text.js';
import { renderFieldReportPdf } from './field-report-template.js';
import { renderStrengthReportPdf, STRENGTH_STANDARDS_LINE } from './strength-report-template.js';
import { renderSummaryReportPdf } from './summary-report-template.js';

// MM-V2-C32: the P1 templates (provisional designs, sections 1, 3, 4, 5). Fictional data only.

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

describe('report numbers (design section 2)', () => {
  it('formats and parses CF / CS / CSR numbers', () => {
    expect(formatConcreteReportNumber('field', 2026, 12)).toBe('CF-2026-00012');
    expect(formatConcreteReportNumber('strength', 2026, 31)).toBe('CS-2026-00031');
    expect(formatConcreteReportNumber('summary', 2026, 4)).toBe('CSR-2026-0004');
    expect(() => formatConcreteReportNumber('summary', 2026, 10000)).toThrow();
    expect(parseConcreteReportNumber('CSR-2026-0004')).toEqual({
      kind: 'summary',
      year: 2026,
      seq: 4,
    });
    expect(parseConcreteReportNumber('CF-2026-0004')).toBeNull();
    expect(parseConcreteReportNumber('CF-2026-00000')).toBeNull();
  });
});

describe('field report template P1 (design section 3)', () => {
  it('is deterministic: the same input gives the same bytes', async () => {
    const a = await renderFieldReportPdf(fieldRenderInput());
    const b = await renderFieldReportPdf(fieldRenderInput());
    expect(sha(a)).toBe(sha(b));
    expect(Buffer.from(a).subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  it('prints the header, title line, footer on every page and the sign-off', async () => {
    const bytes = await renderFieldReportPdf(fieldRenderInput());
    const text = pdfText(bytes);
    const pages = pdfPageCount(bytes);
    expect(pages).toBeGreaterThanOrEqual(1);
    expect(text).toContain('Material Mule Testing Laboratory');
    expect(text).toContain('Concrete Field Report');
    expect(text).toContain('CF-2026-00012');
    expect(text).toContain('Rev 0');
    expect(text).toContain('Issued 2026-11-09');
    for (let page = 1; page <= pages; page++) expect(text).toContain(`Page ${page} of ${pages}`);
    expect(text.split('Field report template P1').length - 1).toBe(pages);
    expect(text.split('Provisional template').length - 1).toBe(pages);
    expect(text.split('Results relate only to the items tested.').length - 1).toBe(pages);
    expect(text).toContain('Reviewed by');
    expect(text).toContain('Riley Reviewer');
    expect(text).toContain('Issued by');
    // No accreditation marks, standards or strength in a field report.
    expect(text).not.toMatch(/accredit|ASTM|CSA A23/i);
  });

  it('prints "—" for missing values, never 0 or No', async () => {
    const text = pdfText(await renderFieldReportPdf(fieldRenderInput()));
    // Density and water added are not recorded in the fixture.
    const lines = text.split('\n');
    const loadRow = lines.indexOf('T-88812');
    expect(loadRow).toBeGreaterThan(0);
    const row = lines.slice(loadRow, loadRow + 12);
    expect(row.filter((cell) => cell === '—').length).toBeGreaterThanOrEqual(2);
    expect(row).not.toContain('0');
    expect(row).not.toContain('No');
  });

  it('marks out-of-range readings with ⚠ and a legend; the value prints as recorded', async () => {
    const text = pdfText(await renderFieldReportPdf(fieldRenderInput()));
    expect(text).toContain('130');
    expect(text).toContain(
      "Reading outside the mix's specified range. The value is printed as recorded.",
    );

    const inRange = {
      ...FIELD_SNAPSHOT,
      fields: {
        ...FIELD_SNAPSHOT.fields,
        readings: FIELD_SNAPSHOT.fields.readings.map((r) => ({
          ...r,
          value: r.test === 'slump' ? 90 : 6,
        })),
      },
    };
    const clean = pdfText(await renderFieldReportPdf(fieldRenderInput({ snapshot: inRange })));
    expect(clean).not.toContain('Reading outside');
  });

  it('prints the revision line and reason on a revision', async () => {
    const text = pdfText(
      await renderFieldReportPdf(
        fieldRenderInput({
          revisionNo: 1,
          supersedes: {
            revisionNo: 0,
            issuedAt: new Date('2026-11-09T18:30:00.000Z'),
            reason: 'Ambient temperature misread',
          },
        }),
      ),
    );
    expect(text).toContain('Rev 1, supersedes Rev 0 issued 2026-11-09.');
    expect(text).toContain('Revision reason: Ambient temperature misread');
  });

  it('prints the machine block only when included, as copied at issue', async () => {
    const included = pdfText(await renderFieldReportPdf(fieldRenderInput()));
    expect(included).toContain('Testing machine (as registered at issue)');
    expect(included).toContain('CM-3000');
    const omitted = pdfText(
      await renderFieldReportPdf(fieldRenderInput({ includeMachineInfo: false })),
    );
    expect(omitted).not.toContain('Testing machine');
  });

  it('prints characters the standard font lacks as "?" instead of failing', async () => {
    const snapshot = {
      ...FIELD_SNAPSHOT,
      fields: { ...FIELD_SNAPSHOT.fields, comments: 'Pour ≈ 34 m³ 混凝土' },
    };
    const text = pdfText(await renderFieldReportPdf(fieldRenderInput({ snapshot })));
    expect(text).toContain('Pour ? 34 m³ ???');
  });

  it('a preview says it is not numbered or issued', async () => {
    const text = pdfText(
      await renderFieldReportPdf(fieldRenderInput({ reportNumber: null, issuedAt: null })),
    );
    expect(text).toContain('PREVIEW — not numbered, not issued');
    expect(text).toContain('Not issued');
  });
});

describe('strength report template P1 (design section 4, unwired until C39)', () => {
  const render = (snapshot: ConcreteStrengthReportSnapshot = STRENGTH_SNAPSHOT) => {
    const base = fieldRenderInput();
    return renderStrengthReportPdf({
      ...base,
      template: { name: 'Strength report template', revision: 'P1', provisional: true },
      reportNumber: 'CS-2026-00031',
      snapshot,
    });
  };

  it('prints the set block, every specimen and the open-gate placeholders', async () => {
    const text = pdfText(await render());
    expect(text).toContain('Concrete Compressive Strength Report');
    expect(text).toContain('CS-2026-00031');
    expect(text).toContain('CF-2026-00012');
    expect(text).toContain('26-0042A');
    expect(text).toContain('201.4 kN');
    // Wrapped in its cell: "Not yet tested (target" / "2026-12-04)".
    expect(text.split('\n').join(' ')).toContain('Not yet tested (target 2026-12-04)');
    expect(text).toContain('HOLD');
    expect(text).toContain(STRENGTH_STANDARDS_LINE);
    expect(text).toContain('Strength report template P1');
    // G1/G8 open: no MPa result, area or assessment is printed.
    expect(text).not.toMatch(/\d MPa\b(?! at)/);
  });
});

describe('summary report template P1 (design section 5)', () => {
  it('prints only issued values: Pending review, —, HOLD and the totals', async () => {
    const bytes = await renderSummaryReportPdf({
      header: { companyName: 'Material Mule Testing Laboratory', address: null, phone: null },
      template: { name: 'Summary report template', revision: 'P1', provisional: true },
      reportNumber: 'CSR-2026-0004',
      issuedAt: new Date('2026-11-09T18:30:00.000Z'),
      issuedBy: { name: 'Pat Example', at: new Date('2026-11-09T18:30:00.000Z') },
      snapshot: SUMMARY_SNAPSHOT,
    });
    const text = pdfText(bytes);
    expect(text).toContain('Project Concrete Summary Report');
    expect(text).toContain('CSR-2026-0004');
    expect(text).toContain('7 d');
    expect(text).toContain('28 d');
    expect(text).toContain('Pending review');
    expect(text).toContain('Pending · HOLD 1');
    expect(text).toContain('Sets in range');
    expect(text).toContain('Summary report template P1');
  });
});
