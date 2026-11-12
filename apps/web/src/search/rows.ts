import {
  CONCRETE_SEARCH_MATCH_LABEL,
  LAB_PROGRAM_STATUS_STAGE,
  STORAGE_UNIT_RECORD_STATUS_LABELS,
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  currentLocationName,
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  locationKindLabel,
  storageUnitTypeLabel,
  type ConcreteSearch,
  type InventoryItem,
  type LabProgramSummary,
  type ProjectSummary,
  type ReceiptLogItem,
  type StageKey,
  type StorageLocation,
  type StorageUnitRecordStatus,
} from '@materialmule/shared';

// Rows of the search results page and the Ctrl K menu: what each kind of record says about
// itself. Test holes are found through their storage units; samples are matched by the units'
// SAMPLE#/DEPTH summaries and sample references, since receiving keeps no individual sample
// inventory.

export interface ResultTag {
  label: string;
  stage: StageKey;
}

export interface ResultRow {
  key: string;
  /** The record as people write it (unit ID, project number), in mono. */
  id: string;
  title: string;
  sub: string;
  tag: ResultTag | null;
  href: string;
}

/** A storage unit row: its own columns (ID, project, test holes, where, stage). */
export interface UnitRow {
  key: string;
  id: string;
  projectNumber: string;
  projectName: string;
  type: string;
  contents: string;
  where: string;
  stage: ResultTag;
  href: string;
}

export const PROGRAM_TAG: Record<LabProgramSummary['status'], ResultTag> = {
  draft: { label: 'Draft', stage: LAB_PROGRAM_STATUS_STAGE.draft },
  submitted: { label: 'In progress', stage: LAB_PROGRAM_STATUS_STAGE.submitted },
  closed: { label: 'Closed', stage: LAB_PROGRAM_STATUS_STAGE.closed },
};

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

function recordStatusTag(status: StorageUnitRecordStatus): ResultTag {
  return {
    label: STORAGE_UNIT_RECORD_STATUS_LABELS[status],
    stage: STORAGE_UNIT_RECORD_STATUS_STAGE[status],
  };
}

/**
 * A storage unit's stage, as a record status word and its stage colour (DESIGN.md › Inventory,
 * round 3: "In lab, Short-term, Long-term, Retention due, Retention overdue, Disposed, Location
 * conflict"). STRATA-58: the server derives both from the unit's real state and sends them on
 * every inventory row; the screen never guesses. A row from a server without them (an older
 * build) reads Disposed when it is, otherwise In storage.
 */
export function unitStage(
  unit: Pick<InventoryItem, 'status' | 'recordStatus' | 'stage'>,
): ResultTag {
  if (unit.recordStatus) {
    return {
      label: STORAGE_UNIT_RECORD_STATUS_LABELS[unit.recordStatus],
      stage: unit.stage ?? STORAGE_UNIT_RECORD_STATUS_STAGE[unit.recordStatus],
    };
  }
  if (unit.status === 'disposed') return recordStatusTag('disposed');
  return { label: 'In storage', stage: unit.stage ?? 'storage' };
}

export function unitContents(unit: InventoryItem): string {
  return unit.sample
    ? formatSampleIdentity(unit.sample)
    : unit.holes
        .map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`)
        .join(', ');
}

export function unitRow(unit: InventoryItem): UnitRow {
  return {
    key: unit.id,
    id: unit.readableId,
    projectNumber: unit.project.projectNumber,
    projectName: unit.project.name,
    type: storageUnitTypeLabel(unit.unitType),
    contents: unitContents(unit),
    where: currentLocationName(unit),
    stage: unitStage(unit),
    href: `/sample-storage/${encodeURIComponent(unit.readableId)}`,
  };
}

/** Test holes whose name contains the query, found through the units that hold their samples. */
export function testHoleRows(units: InventoryItem[], q: string): ResultRow[] {
  const needle = q.toLowerCase();
  const holes = new Map<
    string,
    { name: string; project: InventoryItem['project']; units: number }
  >();
  for (const unit of units) {
    for (const hole of unit.holes) {
      if (!hole.testHoleName.toLowerCase().includes(needle)) continue;
      const found = holes.get(hole.testHoleId);
      if (found) found.units += 1;
      else holes.set(hole.testHoleId, { name: hole.testHoleName, project: unit.project, units: 1 });
    }
  }
  return [...holes.entries()].map(([id, hole]) => ({
    key: id,
    id: hole.name,
    title: `Test hole on ${hole.project.projectNumber}`,
    sub: `${plural(hole.units, 'storage unit')} found`,
    tag: null,
    href: `/sample-storage?${new URLSearchParams({ projectId: hole.project.id, testHoleId: id }).toString()}`,
  }));
}

export function projectRow(project: ProjectSummary): ResultRow {
  return {
    key: project.id,
    id: project.projectNumber,
    title: project.name,
    sub: project.client,
    tag: null,
    href: `/projects/${project.id}`,
  };
}

export function shelfRow(location: StorageLocation): ResultRow {
  return {
    key: location.id,
    id: location.code,
    title: location.name,
    sub: `${plural(location.inStockCount, 'unit')} · ${locationKindLabel(location.kind)}`,
    tag: location.active ? null : { label: 'Retired', stage: 'closed' },
    href: `/sample-storage/locations/${encodeURIComponent(location.code)}`,
  };
}

/** Receipts get no number of their own: they are named by date and receiver (round 3). */
export function receiptRow(receipt: ReceiptLogItem): ResultRow {
  return {
    key: receipt.id,
    id: receipt.project.projectNumber,
    title: `Receipt ${receipt.receivedDate} · ${receipt.receiver.name}`,
    sub: plural(receipt.quantity, 'storage unit'),
    tag: null,
    href: `/receiving-log/${encodeURIComponent(receipt.id)}`,
  };
}

export function programRow(program: LabProgramSummary): ResultRow {
  return {
    key: program.id,
    id: program.programNumber ?? 'Draft',
    title: `${program.project.projectNumber} · ${program.project.name}`,
    sub: `${plural(program.testCount, 'test')} · requested by ${program.requestedBy.name}`,
    // The server's stage (STRATA-58) colours the tag; the words follow the status.
    tag: {
      ...PROGRAM_TAG[program.status],
      stage: program.stage ?? PROGRAM_TAG[program.status].stage,
    },
    href: `/lab-testing/programs/${encodeURIComponent(program.id)}`,
  };
}

/**
 * Concrete specimen sets, by the ID they carry today (temporary or permanent) on their field
 * report. Set numbering is an open gate (package 3): nothing here allocates or implies one.
 */
export function concreteSetRows(result: ConcreteSearch): ResultRow[] {
  return result.items.flatMap((report): ResultRow[] => {
    const report_ = report.paperFieldId ? `Field report ${report.paperFieldId}` : 'Field report';
    const matched = `Matched on ${report.matches.map((m) => CONCRETE_SEARCH_MATCH_LABEL[m]).join(', ')}`;
    if (report.sets.length === 0) {
      // A report without sets yet still shows, through its project's Concrete section.
      return [
        {
          key: report.fieldReportId,
          id: report.paperFieldId ?? 'Field report',
          title: `${report.projectNumber} · ${report.projectName}`,
          sub: [report.castingDate ? `Cast ${report.castingDate}` : null, matched]
            .filter(Boolean)
            .join(' · '),
          tag: null,
          href: `/projects/${encodeURIComponent(report.projectId)}/concrete`,
        },
      ];
    }
    return report.sets.map((set) => ({
      key: set.setId,
      id: `${set.identity.permanentId ?? set.identity.temporaryId ?? 'Unnumbered set'}${
        set.matched && result.letter ? result.letter : ''
      }`,
      title: `${report.projectNumber} · ${report.projectName}`,
      sub: [
        report_,
        report.castingDate ? `cast ${report.castingDate}` : null,
        plural(set.specimenCount, 'specimen'),
        matched,
      ]
        .filter(Boolean)
        .join(' · '),
      tag: set.voided ? { label: 'Void', stage: 'closed' } : null,
      href: `/concrete/specimens/${encodeURIComponent(set.setId)}${
        set.matched && result.letter ? `?letter=${result.letter}` : ''
      }`,
    }));
  });
}
