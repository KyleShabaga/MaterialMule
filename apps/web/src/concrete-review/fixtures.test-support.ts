import {
  CONCRETE_FIELD_REPORT_DRAFT_FIELDS,
  CONCRETE_REPORT_SPEC_EMPTY,
  concreteFieldReportDetailSchema,
  type ConcreteFieldReportDetail,
  type ConcreteReportVersionDetail,
  type ConcreteReportVersionSummary,
  type MeResponse,
} from '@materialmule/shared';

// MM-V2-C28 web tests: fictional field reports (DEMO-2601), reviewers and versions.

export const PEOPLE = {
  tech: { userId: '00000000-0000-4000-8000-0000000000a1', initials: 'AT', name: 'Alex Tester' },
  rv: { userId: '00000000-0000-4000-8000-0000000000a2', initials: 'RR', name: 'Riley Reviewer' },
  pe: { userId: '00000000-0000-4000-8000-0000000000a3', initials: 'PE', name: 'Pat Example' },
  js: { userId: '00000000-0000-4000-8000-0000000000a4', initials: 'JS', name: 'Jordan Smith' },
};

export const REPORT_ID = '00000000-0000-4000-8000-0000000000b1';
export const PROJECT_ID = '00000000-0000-4000-8000-0000000000c1';
export const READING_ID = '00000000-0000-4000-8000-0000000000d1';

export const me = (
  person: keyof typeof PEOPLE,
  overrides: Partial<MeResponse> = {},
): MeResponse => ({
  id: PEOPLE[person].userId,
  displayName: PEOPLE[person].name,
  initials: PEOPLE[person].initials,
  accountType: 'personal',
  status: 'active',
  roles: [],
  permissions: ['inventory.read'],
  sessionExpiresAt: '2026-11-09T06:00:00.000Z',
  ...overrides,
});

export function fields(overrides: Record<string, unknown> = {}) {
  const base = Object.fromEntries(
    CONCRETE_FIELD_REPORT_DRAFT_FIELDS.map((f) => [
      f,
      f === 'locationElements' || f === 'placementMethods' ? [] : null,
    ]),
  );
  return {
    ...base,
    reportDate: '2026-11-08',
    supplierName: 'Example Ready-Mix',
    mixNumber: '0042',
    ticketNumber: 'T-100',
    truckNumber: 'T-7',
    mixId: null,
    projectSpec: { ...CONCRETE_REPORT_SPEC_EMPTY, slumpTargetMm: 80, slumpToleranceMm: 30 },
    ticketSpec: CONCRETE_REPORT_SPEC_EMPTY,
    readings: [
      {
        id: READING_ID,
        test: 'slump',
        context: 'initial',
        position: 1,
        value: 130,
        measuredAt: null,
        note: null,
      },
    ],
    attachmentRefs: [],
    ...overrides,
  };
}

const WARNINGS = [
  {
    code: 'slump_out_of_range' as const,
    field: `readings.${READING_ID}.value`,
    message: 'Slump 130 mm is outside 80 ± 30 mm',
  },
];

export function versionSummary(
  versionNo: number,
  overrides: Partial<ConcreteReportVersionSummary> = {},
): ConcreteReportVersionSummary {
  return {
    id: `00000000-0000-4000-8000-00000000e00${versionNo}`,
    versionNo,
    state: 'submitted',
    revisionOfVersionNo: null,
    snapshotSha256: 'ab12cd34ef56ab12cd34ef56',
    submittedAt: '2026-11-08T18:00:00.000Z',
    submittedBy: PEOPLE.tech,
    submittedStaff: PEOPLE.tech,
    route: { kind: 'designated_reviewers', routedTo: null, reason: null },
    review: null,
    closed: null,
    issued: null,
    ...overrides,
  };
}

export function versionDetail(
  versionNo: number,
  snapshotFields: Record<string, unknown>,
  overrides: Partial<ConcreteReportVersionSummary> = {},
  warnings = WARNINGS,
): ConcreteReportVersionDetail {
  return {
    ...versionSummary(versionNo, overrides),
    reportId: REPORT_ID,
    snapshot: {
      kind: 'field',
      versionNo,
      projectNumber: 'DEMO-2601',
      projectName: 'Fictional project',
      client: 'Example Client',
      technician: PEOPLE.tech,
      fields: snapshotFields,
      mixSnapshot: null,
      airMeterUse: null,
      specimenSets: [],
      warnings,
    },
  };
}

export function detail(
  overrides: {
    state?: ConcreteFieldReportDetail['lifecycle']['state'];
    allowedActions?: ConcreteFieldReportDetail['lifecycle']['allowedActions'];
    latest?: ConcreteReportVersionSummary;
    technician?: typeof PEOPLE.tech;
    warnings?: typeof WARNINGS;
  } = {},
): ConcreteFieldReportDetail {
  const state = overrides.state ?? 'submitted';
  return concreteFieldReportDetailSchema.parse({
    id: REPORT_ID,
    projectId: PROJECT_ID,
    projectNumber: 'DEMO-2601',
    projectName: 'Fictional project',
    client: 'Example Client',
    version: 4,
    createdAt: '2026-11-08T17:00:00.000Z',
    updatedAt: '2026-11-08T18:00:00.000Z',
    createdBy: PEOPLE.tech,
    technician: overrides.technician ?? PEOPLE.tech,
    workflow: {
      state: state === 'issued' ? 'reviewed' : state,
      readyToSubmitAt: null,
      submittedAt: '2026-11-08T18:00:00.000Z',
    },
    issuance: {
      status: 'not_issued',
      issueCount: 0,
      lastIssuedVersion: null,
      lastIssuedAt: null,
      lastIssuedByUserId: null,
    },
    fields: fields(),
    mixSnapshot: null,
    manualSpecChanges: { projectSpec: [], ticketSpec: [] },
    airMeterUse: null,
    duplicateTickets: [],
    completeness: { complete: true, missingRequired: [] },
    review: {
      missingRequired: [],
      warnings: overrides.warnings ?? WARNINGS,
      deferredChecks: [{ code: 'ticket_attachment_acknowledged', owner: 'C15' }],
    },
    reviewRouting: {
      scope: 'concrete_field',
      designatedReviewers: [PEOPLE.rv],
      leadProjectEngineer: PEOPLE.pe,
      blocked: null,
    },
    canEdit: false,
    lifecycle: {
      state,
      revised: false,
      latestVersion: overrides.latest ?? versionSummary(1),
      latestIssuedVersionNo: null,
      reviewCounted: false,
      labManagerCorrection: false,
      allowedActions: overrides.allowedActions ?? ['review', 'return'],
    },
  });
}

export function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}
