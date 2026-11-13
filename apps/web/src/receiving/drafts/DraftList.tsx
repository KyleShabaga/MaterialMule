import { receiptDraftDeleteHint } from '@materialmule/shared';
import { useState } from 'react';
import { ConfirmDialog, StatusBadge } from '../../components/app-ui';
import { useOptionalRecordingPerson } from '../../session/recording-person-store';
import { formatUnitCount } from '../draft';
import { daysUntilAutoDelete, type DraftAutoDelete } from './auto-delete';
import { draftTitle, formatSavedDateTime, receiverText } from './format';
import {
  DraftDeleteError,
  authorizeDraftDelete,
  deleteAvailability,
  useDraftOwnership,
} from './ownership';
import { STALE_AFTER_DAYS, isStale, type StoredDraft } from './record';

// "Drafts on this computer" on the receiving landing (MM-T11). Only drafts this session may
// see are passed in (LAB drafts for LAB, personal drafts for their owner). With draft auto-delete
// on (MM-T45) a line above the list states the rule, each draft in its last week says when it
// goes, an interrupted confirmation says it is never deleted (MM-T61), and a notice reports a
// clean-up. STRATA-108: only the person who started a draft or a Lab Manager may discard it;
// the server authorizes first and `onDiscard` (which removes the local copy) runs only after.

export function DraftList({
  drafts,
  unreadable,
  autoDelete = null,
  notice = null,
  onResume,
  onDiscard,
}: {
  drafts: StoredDraft[];
  unreadable: number;
  /** The auto-delete setting when it loaded; null when unknown (then it is treated as off). */
  autoDelete?: DraftAutoDelete | null;
  /** One-time notice after automatic clean-up deleted drafts on this visit. */
  notice?: string | null;
  onResume: (record: StoredDraft) => void;
  onDiscard: (record: StoredDraft) => Promise<void>;
}) {
  const [discarding, setDiscarding] = useState<StoredDraft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const station = useOptionalRecordingPerson();
  const picked = station?.isStation ? (station.person?.id ?? null) : null;
  const ownership = useDraftOwnership(drafts, picked);

  async function discard() {
    const record = discarding;
    setDiscarding(null);
    if (!record) return;
    try {
      await authorizeDraftDelete(record.draftId, picked);
      await onDiscard(record);
      setError(null);
    } catch (problem) {
      setError(
        problem instanceof DraftDeleteError
          ? problem.message
          : "The draft couldn't be discarded. Try again.",
      );
    }
  }

  const autoDeleteOn = autoDelete?.enabled ? autoDelete : null;

  return (
    <>
      {autoDeleteOn ? (
        <p className="field-hint draft-auto-delete-rule">
          Drafts are deleted automatically after {autoDeleteOn.afterDays} days without changes (set
          by an administrator).
        </p>
      ) : null}
      <section className="receive-drafts" aria-labelledby="drafts-heading">
        <h2 id="drafts-heading">Drafts on this computer</h2>
        {notice ? (
          <p className="draft-cleanup-notice" role="status">
            {notice}
          </p>
        ) : null}
        {drafts.length === 0 ? (
          <p className="empty-state">No drafts on this computer.</p>
        ) : (
          <ul className="draft-list" aria-labelledby="drafts-heading">
            {drafts.map((record) => {
              const title = draftTitle(record);
              const daysLeft = autoDeleteOn ? daysUntilAutoDelete(record, autoDeleteOn) : null;
              const { allowed, ownership: owned } = deleteAvailability(ownership, record.draftId);
              const hint = owned && !allowed ? receiptDraftDeleteHint(owned) : null;
              return (
                <li key={record.draftId} className="draft-item receive-draft-row">
                  <StatusBadge tone="waiting">DRAFT</StatusBadge>
                  <h3 className="receive-draft-title">{title}</h3>
                  <p className="draft-facts">
                    {formatUnitCount(record.data.units.length)} · {receiverText(record.receiver)} ·
                    Last saved {formatSavedDateTime(record.lastSavedAt)}
                  </p>
                  {record.status === 'confirming' ? (
                    <p>
                      <StatusBadge tone="warning">Confirmation interrupted</StatusBadge> Resume to
                      finish; it sends the same receipt again and never creates duplicates.
                    </p>
                  ) : null}
                  {autoDeleteOn && record.status === 'confirming' ? (
                    <p className="field-hint">
                      Never deleted automatically: resume to finish confirming.
                    </p>
                  ) : null}
                  {daysLeft !== null ? (
                    <p className="text-warning">{deletedIn(daysLeft)} unless you change it.</p>
                  ) : null}
                  {isStale(record) ? (
                    <p>
                      <StatusBadge tone="warning">Stale</StatusBadge> Not saved for over{' '}
                      {STALE_AFTER_DAYS} days. Review it, then confirm or discard it.
                    </p>
                  ) : null}
                  <div className="draft-actions">
                    <button
                      type="button"
                      className="primary"
                      aria-label={`Resume draft ${title}`}
                      onClick={() => onResume(record)}
                    >
                      Resume
                    </button>
                    <button
                      type="button"
                      aria-label={`Discard draft ${title}`}
                      disabled={!allowed}
                      onClick={() => setDiscarding(record)}
                    >
                      Discard
                    </button>
                  </div>
                  {hint ? <p className="field-hint">{hint}.</p> : null}
                </li>
              );
            })}
          </ul>
        )}
        {unreadable > 0 ? (
          <p className="field-hint">
            {unreadable === 1 ? '1 draft' : `${unreadable} drafts`} on this computer can't be opened
            by this version of Material Mule. They are kept as they are.
          </p>
        ) : null}
        {error ? (
          <p className="field-error" role="alert">
            {error}
          </p>
        ) : null}
        <ConfirmDialog
          open={discarding !== null}
          title="Discard this draft?"
          confirmLabel="Discard draft"
          danger
          onConfirm={() => void discard()}
          onCancel={() => setDiscarding(null)}
        >
          <p>
            {discarding ? draftTitle(discarding) : ''}: everything entered is removed from this
            computer. This can't be undone.
            {discarding?.status === 'confirming'
              ? ' If its confirmation already went through, the storage units stay in Material Mule.'
              : ''}
          </p>
        </ConfirmDialog>
      </section>
    </>
  );
}

function deletedIn(days: number): string {
  if (days === 0) return 'Deleted today';
  if (days === 1) return 'Deleted tomorrow';
  return `Deleted in ${days} days`;
}
