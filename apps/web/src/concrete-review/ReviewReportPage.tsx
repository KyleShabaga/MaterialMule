import {
  CONCRETE_EXCEPTION_LABEL,
  concreteReviewOpenExceptions,
  type ConcreteChecklistItem,
  type ConcreteFieldReportDetail,
  type ConcreteReportTransition,
  type ConcreteReportVersionList,
  type MeResponse,
} from '@materialmule/shared';
import {
  Check,
  Eye,
  FileLock,
  Lock,
  RefreshCw,
  RotateCw,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Textarea } from '@/components/ui/textarea';
import { PersonAvatar } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { notifySuccess } from '../components/strata/toast';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { documentException, problemText, sendCommand } from './api';
import {
  PanelSection,
  ReportHeader,
  ReportLoading,
  ReportPaper,
  ReportSplit,
  ReportSteps,
  type StepState,
} from './ReportLayout';
import {
  changeLabel,
  formatValue,
  paperSectionOf,
  ReportPreview,
  type PaperMarker,
} from './ReportPreview';
import { documentBlock, markReviewedBlock, returnBlock, whoCanReview } from './rules';
import { useReviewData, type ReviewData } from './useReviewData';
import './review.css';

// MM-V2-C28 / STRATA-96 (DESIGN.md › Concrete review, round 8; boards R8Report*): the report
// page's Review step. The report as it would be issued (paper, left) beside the review panel
// (right): exceptions (each resolved or documented with a note), changes since the last version,
// comments, routing and history; the decision pinned at the panel's foot: Return for correction
// (a comment is required) or Mark reviewed (once no exception is open). The report's own author
// never sees a reviewer's decision, and neither does the shared LAB account; everyone else sees
// it disabled with the reason when the server doesn't allow it. The server checks every command
// again, including the version shown (stale versions are refused and offered a reload).

const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready_to_submit: 'Ready to submit',
  submitted: 'Awaiting review',
  returned: 'Returned for correction',
  reviewed: 'Reviewed awaiting issuance',
  issued: 'Issued',
  void: 'Void',
};

const STATE_STAGE = {
  draft: 'draft',
  ready_to_submit: 'draft',
  submitted: 'due',
  returned: 'danger',
  reviewed: 'due',
  issued: 'closed',
  void: 'closed',
} as const;

/** The report's workflow state as a tag (the project's Field reports list uses it too). */
export function StateBadge({ state }: { state: string }) {
  return (
    <StageTag
      stage={STATE_STAGE[state as keyof typeof STATE_STAGE] ?? 'closed'}
      label={STATE_LABEL[state] ?? state}
    />
  );
}

/** The report page's status words (round 8): Submitted, Returned for correction, … Recalled. */
function ReportStatusTag({ detail }: { detail: ConcreteFieldReportDetail }) {
  const state = detail.lifecycle.state;
  const recalled =
    (state === 'draft' || state === 'ready_to_submit') &&
    detail.lifecycle.latestVersion?.closed?.kind === 'recalled';
  if (recalled) return <StageTag stage="draft" label="Recalled" />;
  const words: Record<string, string> = { ...STATE_LABEL, submitted: 'Submitted' };
  return (
    <StageTag
      stage={STATE_STAGE[state as keyof typeof STATE_STAGE] ?? 'closed'}
      label={words[state] ?? state}
    />
  );
}

/** A dialog asking for a required comment (strength: return, revise, exclude; field: revise). */
export function CommentDialog({
  open,
  title,
  label,
  hint,
  confirmLabel,
  busy,
  error,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  label: string;
  hint: string;
  confirmLabel: string;
  busy: boolean;
  error: string | null;
  onConfirm: (comment: string) => void;
  onCancel: () => void;
}) {
  const fieldId = useId();
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  const shown = missing ? 'Enter a comment explaining the changes needed.' : error;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) return;
        onCancel();
      }}
    >
      <DialogContent
        onOpenAutoFocus={() => {
          setComment('');
          setMissing(false);
        }}
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (comment.trim() === '') {
              setMissing(true);
              return;
            }
            onConfirm(comment.trim());
          }}
        >
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription className="sr-only">{hint}</DialogDescription>
          </DialogHeader>
          <Field data-invalid={shown ? true : undefined}>
            <FieldLabel htmlFor={fieldId}>
              {label}
              <span className="text-muted-foreground" aria-hidden="true">
                (required)
              </span>
            </FieldLabel>
            <Textarea
              id={fieldId}
              rows={4}
              maxLength={2000}
              aria-required="true"
              value={comment}
              aria-invalid={Boolean(shown)}
              onChange={(event) => {
                setComment(event.target.value);
                setMissing(false);
              }}
            />
            <FieldDescription>{hint}</FieldDescription>
            {shown ? <FieldError>{shown}</FieldError> : null}
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? 'Sending…' : confirmLabel}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

/** A button that, when unavailable, stays visible but disabled with its reason beside it. */
export function ActionButton({
  label,
  block,
  onClick,
  primary = false,
  busy = false,
}: {
  label: string;
  block: string | null;
  onClick: () => void;
  primary?: boolean;
  busy?: boolean;
}) {
  const reasonId = useId();
  return (
    <div className="flex flex-col gap-1">
      <Button
        type="button"
        variant={primary ? 'default' : 'outline'}
        disabled={block !== null || busy}
        aria-describedby={block ? reasonId : undefined}
        onClick={onClick}
      >
        {label}
      </Button>
      {block ? (
        <p id={reasonId} className="text-sm text-muted-foreground">
          {block}
        </p>
      ) : null}
    </div>
  );
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="contents">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{children}</dd>
    </div>
  );
}

export const PANEL_DL = 'grid grid-cols-[6.5rem_1fr] gap-x-3 gap-y-1 text-sm';

// ---------------------------------------------------------------------------------------------

function ExceptionEntry({
  n,
  item,
  canDocument,
  onDocument,
}: {
  n: number;
  item: ConcreteChecklistItem;
  canDocument: boolean;
  onDocument: (note: string) => Promise<string | null>;
}) {
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const status =
    item.status === 'documented' ? (
      <StageTag stage="closed" label="Documented" />
    ) : item.status === 'resolved' ? (
      <StageTag stage="closed" label="Resolved" />
    ) : (
      <StageTag stage="danger" label="Open" />
    );
  return (
    <Item
      variant="outline"
      size="sm"
      role="listitem"
      id={`exception-${n}`}
      tabIndex={-1}
      className="flex-col items-stretch gap-2 scroll-mt-4"
    >
      <div className="flex items-start justify-between gap-2">
        <ItemTitle className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-stage-due-bg text-[11px] font-semibold text-stage-due-fg"
          >
            {n}
          </span>
          {CONCRETE_EXCEPTION_LABEL[item.code]}
        </ItemTitle>
        {status}
      </div>
      <ItemDescription className="line-clamp-none">{item.messages.join(' ')}</ItemDescription>
      {item.status === 'resolved' ? (
        <p className="text-sm text-muted-foreground">
          No longer raised by the report as it stands now.
        </p>
      ) : null}
      {item.note ? (
        <div className="rounded-md bg-muted px-2 py-1.5 text-sm">
          <p>“{item.note.note}”</p>
          <p className="text-xs text-muted-foreground">
            {item.note.documentedBy.name} · {shortDateTime(item.note.documentedAt)}
          </p>
        </div>
      ) : null}
      {item.status === 'open' && canDocument ? (
        <form
          className="flex flex-col gap-2"
          onSubmit={async (event) => {
            event.preventDefault();
            if (note.trim() === '') {
              setError('Enter a note explaining how it was addressed.');
              return;
            }
            setBusy(true);
            const problem = await onDocument(note.trim());
            setBusy(false);
            if (problem) setError(problem);
          }}
        >
          <Field data-invalid={error ? true : undefined}>
            <FieldLabel htmlFor={fieldId}>How it was addressed</FieldLabel>
            <Textarea
              id={fieldId}
              rows={2}
              maxLength={2000}
              aria-required="true"
              placeholder="Enter a note explaining how it was addressed."
              value={note}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setNote(event.target.value);
                setError(null);
              }}
            />
            {error ? <FieldError>{error}</FieldError> : null}
          </Field>
          <div>
            <Button type="submit" variant="outline" size="sm" disabled={busy}>
              {busy ? 'Saving…' : 'Save note'}
            </Button>
          </div>
        </form>
      ) : null}
    </Item>
  );
}

function Exceptions({
  data,
  canDocument,
  onDocument,
}: {
  data: ReviewData;
  canDocument: boolean;
  onDocument: (item: ConcreteChecklistItem, note: string) => Promise<string | null>;
}) {
  const { checklist, detail } = data;
  const open = concreteReviewOpenExceptions(checklist);
  const documented = checklist.length - open.length;
  const count =
    checklist.length === 0
      ? undefined
      : open.length > 0
        ? `${open.length} open · ${documented} documented`
        : `${documented} documented`;
  return (
    <PanelSection id="review-exceptions" title="Exceptions" count={count}>
      {checklist.length === 0 ? (
        <p className="text-sm text-muted-foreground">None on this version.</p>
      ) : (
        <div role="list" className="flex flex-col gap-2">
          {checklist.map((item, i) => (
            <ExceptionEntry
              key={item.key}
              n={i + 1}
              item={item}
              canDocument={canDocument}
              onDocument={(note) => onDocument(item, note)}
            />
          ))}
        </div>
      )}
      <p className="text-xs text-muted-foreground">
        Not checked yet:{' '}
        {[
          ...detail.review.deferredChecks.map(
            (c) => `${c.code.replace(/_/g, ' ')} (arrives with ${c.owner})`,
          ),
          'curing temperature (arrives with C06)',
        ].join('; ')}
        .
      </p>
    </PanelSection>
  );
}

function Changes({ data }: { data: ReviewData }) {
  const { changes, previous, versions, version } = data;
  const previousVersion = versions.versions.find((v) => v.versionNo === version.versionNo - 1);
  return (
    <PanelSection
      id="review-changes"
      title={
        previous ? `Changes since version ${previous.versionNo}` : 'Changes since the last version'
      }
      count={previous && changes.length > 0 ? changes.length : undefined}
    >
      {!previous ? (
        <p className="text-sm text-muted-foreground">None on this version. It is the first.</p>
      ) : changes.length === 0 ? (
        <p className="text-sm text-muted-foreground">None on this version.</p>
      ) : (
        <>
          <p className="text-sm text-muted-foreground">
            {changes.length} {changes.length === 1 ? 'field changed' : 'fields changed'}; each is
            highlighted in the report with its previous value.
          </p>
          <ul className="flex flex-col gap-1 text-sm">
            {changes.map((c) => (
              <li key={c.path} className="flex items-start gap-2">
                <span
                  aria-hidden="true"
                  className="mt-1.5 size-1.5 shrink-0 rounded-full bg-stage-due-mark"
                />
                <span className="min-w-0 break-words">
                  {changeLabel(c.path)}
                  {c.before !== undefined && typeof c.before !== 'object' ? (
                    <>
                      {' '}
                      <span className="font-mono">{formatValue(c.before)}</span> →{' '}
                      <span className="font-mono">{formatValue(c.after)}</span>
                    </>
                  ) : null}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {previousVersion?.closed ? (
        <p className="text-sm">
          {previousVersion.closed.kind === 'returned' ? 'Returned' : 'Recalled'} by{' '}
          {previousVersion.closed.by.name}, {shortDateTime(previousVersion.closed.at)}
          {previousVersion.closed.comment ? `: “${previousVersion.closed.comment}”` : ''}
        </p>
      ) : null}
    </PanelSection>
  );
}

const ACTION_WORDS: Record<string, string> = {
  submit: 'submitted',
  resubmit: 'resubmitted',
  recall: 'recalled',
  return: 'returned',
  review: 'marked reviewed',
  issue: 'issued',
  revise: 'started a revision of',
};

function historyTitle(t: ConcreteReportTransition): string {
  const who = t.staff ? `${t.staff.name} (on ${t.actor.name})` : t.actor.name;
  const verb = ACTION_WORDS[t.action] ?? t.action.replace(/_/g, ' ');
  const routed = t.routedTo ? `; routed to ${t.routedTo.name}` : '';
  if (t.action === 'return') return `${who} returned version ${t.versionNo} for correction`;
  if (t.action === 'resubmit') return `${who} resubmitted it as version ${t.versionNo}${routed}`;
  return `${who} ${verb} version ${t.versionNo}${routed}`;
}

/** Decision comments the server keeps: return, recall and revision reasons. */
function Comments({ versions }: { versions: ConcreteReportVersionList }) {
  const comments = versions.transitions.filter((t) => t.comment);
  return (
    <PanelSection id="review-comments" title="Comments" count={comments.length || undefined}>
      {comments.length === 0 ? (
        <p className="text-sm text-muted-foreground">No comments on this report.</p>
      ) : (
        <ol className="flex flex-col gap-3">
          {[...comments].reverse().map((t) => (
            <li key={t.id} className="flex gap-2">
              <PersonAvatar name={t.actor.name} userId={t.actor.userId} />
              <div className="min-w-0 text-sm">
                <p className="text-xs text-muted-foreground">
                  <span className="font-semibold text-foreground">{t.actor.name}</span> ·{' '}
                  {ACTION_WORDS[t.action] ?? t.action} version {t.versionNo} · {shortDateTime(t.at)}
                </p>
                <p className="break-words">{t.comment}</p>
              </div>
            </li>
          ))}
        </ol>
      )}
    </PanelSection>
  );
}

function History({
  versions,
  id = 'review-history',
}: {
  versions: ConcreteReportVersionList;
  id?: string;
}) {
  const items = [...versions.transitions].reverse();
  return (
    <PanelSection id={id} title="History">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">Nothing recorded yet.</p>
      ) : (
        <ItemGroup aria-label="History, newest first">
          {items.map((t) => (
            <Item key={t.id} size="sm" className="px-0">
              <ItemMedia>
                <PersonAvatar name={t.actor.name} userId={t.actor.userId} />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="font-normal">{historyTitle(t)}</ItemTitle>
                <ItemDescription>{shortDateTime(t.at)}</ItemDescription>
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </PanelSection>
  );
}

function Routing({ detail, data }: { detail: ConcreteFieldReportDetail; data: ReviewData }) {
  const route = data.version.route;
  return (
    <PanelSection id="review-routing" title="Routing">
      <dl className={PANEL_DL}>
        <Labelled label="Routed to">
          {route.routedTo ? route.routedTo.name : 'Any designated reviewer'}
        </Labelled>
        <Labelled label="Can review">{whoCanReview(detail)}</Labelled>
        <Labelled label="Never">
          {detail.technician
            ? `${detail.technician.name}, who wrote it`
            : 'The report’s technician'}
        </Labelled>
      </dl>
    </PanelSection>
  );
}

function LockedReview({ title, text }: { title: string; text: string }) {
  return (
    <PanelSection id="review-locked" title="Review">
      <div className="flex gap-3 rounded-md bg-muted p-3">
        <Lock aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <div className="text-sm">
          <p className="font-semibold">{title}</p>
          <p className="text-muted-foreground">{text}</p>
        </div>
      </div>
    </PanelSection>
  );
}

/** Who reads the report as not a reviewer: its own author, or the shared LAB account. */
function lockedReason(me: MeResponse, detail: ConcreteFieldReportDetail) {
  if (detail.technician?.userId === me.id) {
    return {
      title: 'You wrote this report',
      text: `You can’t review or issue your own report. ${whoCanReview(detail).replace(/^./, (c) => c.toUpperCase())} reviews it; you’ll see their comments here.`,
    };
  }
  if (me.accountType === 'shared_lab') {
    return {
      title: 'Review needs a personal account',
      text: 'Shared LAB computers can read reports but can’t review or issue them. Sign in with your own account to review.',
    };
  }
  return null;
}

/** The steps for a report in this state, on the Review (or Issue) step. */
// eslint-disable-next-line react-refresh/only-export-components -- report page helpers shared with the Issue step
export function stepsFor(
  state: string,
  on: 'review' | 'issue',
): { review: StepState; issue: StepState } {
  const reviewed = state === 'reviewed' || state === 'issued';
  return {
    review: reviewed ? 'done' : on === 'review' ? 'now' : 'later',
    issue: state === 'issued' ? 'done' : on === 'issue' ? 'now' : 'later',
  };
}

/** The header for the report page (both steps). */
export function FieldReportHeader({
  detail,
  versionNo,
  on,
}: {
  detail: ConcreteFieldReportDetail;
  versionNo: number;
  on: 'review' | 'issue';
}) {
  const date = detail.fields.reportDate ?? 'no date';
  const steps = stepsFor(detail.lifecycle.state, on);
  return (
    <ReportHeader
      crumb={
        <>
          <span className="font-mono">{detail.projectNumber}</span> · {date}
        </>
      }
      steps={<ReportSteps review={steps.review} issue={steps.issue} />}
      title={
        <>
          Field report <span className="font-mono">{date}</span>
        </>
      }
      meta={
        <>
          <span className="font-mono">{detail.projectNumber}</span>
          {detail.technician ? (
            <span className="flex items-center gap-1.5">
              ·{' '}
              <PersonAvatar
                name={detail.technician.name}
                userId={detail.technician.userId}
                size="compact"
              />
              {detail.technician.name}
            </span>
          ) : null}
        </>
      }
      tags={
        <>
          <ReportStatusTag detail={detail} />
          <Badge variant="outline">Version {versionNo}</Badge>
          {detail.lifecycle.revised ? <Badge variant="outline">Revised</Badge> : null}
        </>
      }
    />
  );
}

/** The stale version alert: shown whenever the version on screen isn't the report's latest. */
export function StaleAlert({
  data,
  explicit,
  onLatest,
}: {
  data: ReviewData;
  explicit: boolean;
  onLatest: () => void;
}) {
  if (data.isLatest) return null;
  const latest = data.detail.lifecycle.latestVersion;
  return (
    <Alert>
      <RefreshCw aria-hidden="true" />
      <AlertTitle>
        {explicit
          ? `You are looking at version ${data.version.versionNo}`
          : 'This report changed while it was loading'}
      </AlertTitle>
      <AlertDescription>
        <p>
          {latest
            ? `The report’s latest is version ${latest.versionNo}. Reload it to act on the latest version.`
            : 'Reload it to see where it stands.'}
        </p>
        <Button variant="outline" size="sm" className="mt-2" onClick={onLatest}>
          <RotateCw aria-hidden="true" />
          Reload
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function ReportError({ status, onRetry }: { status: number | null; onRetry: () => void }) {
  return (
    <div className="flex flex-col gap-4">
      <ReportHeader crumb="Field report" title="Field report" />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <TriangleAlert aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>
            {status === 404 ? 'This report doesn’t exist.' : 'Couldn’t load this report.'}
          </EmptyTitle>
          <EmptyDescription>
            {status === 404
              ? 'It may have been deleted, or the link is wrong.'
              : 'Check that this computer is on the office network, then try again. Nothing was changed.'}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {status === 404 ? null : (
            <Button onClick={onRetry}>
              <RotateCw aria-hidden="true" />
              Try again
            </Button>
          )}
          <Button variant="outline" asChild>
            <Link to="/concrete/review">Back to the review queue</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

export function ReportUnavailable({
  detail,
  title,
  text,
  action,
}: {
  detail: ConcreteFieldReportDetail;
  title: string;
  text: string;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <ReportHeader
        crumb={
          <>
            <span className="font-mono">{detail.projectNumber}</span> ·{' '}
            {detail.fields.reportDate ?? 'no date'}
          </>
        }
        title={`Field report · ${detail.projectNumber}`}
        tags={<ReportStatusTag detail={detail} />}
      />
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <FileLock aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{title}</EmptyTitle>
          <EmptyDescription>{text}</EmptyDescription>
        </EmptyHeader>
        <EmptyContent className="flex-row justify-center">
          {action}
          <Button variant="outline" asChild>
            <Link to="/concrete/review">Back to the review queue</Link>
          </Button>
        </EmptyContent>
      </Empty>
    </div>
  );
}

/** Numbered markers for the paper: one per exception, on the section its field belongs to. */
// eslint-disable-next-line react-refresh/only-export-components -- report page helpers shared with the Issue step
export function markersFor(checklist: readonly ConcreteChecklistItem[]): PaperMarker[] {
  const out: PaperMarker[] = [];
  checklist.forEach((item, i) => {
    const section = paperSectionOf(item.field);
    if (section) out.push({ n: i + 1, section, label: CONCRETE_EXCEPTION_LABEL[item.code] });
  });
  return out;
}

// ---------------------------------------------------------------------------------------------

export function ReviewReportPage() {
  const { reportId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const versionParam = Number(params.get('version'));
  const versionNo = Number.isInteger(versionParam) && versionParam > 0 ? versionParam : null;
  const { load, reload } = useReviewData(reportId, versionNo);
  const me = useMe();
  const [error, setError] = useState<string | null>(null);
  const [returning, setReturning] = useState(false);
  const [returnComment, setReturnComment] = useState('');
  const [returnMissing, setReturnMissing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [drawerOpen, setDrawerOpen] = useState(false);
  const returnId = useId();
  const markReasonId = useId();
  const returnReasonId = useId();

  if (load.state === 'loading') return <ReportLoading />;
  if (load.state === 'error') return <ReportError status={load.status} onRetry={reload} />;
  if (load.state === 'empty') {
    return (
      <ReportUnavailable
        detail={load.detail}
        title="This report hasn’t been submitted for review yet."
        text="It comes to the review queue when its technician submits it."
      />
    );
  }

  const { data } = load;
  const { detail, version } = data;
  const state = detail.lifecycle.state;
  const latestNo = detail.lifecycle.latestVersion?.versionNo ?? version.versionNo;

  // A report back in draft (recalled, or a revision started) isn't waiting for review; its last
  // submitted version can still be read on purpose.
  if ((state === 'draft' || state === 'ready_to_submit') && versionNo === null) {
    const closed = detail.lifecycle.latestVersion?.closed;
    return (
      <ReportUnavailable
        detail={detail}
        title="This report isn’t waiting for review."
        text={
          closed?.kind === 'recalled'
            ? `${closed.by.name} recalled it to a draft ${shortDateTime(closed.at)}. It comes back to the review queue when it is submitted again.`
            : 'It is a draft again. It comes back to the review queue when it is submitted again.'
        }
        action={
          <Button asChild>
            <Link to={`/concrete/review/${detail.id}?version=${latestNo}`}>
              <Eye aria-hidden="true" />
              Show version {latestNo}
            </Link>
          </Button>
        }
      />
    );
  }

  const open = concreteReviewOpenExceptions(data.checklist);
  const common = { me, detail };
  const stale = 'Reload to review the latest version first.';
  const markReason = data.isLatest ? markReviewedBlock({ ...common, open }) : stale;
  const returnReason = data.isLatest ? returnBlock(common) : stale;
  const canDocument = data.isLatest && documentBlock(common) === null;
  const locked = lockedReason(me, detail);

  const toLatest = () => {
    if (versionNo !== null) setParams({}, { replace: true });
    reload();
  };

  const run = async (action: 'review' | 'return', extra: Record<string, unknown> = {}) => {
    setBusy(true);
    setError(null);
    try {
      await sendCommand(detail.id, action, {
        version: detail.version,
        // Review fix #139: the server refuses the command if this isn't the latest version.
        reportVersionNo: version.versionNo,
        idempotencyKey: crypto.randomUUID(),
        ...extra,
      });
      return true;
    } catch (failure) {
      setError(problemText(failure));
      if ((failure as { code?: string }).code === 'version_conflict') reload();
      return false;
    } finally {
      setBusy(false);
    }
  };

  const decides = !locked && (state === 'submitted' || state === 'reviewed');

  let footer: ReactNode = null;
  if (decides && returning) {
    footer = (
      <form
        className="flex flex-col gap-2"
        onSubmit={async (event) => {
          event.preventDefault();
          if (returnComment.trim() === '') {
            setReturnMissing(true);
            return;
          }
          if (await run('return', { comment: returnComment.trim() })) {
            setReturning(false);
            setReturnComment('');
            notifySuccess('Returned for correction.');
            reload();
          }
        }}
      >
        <Field data-invalid={returnMissing ? true : undefined}>
          <FieldLabel htmlFor={returnId}>
            Comment for {detail.technician?.name ?? 'the technician'}
          </FieldLabel>
          <Textarea
            id={returnId}
            rows={3}
            maxLength={2000}
            aria-required="true"
            placeholder="What needs to change"
            value={returnComment}
            aria-invalid={returnMissing}
            onChange={(event) => {
              setReturnComment(event.target.value);
              setReturnMissing(false);
            }}
          />
          {returnMissing ? (
            <FieldError>Enter a comment explaining the changes needed.</FieldError>
          ) : null}
        </Field>
        {error ? <FieldError>{error}</FieldError> : null}
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setReturning(false);
              setReturnMissing(false);
            }}
          >
            Cancel
          </Button>
          <Button type="submit" disabled={busy}>
            <Undo2 aria-hidden="true" />
            Return for correction
          </Button>
        </div>
      </form>
    );
  } else if (decides) {
    const sameReason = markReason !== null && markReason === returnReason;
    footer = (
      <>
        {error ? <FieldError>{error}</FieldError> : null}
        {state === 'submitted' && markReason ? (
          <p id={markReasonId} className="text-sm text-muted-foreground">
            {markReason}
          </p>
        ) : null}
        {returnReason && !(state === 'submitted' && sameReason) ? (
          <p id={returnReasonId} className="text-sm text-muted-foreground">
            {returnReason}
          </p>
        ) : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={returnReason !== null || busy}
            aria-describedby={
              returnReason
                ? state === 'submitted' && sameReason
                  ? markReasonId
                  : returnReasonId
                : undefined
            }
            onClick={() => {
              setError(null);
              setReturning(true);
            }}
          >
            Return for correction
          </Button>
          {state === 'submitted' ? (
            <Button
              type="button"
              disabled={markReason !== null || busy}
              aria-describedby={markReason ? markReasonId : undefined}
              onClick={async () => {
                if (await run('review')) {
                  notifySuccess('Marked reviewed. It now awaits issuance.');
                  reload();
                }
              }}
            >
              <Check aria-hidden="true" />
              Mark reviewed
            </Button>
          ) : (
            <Button asChild>
              <Link to={`/concrete/review/${detail.id}/issue`}>Go to issue</Link>
            </Button>
          )}
        </div>
      </>
    );
  } else if (state === 'issued') {
    footer = (
      <div className="flex justify-end">
        <Button variant="outline" asChild>
          <Link to={`/concrete/review/${detail.id}/issue`}>What was issued</Link>
        </Button>
      </div>
    );
  }

  const markers = markersFor(data.checklist);
  const issued = version.issued;

  return (
    <div className="flex min-w-0 flex-col gap-4">
      <FieldReportHeader detail={detail} versionNo={version.versionNo} on="review" />
      <ReportSplit
        panelLabel="Review panel"
        drawerOpen={drawerOpen}
        onDrawerOpenChange={setDrawerOpen}
        alert={<StaleAlert data={data} explicit={versionNo !== null} onLatest={toLatest} />}
        paper={
          <ReportPaper
            icon={Eye}
            label={
              <>
                Review preview, not the issued file · template P1 is provisional (report templates
                are an open item).
                {data.previous && data.changes.length > 0
                  ? ` Changes since version ${data.previous.versionNo} are highlighted.`
                  : ''}
              </>
            }
          >
            <ReportPreview
              snapshot={version.snapshot}
              changes={data.changes}
              versionNo={version.versionNo}
              reportNumber={issued?.reportNumber ?? null}
              issuedAt={issued?.at ?? null}
              markers={markers}
              onMarker={(n) => {
                setDrawerOpen(true);
                // The drawer (or the panel) renders the exception; focus it once it is there.
                requestAnimationFrame(() => {
                  const target = document.getElementById(`exception-${n}`);
                  target?.scrollIntoView?.({ block: 'nearest' });
                  target?.focus();
                });
              }}
            />
          </ReportPaper>
        }
        panel={
          <>
            {locked ? <LockedReview title={locked.title} text={locked.text} /> : null}
            <Exceptions
              data={data}
              canDocument={canDocument && !locked}
              onDocument={async (item, note) => {
                try {
                  await documentException(detail.id, version.versionNo, {
                    code: item.code,
                    field: item.field,
                    note,
                  });
                  notifySuccess(`${CONCRETE_EXCEPTION_LABEL[item.code]} documented.`);
                  reload();
                  return null;
                } catch (failure) {
                  return problemText(failure);
                }
              }}
            />
            <Changes data={data} />
            <Comments versions={data.versions} />
            {locked ? null : <Routing detail={detail} data={data} />}
            <History versions={data.versions} />
          </>
        }
        footer={footer}
      />
      {data.versions.versions.length > 1 ? (
        <nav aria-label="Versions" className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-muted-foreground">Versions:</span>
          {data.versions.versions.map((v) => (
            <Button
              key={v.versionNo}
              variant={v.versionNo === version.versionNo ? 'secondary' : 'ghost'}
              size="sm"
              asChild
            >
              <Link
                to={`/concrete/review/${detail.id}?version=${v.versionNo}`}
                aria-current={v.versionNo === version.versionNo ? 'page' : undefined}
              >
                v{v.versionNo} · {STATE_LABEL[v.state] ?? v.state}
              </Link>
            </Button>
          ))}
        </nav>
      ) : null}
    </div>
  );
}
