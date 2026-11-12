import { describe, expect, it } from 'vitest';
import {
  DEFAULT_SIDEBAR_LAYOUT,
  SIDEBAR_SECTION_IDS,
  normalizeSidebarLayout,
  sidebarRecordRefSchema,
  updateSidebarLayoutSchema,
} from './sidebar';
import {
  STORAGE_UNIT_RECORD_STATUS_STAGE,
  STORAGE_UNIT_RECORD_STATUSES,
  storageUnitStage,
  workStageLabel,
  type StorageUnitStatusFacts,
} from './stage';
import {
  DEFAULT_USER_PREFERENCES,
  TABLE_COLUMN_REGISTRY,
  normalizeHiddenColumns,
  normalizeUserPreferences,
  updateUserPreferencesSchema,
} from './user-preferences';
import {
  INBOX_UPDATE_KINDS,
  REQUEST_TASK_LABELS,
  inboxBadgeText,
  inboxItemSchema,
  inboxQuerySchema,
  requestStage,
  requestTitle,
  updateTitle,
} from './inbox';
import { ACTION_REQUEST_KINDS } from './action-requests';
import { undoRequestSchema } from './undo';
import { initialsFromName, personPhotoUrl } from './people';

// Fictional data only (DEMO-2601, TH26-01, Pat Example).

const shelf: StorageUnitStatusFacts = {
  disposed: false,
  openConflict: false,
  inLab: false,
  awaitingPutAway: false,
  storageTerm: null,
  retentionDue: false,
  retentionOverdue: false,
};

describe('STRATA-58 stage', () => {
  it('maps every record status to a stage', () => {
    for (const status of STORAGE_UNIT_RECORD_STATUSES) {
      expect(STORAGE_UNIT_RECORD_STATUS_STAGE[status]).toBeTruthy();
    }
  });

  it('derives the record status in rule order', () => {
    expect(storageUnitStage(shelf)).toEqual({ recordStatus: 'short_term', stage: 'storage' });
    expect(storageUnitStage({ ...shelf, storageTerm: 'long_term' }).recordStatus).toBe('long_term');
    expect(storageUnitStage({ ...shelf, awaitingPutAway: true })).toEqual({
      recordStatus: 'received',
      stage: 'draft',
    });
    expect(storageUnitStage({ ...shelf, inLab: true }).stage).toBe('lab');
    expect(storageUnitStage({ ...shelf, inLab: true, retentionDue: true }).recordStatus).toBe(
      'retention_due',
    );
    expect(storageUnitStage({ ...shelf, retentionDue: true, retentionOverdue: true }).stage).toBe(
      'danger',
    );
    expect(storageUnitStage({ ...shelf, openConflict: true, retentionOverdue: true })).toEqual({
      recordStatus: 'location_conflict',
      stage: 'danger',
    });
    expect(storageUnitStage({ ...shelf, disposed: true, openConflict: true }).stage).toBe('closed');
  });

  it('writes work tags as "<Stage> · <domain>"', () => {
    expect(workStageLabel('due', 'retention')).toBe('Due · Retention');
    expect(workStageLabel('draft', 'receipt')).toBe('Draft · Receipt');
    expect(workStageLabel('danger', 'correction')).toBe('Urgent · Correction');
  });
});

describe('STRATA-41 sidebar layout', () => {
  it('defaults to every section shown, Recent and Retention folded', () => {
    expect(normalizeSidebarLayout(undefined)).toEqual(DEFAULT_SIDEBAR_LAYOUT);
    expect(DEFAULT_SIDEBAR_LAYOUT.folded).toEqual(['recent', 'retention']);
  });

  it('drops unknown and duplicate ids and appends missing sections', () => {
    const layout = normalizeSidebarLayout({
      order: ['concrete', 'nope', 'concrete', 'pinned'],
      hidden: ['recent', 'today', 'recent'],
      folded: ['soils', 'retention', 42],
    });
    expect(layout.order).toEqual(['concrete', 'pinned', 'recent', 'storage_units', 'soils']);
    expect(layout.order).toHaveLength(SIDEBAR_SECTION_IDS.length);
    expect(layout.hidden).toEqual(['recent']);
    expect(layout.folded).toEqual(['soils', 'retention']);
  });

  it('keeps an explicit empty fold list (everything open)', () => {
    expect(normalizeSidebarLayout({ folded: [] }).folded).toEqual([]);
  });

  it('refuses fixed rows and unknown ids in a PUT', () => {
    expect(
      updateSidebarLayoutSchema.safeParse({ order: ['today'], hidden: [], folded: [], version: 0 })
        .success,
    ).toBe(false);
    expect(
      updateSidebarLayoutSchema.safeParse({
        order: ['pinned'],
        hidden: [],
        folded: [],
        version: 0,
        userId: 'someone',
      }).success,
    ).toBe(false);
  });

  it('pins and recents use a stable kind and UUID', () => {
    expect(
      sidebarRecordRefSchema.safeParse({
        kind: 'storage_unit',
        id: '00000000-0000-4000-8000-000000000014',
      }).success,
    ).toBe(true);
    expect(
      sidebarRecordRefSchema.safeParse({ kind: 'storage_unit', id: 'BKT-2026-000014' }).success,
    ).toBe(false);
    expect(
      sidebarRecordRefSchema.safeParse({ kind: 'page', id: '00000000-0000-4000-8000-000000000014' })
        .success,
    ).toBe(false);
  });
});

describe('STRATA-29 preferences and STRATA-51 columns', () => {
  it('falls back field by field', () => {
    expect(normalizeUserPreferences(null)).toEqual(DEFAULT_USER_PREFERENCES);
    const prefs = normalizeUserPreferences({ theme: 'dark', dateFormat: 'nope', extra: 1 });
    expect(prefs.theme).toBe('dark');
    expect(prefs.dateFormat).toBe('iso');
    expect(prefs).not.toHaveProperty('extra');
    expect(DEFAULT_USER_PREFERENCES.shareInboxOnStations).toBe(false);
  });

  it('PATCH needs a version and at least one field', () => {
    expect(updateUserPreferencesSchema.safeParse({ version: 0 }).success).toBe(false);
    expect(updateUserPreferencesSchema.safeParse({ theme: 'dark' }).success).toBe(false);
    expect(updateUserPreferencesSchema.safeParse({ theme: 'dark', version: 3 }).success).toBe(true);
    expect(
      updateUserPreferencesSchema.safeParse({ theme: 'dark', version: 3, labTimeZone: 'UTC' })
        .success,
    ).toBe(false);
  });

  it('never hides required columns', () => {
    expect(normalizeHiddenColumns('inbox', ['task', 'title', 'job_number', 'from', 'x'])).toEqual([
      'from',
    ]);
    expect(normalizeHiddenColumns('inventory', undefined)).toEqual(['retain_until']);
    const required = TABLE_COLUMN_REGISTRY.inbox.filter((c) => c.required).map((c) => c.id);
    expect(required).toEqual(['task', 'title', 'job_number']);
  });
});

describe('STRATA-25/55/57 inbox', () => {
  it('has a task label for every request kind and folds opened notices into requests', () => {
    for (const kind of ACTION_REQUEST_KINDS) expect(REQUEST_TASK_LABELS[kind]).toBeTruthy();
    expect(INBOX_UPDATE_KINDS).not.toContain('action_request.opened');
  });

  it('words titles from structured facts, with plurals', () => {
    expect(
      requestTitle({
        kind: 'closure_request',
        projectNumber: 'DEMO-2601',
        programNumber: 'LP-001',
      }),
    ).toBe('Closure requested for LP-001');
    expect(
      requestTitle({
        kind: 'retention_request',
        projectNumber: 'DEMO-2601',
        retentionKind: 'hold',
        retentionScope: 'units',
        retentionUnits: 1,
      }),
    ).toBe('Hold requested for DEMO-2601 · 1 unit');
    expect(
      requestTitle({
        kind: 'retention_request',
        projectNumber: 'DEMO-2601',
        retentionKind: 'extension',
        retentionScope: 'units',
        retentionUnits: 4,
      }),
    ).toBe('Retention extension requested for DEMO-2601 · 4 units');
    expect(updateTitle('action_request.decided', null)).toBe('A request');
    expect(updateTitle('concrete_test.failed')).toBe('Failed concrete test');
  });

  it('gives open corrections the act-now stage and resolved requests closed', () => {
    expect(requestStage('correction', 'open')).toBe('danger');
    expect(requestStage('closure_request', 'open')).toBe('due');
    expect(requestStage('correction', 'resolved')).toBe('closed');
  });

  it('validates the feed query and refuses unknown sorts', () => {
    expect(inboxQuerySchema.parse({})).toMatchObject({ tab: 'all', sort: 'newest', page: 1 });
    expect(inboxQuerySchema.parse({ filter: 'unread,waiting_on_me' }).filter).toEqual([
      'unread',
      'waiting_on_me',
    ]);
    expect(inboxQuerySchema.safeParse({ sort: 'id; DROP TABLE x' }).success).toBe(false);
    expect(inboxQuerySchema.safeParse({ filter: 'everything' }).success).toBe(false);
  });

  it('carries the job number as a field, null for non-project items', () => {
    const update = {
      key: 'update:1',
      sourceId: '1',
      task: 'Failed test',
      title: 'Failed concrete test',
      projectId: null,
      jobNumber: null,
      record: null,
      from: null,
      receivedAt: '2026-11-12T16:00:00Z',
      unread: true,
      stage: 'danger',
      domain: 'concrete',
      href: '/concrete',
      type: 'update',
      kind: 'concrete_test.failed',
      dismissed: false,
      aboutMyRequest: false,
      linkedRequestStatus: null,
    };
    expect(inboxItemSchema.parse(update).jobNumber).toBeNull();
    expect(inboxItemSchema.safeParse({ ...update, kind: 'action_request.opened' }).success).toBe(
      false,
    );
  });

  it('shows the badge as nothing, a number or 9+', () => {
    expect(inboxBadgeText(0)).toBeNull();
    expect(inboxBadgeText(3)).toBe('3');
    expect(inboxBadgeText(12)).toBe('9+');
  });
});

describe('STRATA-123 undo and STRATA-52 photos', () => {
  it('only accepts implemented undo actions', () => {
    const base = {
      sourceId: '00000000-0000-4000-8000-000000000001',
      idempotencyKey: '00000000-0000-4000-8000-000000000002',
    };
    expect(undoRequestSchema.safeParse({ ...base, action: 'move' }).success).toBe(true);
    expect(undoRequestSchema.safeParse({ ...base, action: 'disposal' }).success).toBe(false);
    expect(undoRequestSchema.safeParse({ ...base, action: 'test_completion' }).success).toBe(false);
  });

  it('builds photo URLs and initials', () => {
    expect(personPhotoUrl('abc')).toBe('/api/people/abc/photo');
    expect(initialsFromName('Pat Example')).toBe('PE');
    expect(initialsFromName('  ')).toBe('?');
  });
});
