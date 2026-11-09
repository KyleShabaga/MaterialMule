import type {
  ConcreteFieldReading,
  ConcreteFieldReportFields,
  ConcreteMixSnapshot,
  ConcreteSpecimenSetDetail,
  PersonSnapshot,
} from '@materialmule/shared';
import {
  formatDate,
  formatDateTime,
  formatNumber,
  formatText,
  formatYesNo,
  MISSING,
  ReportPdf,
  type Cell,
  type ReportHeaderText,
} from './pdf-layout.js';

// MM-V2-C32: the concrete field report, template revision P1 (provisional design, section 3).
// Everything printed comes from the frozen C09 version snapshot and the values copied at issue;
// nothing is re-read from live records. Only fields the report records are printed (no weather,
// departure time or exposure class: the record has none). Missing values print "—", never 0 or
// No; out-of-range readings are marked ⚠ with a legend and printed as recorded.

/** What a field report version freezes (C09 snapshotOf + C05 specimen sets). */
export interface FieldReportSnapshot {
  kind: 'field';
  versionNo: number;
  reportId: string;
  projectNumber: string;
  projectName: string;
  client: string | null;
  technician: PersonSnapshot | null;
  fields: ConcreteFieldReportFields;
  mixSnapshot: ConcreteMixSnapshot | null;
  specimenSets?: Omit<ConcreteSpecimenSetDetail, 'canEdit'>[];
}

export interface TestingMachineCopy {
  identifier: string | null;
  make: string | null;
  model: string | null;
  calibratedOn: string | null;
  nextDueOn: string | null;
}

export interface FieldReportRenderInput {
  header: ReportHeaderText;
  template: { name: string; revision: string; provisional: boolean };
  /** Null for a preview (never stored). */
  reportNumber: string | null;
  revisionNo: number;
  issuedAt: Date | null;
  /** The issue this revision supersedes, and why it was revised. */
  supersedes: { revisionNo: number; issuedAt: Date; reason: string | null } | null;
  snapshot: FieldReportSnapshot;
  leadProjectEngineer: string | null;
  reviewedBy: { name: string; at: Date } | null;
  issuedBy: { name: string; at: Date } | null;
  /** The reviewer's exception notes on this version (C28). */
  exceptionNotes: { label: string; note: string; by: string; at: Date }[];
  includePhotos: boolean;
  includeMachineInfo: boolean;
  /** The testing machine as registered at issue (C27), when included; null: none registered. */
  machine: TestingMachineCopy | null;
}

const SAMPLING: Record<string, string> = {
  chute: 'Chute',
  end_of_pump: 'End of pump',
  hopper: 'Hopper',
  other: 'Other',
};
const PLACEMENT: Record<string, string> = {
  chute: 'Chute',
  pump: 'Pump',
  extruder: 'Extruder',
  crane_bucket: 'Crane bucket',
  wheel_barrow: 'Wheel barrow',
  other: 'Other',
};
const MATERIAL: Record<string, string> = {
  concrete: 'Concrete',
  epoxy_grout: 'Epoxy grout',
  cementitious_grout: 'Cementitious grout',
  cellular_concrete: 'Cellular concrete',
  scc: 'Self-consolidating concrete',
};
const CONTEXT: Record<string, string> = {
  initial: 'Initial',
  retest: 'Retest',
  after_superplasticizer: 'After superplasticizer',
  after_water: 'After water added',
};
const SP: Record<string, string> = {
  on_site: 'On site',
  at_plant: 'At plant',
  none: 'No SP',
};

export function slumpOutOfRange(
  value: number | null,
  spec: ConcreteFieldReportFields['projectSpec'],
): boolean {
  return (
    value !== null &&
    spec.slumpTargetMm !== null &&
    spec.slumpToleranceMm !== null &&
    Math.abs(value - spec.slumpTargetMm) > spec.slumpToleranceMm + 1e-9
  );
}

export function airOutOfRange(
  value: number | null,
  spec: ConcreteFieldReportFields['projectSpec'],
): boolean {
  return (
    value !== null &&
    ((spec.airMinPercent !== null && value < spec.airMinPercent) ||
      (spec.airMaxPercent !== null && value > spec.airMaxPercent))
  );
}

function elementsOf(fields: ConcreteFieldReportFields): string {
  const parts = [...(fields.locationElements ?? [])].filter((e) => e !== 'Other');
  if (fields.locationElementOther) parts.push(fields.locationElementOther);
  return parts.length ? parts.join(', ') : MISSING;
}

function choice(map: Record<string, string>, value: string | null, other?: string | null) {
  if (value === null || value === undefined) return MISSING;
  if (value === 'other' && other) return `Other: ${other}`;
  return map[value] ?? value;
}

function readingCell(
  reading: ConcreteFieldReading | undefined,
  spec: ConcreteFieldReportFields['projectSpec'],
): Cell {
  if (!reading || reading.value === null) return MISSING;
  const warn =
    reading.test === 'slump'
      ? slumpOutOfRange(reading.value, spec)
      : airOutOfRange(reading.value, spec);
  return { text: String(reading.value), warn };
}

export function setLabel(set: {
  identity: { permanentId: string | null; temporaryId: string | null };
}) {
  return set.identity.permanentId ?? set.identity.temporaryId ?? MISSING;
}

function agesOf(set: Omit<ConcreteSpecimenSetDetail, 'canEdit'>): string {
  if (set.specimens.length === 0) return MISSING;
  return set.specimens
    .map((s) => `${s.letter} ${s.assignedAge === 'HOLD' ? 'HOLD' : `${s.assignedAge} d`}`)
    .join(', ');
}

export async function renderFieldReportPdf(input: FieldReportRenderInput): Promise<Uint8Array> {
  const { snapshot } = input;
  const f = snapshot.fields;
  const spec = f.projectSpec;
  const sets = (snapshot.specimenSets ?? []).filter((s) => s.void === null);
  const pdf = await ReportPdf.create({
    header: input.header,
    title: 'Concrete Field Report',
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
    ['Contractor', formatText(f.contractorName)],
  ]);

  pdf.section('Placement');
  pdf.fields([
    ['Field ID', formatText(f.paperFieldId)],
    ['Placement date', formatDate(f.reportDate)],
    ['Technician', formatText(snapshot.technician?.name)],
    ['Material', choice(MATERIAL, f.material)],
    ['Arrived', formatDateTime(f.arrivedAt)],
    ['Sampled', formatDateTime(f.sampledAt)],
    ['Tested', formatDateTime(f.testedAt)],
    ['Cast', formatDateTime(f.castAt)],
    ['Ambient temperature', formatNumber(f.ambientTempC, '°C')],
    ['Structure / element', elementsOf(f)],
    ['Location', formatText(f.locationDescription)],
    ['Sampling location', choice(SAMPLING, f.samplingLocation, f.samplingLocationOther)],
    [
      'Placement method',
      f.placementMethods.length
        ? f.placementMethods
            .map((m) =>
              m === 'other' && f.placementMethodOther
                ? `Other: ${f.placementMethodOther}`
                : (PLACEMENT[m] ?? m),
            )
            .join(', ')
        : MISSING,
    ],
    ['Time limit exceeded', formatYesNo(f.timeLimitExceeded)],
    ...(f.timeLimitExceeded
      ? [['Informed', formatText(f.timeLimitInformed)] as [string, string]]
      : []),
    ['Load decision', f.loadRejected === null ? MISSING : f.loadRejected ? 'Rejected' : 'Accepted'],
    [
      'Decided by',
      f.loadDecisionByName || f.loadDecisionByCompany
        ? [f.loadDecisionByName, f.loadDecisionByCompany].filter(Boolean).join(', ')
        : MISSING,
    ],
  ]);

  pdf.section('Mix');
  const mix = input.snapshot.mixSnapshot;
  pdf.fields([
    ['Supplier', formatText(f.supplierName)],
    ['Plant', formatText(f.plantName)],
    ['Mix number', formatText(f.mixNumber)],
    [
      'Mix registry',
      mix
        ? `Revision ${mix.revisionNumber}${mix.revisionState === 'draft' ? ' (not approved when chosen)' : ''}`
        : 'Not in the project registry',
    ],
    [
      'Specified strength',
      spec.specifiedStrengthMpa === null
        ? MISSING
        : `${spec.specifiedStrengthMpa} MPa${spec.specifiedStrengthAgeDays !== null ? ` at ${spec.specifiedStrengthAgeDays} d` : ''}`,
    ],
    ['Nominal max aggregate', formatNumber(spec.maxAggregateSizeMm, 'mm')],
    [
      'Specified slump',
      spec.slumpTargetMm === null
        ? MISSING
        : `${spec.slumpTargetMm}${spec.slumpToleranceMm !== null ? ` ± ${spec.slumpToleranceMm}` : ''} mm`,
    ],
    [
      'Specified air',
      spec.airMinPercent === null && spec.airMaxPercent === null
        ? MISSING
        : `${spec.airMinPercent ?? MISSING} – ${spec.airMaxPercent ?? MISSING} %`,
    ],
    ['Cement type', formatText(spec.cementType)],
    ['Superplasticizer', choice(SP, f.superplasticizerAdded)],
  ]);

  pdf.section('Load sampled');
  const initial = (test: 'slump' | 'air') =>
    f.readings.find((r) => r.test === test && r.context === 'initial');
  pdf.table(
    [
      { header: 'Ticket', width: 1.2 },
      { header: 'Truck', width: 0.8 },
      { header: 'Load m³', width: 0.7, align: 'right' },
      { header: 'Cumulative m³', width: 1.05, align: 'right' },
      { header: 'Batched', width: 1.3 },
      { header: 'Slump mm', width: 0.8, align: 'right' },
      { header: 'Air %', width: 0.7, align: 'right' },
      { header: 'Concrete °C', width: 0.8, align: 'right' },
      { header: 'Density kg/m³', width: 0.9, align: 'right' },
      { header: 'Water added', width: 1.1 },
      { header: 'Sets cast', width: 1.35 },
    ],
    [
      [
        formatText(f.ticketNumber),
        formatText(f.truckNumber),
        formatNumber(f.loadVolumeM3),
        formatNumber(f.cumulativeVolumeM3),
        formatDateTime(f.batchedAt),
        readingCell(initial('slump'), spec),
        readingCell(initial('air'), spec),
        formatNumber(f.concreteTempC),
        formatNumber(f.unitWeightKgM3),
        f.waterAdded === true && f.waterAddedAuthorizedBy
          ? `Yes (authorized by ${f.waterAddedAuthorizedBy})`
          : formatYesNo(f.waterAdded),
        sets.length
          ? sets
              .map((s) => `${setLabel(s)} (${s.specimens.map((x) => x.letter).join('')})`)
              .join(', ')
          : MISSING,
      ],
    ],
  );

  if (f.readings.length > 0) {
    pdf.section('Slump and air readings');
    const ordered = [...f.readings].sort((a, b) =>
      a.test === b.test ? a.position - b.position : a.test === 'slump' ? -1 : 1,
    );
    pdf.table(
      [
        { header: 'Test', width: 0.8 },
        { header: 'Reading', width: 1.4 },
        { header: 'Time', width: 1.2 },
        { header: 'Value', width: 0.9, align: 'right' },
        { header: 'Note', width: 2.7 },
      ],
      ordered.map((r) => [
        r.test === 'slump' ? 'Slump (mm)' : 'Air (%)',
        CONTEXT[r.context] ?? r.context,
        r.context === 'initial' ? formatDateTime(f.testedAt) : formatDateTime(r.measuredAt),
        readingCell(r, spec),
        formatText(r.note),
      ]),
    );
  }
  if (pdf.anyWarning) {
    pdf.legend("Reading outside the mix's specified range. The value is printed as recorded.");
  }

  pdf.section('Specimens cast');
  pdf.table(
    [
      { header: 'Set ID', width: 1.2 },
      { header: 'Type and size', width: 1.3 },
      { header: 'Specimens', width: 0.8, align: 'right' },
      { header: 'Assigned ages', width: 3.7 },
    ],
    sets.map((s) => [
      setLabel(s),
      `${s.specimenType.charAt(0).toUpperCase()}${s.specimenType.slice(1)}${s.mouldSize ? ` ${s.mouldSize} mm` : ''}`,
      String(s.specimenCount),
      agesOf(s),
    ]),
    { empty: f.specimensCast === false ? 'No specimens cast.' : 'No specimens recorded.' },
  );

  pdf.section('Remarks and exceptions');
  pdf.fields(
    [
      ['Technician remarks', formatText(f.comments)],
      [
        'Results reported to',
        f.resultsReportedToName || f.resultsReportedToCompany
          ? [f.resultsReportedToName, f.resultsReportedToCompany].filter(Boolean).join(', ')
          : MISSING,
      ],
    ],
    1,
  );
  if (input.exceptionNotes.length > 0) {
    pdf.paragraph('Reviewer exception notes:', { bold: true });
    for (const note of input.exceptionNotes) {
      pdf.paragraph(`${note.label}: ${note.note} (${note.by}, ${formatDate(note.at)})`);
    }
  } else {
    pdf.paragraph('Reviewer exception notes: none.', { muted: true });
  }

  if (input.includeMachineInfo) {
    pdf.section('Testing machine (as registered at issue)');
    if (input.machine) {
      pdf.fields([
        ['Equipment ID', formatText(input.machine.identifier)],
        ['Make', formatText(input.machine.make)],
        ['Model', formatText(input.machine.model)],
        ['Last calibration', formatDate(input.machine.calibratedOn)],
        ['Next calibration due', formatDate(input.machine.nextDueOn)],
      ]);
    } else {
      pdf.paragraph('No testing machine was registered at issue.', { muted: true });
    }
  }
  if (input.includePhotos) {
    pdf.section('Photos');
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
