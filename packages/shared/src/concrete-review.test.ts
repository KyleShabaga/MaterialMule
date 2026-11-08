import { describe, expect, it } from 'vitest';
import {
  concreteExceptionNoteRequestSchema,
  concreteReportIssueRequestSchema,
  concreteReviewChecklist,
  concreteReviewOpenExceptions,
  concreteReviewQueueQuerySchema,
  concreteSnapshotChanged,
  diffConcreteReportSnapshots,
  type ConcreteExceptionNote,
} from './concrete-review';

// MM-V2-C28: queue query, the review checklist (AC1) and the change comparison (AC3). Fictional
// values only.

const KEY = '7f0c2c0e-4b8e-4c43-9a51-3d7d6f1b2a10';
const PERSON = { userId: '11111111-1111-4111-8111-111111111111', initials: 'RR', name: 'Riley' };

const note = (
  code: ConcreteExceptionNote['code'],
  field: string | null,
): ConcreteExceptionNote => ({
  id: '22222222-2222-4222-8222-222222222222',
  versionNo: 1,
  code,
  field,
  note: 'Accepted by the engineer',
  documentedBy: PERSON,
  documentedAt: '2026-11-08T18:00:00.000Z',
});

describe('concreteReviewQueueQuerySchema', () => {
  it('defaults to awaiting review, page 1, everyone’s rows', () => {
    expect(concreteReviewQueueQuerySchema.parse({})).toMatchObject({
      status: 'awaiting_review',
      exceptions: 'any',
      mine: false,
      page: 1,
      pageSize: 25,
    });
  });

  it('reads query-string booleans and numbers', () => {
    expect(
      concreteReviewQueueQuerySchema.parse({ mine: 'true', page: '2', status: 'issued' }),
    ).toMatchObject({ mine: true, page: 2, status: 'issued' });
  });

  it('refuses unknown statuses, report types and reversed date ranges', () => {
    expect(concreteReviewQueueQuerySchema.safeParse({ status: 'draft' }).success).toBe(false);
    expect(concreteReviewQueueQuerySchema.safeParse({ reportType: 'strength' }).success).toBe(
      false,
    );
    expect(concreteReviewQueueQuerySchema.safeParse({ mine: 'yes' }).success).toBe(false);
    const reversed = concreteReviewQueueQuerySchema.safeParse({
      submittedFrom: '2026-11-09',
      submittedTo: '2026-11-08',
    });
    expect(reversed.success).toBe(false);
  });
});

describe('concreteReviewChecklist (AC1)', () => {
  const submitted = [
    { code: 'slump_out_of_range' as const, field: 'readings.a.value', message: 'Slump 130 mm' },
    { code: 'duplicate_ticket' as const, field: 'ticketNumber', message: 'On 1 other report' },
    { code: 'air_meter_flag' as const, field: 'airMeterEquipmentId', message: 'Overdue' },
    { code: 'air_meter_flag' as const, field: 'airMeterEquipmentId', message: 'No calibration' },
  ];

  it('starts with every exception open and groups messages per code and field', () => {
    const items = concreteReviewChecklist({ submitted, live: submitted, notes: [] });
    expect(items.map((i) => [i.code, i.status])).toEqual([
      ['slump_out_of_range', 'open'],
      ['duplicate_ticket', 'open'],
      ['air_meter_flag', 'open'],
    ]);
    expect(items[2]!.messages).toEqual(['Overdue', 'No calibration']);
    expect(concreteReviewOpenExceptions(items)).toHaveLength(3);
  });

  it('resolves an exception the live report no longer raises, and documents noted ones', () => {
    const items = concreteReviewChecklist({
      submitted,
      live: submitted.filter((w) => w.code !== 'duplicate_ticket'),
      notes: [note('slump_out_of_range', 'readings.a.value')],
    });
    expect(items.map((i) => i.status)).toEqual(['documented', 'resolved', 'open']);
    expect(items[0]!.note?.note).toBe('Accepted by the engineer');
    expect(concreteReviewOpenExceptions(items).map((i) => i.code)).toEqual(['air_meter_flag']);
  });

  it('never resolves by live recheck when the live report is another version', () => {
    const items = concreteReviewChecklist({ submitted, live: null, notes: [] });
    expect(items.every((i) => i.status === 'open')).toBe(true);
  });

  it('a note for another field documents nothing', () => {
    const items = concreteReviewChecklist({
      submitted: submitted.slice(0, 1),
      live: submitted.slice(0, 1),
      notes: [note('slump_out_of_range', 'readings.b.value')],
    });
    expect(items[0]!.status).toBe('open');
  });

  it('a version without exceptions has nothing to resolve', () => {
    expect(concreteReviewChecklist({ submitted: [], live: [], notes: [] })).toEqual([]);
  });
});

describe('diffConcreteReportSnapshots (AC3)', () => {
  const base = () => ({
    versionNo: 1,
    fields: {
      ticketNumber: 'T-1',
      projectSpec: { slumpTargetMm: 80, slumpToleranceMm: 30 },
      readings: [
        { id: 'r1', test: 'slump', value: 130 },
        { id: 'r2', test: 'air', value: 6 },
      ],
    },
    mixSnapshot: null,
    warnings: [{ code: 'slump_out_of_range' }],
  });

  it('reports nothing for v1 or an unchanged resubmission', () => {
    expect(diffConcreteReportSnapshots(null, base())).toEqual([]);
    expect(diffConcreteReportSnapshots(base(), { ...base(), versionNo: 2, warnings: [] })).toEqual(
      [],
    );
  });

  it('marks only the changed leaves', () => {
    const next = base();
    next.fields.ticketNumber = 'T-2';
    next.fields.projectSpec.slumpToleranceMm = 40;
    next.fields.readings[0]!.value = 100;
    const changes = diffConcreteReportSnapshots(base(), next);
    expect(changes).toEqual([
      { path: 'fields.ticketNumber', before: 'T-1', after: 'T-2' },
      { path: 'fields.projectSpec.slumpToleranceMm', before: 30, after: 40 },
      { path: 'fields.readings.r1.value', before: 130, after: 100 },
    ]);
    expect(concreteSnapshotChanged(changes, 'fields.readings.r1')).toBe(true);
    expect(concreteSnapshotChanged(changes, 'fields.readings.r2')).toBe(false);
    expect(concreteSnapshotChanged(changes, 'fields.truckNumber')).toBe(false);
  });

  it('matches list items by id: an added or removed reading is one change', () => {
    const next = base();
    next.fields.readings = [
      { id: 'r2', test: 'air', value: 6 },
      { id: 'r3', test: 'slump', value: 95 },
    ];
    const changes = diffConcreteReportSnapshots(base(), next);
    expect(changes.map((c) => c.path)).toEqual(['fields.readings.r1', 'fields.readings.r3']);
    expect(changes[0]!.after).toBeNull();
    expect(changes[1]!.before).toBeNull();
  });

  it('treats a whole mix snapshot swap as changes under mixSnapshot', () => {
    const next = { ...base(), mixSnapshot: { mixId: 'm1', revision: 2 } };
    expect(diffConcreteReportSnapshots(base(), next).map((c) => c.path)).toEqual(['mixSnapshot']);
  });
});

describe('request schemas', () => {
  it('an exception note needs text', () => {
    expect(
      concreteExceptionNoteRequestSchema.safeParse({ code: 'unknown_mix', field: null, note: ' ' })
        .success,
    ).toBe(false);
    expect(
      concreteExceptionNoteRequestSchema.parse({
        code: 'unknown_mix',
        field: 'mixNumber',
        note: ' Mix confirmed with the supplier ',
      }).note,
    ).toBe('Mix confirmed with the supplier');
  });

  it('issue needs the machine-info choice and refuses photos until C15', () => {
    expect(
      concreteReportIssueRequestSchema.safeParse({ idempotencyKey: KEY, version: 3 }).success,
    ).toBe(false);
    expect(
      concreteReportIssueRequestSchema.parse({
        idempotencyKey: KEY,
        version: 3,
        includeMachineInfo: true,
      }),
    ).toMatchObject({ includePhotos: false, includeMachineInfo: true });
    expect(
      concreteReportIssueRequestSchema.safeParse({
        idempotencyKey: KEY,
        version: 3,
        includeMachineInfo: false,
        includePhotos: true,
      }).success,
    ).toBe(false);
  });
});
