import type { DraftSettings } from '@materialmule/shared';
import { describe, expect, it, vi } from 'vitest';
import { newDraft } from '../draft';
import {
  autoDeleteDrafts,
  autoDeleteNotice,
  selectAutoDelete,
  type DraftSettingState,
} from './auto-delete';
import { newRecord, type StoredDraft } from './record';
import type { DraftStore } from './store';

// Draft auto-delete selection (MM-T45 T1). Fictional accounts only.

const LAB = { id: '00000000-0000-4000-8000-000000000001', accountType: 'shared_lab' as const };
const AT = { id: '00000000-0000-4000-8000-000000000102', accountType: 'test' as const };
const PE = { id: '00000000-0000-4000-8000-000000000101', accountType: 'personal' as const };
const NOW = new Date('2027-03-01T12:00:00.000Z');
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

const on = (afterDays = 90): DraftSettingState => ({
  ok: true,
  data: { draftAutoDelete: { enabled: true, afterDays }, version: 2 } satisfies DraftSettings,
});
const off: DraftSettingState = {
  ok: true,
  data: { draftAutoDelete: { enabled: false, afterDays: 90 }, version: 1 },
};

function draft(owner: typeof LAB | typeof AT | typeof PE, savedDaysAgo: number): StoredDraft {
  return newRecord(newDraft(null, '2026-10-26'), owner, daysAgo(savedDaysAgo));
}

function memoryStore(records: StoredDraft[]): DraftStore & { ids(): string[] } {
  const map = new Map(records.map((r) => [r.draftId, r]));
  return {
    list: async () => ({ drafts: [...map.values()], unreadable: 0 }),
    get: async (id) => map.get(id) ?? null,
    put: async (record) => void map.set(record.draftId, record),
    remove: async (id) => void map.delete(id),
    ids: () => [...map.keys()],
  };
}

describe('selectAutoDelete (MM-T45)', () => {
  it('picks visible drafts last saved more than afterDays ago', () => {
    const old = draft(AT, 91);
    const exactly = draft(AT, 90);
    const recent = draft(AT, 40);
    expect(selectAutoDelete([old, exactly, recent], AT, on(90), NOW)).toEqual([old]);
    expect(selectAutoDelete([old, exactly, recent], AT, on(30), NOW)).toEqual([
      old,
      exactly,
      recent,
    ]);
  });

  it('AC3: never picks a draft in the confirming state', () => {
    const confirming = { ...draft(AT, 400), status: 'confirming' as const };
    expect(selectAutoDelete([confirming], AT, on(30), NOW)).toEqual([]);
  });

  it('follows T11 visibility: personal drafts for their owner only, LAB drafts for LAB only', () => {
    const mine = draft(AT, 200);
    const someoneElses = draft(PE, 200);
    const lab = draft(LAB, 200);
    const all = [mine, someoneElses, lab];
    expect(selectAutoDelete(all, AT, on(), NOW)).toEqual([mine]);
    expect(selectAutoDelete(all, PE, on(), NOW)).toEqual([someoneElses]);
    expect(selectAutoDelete(all, LAB, on(), NOW)).toEqual([lab]);
  });

  it('AC1/AC7: picks nothing when the setting is off or could not be loaded', () => {
    const old = draft(AT, 400);
    expect(selectAutoDelete([old], AT, off, NOW)).toEqual([]);
    expect(selectAutoDelete([old], AT, { ok: false }, NOW)).toEqual([]);
  });

  it('ignores a draft with an unreadable save time', () => {
    const odd = { ...draft(AT, 400), lastSavedAt: 'not a date' };
    expect(selectAutoDelete([odd], AT, on(), NOW)).toEqual([]);
  });
});

describe('autoDeleteDrafts (MM-T45)', () => {
  it('deletes the selection and counts it', async () => {
    const old = draft(AT, 120);
    const recent = draft(AT, 10);
    const store = memoryStore([old, recent]);
    expect(await autoDeleteDrafts(store, [old, recent], AT, on(), NOW)).toBe(1);
    expect(store.ids()).toEqual([recent.draftId]);
  });

  it('keeps a draft that was saved or sent for confirmation since the list was read', async () => {
    const saved = draft(AT, 120);
    const confirming = draft(AT, 120);
    const store = memoryStore([
      { ...saved, lastSavedAt: NOW.toISOString() },
      { ...confirming, status: 'confirming' },
    ]);
    expect(await autoDeleteDrafts(store, [saved, confirming], AT, on(), NOW)).toBe(0);
    expect(store.ids()).toHaveLength(2);
  });

  it('touches nothing when the setting could not be loaded', async () => {
    const old = draft(AT, 400);
    const store = memoryStore([old]);
    const remove = vi.spyOn(store, 'remove');
    expect(await autoDeleteDrafts(store, [old], AT, { ok: false }, NOW)).toBe(0);
    expect(remove).not.toHaveBeenCalled();
  });
});

describe('autoDeleteNotice', () => {
  it('says how many drafts went and why', () => {
    expect(autoDeleteNotice(2, 90)).toBe(
      '2 drafts older than 90 days were deleted from this computer (automatic clean-up set by an administrator).',
    );
    expect(autoDeleteNotice(1, 30)).toBe(
      '1 draft older than 30 days was deleted from this computer (automatic clean-up set by an administrator).',
    );
  });
});
