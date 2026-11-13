import {
  ACCEPT_BLOCKED_REASONS,
  REVIEW_COMMENT_MAX_LENGTH,
  REVIEW_EVENT_LABEL,
  REVIEW_STATE_LABEL,
  formatPerson,
  type ProgramWork,
  type ReviewEvent,
  type ReviewState,
  type StageKey,
} from '@materialmule/shared';
import { ChevronRight } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { StageTag } from '../components/strata/stage-tag';
import { shortDateTime } from '../dashboard/format';
import { acceptTest, markCorrectionDone, reviewDecision, type WriteResult } from './api';
import { problemText } from './problem-text';

// Review corrections and delegated acceptance on a worked program (MM-T25, Strata STRATA-87).
// The server decides what this account may do to each test (`reviewActions`) and enforces it
// again on every action; the buttons only mirror that. "Done" (testing finished) and "Review
// complete" (review finished) are always different words. A shared LAB station sees why it
// can't act. Review is never one's own work: the server refuses the requester and the tester.

const newKey = () => crypto.randomUUID();

const STATE_STAGE: Record<ReviewState, StageKey> = {
  awaiting_review: 'due',
  returned: 'danger',
  correction_done: 'due',
  review_complete: 'lab',
};

/**
 * A reason dialog (shadcn Dialog): a required text, the action's own button, and Back. Controlled
 * so a More menu item can open it. The text stays when the save fails; a lost response keeps the
 * retry key, so trying again can't act twice.
 */
export function ReasonDialog({
  open,
  onOpenChange,
  title,
  fieldLabel,
  description,
  submitLabel,
  maxLength = REVIEW_COMMENT_MAX_LENGTH,
  onSubmit,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  fieldLabel: string;
  description?: ReactNode;
  submitLabel?: string;
  maxLength?: number;
  onSubmit: (text: string, key: string) => Promise<WriteResult<unknown>>;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) setProblem(null);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <form
          className="grid gap-4"
          onSubmit={async (event) => {
            event.preventDefault();
            setBusy(true);
            const result = await onSubmit(text.trim(), key);
            setBusy(false);
            if (!result.ok && result.kind === 'network') {
              setProblem(problemText(result));
              return;
            }
            setKey(newKey());
            if (result.ok) {
              setText('');
              setProblem(null);
              onOpenChange(false);
            } else {
              setProblem(problemText(result));
            }
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            {description ? <DialogDescription>{description}</DialogDescription> : null}
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor={id}>{fieldLabel} (required)</Label>
            <Textarea
              id={id}
              value={text}
              maxLength={maxLength}
              onChange={(event) => setText(event.target.value)}
            />
          </div>
          {problem ? (
            <p role="alert" className="text-sm text-destructive-text">
              {problem}
            </p>
          ) : null}
          <DialogFooter>
            <DialogClose asChild>
              <Button type="button" variant="outline">
                Back
              </Button>
            </DialogClose>
            <Button type="submit" disabled={busy || !text.trim()}>
              {submitLabel ?? title}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A required-text action (Return for correction, Cancel test, Reopen …): a button and its dialog. */
export function TextAction({
  label,
  fieldLabel,
  description,
  onSubmit,
  maxLength = REVIEW_COMMENT_MAX_LENGTH,
  variant = 'outline',
}: {
  label: string;
  fieldLabel: string;
  description?: ReactNode;
  maxLength?: number;
  variant?: 'outline' | 'default' | 'ghost';
  onSubmit: (text: string, key: string) => Promise<WriteResult<unknown>>;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" variant={variant} onClick={() => setOpen(true)}>
        {label}
      </Button>
      <ReasonDialog
        open={open}
        onOpenChange={setOpen}
        title={label}
        fieldLabel={fieldLabel}
        description={description}
        maxLength={maxLength}
        onSubmit={onSubmit}
      />
    </>
  );
}

/** A collapsed list under a link-style trigger ("Review history (2)"). */
export function HistoryDisclosure({ label, children }: { label: string; children: ReactNode }) {
  return (
    <Collapsible className="group/history">
      <CollapsibleTrigger asChild>
        <Button variant="link" size="sm" className="h-auto gap-1 p-0 text-muted-foreground">
          <ChevronRight
            aria-hidden="true"
            className="transition-transform group-data-[state=open]/history:rotate-90"
          />
          {label}
        </Button>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <ol className="mt-1 flex flex-col gap-1 text-sm text-muted-foreground">{children}</ol>
      </CollapsibleContent>
    </Collapsible>
  );
}

function ReviewHistory({ events }: { events: ReviewEvent[] }) {
  if (events.length === 0) return null;
  return (
    <HistoryDisclosure label={`Review history (${events.length})`}>
      {events.map((event) => (
        <li key={event.id}>
          {REVIEW_EVENT_LABEL[event.kind]} by{' '}
          {formatPerson(event.person.initials, event.person.name)}
          {event.viaDelegation ? ' (acceptance delegate)' : ''}, {shortDateTime(event.occurredAt)}
          {event.comment ? <span className="whitespace-pre-wrap">: {event.comment}</span> : null}
        </li>
      ))}
    </HistoryDisclosure>
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
  const history = <ReviewHistory events={events} />;

  if (progress.status === 'accepted') {
    return (
      <div className="flex flex-col gap-1">
        {progress.acceptedBy && progress.acceptedAt ? (
          <span className="text-sm text-muted-foreground">
            Accepted by {formatPerson(progress.acceptedBy.initials, progress.acceptedBy.name)}
            {progress.acceptedViaDelegation ? ' (acceptance delegate)' : ''},{' '}
            {shortDateTime(progress.acceptedAt)}
          </span>
        ) : null}
        {history}
      </div>
    );
  }
  const state = progress.reviewState;
  if (progress.status !== 'review' || !state) return events.length > 0 ? history : null;

  const actions = progress.reviewActions;
  const openItem = work.actionItems.find(
    (item) =>
      item.kind === 'correction' && item.testRequestId === testRequestId && item.status === 'open',
  );
  const finish = (result: WriteResult<unknown>) => {
    onDone(result.ok ? null : problemText(result));
    return result;
  };
  const blocked = actions.acceptBlockedReason;

  return (
    <div className="flex flex-col gap-2" data-slot="review-controls">
      <div className="flex flex-wrap items-center gap-2">
        <StageTag stage={STATE_STAGE[state]} label={REVIEW_STATE_LABEL[state]} />
        {openItem ? (
          <p className="text-sm">
            Returned to Lab Manager by{' '}
            {formatPerson(openItem.createdBy.initials, openItem.createdBy.name)}:{' '}
            <span className="whitespace-pre-wrap">{openItem.comment}</span>
          </p>
        ) : null}
      </div>
      {blocked === 'personal_sign_in' ? (
        <p className="text-sm text-muted-foreground">
          Review and acceptance need a personal sign-in. Choosing a person on this LAB station
          doesn’t give their authority.
        </p>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          {actions.canReview ? (
            <>
              <Button
                type="button"
                size="sm"
                variant="outline"
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
              </Button>
              <TextAction
                label="Return for correction"
                fieldLabel="What needs correcting"
                description="The Lab Manager sees this and corrects the test."
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
          <Button
            type="button"
            size="sm"
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
          </Button>
          {blocked ? (
            <span id={reasonId} className="text-sm text-muted-foreground">
              {ACCEPT_BLOCKED_REASONS[blocked]}
            </span>
          ) : null}
        </div>
      )}
      {history}
    </div>
  );
}
