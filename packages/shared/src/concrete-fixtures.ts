import type { ConcreteFieldReport, ConcreteSpecimen, ConcreteSpecimenSet } from './concrete';

// MM-V2-C01: fictional concrete fixtures for contract tests and later cards. People and the
// project are the dev fixtures (apps/api/seed/dev.sql: DEMO-2601, Alex Tester, Pat Example, the
// LAB account); the device code D07 and every concrete ID are invented. Not loaded into any
// database.

const DEMO_2601 = '00000000-0000-4000-8000-000000000201';
const LAB = '00000000-0000-4000-8000-000000000001';
const ALEX_TESTER = '00000000-0000-4000-8000-000000000102';
const PAT_EXAMPLE = '00000000-0000-4000-8000-000000000101';
const CREATED = '2026-11-07T15:00:00.000Z';
const UPDATED = '2026-11-07T16:30:00.000Z';

const notIssued = {
  status: 'not_issued',
  issueCount: 0,
  lastIssuedVersion: null,
  lastIssuedAt: null,
  lastIssuedByUserId: null,
} as const;

function specimen(
  id: string,
  setId: string,
  letter: string,
  setIds: { temporaryId: string | null; permanentId: string | null },
): ConcreteSpecimen {
  return {
    id,
    projectId: DEMO_2601,
    setId,
    letter,
    identity: {
      temporaryId: setIds.temporaryId && `${setIds.temporaryId}${letter}`,
      permanentId: setIds.permanentId && `${setIds.permanentId}${letter}`,
    },
    version: 1,
    createdAt: CREATED,
    updatedAt: CREATED,
  };
}

/** Just started on a phone: nothing filled in, no technician yet, no specimens, no numbers. */
const emptyDraft: ConcreteFieldReport = {
  id: '00000000-0000-4000-8000-00000000c101',
  projectId: DEMO_2601,
  version: 1,
  createdAt: CREATED,
  updatedAt: CREATED,
  createdByUserId: ALEX_TESTER,
  technicianUserId: null,
  completeness: { complete: false, missingRequired: ['technician', 'fieldTestDate'] },
  workflow: { state: 'draft', readyToSubmitAt: null, submittedAt: null },
  issuance: notIssued,
  sets: [],
};

const TEMP_SET = '00000000-0000-4000-8000-00000000c201';
const temporaryIds = { temporaryId: 'TMP-D07-001', permanentId: null };
const temporarySet: ConcreteSpecimenSet = {
  id: TEMP_SET,
  projectId: DEMO_2601,
  fieldReportId: '00000000-0000-4000-8000-00000000c102',
  identity: { temporaryId: 'TMP-D07-001', permanentId: null, permanentNumber: null },
  specimens: [
    specimen('00000000-0000-4000-8000-00000000c301', TEMP_SET, 'A', temporaryIds),
    specimen('00000000-0000-4000-8000-00000000c302', TEMP_SET, 'B', temporaryIds),
  ],
  version: 1,
  createdAt: CREATED,
  updatedAt: CREATED,
};

/** Ready to submit offline, entered at a LAB station for Alex: a temporary set, no number yet. */
const draftWithTemporarySet: ConcreteFieldReport = {
  ...emptyDraft,
  id: '00000000-0000-4000-8000-00000000c102',
  createdByUserId: LAB,
  technicianUserId: ALEX_TESTER,
  version: 3,
  updatedAt: UPDATED,
  completeness: { complete: true, missingRequired: [] },
  workflow: { state: 'ready_to_submit', readyToSubmitAt: UPDATED, submittedAt: null },
  sets: [temporarySet],
};

/** The same report after the server attached permanent ID 26-01: every UUID is unchanged. */
const numberedIds = { temporaryId: 'TMP-D07-001', permanentId: '26-01' };
const withPermanentAlias: ConcreteFieldReport = {
  ...draftWithTemporarySet,
  version: 4,
  workflow: {
    state: 'submitted',
    readyToSubmitAt: UPDATED,
    submittedAt: '2026-11-07T17:00:00.000Z',
  },
  sets: [
    {
      ...temporarySet,
      version: 2,
      identity: { temporaryId: 'TMP-D07-001', permanentId: '26-01', permanentNumber: 1 },
      specimens: temporarySet.specimens.map((s) => specimen(s.id, TEMP_SET, s.letter, numberedIds)),
    },
  ],
};

/** Reviewed, and version 5 issued once by the project's lead. */
const issued: ConcreteFieldReport = {
  ...withPermanentAlias,
  version: 5,
  workflow: { ...withPermanentAlias.workflow, state: 'reviewed' },
  issuance: {
    status: 'issued',
    issueCount: 1,
    lastIssuedVersion: 5,
    lastIssuedAt: '2026-11-08T09:00:00.000Z',
    lastIssuedByUserId: PAT_EXAMPLE,
  },
};

export const CONCRETE_FIXTURES = {
  emptyDraft,
  draftWithTemporarySet,
  withPermanentAlias,
  issued,
} as const;
