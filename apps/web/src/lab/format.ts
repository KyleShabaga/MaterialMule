import {
  LINE_SCOPE_LABEL,
  formatLineDepth,
  type LabLine,
  type TestRequest,
} from '@materialmule/shared';

/** One line's heading: "TH26-01 · ALL" or "TH26-01 · G3 at 7.5 ft". */
export function lineTitle(line: LabLine): string {
  const source = line.source?.label ?? 'No source';
  if (line.scope !== 'specific') return `${source} · ${LINE_SCOPE_LABEL[line.scope]}`;
  const depth = formatLineDepth(line);
  return `${source} · ${line.sampleLabel ?? '?'}${depth ? ` at ${depth}` : ''}`;
}

export function requestName(request: Pick<TestRequest, 'code' | 'name' | 'description'>): string {
  return `${request.code} · ${request.name ?? request.description}`;
}
