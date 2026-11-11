import {
  currentLocationName,
  formatSampleIdentity,
  formatStorageUnitHoleSummary,
  storageUnitStatusLabel,
  storageUnitTypeLabel,
  type InventoryItem,
  type LabProgramSummary,
  type StorageUnitStatus,
} from '@materialmule/shared';
import type { BadgeTone } from '../components/ui';

// Rows of the search results page: what each kind of record says about itself. Test holes are
// found through their storage units; samples are matched by the units' SAMPLE#/DEPTH summaries
// and sample references, since receiving keeps no individual sample inventory.

export interface ResultRow {
  key: string;
  /** The record as people write it (unit ID, project number), in mono. */
  id: string;
  title: string;
  sub: string;
  tag: { label: string; tone: BadgeTone };
  href: string;
}

const STATUS_TONE: Record<StorageUnitStatus, BadgeTone> = {
  in_stock: 'storage',
  approved_for_disposal: 'waiting',
  disposed: 'closed',
};

export const PROGRAM_TAG: Record<LabProgramSummary['status'], { label: string; tone: BadgeTone }> =
  {
    draft: { label: 'Draft', tone: 'waiting' },
    submitted: { label: 'In progress', tone: 'lab' },
    closed: { label: 'Closed', tone: 'closed' },
  };

export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function unitRow(unit: InventoryItem): ResultRow {
  const contents = unit.sample
    ? formatSampleIdentity(unit.sample)
    : unit.holes
        .map((hole) => `${hole.testHoleName}: ${formatStorageUnitHoleSummary(hole)}`)
        .join(', ');
  return {
    key: unit.id,
    id: unit.readableId,
    title: `${storageUnitTypeLabel(unit.unitType)} · ${unit.project.projectNumber}`,
    sub: [contents, currentLocationName(unit)].filter(Boolean).join(' · '),
    tag: { label: storageUnitStatusLabel(unit.status), tone: STATUS_TONE[unit.status] },
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
    tag: { label: 'Test hole', tone: 'closed' },
    href: `/sample-storage?${new URLSearchParams({ projectId: hole.project.id, testHoleId: id }).toString()}`,
  }));
}
