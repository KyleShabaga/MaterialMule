import { useState } from 'react';
import { ConfirmDialog, StatusBadge } from '../../components/ui';
import { formatUnitCount } from '../draft';
import type { DraftAutoDelete } from './auto-delete';
import { draftTitle, formatSavedDateTime, receiverText } from './format';
import { STALE_AFTER_DAYS, isStale, type StoredDraft } from './record';

// "Drafts on this computer" on the receiving landing (TRP-T11). Only drafts this session may
// see are passed in (LAB drafts for LAB, personal drafts for their owner). With draft auto-delete
// on (TRP-T40) the Stale badge says when the draft goes, and a notice reports a clean-up.

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

  async function discard() {
    const record = discarding;
    setDiscarding(null);
    if (!record) return;
    try {
      await onDiscard(record);
      setError(null);
    } catch {
      setError("The draft couldn't be discarded. Try again.");
    }
  }

  return (
    <section className="card" aria-labelledby="drafts-heading">
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
            return (
              <li key={record.draftId} className="draft-item">
                <h3>{title}</h3>
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
                {isStale(record) ? (
                  <p>
                    <StatusBadge tone="warning">Stale</StatusBadge> Not saved for over{' '}
                    {STALE_AFTER_DAYS} days.{' '}
                    {autoDelete?.enabled && record.status !== 'confirming'
                      ? `Deleted automatically after ${autoDelete.afterDays} days without changes. `
                      : ''}
                    Review it, then confirm or discard it.
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
                    onClick={() => setDiscarding(record)}
                  >
                    Discard
                  </button>
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {unreadable > 0 ? (
        <p className="field-hint">
          {unreadable === 1 ? '1 draft' : `${unreadable} drafts`} on this computer can't be opened
          by this version of Trapezoid. They are kept as they are.
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
        onConfirm={() => void discard()}
        onCancel={() => setDiscarding(null)}
      >
        <p>
          {discarding ? draftTitle(discarding) : ''}: everything entered is removed from this
          computer. This can't be undone.
          {discarding?.status === 'confirming'
            ? ' If its confirmation already went through, the storage units stay in Trapezoid.'
            : ''}
        </p>
      </ConfirmDialog>
    </section>
  );
}
