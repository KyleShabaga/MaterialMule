import {
  CLOSE_BLOCKED_REASONS,
  formatAttribution,
  LIFECYCLE_REASON_MAX_LENGTH,
  type LabProgram,
  type LabProgramPhase,
  type ProgramWork,
  type TestProgress,
} from '@materialmule/shared';
import { Ellipsis, Flag, Link2, Printer } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { PersonCell } from '../components/strata/person-avatar';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { changePriority, reopenProgram, requestClosure } from './api';
import { recordDate } from './format';
import { useCloseProgram } from './LifecycleControls';
import { problemText } from './problem-text';
import { PriorityTag, ProgramStatusTag } from './program-tags';
import { ProgressMeter } from './ProgressCells';
import { ReasonDialog } from './ReviewControls';

// The program page header (STRATA-87, the record pattern): the label block (project, LP number,
// requested by, submitted, priority) left; the status tag, "n of m" progress, one main action by
// phase and More right. Every action mirrors what the server reports and is enforced there again.
// No Undo here: lane 1C's server Undo covers moves and dismissed notifications, no lab action.

const newKey = () => crypto.randomUUID();

export function ProgramHeader({
  program,
  work,
  phase,
  progress,
  reviewing,
  onReview,
  onDone,
}: {
  program: LabProgram;
  work: ProgramWork | null;
  phase: LabProgramPhase;
  progress: TestProgress;
  reviewing: boolean;
  /** Start or stop reviewing on this page (Due · Review). */
  onReview: (() => void) | null;
  onDone: (message: string | null) => void;
}) {
  const reasonId = useId();
  const [dialog, setDialog] = useState<'reopen' | 'request-close' | null>(null);
  const [priorityKey, setPriorityKey] = useState(newKey);
  const requester = program.submittedFor ?? program.requestedBy;
  const recordedBy = program.submittedBy ?? program.createdBy;
  const life = work?.lifecycle ?? null;
  const tagsHref = `/lab-testing/programs/${program.id}/tags`;
  const { close, busy } = useCloseProgram(program, work!, (message, closed) => {
    if (closed) notifySuccess(`${program.programNumber ?? 'The program'} is closed`);
    onDone(message);
  });

  const blocked = life?.closeBlockedReason ?? null;
  const closeReason =
    blocked && blocked !== 'not_open'
      ? blocked === 'unresolved' || blocked === 'empty_program'
        ? life!.closure.summary
        : CLOSE_BLOCKED_REASONS[blocked]
      : null;
  const openRequest = work?.actionItems.find(
    (item) => item.kind === 'closure_request' && item.status === 'open',
  );
  const submitted = life?.status === 'submitted';
  // Close program is the requester's and the lead's main action; a Lab Manager closes from More.
  const closesHere = submitted && (life?.closeAs === 'requester' || life?.closeAs === 'lead');
  const closeInMore = submitted && life?.closeAs === 'lab_manager' && life.canClose;

  const closeButton = (
    <Button
      type="button"
      variant={phase === 'ready' ? 'default' : 'outline'}
      disabled={busy || !life?.canClose}
      aria-describedby={closeReason ? reasonId : undefined}
      onClick={() => void close()}
    >
      Close program
    </Button>
  );

  let main: ReactNode = null;
  if (submitted && phase === 'review' && onReview) {
    main = (
      <Button type="button" variant={reviewing ? 'outline' : 'default'} onClick={onReview}>
        {reviewing ? 'Stop reviewing' : 'Review'}
      </Button>
    );
  } else if (submitted && (phase === 'pull' || phase === 'testing')) {
    main = (
      <Button asChild>
        <Link to={tagsHref}>
          <Printer aria-hidden="true" />
          Print tags
        </Link>
      </Button>
    );
  } else if (!submitted && life?.canReopen) {
    main = (
      <Button type="button" variant="outline" onClick={() => setDialog('reopen')}>
        Reopen program
      </Button>
    );
  }
  // The requester and the lead always see Close program; until the program is ready it is
  // disabled with the reason (Ready presentation never bypasses the closure preconditions).

  const otherPriority = program.priority === 'urgent' ? 'normal' : 'urgent';
  const canPriority = work?.canChangePriority === true && submitted;
  const canRequestClose = submitted && life?.canRequestClose && !life.canClose && !openRequest;

  return (
    <header className="program-lifecycle flex flex-col gap-4" data-slot="record-header">
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/lab-testing/programs">Lab programs</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage className="font-mono">{program.programNumber}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="flex flex-wrap items-start justify-between gap-x-8 gap-y-4">
        <div className="flex min-w-0 flex-col gap-2">
          <p className="text-sm text-muted-foreground">
            Lab program ·{' '}
            <Button
              variant="link"
              asChild
              className="h-auto p-0 font-mono text-sm focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring [&:hover]:underline"
            >
              <Link to={`/projects/${program.project.id}`}>{program.project.projectNumber}</Link>
            </Button>{' '}
            {program.project.name}
          </p>
          <h1 id="program-heading" className="font-mono text-[28px] leading-[34px] font-bold">
            {program.programNumber}
          </h1>
          <dl className="flex flex-wrap items-center gap-x-6 gap-y-2 text-sm">
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Requested by</dt>
              <dd className="flex items-center gap-2">
                <PersonCell name={requester.name} userId={requester.userId} />
                {recordedBy?.accountType === 'shared_lab' ? (
                  // The LAB station's chosen person is attribution only (docs/permissions.md).
                  <span className="text-muted-foreground">
                    {formatAttribution(recordedBy, requester)}
                  </span>
                ) : null}
              </dd>
            </div>
            {program.submittedAt ? (
              <div className="flex items-center gap-2">
                <dt className="text-muted-foreground">Submitted</dt>
                <dd className="font-mono">{recordDate(program.submittedAt)}</dd>
              </div>
            ) : null}
            <div className="flex items-center gap-2">
              <dt className="text-muted-foreground">Priority</dt>
              <dd>{program.priority === 'urgent' ? 'Urgent' : 'Normal'}</dd>
            </div>
          </dl>
        </div>
        <div className="flex flex-col items-start gap-3 sm:items-end">
          <div className="flex flex-wrap items-center gap-2">
            <ProgramStatusTag phase={phase} />
            {program.priority === 'urgent' ? <PriorityTag priority="urgent" /> : null}
          </div>
          <ProgressMeter progress={progress} size="header" />
          <div className="flex flex-wrap items-center gap-2">
            {main}
            {closesHere ? closeButton : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button type="button" variant="outline" size="icon-sm" aria-label="More">
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                {closeInMore ? (
                  <DropdownMenuItem disabled={busy} onSelect={() => void close()}>
                    Close program
                  </DropdownMenuItem>
                ) : null}
                {canPriority ? (
                  <DropdownMenuItem
                    onSelect={async () => {
                      const result = await changePriority(program.id, {
                        priority: otherPriority,
                        version: program.version,
                        idempotencyKey: priorityKey,
                      });
                      if (result.ok || result.kind !== 'network') setPriorityKey(newKey());
                      if (result.ok) {
                        notifySuccess(
                          otherPriority === 'urgent' ? 'Marked urgent' : 'Marked normal',
                        );
                      }
                      onDone(result.ok ? null : problemText(result));
                    }}
                  >
                    <Flag aria-hidden="true" />
                    {otherPriority === 'urgent' ? 'Mark urgent' : 'Mark normal'}
                  </DropdownMenuItem>
                ) : null}
                {submitted && phase !== 'pull' && phase !== 'testing' ? (
                  <DropdownMenuItem asChild>
                    <Link to={tagsHref}>
                      <Printer aria-hidden="true" />
                      Print tags
                    </Link>
                  </DropdownMenuItem>
                ) : null}
                {canRequestClose ? (
                  <DropdownMenuItem onSelect={() => setDialog('request-close')}>
                    Request closure
                  </DropdownMenuItem>
                ) : null}
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    const url = `${window.location.origin}/lab-testing/programs/${program.id}`;
                    navigator.clipboard?.writeText(url).then(
                      () => notifySuccess('Link copied'),
                      () => notifyError('Couldn’t copy the link.'),
                    );
                  }}
                >
                  <Link2 aria-hidden="true" />
                  Copy link
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
          {closeReason && closesHere ? (
            <p id={reasonId} className="max-w-sm text-sm text-muted-foreground sm:text-right">
              {closeReason}
            </p>
          ) : null}
        </div>
      </div>
      {life ? (
        <>
          <ReasonDialog
            open={dialog === 'reopen'}
            onOpenChange={(open) => setDialog(open ? 'reopen' : null)}
            title="Reopen program"
            fieldLabel="Reason for reopening"
            description="Reopening keeps the program’s history and its closed record."
            maxLength={LIFECYCLE_REASON_MAX_LENGTH}
            onSubmit={async (reason, key) => {
              const result = await reopenProgram(program.id, {
                reason,
                version: life.version,
                idempotencyKey: key,
              });
              if (result.ok)
                notifySuccess(`${program.programNumber ?? 'The program'} is open again`);
              if (result.ok || result.kind !== 'network') {
                onDone(result.ok ? null : problemText(result));
              }
              return result;
            }}
          />
          <ReasonDialog
            open={dialog === 'request-close'}
            onOpenChange={(open) => setDialog(open ? 'request-close' : null)}
            title="Request closure"
            fieldLabel="Why this program can close"
            description="The people who can close it get your request in their Inbox."
            submitLabel="Send request"
            maxLength={LIFECYCLE_REASON_MAX_LENGTH}
            onSubmit={async (reason, key) => {
              const result = await requestClosure(program.id, { reason, idempotencyKey: key });
              if (result.ok) notifySuccess('Closure requested');
              if (result.ok || result.kind !== 'network') {
                onDone(result.ok ? null : problemText(result));
              }
              return result;
            }}
          />
        </>
      ) : null}
    </header>
  );
}
