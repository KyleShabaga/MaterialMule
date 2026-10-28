import {
  ACCEPT_BLOCKED_REASONS,
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_EVENT_LABEL,
  REVIEW_STATE_LABEL,
  formatPerson,
  type ProgramWork,
  type ReviewState,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { StatusBadge, type BadgeTone } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { acceptTest, markCorrectionDone, reviewDecision, type WriteResult } from './api';

// Review corrections and delegated acceptance on a worked program (MM-T25). The server decides
// what this account may do to each test (`reviewActions`) and enforces it again on every action;
// the buttons only mirror that. "Completed" (testing finished) and "Review complete" (review
// finished) are always shown as different words. A shared LAB station sees why it can't act.

const newKey = () => crypto.randomUUID();

const STATE_TONE: Record<ReviewState, BadgeTone> = {
  awaiting_review: 'info',
  returned: 'warning',
  correction_done: 'info',
  review_complete: 'success',
};

function problemText(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  if (result.kind === 'conflict') {
    if (result.code === 'version_conflict') {
      return 'Someone else updated this test first. It has been refreshed; check it and try again.';
    }
    if (result.code === 'correction_superseded') {
      return 'This correction was already dealt with. The test has been refreshed.';
    }
    return 'This changed elsewhere. The test has been refreshed.';
  }
  if (result.kind === 'invalid') {
    return result.errors.map((error) => error.message).join(' ') || 'Check the details.';
  }
  if (result.kind === 'forbidden') return 'You can’t do this from this account.';
  if (result.kind === 'unauthenticated') return 'Your session has ended. Sign in again.';
  if (result.kind === 'network') return 'Couldn’t reach Material Mule. Try again.';
  return 'Something went wrong. Try again.';
}

/** A required-text action (Return for correction, Mark correction done). */
function TextAction({
  label,
  fieldLabel,
  onSubmit,
}: {
  label: string;
  fieldLabel: string;
  onSubmit: (text: string, key: string) => Promise<WriteResult<unknown>>;
}) {
  const id = useId();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {label}
      </button>
    );
  }
  return (
    <form
      className="action-panel"
      aria-labelledby={`${id}-title`}
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await onSubmit(text.trim(), key);
        setBusy(false);
        // A lost response keeps the key (and the text), so trying again can't act twice.
        if (!result.ok && result.kind === 'network') return;
        setKey(newKey());
        if (result.ok) {
          setText('');
          setOpen(false);
        }
      }}
    >
      <p id={`${id}-title`} className="action-title">
        {label}
      </p>
      <label htmlFor={id}>{fieldLabel} (required)</label>
      <textarea
        id={id}
        value={text}
        maxLength={REVIEW_COMMENT_MAX_LENGTH}
        onChange={(event) => setText(event.target.value)}
      />
      <div className="form-actions">
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button type="submit" className="primary" disabled={busy || !text.trim()}>
          {label}
        </button>
      </div>
    </form>
  );
}

export function ReviewControls({
  testRequestId,
  work,
  onDone,
}: {
  testRequestId: string;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const reasonId = useId();
  const [acceptKey, setAcceptKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const progress = work.requests.find((r) => r.testRequestId === testRequestId);
  if (!progress) return null;
  const events = work.reviewEvents.filter((event) => event.testRequestId === testRequestId);
  const history =
    events.length > 0 ? (
      <details className="review-history">
        <summary>Review history ({events.length})</summary>
        <ol>
          {events.map((event) => (
            <li key={event.id}>
              {REVIEW_EVENT_LABEL[event.kind]} by{' '}
              {formatPerson(event.person.initials, event.person.name)}
              {event.viaDelegation ? ' (acceptance delegate)' : ''},{' '}
              {shortDateTime(event.occurredAt)}
              {event.comment ? <span className="pre-wrap">: {event.comment}</span> : null}
            </li>
          ))}
        </ol>
      </details>
    ) : null;

  if (progress.status === 'accepted') {
    return (
      <>
        {progress.acceptedBy && progress.acceptedAt ? (
          <span className="field-hint">
            Accepted by {formatPerson(progress.acceptedBy.initials, progress.acceptedBy.name)}
            {progress.acceptedViaDelegation ? ' (acceptance delegate)' : ''},{' '}
            {shortDateTime(progress.acceptedAt)}
          </span>
        ) : null}
        {history}
      </>
    );
  }
  const state = progress.reviewState;
  if (progress.status !== 'review' || !state) return history;

  const actions = progress.reviewActions;
  const openItem = work.actionItems.find(
    (item) => item.testRequestId === testRequestId && item.status === 'open',
  );
  const finish = (result: WriteResult<unknown>) => {
    onDone(result.ok ? null : problemText(result));
    return result;
  };
  const blocked = actions.acceptBlockedReason;

  return (
    <div className="review-controls">
      <StatusBadge tone={STATE_TONE[state]}>{REVIEW_STATE_LABEL[state]}</StatusBadge>
      {openItem ? (
        <p className="review-return">
          Returned to Lab Manager by{' '}
          {formatPerson(openItem.createdBy.initials, openItem.createdBy.name)}:{' '}
          <span className="pre-wrap">{openItem.comment}</span>
        </p>
      ) : null}
      {blocked === 'personal_sign_in' ? (
        <p className="field-hint">
          Review and acceptance need a personal sign-in. Choosing a person on this LAB station
          doesn’t give their authority.
        </p>
      ) : (
        <div className="review-actions">
          {actions.canReview ? (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  finish(
                    await reviewDecision(testRequestId, {
                      action: 'complete',
                      version: progress.version,
                      idempotencyKey: newKey(),
                    }),
                  );
                  setBusy(false);
                }}
              >
                Mark review complete
              </button>
              <TextAction
                label="Return for correction"
                fieldLabel="What needs correcting"
                onSubmit={async (comment, key) =>
                  finish(
                    await reviewDecision(testRequestId, {
                      action: 'return',
                      comment,
                      version: progress.version,
                      idempotencyKey: key,
                    }),
                  )
                }
              />
            </>
          ) : null}
          {actions.canCorrectionDone ? (
            <TextAction
              label="Mark correction done"
              fieldLabel="What was corrected"
              onSubmit={async (note, key) =>
                finish(
                  await markCorrectionDone(testRequestId, {
                    note,
                    version: progress.version,
                    idempotencyKey: key,
                    ...(openItem ? { actionItemId: openItem.id } : {}),
                  }),
                )
              }
            />
          ) : null}
          <button
            type="button"
            className="primary"
            disabled={busy || !actions.canAccept}
            aria-describedby={blocked ? reasonId : undefined}
            onClick={async () => {
              setBusy(true);
              const result = await acceptTest(testRequestId, {
                version: progress.version,
                idempotencyKey: acceptKey,
              });
              setBusy(false);
              if (result.ok || result.kind !== 'network') setAcceptKey(newKey());
              finish(result);
            }}
          >
            Accept
          </button>
          {blocked ? (
            <span id={reasonId} className="field-hint">
              {ACCEPT_BLOCKED_REASONS[blocked]}
            </span>
          ) : null}
        </div>
      )}
      {history}
    </div>
  );
}
