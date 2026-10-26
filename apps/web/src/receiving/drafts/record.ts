import type { MeResponse, ReceiverOption } from '@trapezoid/shared';
import { newUuid, type ReceiptDraft } from '../draft';

// A receiving draft as stored on this workstation (TRP-T11). Drafts live only in this browser's
// IndexedDB: no server copy, no cross-device sync (App Idea §3). They hold business data only,
// never a token or password, and never a storage unit ID (IDs exist only after confirmation).

/** Bump when the record shape changes, and add a step to RECORD_MIGRATIONS. */
export const DRAFT_RECORD_VERSION = 1;

/**
 * Drafts not saved for this long are flagged for review. They are deleted automatically only when
 * an Admin or Lab Manager has turned on draft auto-delete (MM-T45, see auto-delete.ts).
 */
export const STALE_AFTER_DAYS = 30;

export type DraftStatus = 'editing' | 'confirming';
export type DraftStep = 'details' | 'review';

/** "lab" drafts belong to the shared LAB station; "personal" ones to one signed-in person. */
export type DraftOwnerType = 'lab' | 'personal';

/** Who received the samples, as shown when the draft was saved. */
export interface ReceiverSnapshot {
  staffId: string;
  initials: string;
  displayName: string;
}

export type DraftHistoryEntry =
  | { type: 'created'; at: string; accountId: string; receiver: ReceiverSnapshot | null }
  | {
      type: 'receiver_changed';
      at: string;
      /** The signed-in account that made the change (for LAB, the LAB account). */
      accountId: string;
      from: ReceiverSnapshot | null;
      to: ReceiverSnapshot;
    };

export interface StoredDraft {
  version: typeof DRAFT_RECORD_VERSION;
  draftId: string;
  /** Same key as `data.idempotencyKey`; every confirmation attempt reuses it (TRP-T09). */
  idempotencyKey: string;
  owner: { accountId: string; type: DraftOwnerType };
  /** Snapshot of `data.receiver`, for the draft list. */
  receiver: ReceiverSnapshot | null;
  data: ReceiptDraft;
  step: DraftStep;
  /** `confirming` from just before the confirmation request until a definite answer. */
  status: DraftStatus;
  createdAt: string;
  lastSavedAt: string;
  history: DraftHistoryEntry[];
}

export function ownerTypeOf(me: Pick<MeResponse, 'accountType'>): DraftOwnerType {
  return me.accountType === 'shared_lab' ? 'lab' : 'personal';
}

export function snapshotOf(receiver: ReceiverOption | null): ReceiverSnapshot | null {
  return receiver
    ? { staffId: receiver.id, initials: receiver.initials, displayName: receiver.displayName }
    : null;
}

/** A new, not yet saved draft record around wizard data. */
export function newRecord(
  data: ReceiptDraft,
  me: Pick<MeResponse, 'id' | 'accountType'>,
  now = new Date(),
): StoredDraft {
  const at = now.toISOString();
  const receiver = snapshotOf(data.receiver);
  return {
    version: DRAFT_RECORD_VERSION,
    draftId: newUuid(),
    idempotencyKey: data.idempotencyKey,
    owner: { accountId: me.id, type: ownerTypeOf(me) },
    receiver,
    data,
    step: 'details',
    status: 'editing',
    createdAt: at,
    lastSavedAt: at,
    history: [{ type: 'created', at, accountId: me.id, receiver }],
  };
}

/** The receiver according to the history: the last one chosen, or the one it started with. */
export function recordedReceiver(history: DraftHistoryEntry[]): ReceiverSnapshot | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const entry = history[i]!;
    if (entry.type === 'receiver_changed') return entry.to;
    if (entry.type === 'created') return entry.receiver;
  }
  return null;
}

/**
 * New wizard data for a record. Choosing a different receiver adds a history entry (from, to,
 * time, account). Clearing the field on its way to another person isn't a choice, so it adds
 * nothing; the entry is written when someone is picked. Receivers only change through this
 * explicit choice: nothing here or elsewhere reassigns a draft on its own.
 */
export function withData(
  record: StoredDraft,
  data: ReceiptDraft,
  accountId: string,
  now = new Date(),
): StoredDraft {
  const receiver = snapshotOf(data.receiver);
  const recorded = recordedReceiver(record.history);
  const history =
    receiver && receiver.staffId !== recorded?.staffId
      ? [
          ...record.history,
          {
            type: 'receiver_changed' as const,
            at: now.toISOString(),
            accountId,
            from: recorded,
            to: receiver,
          },
        ]
      : record.history;
  return { ...record, data, receiver, idempotencyKey: data.idempotencyKey, history };
}

/** LAB drafts show to LAB sessions on this browser; personal drafts only to the same person. */
export function visibleTo(record: StoredDraft, me: Pick<MeResponse, 'id' | 'accountType'>) {
  return record.owner.type === 'lab'
    ? me.accountType === 'shared_lab'
    : me.accountType !== 'shared_lab' && record.owner.accountId === me.id;
}

export function isStale(record: Pick<StoredDraft, 'lastSavedAt'>, now = new Date()): boolean {
  const saved = Date.parse(record.lastSavedAt);
  return Number.isFinite(saved) && now.getTime() - saved > STALE_AFTER_DAYS * 86_400_000;
}

/** One step per older version: RECORD_MIGRATIONS[n] turns a version-n record into n + 1. */
export type RecordMigrations = Record<number, (record: Record<string, unknown>) => unknown>;

/** Version 1 is the first stored format (TRP-T11), so nothing needs upgrading yet. */
export const RECORD_MIGRATIONS: RecordMigrations = {};

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function looksCurrent(value: Record<string, unknown>): boolean {
  return (
    value.version === DRAFT_RECORD_VERSION &&
    typeof value.draftId === 'string' &&
    typeof value.idempotencyKey === 'string' &&
    isObject(value.owner) &&
    typeof value.owner.accountId === 'string' &&
    (value.owner.type === 'lab' || value.owner.type === 'personal') &&
    isObject(value.data) &&
    Array.isArray(value.data.units) &&
    (value.status === 'editing' || value.status === 'confirming') &&
    typeof value.lastSavedAt === 'string' &&
    Array.isArray(value.history)
  );
}

/**
 * Brings a stored value up to the current record version. Returns null for something this
 * version can't read (a newer format, or damaged); such records are left in storage untouched.
 */
export function upgradeRecord(
  value: unknown,
  migrations: RecordMigrations = RECORD_MIGRATIONS,
): StoredDraft | null {
  let record = value;
  for (let guard = 0; guard <= DRAFT_RECORD_VERSION; guard++) {
    if (!isObject(record) || typeof record.version !== 'number') return null;
    if (record.version === DRAFT_RECORD_VERSION) break;
    const step = migrations[record.version];
    if (record.version > DRAFT_RECORD_VERSION || !step) return null;
    record = step(record);
  }
  return isObject(record) && looksCurrent(record) ? (record as unknown as StoredDraft) : null;
}
