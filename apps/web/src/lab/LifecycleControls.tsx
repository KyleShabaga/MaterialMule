import {
  LIFECYCLE_REASON_MAX_LENGTH,
  closureBlockerLabel,
  formatPerson,
  type LabProgram,
  type ProgramWork,
  type TestRequest,
} from '@materialmule/shared';
import { CircleCheck, ListChecks } from 'lucide-react';
import { useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { shortDateTime } from '../dashboard/format';
import { cancelTest, closeProgram, repeatTest, requestCancellation, type WriteResult } from './api';
import { requestName } from './format';
import { problemText } from './problem-text';
import { TextAction } from './ReviewControls';

// Program lifecycle, cancellation and repeats on a worked program (MM-T26, Strata STRATA-87). The
// server decides what this account may do (`lifecycle` on the program and on each test) and
// enforces it again on every action; the buttons only mirror that. Asking for a cancellation or
// closure is kept apart from the decision buttons, and nothing shows Closed until the close itself
// has committed. Ready presentation never bypasses the closure preconditions.

const newKey = () => crypto.randomUUID();

// eslint-disable-next-line react-refresh/only-export-components -- shared with the program page
export function testLabel(program: LabProgram, testRequestId: string): string {
  for (const line of program.lines) {
    const request = line.requests.find((r) => r.id === testRequestId);
    if (request) return `Line ${line.lineNumber} · ${requestName(request)}`;
  }
  return 'a test';
}

/**
 * Close program: enabled only when the server says this account may close now. A Lab Manager
 * who isn't the requester or lead gets it from More (`closeAs`), the others as the main action.
 */
// eslint-disable-next-line react-refresh/only-export-components -- the close action's hook belongs with it
export function useCloseProgram(
  program: LabProgram,
  work: ProgramWork,
  onDone: (message: string | null, closed?: boolean) => void,
) {
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const close = async () => {
    setBusy(true);
    const result = await closeProgram(program.id, {
      version: work.lifecycle.version,
      idempotencyKey: key,
    });
    setBusy(false);
    if (result.ok || result.kind !== 'network') setKey(newKey());
    onDone(result.ok ? null : problemText(result), result.ok);
  };
  return { close, busy };
}

/**
 * What stands between this program and closing, and the lifecycle notes: who closed it, an open
 * closure request, the LAB station's personal sign-in note. "Every test is accepted or cancelled
 * with a reason." once nothing is left.
 */
export function ProgramLifecycle({ program, work }: { program: LabProgram; work: ProgramWork }) {
  const life = work.lifecycle;
  const blocked = life.closeBlockedReason;
  const openRequest = work.actionItems.find(
    (item) => item.kind === 'closure_request' && item.status === 'open',
  );
  const showChecklist =
    life.status === 'submitted' &&
    (blocked === 'unresolved' || blocked === 'empty_program' || life.canClose);
  return (
    <section aria-label="Closure" className="flex flex-col gap-3" data-slot="program-lifecycle">
      {life.status === 'closed' && life.closedBy && life.closedAt ? (
        <p className="text-sm text-muted-foreground">
          Closed by {formatPerson(life.closedBy.initials, life.closedBy.name)},{' '}
          {shortDateTime(life.closedAt)}. Closing changes no stored material, retention or disposal.
        </p>
      ) : null}
      {openRequest ? (
        <p className="text-sm">
          Closure requested by{' '}
          {formatPerson(openRequest.createdBy.initials, openRequest.createdBy.name)}:{' '}
          <span className="whitespace-pre-wrap">{openRequest.comment}</span>
        </p>
      ) : null}
      {blocked === 'personal_sign_in' ? (
        <p className="text-sm text-muted-foreground">
          Closing, reopening and cancelling need a personal sign-in. Choosing a person on this LAB
          station doesn’t give their authority.
        </p>
      ) : null}
      {showChecklist ? (
        <Alert>
          {life.closure.blockers.length === 0 && !life.closure.emptyProgram ? (
            <CircleCheck aria-hidden="true" />
          ) : (
            <ListChecks aria-hidden="true" />
          )}
          <AlertTitle>Closure checklist: {life.closure.summary}</AlertTitle>
          <AlertDescription>
            {life.closure.emptyProgram ? (
              <p>At least one test request is needed before this program can close.</p>
            ) : life.closure.blockers.length === 0 ? (
              <p>Every test is accepted or cancelled with a reason.</p>
            ) : (
              <>
                <p>Every test is accepted or cancelled with a reason before closing.</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {life.closure.blockers.map((blocker) => (
                    <li key={blocker.testRequestId}>
                      <Button
                        variant="link"
                        asChild
                        className="h-auto p-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
                      >
                        <a href={`#request-${blocker.testRequestId}`}>
                          {testLabel(program, blocker.testRequestId)}
                        </a>
                      </Button>
                      : {closureBlockerLabel(blocker)}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </AlertDescription>
        </Alert>
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
  const link = (id: string, text: string) => (
    <Button
      variant="link"
      asChild
      className="h-auto p-0 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
    >
      <a href={`#request-${id}`}>{text}</a>
    </Button>
  );
  const notes = (
    <>
      {life.repeatOfId ? (
        <span className="text-sm text-muted-foreground">
          Repeat of {link(life.repeatOfId, testLabel(program, life.repeatOfId))}
        </span>
      ) : null}
      {life.repeatIds.length > 0 ? (
        <span className="text-sm text-muted-foreground">
          Repeated as{' '}
          {life.repeatIds.map((id, index) => (
            <span key={id}>
              {index > 0 ? ', ' : ''}
              {link(id, `repeat ${index + 1}`)}
            </span>
          ))}
        </span>
      ) : null}
      {life.cancelledBy && life.cancelledAt ? (
        <span className="text-sm text-muted-foreground">
          Cancelled by {formatPerson(life.cancelledBy.initials, life.cancelledBy.name)},{' '}
          {shortDateTime(life.cancelledAt)}:{' '}
          <span className="whitespace-pre-wrap">“{life.cancelReason}”</span>
        </span>
      ) : null}
      {openRequest ? (
        <span className="text-sm">
          Cancellation requested by{' '}
          {formatPerson(openRequest.createdBy.initials, openRequest.createdBy.name)}:{' '}
          <span className="whitespace-pre-wrap">{openRequest.comment}</span>
        </span>
      ) : null}
    </>
  );
  const actions =
    life.canRepeat || life.canCancel || (life.canRequestCancel && !openRequest) ? (
      <div className="flex flex-wrap items-center gap-2">
        {life.canRepeat ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
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
          </Button>
        ) : null}
        {life.canCancel ? (
          <TextAction
            label="Cancel test"
            fieldLabel="Reason for cancelling"
            description="The requester sees the reason. A cancelled test counts as resolved for closing."
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
    ) : null;
  return (
    <div className="flex flex-col gap-1" data-slot="request-lifecycle">
      {notes}
      {actions}
    </div>
  );
}
