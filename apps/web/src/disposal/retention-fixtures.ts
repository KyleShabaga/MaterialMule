import type {
  RetentionDecisionUnit,
  RetentionPipeline,
  RetentionPipelineUnit,
} from '@materialmule/shared';

// Fictional fixtures for the Retention page and decision drawer tests (DEMO-2601, DEMO-2610).

export const LEAD = { userId: 'u-pe', initials: 'PE', name: 'Pat Example' };

export function pipelineUnit(
  n: number,
  overrides: Partial<RetentionPipelineUnit> = {},
): RetentionPipelineUnit {
  return {
    storageUnitId: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`,
    readableId: `BKT-2026-${String(n).padStart(6, '0')}`,
    unitType: 'bucket',
    status: 'in_stock',
    version: 1,
    project: { id: 'p1', projectNumber: 'DEMO-2610', name: 'Hillcrest reservoir', lead: LEAD },
    holes: ['TH26-01'],
    location: { code: 'WH-A-B1-S2', name: 'Warehouse A bay 1 shelf 2' },
    receivedDate: '2025-11-04',
    minimumRetainUntil: '2026-11-04',
    effectiveRetainUntil: '2026-11-04',
    band: 'overdue',
    hold: null,
    extensionCount: 0,
    requestWaiting: false,
    eligible: true,
    programOpen: false,
    retentionExempt: false,
    blockers: [],
    listEntry: null,
    approval: null,
    disposal: null,
    canDecide: true,
    canApprove: true,
    ...overrides,
  };
}

export function decisionUnit(
  n: number,
  overrides: Partial<RetentionDecisionUnit> = {},
): RetentionDecisionUnit {
  return { ...pipelineUnit(n), listBlockers: [], ...overrides };
}

export function pipeline(overrides: Partial<RetentionPipeline> = {}): RetentionPipeline {
  return {
    asOf: '2026-11-11',
    tab: 'coming',
    counts: { coming: 3, eligible: 1, list: 9, approved: 5, disposed: 214, tested: 0 },
    bandCounts: { overdue: 2, month: 1, later: 0 },
    rows: [],
    total: 0,
    page: 1,
    pageSize: 100,
    tested: [],
    canRequest: true,
    ...overrides,
  };
}
