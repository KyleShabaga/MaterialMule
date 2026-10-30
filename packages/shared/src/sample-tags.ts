import { z } from 'zod';
import { SAMPLE_TAG_MODES, type SampleTagMode } from './lab-catalogue';
import {
  LAB_PROGRAM_STATUSES,
  LAB_SOURCE_KINDS,
  LINE_SCOPES,
  TEST_REQUEST_STATUSES,
  depthKey,
  sampleIdentityKey,
  type DepthMode,
  type LabProgram,
  type TestRequestStatus,
} from './lab-programs';

// Printable sample ID tags (MM-T69). Tags are derived from a submitted program's current requests
// every time they are shown: nothing is stored and printing changes nothing.
//
// * Only Specific-sample lines get tags; ALL / All grabs / All SPT lines have no individual sample
//   and are listed as untagged instead (owner decision 2026-10-29). Nothing is invented.
// * Cancelled requests are left out. A request's own identity (MM-T26) wins over its line's.
// * A test whose catalogue setting is "no tag" is listed, not tagged. "Own tag" (the default)
//   always gets a tag of its own. "Shared" tests of the same group share one tag, but only for the
//   same sample identity (project + source + full label) at the same depth.

export const SAMPLE_TAG_TIME_ZONE = 'America/Edmonton';

export const sampleTagTestSchema = z.object({
  requestId: z.string(),
  testTypeId: z.string(),
  code: z.string(),
  /** Concise name when the catalogue had one at submission, otherwise the description. */
  name: z.string(),
  status: z.enum(TEST_REQUEST_STATUSES),
});
export type SampleTagTest = z.infer<typeof sampleTagTestSchema>;

export const sampleTagSchema = z.object({
  /** Stable while the program's requests don't change. */
  key: z.string(),
  lineNumbers: z.array(z.number().int()),
  source: z.object({ kind: z.enum(LAB_SOURCE_KINDS), id: z.string(), label: z.string() }),
  sampleLabel: z.string(),
  /** "1.0–1.1 m", "10.0 m". */
  depth: z.string(),
  /** The shared group's name, or null for a test's own tag. */
  tagGroup: z.string().nullable(),
  tests: z.array(sampleTagTestSchema),
  /** At least one test is still Requested or In progress (selected for printing by default). */
  pending: z.boolean(),
});
export type SampleTag = z.infer<typeof sampleTagSchema>;

/** `GET /api/lab-programs/:id/sample-tags`. */
export const sampleTagSheetSchema = z.object({
  program: z.object({
    id: z.string(),
    programNumber: z.string(),
    status: z.enum(LAB_PROGRAM_STATUSES),
    project: z.object({ id: z.string(), projectNumber: z.string(), name: z.string() }),
  }),
  tags: z.array(sampleTagSchema),
  /** Tests on Specific lines whose catalogue setting is "no tag". */
  noTagTests: z.array(
    z.object({
      lineNumber: z.number().int(),
      sampleLabel: z.string(),
      depth: z.string(),
      test: sampleTagTestSchema,
    }),
  ),
  /** ALL / Grabs / SPT lines with tests that would otherwise need a tag. */
  untaggedLines: z.array(
    z.object({
      lineNumber: z.number().int(),
      scope: z.enum(LINE_SCOPES),
      sourceLabel: z.string(),
      tests: z.array(sampleTagTestSchema),
    }),
  ),
});
export type SampleTagSheet = z.infer<typeof sampleTagSheetSchema>;

export const sampleTagRuleSchema = z.object({
  mode: z.enum(SAMPLE_TAG_MODES),
  group: z.string().nullable(),
});
export type SampleTagRule = { mode: SampleTagMode; group: string | null };

const PENDING: readonly TestRequestStatus[] = ['requested', 'in_progress'];

/** At least one decimal, at most two: 10 → "10.0", 1.25 → "1.25". */
function tagNumber(value: number): string {
  const rounded = Number(value.toFixed(2));
  return Number.isInteger(rounded) ? rounded.toFixed(1) : String(rounded);
}

/** "1.5 m", "1.0–1.1 m". */
export function formatTagDepth(depth: {
  depthMode: DepthMode;
  depthFrom: number;
  depthTo: number | null;
  depthUnit: 'ft' | 'm';
}): string {
  if (depth.depthMode === 'interval' && depth.depthTo !== null) {
    return `${tagNumber(depth.depthFrom)}–${tagNumber(depth.depthTo)} ${depth.depthUnit}`;
  }
  return `${tagNumber(depth.depthFrom)} ${depth.depthUnit}`;
}

/** "26-Oct-26": the print date in America/Edmonton, as on the lab's paper tags. */
export function formatTagDate(date: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: SAMPLE_TAG_TIME_ZONE,
    day: '2-digit',
    month: 'short',
    year: '2-digit',
  }).formatToParts(date);
  const part = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return `${part('day')}-${part('month').replace('.', '')}-${part('year')}`;
}

/**
 * Tags for a submitted (or closed) program. `rules` maps test type IDs to their catalogue setting;
 * a test missing from it gets its own tag.
 */
export function buildSampleTags(
  program: Pick<LabProgram, 'id' | 'programNumber' | 'status' | 'project' | 'lines'>,
  rules: ReadonlyMap<string, SampleTagRule>,
): SampleTagSheet {
  const tags = new Map<string, SampleTag>();
  const noTagTests: SampleTagSheet['noTagTests'] = [];
  const untaggedLines: SampleTagSheet['untaggedLines'] = [];

  for (const line of [...program.lines].sort((a, b) => a.lineNumber - b.lineNumber)) {
    const requests = line.requests.filter((r) => r.status !== 'cancelled');
    if (!line.source || requests.length === 0) continue;
    const source = line.source;
    const ruleOf = (testTypeId: string): SampleTagRule =>
      rules.get(testTypeId) ?? { mode: 'own', group: null };
    const toTest = (r: (typeof requests)[number]): SampleTagTest => ({
      requestId: r.id,
      testTypeId: r.testTypeId,
      code: r.code,
      name: r.name ?? r.description,
      status: r.status,
    });

    if (line.scope !== 'specific') {
      const tagged = requests.filter((r) => ruleOf(r.testTypeId).mode !== 'none');
      if (tagged.length > 0) {
        untaggedLines.push({
          lineNumber: line.lineNumber,
          scope: line.scope,
          sourceLabel: source.label,
          tests: tagged.map(toTest),
        });
      }
      continue;
    }

    for (const request of requests) {
      const identity =
        request.identity ??
        (line.sampleLabel !== null &&
        line.depthMode !== null &&
        line.depthFrom !== null &&
        line.depthUnit !== null
          ? {
              sampleLabel: line.sampleLabel,
              depthMode: line.depthMode,
              depthFrom: line.depthFrom,
              depthTo: line.depthTo,
              depthUnit: line.depthUnit,
            }
          : null);
      // A submitted Specific line always has its identity; skip defensively rather than invent.
      if (!identity) continue;
      const depth = formatTagDepth(identity);
      const rule = ruleOf(request.testTypeId);
      const test = toTest(request);
      if (rule.mode === 'none') {
        noTagTests.push({
          lineNumber: line.lineNumber,
          sampleLabel: identity.sampleLabel,
          depth,
          test,
        });
        continue;
      }
      const identityKey = `${sampleIdentityKey(source, identity.sampleLabel)}@${depthKey(depth)}`;
      const groupKey =
        rule.mode === 'shared' && rule.group
          ? `group:${rule.group.trim().toLowerCase()}`
          : `own:${request.id}`;
      const key = `${identityKey}|${groupKey}`;
      const existing = tags.get(key);
      if (existing) {
        existing.tests.push(test);
        if (!existing.lineNumbers.includes(line.lineNumber)) {
          existing.lineNumbers.push(line.lineNumber);
        }
        existing.pending ||= PENDING.includes(test.status);
        continue;
      }
      tags.set(key, {
        key,
        lineNumbers: [line.lineNumber],
        source: { kind: source.kind, id: source.id, label: source.label },
        sampleLabel: identity.sampleLabel,
        depth,
        tagGroup: rule.mode === 'shared' ? rule.group : null,
        tests: [test],
        pending: PENDING.includes(test.status),
      });
    }
  }

  return {
    program: {
      id: program.id,
      programNumber: program.programNumber ?? '',
      status: program.status,
      project: program.project,
    },
    tags: [...tags.values()],
    noTagTests,
    untaggedLines,
  };
}

/** One tag per test (the preview's "split"); never merges and never drops a test. */
export function splitSampleTag(tag: SampleTag): SampleTag[] {
  if (tag.tests.length <= 1) return [tag];
  return tag.tests.map((test) => ({
    ...tag,
    key: `${tag.key}#${test.requestId}`,
    tests: [test],
    pending: PENDING.includes(test.status),
  }));
}

// ---------------------------------------------------------------------------------------------
// Sheet layout: Uline S-15619 insert cards, measured from the supplied template PDF. Letter
// portrait, two columns by five rows of 4 × 2 in cards; inches from the sheet's top-left corner.
// ---------------------------------------------------------------------------------------------

export const TAG_SHEET = {
  widthIn: 8.5,
  heightIn: 11,
  columns: 2,
  rows: 5,
  cardWidthIn: 4,
  cardHeightIn: 2,
  /** Left edge of each column (17 pt and 307 pt in the template). */
  columnLeftIn: [17 / 72, 307 / 72],
  /** Top of the first row (36 pt) and the row pitch (144 pt). */
  topIn: 0.5,
  rowPitchIn: 2,
} as const;

export const TAG_SLOTS_PER_SHEET = TAG_SHEET.columns * TAG_SHEET.rows;

/**
 * Slot position (1–10, left to right then down) to place `count` tags from `startPosition` on the
 * first sheet. Returns sheets of ten slots, each the index of a tag or null for a blank slot.
 */
export function layoutTagSheets(count: number, startPosition = 1): (number | null)[][] {
  const start = Math.min(Math.max(Math.trunc(startPosition) || 1, 1), TAG_SLOTS_PER_SHEET);
  const slots: (number | null)[] = [
    ...Array.from({ length: start - 1 }, () => null),
    ...Array.from({ length: count }, (_, index) => index),
  ];
  const sheets: (number | null)[][] = [];
  for (let offset = 0; offset < slots.length; offset += TAG_SLOTS_PER_SHEET) {
    const sheet = slots.slice(offset, offset + TAG_SLOTS_PER_SHEET);
    while (sheet.length < TAG_SLOTS_PER_SHEET) sheet.push(null);
    sheets.push(sheet);
  }
  return count === 0 ? [] : sheets;
}
