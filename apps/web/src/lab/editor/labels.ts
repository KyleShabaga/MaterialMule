import {
  formatLineDepth,
  testDisplayName,
  type LabSource,
  type TestType,
} from '@materialmule/shared';
import type { LineDraft } from '../line-draft';
import { numberOrNull } from '../line-draft';

/** "DEMO-MC · Moisture Content" for a catalogue test. */
export function testLabel(test: Pick<TestType, 'code' | 'name' | 'description'>): string {
  return `${test.code} · ${testDisplayName(test)}`;
}

/** The name a test is known by in the Grid's column headings: the concise name, else the code. */
export function testShortName(test: Pick<TestType, 'code' | 'name'>): string {
  return test.name ?? test.code;
}

export const SOURCE_KIND_LABEL: Record<LabSource['kind'], string> = {
  test_hole: 'Test hole',
  standalone_unit: 'Standalone Shelby tube',
  standalone_bulk_group: 'Standalone bulk sample',
};

/** "TH26-01", "Embankment Location 03 · ST-2026-000004"; "No source yet" before one is chosen. */
export function sourceLabel(line: Pick<LineDraft, 'source'>, sources: LabSource[]): string {
  if (!line.source) return 'No source yet';
  return (
    sources.find((s) => s.kind === line.source!.kind && s.id === line.source!.id)?.label ??
    SOURCE_KIND_LABEL[line.source.kind]
  );
}

/** What the line asks for: "ALL", "All grabs (G)", or "G3 at 1.5–3 m". */
export function sampleSummary(line: LineDraft, scopeLabel: string): string {
  if (line.scope !== 'specific') return scopeLabel;
  const depth = formatLineDepth({
    depthMode: line.depthMode,
    depthFrom: numberOrNull(line.depthFrom),
    depthTo: line.depthMode === 'interval' ? numberOrNull(line.depthTo) : null,
    depthUnit: line.depthUnit,
  });
  const label = line.sampleLabel.trim() || 'Sample';
  return depth ? `${label} at ${depth}` : label;
}
