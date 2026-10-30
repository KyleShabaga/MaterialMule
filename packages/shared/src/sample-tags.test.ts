import { describe, expect, it } from 'vitest';
import { createTestTypeRequestSchema, updateTestTypeRequestSchema } from './lab-catalogue';
import type { LabLine, LabProgram, TestRequest } from './lab-programs';
import {
  buildSampleTags,
  formatTagDate,
  formatTagDepth,
  layoutTagSheets,
  splitSampleTag,
  type SampleTagRule,
} from './sample-tags';

// MM-T69 acceptance criteria, proved on the pure tag builder. Fictional data (DEMO-2601, TH26-01).
const MC = 'type-mc';
const VI = 'type-vi';
const ATT = 'type-att';
const HYD = 'type-hyd';
const GS = 'type-gs';
const UNSET = 'type-unset';

const rules = new Map<string, SampleTagRule>([
  [MC, { mode: 'none', group: null }],
  [VI, { mode: 'none', group: null }],
  [ATT, { mode: 'own', group: null }],
  [HYD, { mode: 'shared', group: 'Grain size' }],
  [GS, { mode: 'shared', group: 'grain size ' }],
]);

let nextId = 0;
function request(testTypeId: string, overrides: Partial<TestRequest> = {}): TestRequest {
  nextId += 1;
  return {
    id: `req-${nextId}`,
    testTypeId,
    code: testTypeId.toUpperCase(),
    name: `Name ${testTypeId}`,
    description: `Description ${testTypeId}`,
    groupName: 'Soils',
    subgroupName: null,
    status: 'requested',
    version: 1,
    repeatOfId: null,
    amendmentId: null,
    identityRevision: 0,
    identity: null,
    ...overrides,
  };
}

function line(overrides: Partial<LabLine> & Pick<LabLine, 'requests'>): LabLine {
  return {
    id: `line-${overrides.lineNumber ?? 1}`,
    lineNumber: 1,
    source: { kind: 'test_hole', id: 'hole-1', label: 'TH26-01' },
    scope: 'specific',
    sampleLabel: 'G13',
    depthMode: 'point',
    depthFrom: 10,
    depthTo: null,
    depthUnit: 'm',
    acknowledgedDepths: [],
    tests: [],
    unitIds: [],
    coverage: [],
    coverageCapturedAt: null,
    amendmentId: null,
    ...overrides,
  };
}

function program(lines: LabLine[]): LabProgram {
  return {
    id: 'program-1',
    programNumber: 'LP-2026-0012',
    status: 'submitted',
    priority: 'normal',
    notes: null,
    project: { id: 'project-1', projectNumber: 'DEMO-2601', name: 'Demo Project' },
    createdBy: { userId: 'u', initials: 'AT', name: 'Test AT', accountType: 'test' },
    requestedBy: { userId: 'u', initials: 'AT', name: 'Test AT' },
    createdAt: '2026-10-26T15:00:00Z',
    updatedAt: '2026-10-26T15:00:00Z',
    version: 2,
    submittedAt: '2026-10-26T15:00:00Z',
    submittedBy: null,
    submittedFor: null,
    lines,
  };
}

describe('sample ID tags (MM-T69)', () => {
  it('gives moisture content and VI no tag, and Atterberg and hydrometer separate tags', () => {
    const sheet = buildSampleTags(
      program([line({ requests: [request(MC), request(VI), request(ATT), request(HYD)] })]),
      rules,
    );
    expect(sheet.tags.map((tag) => tag.tests.map((t) => t.testTypeId))).toEqual([[ATT], [HYD]]);
    expect(sheet.noTagTests.map((t) => t.test.testTypeId)).toEqual([MC, VI]);
  });

  it('produces no tag for a sample with only moisture content and VI', () => {
    const sheet = buildSampleTags(program([line({ requests: [request(MC), request(VI)] })]), rules);
    expect(sheet.tags).toEqual([]);
    expect(sheet.noTagTests).toHaveLength(2);
  });

  it('puts every requested test on exactly one tag or the no-tag list', () => {
    const requests = [request(MC), request(ATT), request(HYD), request(GS), request(UNSET)];
    const sheet = buildSampleTags(program([line({ requests })]), rules);
    const placed = [
      ...sheet.tags.flatMap((tag) => tag.tests.map((t) => t.requestId)),
      ...sheet.noTagTests.map((t) => t.test.requestId),
    ];
    expect(placed.sort()).toEqual(requests.map((r) => r.id).sort());
  });

  it('shares a tag only within the same group (ignoring case), sample and depth', () => {
    const sheet = buildSampleTags(
      program([
        line({ lineNumber: 1, requests: [request(GS), request(HYD)] }),
        // Same sample and depth on another line: joins the shared tag.
        line({ lineNumber: 2, requests: [request(HYD)] }),
        // Same label at another depth: its own tag.
        line({ lineNumber: 3, depthFrom: 12, requests: [request(HYD)] }),
      ]),
      rules,
    );
    expect(sheet.tags.map((tag) => [tag.lineNumbers, tag.tests.length, tag.depth])).toEqual([
      [[1, 2], 3, '10.0 m'],
      [[3], 1, '12.0 m'],
    ]);
  });

  it('gives an unconfigured test its own tag, never combined', () => {
    const sheet = buildSampleTags(
      program([line({ requests: [request(UNSET), request(UNSET), request(ATT)] })]),
      new Map(),
    );
    expect(sheet.tags).toHaveLength(3);
  });

  it('keeps identical labels at different sources apart', () => {
    const sheet = buildSampleTags(
      program([
        line({ lineNumber: 1, requests: [request(HYD)] }),
        line({
          lineNumber: 2,
          source: { kind: 'test_hole', id: 'hole-2', label: 'TH26-02' },
          requests: [request(HYD)],
        }),
      ]),
      rules,
    );
    expect(sheet.tags.map((tag) => tag.source.label)).toEqual(['TH26-01', 'TH26-02']);
  });

  it('keeps interval and point depths with units, and uses a request’s own identity', () => {
    const sheet = buildSampleTags(
      program([
        line({
          depthMode: 'interval',
          depthFrom: 1,
          depthTo: 1.1,
          sampleLabel: 'G1',
          requests: [
            request(ATT),
            request(ATT, {
              identity: {
                sampleLabel: 'G2',
                depthMode: 'point',
                depthFrom: 7.5,
                depthTo: null,
                depthUnit: 'ft',
              },
            }),
          ],
        }),
      ]),
      rules,
    );
    expect(sheet.tags.map((tag) => `${tag.sampleLabel} ${tag.depth}`)).toEqual([
      'G1 1.0–1.1 m',
      'G2 7.5 ft',
    ]);
  });

  it('leaves out cancelled requests and lists broad lines as untagged', () => {
    const sheet = buildSampleTags(
      program([
        line({ requests: [request(ATT, { status: 'cancelled' })] }),
        line({
          lineNumber: 2,
          scope: 'all',
          sampleLabel: null,
          depthMode: null,
          depthFrom: null,
          depthUnit: null,
          requests: [request(MC), request(ATT)],
        }),
      ]),
      rules,
    );
    expect(sheet.tags).toEqual([]);
    expect(sheet.untaggedLines).toEqual([
      expect.objectContaining({ lineNumber: 2, scope: 'all', sourceLabel: 'TH26-01' }),
    ]);
    expect(sheet.untaggedLines[0]!.tests.map((t) => t.testTypeId)).toEqual([ATT]);
  });

  it('marks a tag pending while any test is requested or in progress', () => {
    const sheet = buildSampleTags(
      program([
        line({
          requests: [
            request(ATT, { status: 'accepted' }),
            request(HYD, { status: 'completed' }),
            request(GS, { status: 'in_progress' }),
          ],
        }),
      ]),
      rules,
    );
    expect(sheet.tags.map((tag) => tag.pending)).toEqual([false, true]);
  });

  it('splits a shared tag into one tag per test without dropping any', () => {
    const sheet = buildSampleTags(
      program([line({ requests: [request(GS), request(HYD)] })]),
      rules,
    );
    const split = splitSampleTag(sheet.tags[0]!);
    expect(split.map((tag) => tag.tests.length)).toEqual([1, 1]);
    expect(new Set(split.map((tag) => tag.key)).size).toBe(2);
    expect(splitSampleTag(split[0]!)).toEqual([split[0]]);
  });
});

describe('tag formatting and sheet layout (MM-T69)', () => {
  it('formats depth with at least one decimal', () => {
    expect(
      formatTagDepth({ depthMode: 'interval', depthFrom: 0.7, depthTo: 0.8, depthUnit: 'm' }),
    ).toBe('0.7–0.8 m');
    expect(
      formatTagDepth({ depthMode: 'point', depthFrom: 1.25, depthTo: null, depthUnit: 'ft' }),
    ).toBe('1.25 ft');
  });

  it('formats the print date in America/Edmonton', () => {
    // 05:00 UTC on 27 Oct is still 26 Oct in Edmonton.
    expect(formatTagDate(new Date('2026-10-27T05:00:00Z'))).toBe('26-Oct-26');
  });

  it('starts at the chosen position and paginates in order', () => {
    expect(layoutTagSheets(0)).toEqual([]);
    expect(layoutTagSheets(3, 9)).toEqual([
      [null, null, null, null, null, null, null, null, 0, 1],
      [2, null, null, null, null, null, null, null, null, null],
    ]);
    expect(layoutTagSheets(10).flat()).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(layoutTagSheets(1, 99)[0]![9]).toBe(0);
  });
});

describe('catalogue tag setting (MM-T69)', () => {
  const base = {
    groupId: '00000000-0000-4000-8000-00000000c101',
    code: 'DEMO-HYD',
    description: 'Hydrometer',
  };

  it('defaults to own tag and needs a group only when shared', () => {
    expect(createTestTypeRequestSchema.parse(base)).toMatchObject({
      sampleTagMode: 'own',
      sampleTagGroup: null,
    });
    expect(
      createTestTypeRequestSchema.safeParse({ ...base, sampleTagMode: 'shared' }).success,
    ).toBe(false);
    expect(
      createTestTypeRequestSchema.safeParse({
        ...base,
        sampleTagMode: 'none',
        sampleTagGroup: 'Grain size',
      }).success,
    ).toBe(false);
    expect(
      createTestTypeRequestSchema.parse({
        ...base,
        sampleTagMode: 'shared',
        sampleTagGroup: '  Grain size ',
      }).sampleTagGroup,
    ).toBe('Grain size');
  });

  it('refuses a group without a mode on update', () => {
    expect(
      updateTestTypeRequestSchema.safeParse({ version: 1, sampleTagGroup: 'Grain size' }).success,
    ).toBe(false);
    expect(
      updateTestTypeRequestSchema.safeParse({ version: 1, sampleTagMode: 'none' }).success,
    ).toBe(true);
  });
});
