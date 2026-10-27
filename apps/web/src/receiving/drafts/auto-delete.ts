import type { DraftSettings, MeResponse } from '@materialmule/shared';
import { visibleTo, type StoredDraft } from './record';
import type { DraftStore } from './store';

// Automatic clean-up of old drafts on this browser (MM-T45, amends the T11 "never deleted"
// decision). Runs only with a setting fetched successfully from the server and switched on.
// It deletes only drafts this session may see (T11 visibility rules) that haven't been saved for
// more than `afterDays` days, and never a draft in the `confirming` state: its receipt may have
// gone through, and resuming it is the only way to find out.

export type DraftAutoDelete = DraftSettings['draftAutoDelete'];

/** The setting as Receive samples knows it: loaded from the server, or not known. */
export type DraftSettingState = { ok: true; data: DraftSettings } | { ok: false };

const DAY_MS = 86_400_000;

function expired(record: StoredDraft, afterDays: number, now: Date): boolean {
  const saved = Date.parse(record.lastSavedAt);
  return Number.isFinite(saved) && now.getTime() - saved > afterDays * DAY_MS;
}

/** Whether automatic clean-up may delete this record now. */
export function isAutoDeletable(
  record: StoredDraft,
  me: Pick<MeResponse, 'id' | 'accountType'>,
  setting: DraftAutoDelete,
  now = new Date(),
): boolean {
  return (
    setting.enabled &&
    record.status !== 'confirming' &&
    visibleTo(record, me) &&
    expired(record, setting.afterDays, now)
  );
}

/** The drafts automatic clean-up would delete; none unless the setting loaded and is on. */
export function selectAutoDelete(
  drafts: StoredDraft[],
  me: Pick<MeResponse, 'id' | 'accountType'>,
  setting: DraftSettingState,
  now = new Date(),
): StoredDraft[] {
  if (!setting.ok || !setting.data.draftAutoDelete.enabled) return [];
  return drafts.filter((d) => isAutoDeletable(d, me, setting.data.draftAutoDelete, now));
}

/**
 * Deletes the selected drafts and returns how many went. Each record is read again just before
 * it is deleted, so one saved or sent for confirmation in another tab meanwhile is kept.
 */
export async function autoDeleteDrafts(
  store: DraftStore,
  drafts: StoredDraft[],
  me: Pick<MeResponse, 'id' | 'accountType'>,
  setting: DraftSettingState,
  now = new Date(),
): Promise<number> {
  if (!setting.ok) return 0;
  let deleted = 0;
  for (const candidate of selectAutoDelete(drafts, me, setting, now)) {
    const current = await store.get(candidate.draftId);
    if (current && isAutoDeletable(current, me, setting.data.draftAutoDelete, now)) {
      await store.remove(current.draftId);
      deleted++;
    }
  }
  return deleted;
}

/** "2 drafts older than 90 days were deleted from this computer (…)." */
export function autoDeleteNotice(count: number, afterDays: number): string {
  const drafts = count === 1 ? '1 draft' : `${count} drafts`;
  const verb = count === 1 ? 'was' : 'were';
  return `${drafts} older than ${afterDays} days ${verb} deleted from this computer (automatic clean-up set by an administrator).`;
}
