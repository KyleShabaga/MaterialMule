import {
  CLOSE_BLOCKED_REASONS,
  LIFECYCLE_REASON_MAX_LENGTH,
  PROGRAM_STATUS_LABEL,
  closureBlockerLabel,
  formatPerson,
  type LabProgram,
  type ProgramWork,
  type TestRequest,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import {
  cancelTest,
  closeProgram,
  reopenProgram,
  repeatTest,
  requestCancellation,
  requestClosure,
  type WriteResult,
} from './api';
import { requestName } from './format';
import { problemText } from './problem-text';
import { TextAction } from './ReviewControls';

// Program lifecycle, cancellation and repeats on a worked program (MM-T26). The server decides
// what this account may do (`lifecycle` on the program and on each test) and enforces it again on
// every action; the buttons only mirror that. Asking for a cancellation or closure is kept apart
// from the decision buttons, and nothing shows Closed until the close itself has committed.

const newKey = () => crypto.randomUUID();

function testLabel(program: LabProgram, testRequestId: string): string {
  for (const line of program.lines) {
    const request = line.requests.find((r) => r.id === testRequestId);
    if (request) return `Line ${line.lineNumber} · ${requestName(request)}`;
  }
  return 'a test';
}

/** Program header: Open/Closed, closure checklist, close / request closure / reopen, history. */
export function ProgramLifecycle({
  program,
  work,
  onDone,
}: {
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const reasonId = useId();
  const [closeKey, setCloseKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const life = work.lifecycle;
  const finish = (result: WriteResult<unknown>) => {
    onDone(result.ok ? null : problemText(result));
    return result;
  };
  const blocked = life.closeBlockedReason;
  const openRequest = work.actionItems.find(
    (item) => item.kind === 'closure_request' && item.status === 'open',
  );
  const showChecklist = blocked === 'unresolved' || blocked === 'empty_program' || life.canClose;

  return (
    <section className="program-lifecycle" aria-labelledby={`${reasonId}-status`}>
      <p id={`${reasonId}-status`} className="lifecycle-status">
        <StatusBadge tone={life.status === 'closed' ? 'neutral' : 'success'}>
          {PROGRAM_STATUS_LABEL[life.status]}
        </StatusBadge>
        {life.status === 'closed' && life.closedBy && life.closedAt ? (
          <span className="field-hint">
            Closed by {formatPerson(life.closedBy.initials, life.closedBy.name)},{' '}
            {shortDateTime(life.closedAt)}. Closing changes no stored material, retention or
            disposal.
          </span>
        ) : null}
      </p>
      {openRequest ? (
        <p className="field-hint">
          Closure requested by{' '}
          {formatPerson(openRequest.createdBy.initials, openRequest.createdBy.name)}:{' '}
          <span className="pre-wrap">{openRequest.comment}</span>
        </p>
      ) : null}
      {blocked === 'personal_sign_in' ? (
        <p className="field-hint">
          Closing, reopening and cancelling need a personal sign-in. Choosing a person on this LAB
          station doesn’t give their authority.
        </p>
      ) : (
        <div className="lifecycle-actions">
          {life.status === 'submitted' ? (
            <>
              <button
                type="button"
                className="primary"
                disabled={busy || !life.canClose}
                aria-describedby={blocked ? `${reasonId}-reason` : undefined}
                onClick={async () => {
                  setBusy(true);
                  const result = await closeProgram(program.id, {
                    version: life.version,
                    idempotencyKey: closeKey,
                  });
                  setBusy(false);
                  if (result.ok || result.kind !== 'network') setCloseKey(newKey());
                  finish(result);
                }}
              >
                Close program
              </button>
              {blocked && blocked !== 'not_open' ? (
                <span id={`${reasonId}-reason`} className="field-hint">
                  {blocked === 'unresolved' || blocked === 'empty_program'
                    ? life.closure.summary
                    : CLOSE_BLOCKED_REASONS[blocked]}
                </span>
              ) : null}
              {life.canRequestClose && !life.canClose && !openRequest ? (
                <TextAction
                  label="Request closure"
                  fieldLabel="Why this program can close"
                  maxLength={LIFECYCLE_REASON_MAX_LENGTH}
                  onSubmit={async (reason, key) =>
                    finish(await requestClosure(program.id, { reason, idempotencyKey: key }))
                  }
                />
              ) : null}
            </>
          ) : null}
          {life.canReopen ? (
            <TextAction
              label="Reopen program"
              fieldLabel="Reason for reopening"
              maxLength={LIFECYCLE_REASON_MAX_LENGTH}
              onSubmit={async (reason, key) =>
                finish(
                  await reopenProgram(program.id, {
                    reason,
                    version: life.version,
                    idempotencyKey: key,
                  }),
                )
              }
            />
          ) : null}
        </div>
      )}
      {life.status === 'submitted' && showChecklist ? (
        <details className="closure-checklist" open={blocked === 'empty_program'}>
          <summary>Closure checklist: {life.closure.summary}</summary>
          {life.closure.emptyProgram ? (
            <p>At least one test request is needed before this program can close.</p>
          ) : life.closure.blockers.length === 0 ? (
            <p>Every test is accepted or cancelled with a reason.</p>
          ) : (
            <ul>
              {life.closure.blockers.map((blocker) => (
                <li key={blocker.testRequestId}>
                  <a href={`#request-${blocker.testRequestId}`}>
                    {testLabel(program, blocker.testRequestId)}
                  </a>
                  : {closureBlockerLabel(blocker)}
                </li>
              ))}
            </ul>
          )}
        </details>
      ) : null}
      {life.events.length > 0 ? (
        <details className="lifecycle-history">
          <summary>Program history ({life.events.length})</summary>
          <ol>
            {life.events.map((event) => (
              <li key={event.id}>
                {event.kind === 'closed' ? 'Closed' : 'Reopened'} by{' '}
                {formatPerson(event.person.initials, event.person.name)},{' '}
                {shortDateTime(event.occurredAt)}
                {event.reason ? <span className="pre-wrap">: {event.reason}</span> : null}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </section>
  );
}

/** One test: cancellation, cancellation request, repeat and the links between repeats. */
export function RequestLifecycle({
  request,
  program,
  work,
  onDone,
}: {
  request: TestRequest;
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const [repeatKey, setRepeatKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const progress = work.requests.find((r) => r.testRequestId === request.id);
  if (!progress) return null;
  const life = progress.lifecycle;
  const finish = (result: WriteResult<unknown>) => {
    onDone(result.ok ? null : problemText(result));
    return result;
  };
  const openRequest = work.actionItems.find(
    (item) =>
      item.kind === 'cancellation_request' &&
      item.testRequestId === request.id &&
      item.status === 'open',
  );
  return (
    <div className="request-lifecycle">
      {life.repeatOfId ? (
        <span className="field-hint">
          Repeat of{' '}
          <a href={`#request-${life.repeatOfId}`}>{testLabel(program, life.repeatOfId)}</a>
        </span>
      ) : null}
      {life.repeatIds.length > 0 ? (
        <span className="field-hint">
          Repeated as{' '}
          {life.repeatIds.map((id, index) => (
            <span key={id}>
              {index > 0 ? ', ' : ''}
              <a href={`#request-${id}`}>repeat {index + 1}</a>
            </span>
          ))}
        </span>
      ) : null}
      {life.cancelledBy && life.cancelledAt ? (
        <span className="field-hint">
          Cancelled by {formatPerson(life.cancelledBy.initials, life.cancelledBy.name)},{' '}
          {shortDateTime(life.cancelledAt)}: <span className="pre-wrap">{life.cancelReason}</span>
        </span>
      ) : null}
      {openRequest ? (
        <span className="field-hint">
          Cancellation requested by{' '}
          {formatPerson(openRequest.createdBy.initials, openRequest.createdBy.name)}:{' '}
          <span className="pre-wrap">{openRequest.comment}</span>
        </span>
      ) : null}
      <div className="lifecycle-actions">
        {life.canRepeat ? (
          <button
            type="button"
            disabled={busy}
            onClick={async () => {
              setBusy(true);
              const result = await repeatTest(request.id, {
                version: progress.version,
                idempotencyKey: repeatKey,
              });
              setBusy(false);
              if (result.ok || result.kind !== 'network') setRepeatKey(newKey());
              finish(result);
            }}
          >
            Repeat test
          </button>
        ) : null}
        {life.canCancel ? (
          <TextAction
            label="Cancel test"
            fieldLabel="Reason for cancelling"
            maxLength={LIFECYCLE_REASON_MAX_LENGTH}
            onSubmit={async (reason, key) =>
              finish(
                await cancelTest(request.id, {
                  reason,
                  version: progress.version,
                  idempotencyKey: key,
                }),
              )
            }
          />
        ) : life.canRequestCancel && !openRequest ? (
          <TextAction
            label="Request cancellation"
            fieldLabel="Why this test should be cancelled"
            maxLength={LIFECYCLE_REASON_MAX_LENGTH}
            onSubmit={async (reason, key) =>
              finish(await requestCancellation(request.id, { reason, idempotencyKey: key }))
            }
          />
        ) : null}
      </div>
    </div>
  );
}
