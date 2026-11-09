import type { ConcreteSummaryAgeCell, ConcreteSummarySnapshot } from '@materialmule/shared';
import {
  formatDate,
  formatNumber,
  formatText,
  MISSING,
  ReportPdf,
  type Cell,
  type ReportHeaderText,
} from './pdf-layout.js';

// MM-V2-C32: the project concrete summary report, template revision P1 (provisional design,
// section 5), landscape. It only restates issued results: an age prints a value only when it was
// issued (C39/C24 deliver those; until then none exist), "Pending review" when tested but not
// issued, "—" when untested and "HOLD" for HOLD specimens.

export interface SummaryReportRenderInput {
  header: ReportHeaderText;
  template: { name: string; revision: string; provisional: boolean };
  /** Null for a preview (not numbered). */
  reportNumber: string | null;
  issuedAt: Date | null;
  issuedBy: { name: string; at: Date } | null;
  snapshot: ConcreteSummarySnapshot;
}

export function summaryAgeText(cell: ConcreteSummaryAgeCell | undefined): string {
  if (!cell) return MISSING;
  switch (cell.status) {
    case 'issued':
      return cell.averageMpa === null ? MISSING : `${cell.averageMpa} MPa`;
    case 'pending_review':
      return 'Pending review';
    case 'untested':
    case 'not_scheduled':
      return MISSING;
  }
}

export async function renderSummaryReportPdf(input: SummaryReportRenderInput): Promise<Uint8Array> {
  const s = input.snapshot;
  const pdf = await ReportPdf.create({
    header: input.header,
    title: 'Project Concrete Summary Report',
    reportNumber: input.reportNumber,
    revisionNo: 0,
    issuedAt: input.issuedAt,
    templateLabel: `${input.template.name} ${input.template.revision}`,
    provisional: input.template.provisional,
    orientation: 'landscape',
  });

  pdf.section('Project');
  pdf.fields(
    [
      ['Project number', formatText(s.projectNumber)],
      ['Project name', formatText(s.projectName)],
      ...(s.client && s.client.trim() ? [['Client', s.client] as [string, string]] : []),
      ['Lead project engineer', formatText(s.leadProjectEngineer)],
      [
        'Cast dates',
        s.filters.from || s.filters.to
          ? `${formatDate(s.filters.from)} to ${formatDate(s.filters.to)}`
          : 'All dates',
      ],
      ['Structure / element', s.filters.element ?? 'All'],
      ['Mix', s.filters.mixId ? formatText(s.filters.mixNumber) : 'All'],
    ],
    3,
  );

  pdf.section('Specimen sets');
  const ageColumns = s.ages.map((age) => ({ header: `${age} d`, width: 0.9 }));
  pdf.table(
    [
      { header: 'Cast date', width: 0.9 },
      { header: 'Field report', width: 1.1 },
      { header: 'Set ID', width: 0.9 },
      { header: 'Structure / element', width: 1.4 },
      { header: 'Mix', width: 0.8 },
      { header: 'Specified', width: 0.9 },
      { header: 'Slump mm', width: 0.6, align: 'right' },
      { header: 'Air %', width: 0.5, align: 'right' },
      { header: 'Temp °C', width: 0.5, align: 'right' },
      ...ageColumns,
      { header: 'Status', width: 1.1 },
    ],
    s.rows.map((row): Cell[] => [
      formatDate(row.castDate),
      row.fieldReportNumber ?? 'Not issued',
      formatText(row.setLabel),
      formatText(row.elements),
      formatText(row.mixNumber),
      row.specifiedStrengthMpa === null
        ? MISSING
        : `${row.specifiedStrengthMpa} MPa${row.specifiedStrengthAgeDays !== null ? ` / ${row.specifiedStrengthAgeDays} d` : ''}`,
      formatNumber(row.slumpMm),
      formatNumber(row.airPercent),
      formatNumber(row.concreteTempC),
      ...s.ages.map((age) => summaryAgeText(row.ages[String(age)])),
      `${row.status === 'all_issued' ? 'All ages issued' : 'Pending'}${row.holdCount > 0 ? ` · HOLD ${row.holdCount}` : ''}`,
    ]),
    { empty: 'No specimen sets in this range.', size: 7 },
  );
  pdf.paragraph(
    'Only issued strength values print. Tested but not issued: "Pending review"; untested: "—"; HOLD specimens are counted in the status.',
    { muted: true, size: 7.5 },
  );

  pdf.section('Totals');
  pdf.fields(
    [
      ['Sets in range', String(s.totals.sets)],
      ['Sets with all ages issued', String(s.totals.allIssued)],
      ['Sets pending', String(s.totals.pending)],
    ],
    3,
  );

  pdf.signOff([
    [
      'Issued by',
      formatText(input.issuedBy?.name),
      input.issuedBy ? formatDate(input.issuedBy.at) : MISSING,
    ],
  ]);
  return pdf.finish();
}
