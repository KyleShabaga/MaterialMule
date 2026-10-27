import type { ReceiverOption } from '@materialmule/shared';
import { describe, expect, it } from 'vitest';
import { newDraft, newSummary, toConfirmRequest } from '../draft';
import {
  DRAFT_RECORD_VERSION,
  RECORD_MIGRATIONS,
  isStale,
  newRecord,
  recordedReceiver,
  upgradeRecord,
  visibleTo,
  withData,
} from './record';

// Draft record and history (MM-T11 T2, part of T1). Fictional people only.

const LAB = { id: '00000000-0000-4000-8000-000000000001', accountType: 'shared_lab' as const };
const AT_ACCOUNT = { id: '00000000-0000-4000-8000-000000000102', accountType: 'test' as const };
const PE_ACCOUNT = { id: '00000000-0000-4000-8000-000000000101', accountType: 'personal' as const };
const AT: ReceiverOption = {
  id: AT_ACCOUNT.id,
  initials: 'AT',
  displayName: 'Alex Tester',
  position: 'technician',
};
const PE: ReceiverOption = {
  id: PE_ACCOUNT.id,
  initials: 'PE',
  displayName: 'Pat Example',
  position: 'pm_pe',
};
const T0 = new Date('2026-10-26T16:00:00.000Z');
const T1 = new Date('2026-10-26T16:42:00.000Z');

describe('draft record (MM-T11)', () => {
  it('starts with a created entry, the owner and the idempotency key of the draft', () => {
    const data = newDraft(null, '2026-10-26');
    const record = newRecord(data, LAB, T0);
    expect(record).toMatchObject({
      version: DRAFT_RECORD_VERSION,
      idempotencyKey: data.idempotencyKey,
      owner: { accountId: LAB.id, type: 'lab' },
      receiver: null,
      status: 'editing',
      step: 'details',
      createdAt: T0.toISOString(),
    });
    expect(record.history).toEqual([
      { type: 'created', at: T0.toISOString(), accountId: LAB.id, receiver: null },
    ]);
    expect(newRecord(data, AT_ACCOUNT).owner.type).toBe('personal');
  });

  it('T2: an explicit receiver change records from, to, time and account', () => {
    const record = newRecord({ ...newDraft(AT, '2026-10-26') }, LAB, T0);
    const changed = withData(record, { ...record.data, receiver: PE }, LAB.id, T1);
    expect(changed.receiver).toEqual({
      staffId: PE.id,
      initials: 'PE',
      displayName: 'Pat Example',
    });
    expect(changed.history.at(-1)).toEqual({
      type: 'receiver_changed',
      at: T1.toISOString(),
      accountId: LAB.id,
      from: { staffId: AT.id, initials: 'AT', displayName: 'Alex Tester' },
      to: { staffId: PE.id, initials: 'PE', displayName: 'Pat Example' },
    });
  });

  it('T2: other edits, clearing the field and re-picking the same person add no entry', () => {
    const record = newRecord(newDraft(AT, '2026-10-26'), LAB, T0);
    const edited = withData(record, { ...record.data, description: 'Two buckets' }, LAB.id, T1);
    const cleared = withData(edited, { ...edited.data, receiver: null }, LAB.id, T1);
    const again = withData(cleared, { ...cleared.data, receiver: AT }, LAB.id, T1);
    expect(again.history).toHaveLength(1);
    expect(cleared.receiver).toBeNull();
    expect(recordedReceiver(cleared.history)?.initials).toBe('AT');

    // Cleared, then someone else: one entry from the last chosen receiver.
    const other = withData(cleared, { ...cleared.data, receiver: PE }, LAB.id, T1);
    expect(other.history).toHaveLength(2);
    expect(other.history[1]).toMatchObject({ from: { initials: 'AT' }, to: { initials: 'PE' } });
  });

  it('T2: a LAB draft started blank records the first choice from nobody', () => {
    const record = newRecord(newDraft(null, '2026-10-26'), LAB, T0);
    const chosen = withData(record, { ...record.data, receiver: AT }, LAB.id, T1);
    expect(chosen.history[1]).toMatchObject({ from: null, to: { initials: 'AT' } });
  });

  it('AC7: LAB drafts show to LAB sessions; personal drafts only to their owner', () => {
    const lab = newRecord(newDraft(null), LAB);
    const mine = newRecord(newDraft(AT), AT_ACCOUNT);
    expect(visibleTo(lab, LAB)).toBe(true);
    expect(visibleTo(lab, AT_ACCOUNT)).toBe(false);
    expect(visibleTo(mine, AT_ACCOUNT)).toBe(true);
    expect(visibleTo(mine, PE_ACCOUNT)).toBe(false);
    expect(visibleTo(mine, LAB)).toBe(false);
  });

  it('flags drafts not saved for over 30 days as stale (never deleted)', () => {
    const now = new Date('2026-12-01T12:00:00.000Z');
    expect(isStale({ lastSavedAt: '2026-10-31T11:59:00.000Z' }, now)).toBe(true);
    expect(isStale({ lastSavedAt: '2026-11-01T12:00:01.000Z' }, now)).toBe(false);
  });

  it('T1: upgrades older records through the migration steps; refuses newer or damaged ones', () => {
    const current = newRecord(newDraft(AT, '2026-10-26'), AT_ACCOUNT, T0);
    expect(upgradeRecord(structuredClone(current))).toEqual(current);

    // A hypothetical version-0 record without history, upgraded by an injected step.
    const { history: _history, ...rest } = current;
    const v0 = { ...rest, version: 0 };
    const upgraded = upgradeRecord(v0, {
      ...RECORD_MIGRATIONS,
      0: (old) => ({ ...old, version: 1, history: [] }),
    });
    expect(upgraded).toEqual({ ...current, history: [] });
  });

  it('MM-T36: a draft saved before Shelby tubes and bulk samples opens as ordinary buckets', () => {
    const current = newRecord(newDraft(AT, '2026-10-26'), AT_ACCOUNT, T0);
    const hole = { id: '00000000-0000-4000-8000-000000000301', projectId: 'p', name: 'TH26-01' };
    // Exactly what version 1 stored for a unit row.
    const v1Unit = {
      clientRowId: 'row-1',
      unitType: 'bucket',
      note: 'Lid taped',
      holeQuery: '',
      summaries: [{ ...newSummary(hole), type: 'all' }],
    };
    const v1 = { ...current, version: 1, data: { ...current.data, units: [v1Unit] } };
    const upgraded = upgradeRecord(structuredClone(v1));
    expect(upgraded?.version).toBe(DRAFT_RECORD_VERSION);
    const unit = upgraded!.data.units[0]!;
    expect(unit).toMatchObject({ ...v1Unit, bulk: false, tube: { sourceType: '' } });
    expect(unit.bulkChoice.kind).toBe('new');
    // It still confirms exactly as before: same payload shape, so the same idempotency hash.
    expect(toConfirmRequest(upgraded!.data).units[0]).toEqual({
      clientRowId: 'row-1',
      unitType: 'bucket',
      note: 'Lid taped',
      holeSummaries: [{ testHoleId: hole.id, type: 'all', note: '' }],
    });
    expect(toConfirmRequest(upgraded!.data)).not.toHaveProperty('bulkGroups');
  });

  it('refuses newer, unknown and damaged records', () => {
    const current = newRecord(newDraft(AT, '2026-10-26'), AT_ACCOUNT, T0);

    expect(upgradeRecord({ ...current, version: DRAFT_RECORD_VERSION + 1 })).toBeNull();
    expect(upgradeRecord({ ...current, version: 0 })).toBeNull(); // no step for it
    expect(upgradeRecord({ ...current, data: null })).toBeNull();
    expect(upgradeRecord('not a draft')).toBeNull();
  });
});
