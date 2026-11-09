import type { ConcreteStrengthReportSnapshot } from '@materialmule/shared';
import type { TestingMachineCopy } from './field-report-template.js';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatText,
  MISSING,
  ReportPdf,
  type ReportHeaderText,
} from './pdf-layout.js';

// MM-V2-C32: the concrete compressive strength report, template revision P1 (provisional design,
// section 4), against the snapshot shape agreed with C39 (`ConcreteStrengthReportSnapshot`).
// NOT WIRED to issuing until C39's strength report records are on main. Strength, area, averages
// and the assessment print "—" until C24 delivers the approved method (G1/G8), whatever the
// snapshot holds. No standard is named until the owner confirms one.

export const STRENGTH_STANDARDS_LINE = 'Test methods: [to be confirmed by owner]';

export interface StrengthReportRenderInput {
  header: ReportHeaderText;
  template: { name: string; revision: string; provisional: boolean };
  reportNumber: string | null;
  revisionNo: number;
  issuedAt: Date | null;
  supersedes: { revisionNo: number; issuedAt: Date; reason: string | null } | null;
  snapshot: ConcreteStrengthReportSnapshot;
  leadProjectEngineer: string | null;
  reviewedBy: { name: string; at: Date } | null;
  issuedBy: { name: string; at: Date } | null;
  includePhotos: boolean;
  includeMachineInfo: boolean;
  machine: TestingMachineCopy | null;
}

export async function renderStrengthReportPdf(
  input: StrengthReportRenderInput,
): Promise<Uint8Array> {
  const { snapshot } = input;
  const set = snapshot.set;
  const pdf = await ReportPdf.create({
    header: input.header,
    title: 'Concrete Compressive Strength Report',
    reportNumber: input.reportNumber,
    revisionNo: input.revisionNo,
    issuedAt: input.issuedAt,
    templateLabel: `${input.template.name} ${input.template.revision}`,
    provisional: input.template.provisional,
    orientation: 'portrait',
  });
  if (input.supersedes) {
    pdf.paragraph(
      `Rev ${input.revisionNo}, supersedes Rev ${input.supersedes.revisionNo} issued ${formatDate(input.supersedes.issuedAt)}.`,
      { bold: true },
    );
    pdf.paragraph(`Revision reason: ${formatText(input.supersedes.reason)}`);
  }

  pdf.section('Project');
  pdf.fields([
    ['Project number', formatText(snapshot.projectNumber)],
    ['Project name', formatText(snapshot.projectName)],
    ...(snapshot.client && snapshot.client.trim()
      ? [['Client', snapshot.client] as [string, string]]
      : []),
    ['Lead project engineer', formatText(input.leadProjectEngineer)],
  ]);

  pdf.section('Specimen set');
  pdf.fields([
    ['Set ID', formatText(set.label)],
    ['Field report', formatText(set.fieldReportNumber)],
    ['Field ID', formatText(set.paperFieldId)],
    ['Cast', formatDateTime(set.castAt)],
    ['Structure / element', formatText(set.elements)],
    ['Location', formatText(set.location)],
    ['Supplier', formatText(set.supplierName)],
    ['Mix number', formatText(set.mixNumber)],
    [
      'Specified strength',
      set.specifiedStrengthMpa === null
        ? MISSING
        : `${set.specifiedStrengthMpa} MPa${set.specifiedStrengthAgeDays !== null ? ` at ${set.specifiedStrengthAgeDays} d` : ''}`,
    ],
    ['Specimen size', `${set.specimenType}${set.mouldSize ? ` ${set.mouldSize} mm` : ''}`],
    ['Received at the lab', formatDate(set.receivedOn)],
    ['Initial field curing', formatText(set.initialCuring)],
    ['Lab curing', formatText(set.labCuring)],
  ]);

  pdf.section('Results');
  const unitsProvisional = snapshot.specimens.some((s) => s.test?.unitsProvisional);
  pdf.table(
    [
      { header: 'Specimen', width: 1.1 },
      { header: 'Age (d)', width: 0.6, align: 'right' },
      { header: 'Test date', width: 1 },
      { header: 'Actual age (d)', width: 0.7, align: 'right' },
      { header: 'Avg diameter', width: 0.8, align: 'right' },
      { header: 'Avg height', width: 0.8, align: 'right' },
      { header: 'Area', width: 0.6, align: 'right' },
      { header: 'Max load', width: 0.8, align: 'right' },
      { header: 'Strength', width: 0.7, align: 'right' },
      { header: 'Fracture', width: 0.7 },
      { header: 'Tested by', width: 0.6 },
      { header: 'Remarks', width: 1.4 },
    ],
    snapshot.specimens.map((s) => {
      const age = s.assignedAge === 'HOLD' ? 'HOLD' : String(s.assignedAge);
      if (s.assignedAge === 'HOLD' && !s.test) {
        return [
          s.label,
          age,
          'HOLD',
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          'HOLD',
        ];
      }
      if (!s.test) {
        return [
          s.label,
          age,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          MISSING,
          `Not yet tested (target ${formatDate(s.targetDate)})`,
        ];
      }
      const t = s.test;
      return [
        s.label,
        age,
        formatDate(t.testedOn),
        formatNumber(t.actualAgeDays),
        formatNumber(t.averageDiameter, t.dimensionUnit),
        formatNumber(t.averageHeight, t.dimensionUnit),
        // G1/G8 open: never computed or printed until C24.
        MISSING,
        formatNumber(t.maxLoad, t.loadUnit),
        MISSING,
        formatText(t.fractureType),
        formatText(t.testedByInitials),
        formatText(t.remarks),
      ];
    }),
    { empty: 'No specimens in this set.' },
  );
  if (unitsProvisional) {
    pdf.paragraph('Units as stored on the result (kN, mm), provisional until confirmed.', {
      muted: true,
    });
  }

  pdf.section('By age');
  pdf.table(
    [
      { header: 'Age (d)', width: 1, align: 'right' },
      { header: 'Average strength', width: 2 },
      { header: 'Assessment', width: 3 },
    ],
    // Both stay "—" until C24 delivers the approved method (G1/G8).
    snapshot.ageSummaries.map((a) => [String(a.ageDays), MISSING, MISSING]),
    { empty: 'No age tested yet.' },
  );
  pdf.paragraph('Strength, area, averages and assessment are not calculated yet.', { muted: true });
  pdf.paragraph(STRENGTH_STANDARDS_LINE);

  if (input.includeMachineInfo) {
    pdf.section('Testing machine (as registered at issue)');
    if (input.machine) {
      pdf.fields([
        ['Equipment ID', formatText(input.machine.identifier)],
        ['Make', formatText(input.machine.make)],
        ['Model', formatText(input.machine.model)],
        ['Last calibration', formatDate(input.machine.calibratedOn)],
      ]);
    } else {
      pdf.paragraph('No testing machine was registered at issue.', { muted: true });
    }
  }
  if (input.includePhotos) {
    pdf.section('Failure photos');
    pdf.paragraph('No photos are recorded for this report.', { muted: true });
  }

  pdf.signOff([
    [
      'Reviewed by',
      formatText(input.reviewedBy?.name),
      input.reviewedBy ? formatDate(input.reviewedBy.at) : MISSING,
    ],
    [
      'Issued by',
      formatText(input.issuedBy?.name),
      input.issuedBy ? formatDate(input.issuedBy.at) : MISSING,
    ],
  ]);
  return pdf.finish();
}
