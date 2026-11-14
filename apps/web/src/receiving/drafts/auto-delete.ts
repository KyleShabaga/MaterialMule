import type { DraftSettings, MeResponse } from '@materialmule/shared';
import { visibleTo, type StoredDraft } from './record';
import { closeExpiredDraft } from './ownership';
import type { DraftStore } from './store';

// Automatic clean-up of old drafts on this browser (MM-T45, amends the T11 "never deleted"
// decision). Runs only with a setting fetched successfully from the server and switched on.
// It deletes only drafts this session may see (T11 visibility rules) that haven't been saved for
// more than `afterDays` days, and never a draft in the `confirming` state: its receipt may have
// gone through, and resuming it is the only way to find out.
//
// A deleted draft that the server registry knows about (`registeredAt` set) is then closed there
// as `expired` (migration 0049) so the LAB station stops counting it: only while online, best
// effort, never waited on and never retried. One deleted offline drops out of the station count by
// age instead.

export type DraftAutoDelete = DraftSettings['draftAutoDelete'];

/** The setting as Receive samples knows it: loaded from the server, or not known. */
export type DraftSettingState = { ok: true; data: DraftSettings } | { ok: false };

const DAY_MS = 86_400_000;

function expired(record: StoredDraft, afterDays: number, now: Date): boolean {
  const saved = Date.parse(record.lastSavedAt);
  return Number.isFinite(saved) && now.getTime() - saved > afterDays * DAY_MS;
}

/**
 * Calendar days until automatic clean-up deletes this draft (0 = today, 1 = tomorrow), or null
 * when that is more than a week away, already due, or never (MM-T61).
 */
export function daysUntilAutoDelete(
  record: StoredDraft,
  setting: DraftAutoDelete,
  now = new Date(),
): number | null {
  if (!setting.enabled || record.status === 'confirming') return null;
  const saved = Date.parse(record.lastSavedAt);
  if (!Number.isFinite(saved)) return null;
  const deadline = saved + setting.afterDays * DAY_MS;
  if (deadline < now.getTime()) return null;
  // Calendar days on this computer, so "today" and "tomorrow" mean what they say.
  const days = Math.round((startOfDay(deadline) - startOfDay(now.getTime())) / DAY_MS);
  return days <= 7 ? days : null;
}

function startOfDay(time: number): number {
  const day = new Date(time);
  day.setHours(0, 0, 0, 0);
  return day.getTime();
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

export interface AutoDeleteServer {
  /** Records the clean-up on the server registry; failures are ignored. */
  closeExpired: (draftId: string) => Promise<unknown>;
  /** Whether this browser is online now. */
  online: () => boolean;
}

const httpServer: AutoDeleteServer = {
  closeExpired: closeExpiredDraft,
  online: () => typeof navigator === 'undefined' || navigator.onLine,
};

/**
 * Deletes the selected drafts and returns how many went. Each record is read again just before
 * it is deleted, so one saved or sent for confirmation in another tab meanwhile is kept. A deleted
 * registered draft is closed on the server as `expired` when online (best effort).
 */
export async function autoDeleteDrafts(
  store: DraftStore,
  drafts: StoredDraft[],
  me: Pick<MeResponse, 'id' | 'accountType'>,
  setting: DraftSettingState,
  now = new Date(),
  server: AutoDeleteServer = httpServer,
): Promise<number> {
  if (!setting.ok) return 0;
  let deleted = 0;
  for (const candidate of selectAutoDelete(drafts, me, setting, now)) {
    const current = await store.get(candidate.draftId);
    if (current && isAutoDeletable(current, me, setting.data.draftAutoDelete, now)) {
      await store.remove(current.draftId);
      deleted++;
      if (current.registeredAt && !current.legacy && server.online()) {
        try {
          void server.closeExpired(current.draftId).catch(() => undefined);
        } catch {
          // Best effort: the station count drops it by age anyway.
        }
      }
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
