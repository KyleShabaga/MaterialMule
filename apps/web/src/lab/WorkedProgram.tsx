import {
  COMMENT_MAX_LENGTH,
  REVIEW_EVENT_LABEL,
  STATUS_TRANSITIONS,
  formatAttribution,
  formatLineDepth,
  formatPerson,
  labProgramPhase,
  testProgress,
  type LabComment,
  type LabLine,
  type LabProgram,
  type ProgramUnits,
  type ProgramWork,
  type ReceiverOption,
  type SameSourceUnits,
  type TestRequest,
} from '@materialmule/shared';
import { Check } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useId,
  useState,
  type ComponentProps,
  type ReactNode,
} from 'react';
import { Link, useLocation } from 'react-router';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { cn } from '@/lib/utils';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { PersonAvatar } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { shortDateTime, shortTime } from '../dashboard/format';
import { useMe } from '../session/context';
import {
  addComment,
  changeStatus,
  editComment,
  fetchSameSourceUnits,
  fetchWork,
  type WriteResult,
} from './api';
import { AmendProgram, ChangeAcceptedTest } from './AmendmentControls';
import { TEST_STATE_WORDS, activityTime, lineTitle, requestName } from './format';
import { ProgramLifecycle, RequestLifecycle } from './LifecycleControls';
import { ProgramHeader } from './ProgramHeader';
import { ReviewControls } from './ReviewControls';
import { ProgramUnitsToPull } from './UnitsToPull';

// A submitted program (STRATA-87, the record pattern; MM-T24–T26 behaviour): the header with the
// main action by phase, then the lines with each test's state as a record word and the actions
// the server allows (tests start here, never on Workboard cards), Units to pull, comments, and
// the history beside. A shared LAB station names "Who is doing this?" in each action's own panel:
// the choice belongs to that action on this station only, never to the account. Statuses are
// shared: after any action or conflict the program reloads; what someone was typing stays in its
// box. Progress only: no results are ever recorded or shown.

const newKey = () => crypto.randomUUID();

function problemText(result: Exclude<WriteResult<unknown>, { ok: true }>): string {
  if (result.kind === 'conflict') {
    if (result.code === 'version_conflict') {
      return 'Another station updated this first. The program has been refreshed; check it and try again.';
    }
    if (result.code === 'edit_window_closed') return 'Comments can only be edited for 15 minutes.';
    return 'This changed elsewhere. The program has been refreshed.';
  }
  if (result.kind === 'invalid') {
    return result.errors.map((error) => error.message).join(' ') || 'Check the details.';
  }
  // MM-AO07: authority may have changed since the page loaded; the page reloads after this.
  if (result.kind === 'forbidden') {
    return 'You can’t do this now. Nothing was saved; the page now shows what you can do.';
  }
  if (result.kind === 'network') return 'Couldn’t reach Material Mule. Try again.';
  return 'Something went wrong. Try again.';
}

/** "Who is doing this?" for a LAB station; nothing for a personal account. */
function WhoIsDoingThis({
  value,
  onChange,
}: {
  value: ReceiverOption | null;
  onChange: (value: ReceiverOption | null) => void;
}) {
  const me = useMe();
  if (me.accountType !== 'shared_lab') return null;
  return (
    <ReceiverSelect
      label="Who is doing this?"
      required
      stationPerson="follow"
      value={value}
      onChange={onChange}
      hint="Shared LAB station: attribution only; LAB gains none of this person’s permissions."
    />
  );
}

/**
 * shadcn ItemGroup as a real list: ItemGroup is a `div role="list"`, which can't hold the `li`
 * items (test rows, comments, history) without invalid nesting; same classes and data-slot.
 */
function ItemList({ className, ...props }: ComponentProps<'ul'>) {
  return (
    <ul
      role="list"
      data-slot="item-group"
      className={cn('group/item-group flex flex-col', className)}
      {...props}
    />
  );
}

/** A shadcn checkbox with its label. */
function CheckRow({
  checked,
  onChange,
  children,
}: {
  checked: boolean;
  onChange: (checked: boolean) => void;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <div className="flex items-start gap-2 py-1">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onChange(value === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="font-normal">
        {children}
      </Label>
    </div>
  );
}

/**
 * MM-T73: a Shelby tube or bulk-sample bucket the test used that isn't in the line's frozen
 * coverage. Only units of the line's own source in the program's project are offered, and
 * recording one needs an explicit confirmation, stored with the link (who and when).
 */
function SameSourcePicker({
  testRequestId,
  chosen,
  onChosen,
  confirmed,
  onConfirmed,
}: {
  testRequestId: string;
  chosen: string[];
  onChosen: (ids: string[]) => void;
  confirmed: boolean;
  onConfirmed: (value: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [data, setData] = useState<SameSourceUnits | null>(null);
  const [failed, setFailed] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open || data) return;
    let live = true;
    fetchSameSourceUnits(testRequestId).then(
      (value) => {
        if (live) setData(value);
      },
      () => {
        if (live) setFailed(true);
      },
    );
    return () => {
      live = false;
    };
  }, [open, data, testRequestId]);

  if (!open) {
    return (
      <Button
        type="button"
        variant="link"
        className="h-auto self-start p-0"
        onClick={() => setOpen(true)}
      >
        Used a unit from this source that isn’t listed?
      </Button>
    );
  }
  if (failed) {
    return (
      <p className="text-sm text-muted-foreground">
        Couldn’t load the other units from this source.
      </p>
    );
  }
  if (!data) {
    return <p className="text-sm text-muted-foreground">Loading other units from this source…</p>;
  }
  const source = data.sourceLabel ?? 'this line’s source';
  const chosenIds = data.units
    .filter((unit) => chosen.includes(unit.storageUnitId))
    .map((unit) => unit.readableId);
  return (
    <fieldset className="flex flex-col gap-1" aria-describedby={`${id}-hint`}>
      <legend className="text-sm font-medium">Other units from {source}</legend>
      <p id={`${id}-hint`} className="text-sm text-muted-foreground">
        Outside this line’s coverage. Only Shelby tubes and bulk-sample buckets from the same source
        and project are offered.
      </p>
      {data.units.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No other Shelby tubes or bulk-sample buckets from {source}.
        </p>
      ) : (
        data.units.map((unit) => (
          <CheckRow
            key={unit.storageUnitId}
            checked={chosen.includes(unit.storageUnitId)}
            onChange={(checked) =>
              onChosen(
                checked
                  ? [...chosen, unit.storageUnitId]
                  : chosen.filter((other) => other !== unit.storageUnitId),
              )
            }
          >
            <span className="font-mono">{unit.readableId}</span> {unit.contents ?? ''}
          </CheckRow>
        ))
      )}
      {chosenIds.length > 0 ? (
        <CheckRow checked={confirmed} onChange={onConfirmed}>
          I confirm {chosenIds.join(', ')} {chosenIds.length === 1 ? 'is' : 'are'} from {source} and{' '}
          {chosenIds.length === 1 ? 'was' : 'were'} used in this test
        </CheckRow>
      ) : null}
    </fieldset>
  );
}

/** Start, Mark completed, Send to review: the one path, as the server's transition table allows. */
function StatusAction({
  request,
  line,
  work,
  onDone,
}: {
  request: TestRequest;
  line: LabLine;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const me = useMe();
  const shared = me.accountType === 'shared_lab';
  const progress = work.requests.find((r) => r.testRequestId === request.id);
  const status = progress?.status ?? request.status;
  const next = STATUS_TRANSITIONS[status];
  const [open, setOpen] = useState(false);
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [units, setUnits] = useState<string[]>([]);
  const [noTracked, setNoTracked] = useState(false);
  // MM-T73: same-source units outside the line's coverage, and the explicit confirmation.
  const [extra, setExtra] = useState<string[]>([]);
  const [extraConfirmed, setExtraConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const id = useId();
  if (!next || !progress || !me.permissions.includes('test.progress')) return null;
  const completing = next.to === 'completed';
  const needsUnits = completing && progress.needsTestedUnits;
  const candidates = line.coverage.filter((unit) => unit.included);
  const ready =
    (!shared || person !== null) &&
    (!needsUnits || units.length > 0 || noTracked || extra.length > 0) &&
    (extra.length === 0 || extraConfirmed);

  async function confirm() {
    setBusy(true);
    const tested = [...units, ...extra];
    const result = await changeStatus(request.id, {
      to: next!.to,
      version: progress!.version,
      idempotencyKey: key,
      ...(shared && person ? { actingStaffUserId: person.id } : {}),
      ...(completing && (needsUnits || tested.length > 0) ? { testedStorageUnitIds: tested } : {}),
      ...(completing && extra.length > 0 ? { sameSourceConfirmedUnitIds: extra } : {}),
    });
    setBusy(false);
    // A lost response keeps the key, so trying again can't record the action twice.
    if (!result.ok && result.kind === 'network') {
      onDone(problemText(result));
      return;
    }
    setKey(newKey());
    setOpen(false);
    setPerson(null);
    setUnits([]);
    setExtra([]);
    setExtraConfirmed(false);
    onDone(result.ok ? null : problemText(result));
  }

  if (!open && !shared && !completing) {
    return (
      <Button type="button" size="sm" onClick={() => void confirm()} disabled={busy}>
        {next.action}
      </Button>
    );
  }
  if (!open) {
    return (
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        {next.action}
      </Button>
    );
  }
  return (
    <div
      className="flex basis-full flex-col gap-3 rounded-md border bg-muted/40 p-3"
      role="group"
      aria-labelledby={`${id}-title`}
    >
      <p id={`${id}-title`} className="text-sm font-semibold">
        {next.action}: {request.code}
      </p>
      <WhoIsDoingThis value={person} onChange={setPerson} />
      {completing && candidates.length > 0 ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="text-sm font-medium">
            Units actually used{needsUnits ? ' (required)' : ' (optional)'}
          </legend>
          <p className="text-sm text-muted-foreground">
            Tick only the physical units this test used. Covered material isn’t marked tested unless
            it is ticked here.
          </p>
          {candidates.map((unit) => (
            <CheckRow
              key={unit.storageUnitId}
              checked={units.includes(unit.storageUnitId)}
              onChange={(checked) => {
                setNoTracked(false);
                setUnits((current) =>
                  checked
                    ? [...current, unit.storageUnitId]
                    : current.filter((other) => other !== unit.storageUnitId),
                );
              }}
            >
              <span className="font-mono">{unit.readableId}</span> {unit.contents ?? ''}
            </CheckRow>
          ))}
          {needsUnits ? (
            <CheckRow
              checked={noTracked}
              onChange={(checked) => {
                setNoTracked(checked);
                if (checked) setUnits([]);
              }}
            >
              None of these units was used
            </CheckRow>
          ) : null}
        </fieldset>
      ) : null}
      {completing ? (
        <SameSourcePicker
          testRequestId={request.id}
          chosen={extra}
          onChosen={(chosen) => {
            setExtra(chosen);
            // A confirmation covers exactly the units it named.
            setExtraConfirmed(false);
          }}
          confirmed={extraConfirmed}
          onConfirmed={setExtraConfirmed}
        />
      ) : null}
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="button" size="sm" disabled={!ready || busy} onClick={() => void confirm()}>
          {next.action}
        </Button>
      </div>
    </div>
  );
}

const STATUS_VERB: Partial<Record<TestRequest['status'], string>> = {
  in_progress: 'Started',
  completed: 'Done',
  review: 'Sent to review',
  requested: 'Back to waiting',
};

/** The last status change of a test: "Started by Pat Example, Nov 12, 9:12 a.m." */
function lastChange(work: ProgramWork, requestId: string): string | null {
  const events = work.statusHistory.filter((event) => event.testRequestId === requestId);
  const last = events[events.length - 1];
  if (!last) return null;
  const verb = STATUS_VERB[last.toStatus] ?? 'Changed';
  return `${verb} by ${formatAttribution(last.account, last.person)}, ${shortDateTime(last.changedAt)}`;
}

function CommentBox({
  programId,
  lineId,
  onPosted,
}: {
  programId: string;
  lineId: string | null;
  onPosted: (message: string | null) => void;
}) {
  const me = useMe();
  const shared = me.accountType === 'shared_lab';
  const id = useId();
  const [body, setBody] = useState('');
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  if (!me.permissions.includes('lab_comment.write')) return null;
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={async (event) => {
        event.preventDefault();
        setBusy(true);
        const result = await addComment(programId, {
          lineId,
          body,
          idempotencyKey: key,
          ...(shared && person ? { actingStaffUserId: person.id } : {}),
        });
        setBusy(false);
        if (result.ok) {
          setBody('');
          setKey(newKey());
          setPerson(null);
          onPosted(null);
        } else {
          // The text stays in the box whatever went wrong.
          if (result.kind !== 'network') setKey(newKey());
          onPosted(problemText(result));
        }
      }}
    >
      <Label htmlFor={id}>{lineId ? 'Comment on this line' : 'Comment on the program'}</Label>
      <Textarea
        id={id}
        value={body}
        rows={2}
        maxLength={COMMENT_MAX_LENGTH}
        onChange={(e) => setBody(e.target.value)}
      />
      <WhoIsDoingThis value={person} onChange={setPerson} />
      <Button
        type="submit"
        size="sm"
        variant="outline"
        className="self-end"
        disabled={busy || !body.trim() || (shared && !person)}
      >
        Post comment
      </Button>
    </form>
  );
}

export function CommentItem({
  comment,
  onChanged,
}: {
  comment: LabComment;
  onChanged: (message: string | null) => void;
}) {
  const me = useMe();
  const shared = me.accountType === 'shared_lab';
  const [editing, setEditing] = useState(false);
  const [body, setBody] = useState(comment.body);
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [key, setKey] = useState(newKey);
  const [now, setNow] = useState(() => Date.now());
  const mine = comment.account.userId === me.id;
  const deadline = new Date(comment.editableUntil).getTime();
  const canEdit = mine && deadline > now;
  // MTR-139: Edit (and its deadline) goes away when the window closes, without a reload.
  useEffect(() => {
    if (!canEdit) return;
    const timer = setTimeout(() => setNow(Date.now()), deadline - now);
    return () => clearTimeout(timer);
  }, [canEdit, deadline, now]);
  const author = comment.author ?? comment.account;
  return (
    <Item asChild size="sm" className="items-start px-0">
      <li>
        <PersonAvatar name={author.name} userId={author.userId} />
        <ItemContent className="min-w-0">
          <ItemTitle>
            {formatAttribution(comment.account, comment.author)}
            <span className="font-normal text-muted-foreground">
              {activityTime(comment.createdAt)}
              {comment.editedAt ? ` · edited ${shortDateTime(comment.editedAt)}` : ''}
            </span>
          </ItemTitle>
          {editing ? (
            <form
              className="flex flex-col gap-2"
              onSubmit={async (event) => {
                event.preventDefault();
                // The window can close while the editor is open; the API still decides, but don't
                // send an edit we know it will refuse, whether by click or by Enter in a field.
                if (!mine || new Date(comment.editableUntil).getTime() <= Date.now()) {
                  setNow(Date.now());
                  return;
                }
                const result = await editComment(comment.id, {
                  body,
                  version: comment.version,
                  idempotencyKey: key,
                  ...(shared && person ? { actingStaffUserId: person.id } : {}),
                });
                if (result.ok || result.kind !== 'network') setKey(newKey());
                if (result.ok) setEditing(false);
                onChanged(result.ok ? null : problemText(result));
              }}
            >
              <Label htmlFor={`edit-${comment.id}`} className="sr-only">
                Edit comment
              </Label>
              <Textarea
                id={`edit-${comment.id}`}
                value={body}
                maxLength={COMMENT_MAX_LENGTH}
                onChange={(e) => setBody(e.target.value)}
              />
              <WhoIsDoingThis value={person} onChange={setPerson} />
              {canEdit ? null : (
                <Alert variant="destructive">
                  <AlertDescription>
                    The 15-minute edit window has closed, so this change can’t be saved. Copy your
                    text if you need it, then cancel.
                  </AlertDescription>
                </Alert>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="sm"
                  disabled={!canEdit || !body.trim() || (shared && !person)}
                >
                  Save comment
                </Button>
              </div>
            </form>
          ) : (
            <p className="text-sm whitespace-pre-wrap">{comment.body}</p>
          )}
          {canEdit && !editing ? (
            <p className="flex items-center gap-2 text-sm">
              <Button
                type="button"
                variant="link"
                className="h-auto p-0"
                onClick={() => setEditing(true)}
              >
                Edit
              </Button>
              <span className="text-muted-foreground">
                Editable until {shortTime(comment.editableUntil)}
              </span>
            </p>
          ) : null}
          {comment.revisions.length > 1 ? (
            <details className="text-sm text-muted-foreground" data-slot="earlier-versions">
              <summary className="cursor-pointer">
                Earlier versions ({comment.revisions.length - 1})
              </summary>
              <ol className="mt-1 flex flex-col gap-1">
                {comment.revisions.slice(0, -1).map((revision) => (
                  <li key={revision.revisionNumber}>
                    {formatPerson(revision.person.initials, revision.person.name)},{' '}
                    {shortDateTime(revision.createdAt)}: {revision.body}
                  </li>
                ))}
              </ol>
            </details>
          ) : null}
        </ItemContent>
      </li>
    </Item>
  );
}

function Comments({
  programId,
  lineId,
  comments,
  onChanged,
}: {
  programId: string;
  lineId: string | null;
  comments: LabComment[];
  onChanged: (message: string | null) => void;
}) {
  const mine = comments.filter((comment) => comment.lineId === lineId);
  return (
    <div className="flex flex-col gap-2">
      {mine.length > 0 ? (
        <ItemList aria-label={lineId ? 'Line comments' : 'Program comments'}>
          {mine.map((comment) => (
            <CommentItem
              key={`${comment.id}:${comment.version}`}
              comment={comment}
              onChanged={onChanged}
            />
          ))}
        </ItemList>
      ) : lineId === null ? (
        <p className="text-sm text-muted-foreground">No comments yet.</p>
      ) : null}
      <CommentBox programId={programId} lineId={lineId} onPosted={onChanged} />
    </div>
  );
}

/** A test's state: the record word on its stage colour; Done and Accepted carry a check. */
export function TestStateTag({ status }: { status: TestRequest['status'] }) {
  const word = TEST_STATE_WORDS[status];
  return (
    <StageTag
      stage={word.stage}
      label={word.label}
      icon={word.check ? Check : undefined}
      className="shrink-0"
    />
  );
}

/** One test on a line: name, state, who did what last, and the actions the server allows. */
function TestRow({
  request,
  line,
  program,
  work,
  onDone,
}: {
  request: TestRequest;
  line: LabLine;
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const progress = work.requests.find((r) => r.testRequestId === request.id);
  const status = progress?.status ?? request.status;
  const cancelled = status === 'cancelled';
  const changed = lastChange(work, request.id);
  const tested = work.testedUnits.filter((unit) => unit.testRequestId === request.id);
  return (
    <Item asChild size="sm" className="flex-wrap items-start px-0">
      <li id={`request-${request.id}`} data-status={status}>
        <ItemContent className="min-w-0">
          <ItemTitle className={cn(cancelled && 'text-muted-foreground line-through')}>
            <span title={request.description}>{requestName(request)}</span>
            {request.amendmentId ? <StageTag variant="outline" label="Added by amendment" /> : null}
          </ItemTitle>
          {changed ? <ItemDescription>{changed}</ItemDescription> : null}
          {request.identity ? (
            <ItemDescription>
              Sample now {request.identity.sampleLabel} at {formatLineDepth(request.identity)}
            </ItemDescription>
          ) : null}
          {tested.length > 0 ? (
            <p className="text-sm">
              Used:{' '}
              {tested.map((unit, index) => (
                // The unit's page shows its evidence and, for a personal account, the separate
                // removal after testing (MM-T36).
                <span key={unit.storageUnitId}>
                  {index > 0 ? ', ' : null}
                  <Button variant="link" asChild className="h-auto p-0 font-mono">
                    <Link to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}>
                      {unit.readableId}
                    </Link>
                  </Button>
                </span>
              ))}
            </p>
          ) : null}
          {tested
            .filter((unit) => unit.confirmation !== null)
            .map((unit) => (
              <ItemDescription key={`${unit.storageUnitId}-confirmed`}>
                {unit.readableId} was outside this line’s coverage: same source confirmed by{' '}
                {formatPerson(unit.confirmation!.person.initials, unit.confirmation!.person.name)},{' '}
                {shortDateTime(unit.confirmation!.confirmedAt)}
              </ItemDescription>
            ))}
          <ReviewControls testRequestId={request.id} work={work} onDone={onDone} />
          <RequestLifecycle request={request} program={program} work={work} onDone={onDone} />
          <ChangeAcceptedTest request={request} line={line} work={work} onDone={onDone} />
        </ItemContent>
        <ItemActions className="flex-wrap justify-end">
          <StatusAction request={request} line={line} work={work} onDone={onDone} />
          <TestStateTag status={status} />
        </ItemActions>
      </li>
    </Item>
  );
}

/** One line: its source and scope, the units it covers, its tests and its comments. */
function ProgramLine({
  line,
  program,
  work,
  onDone,
}: {
  line: LabLine;
  program: LabProgram;
  work: ProgramWork;
  onDone: (message: string | null) => void;
}) {
  const headingId = useId();
  const included = line.coverage.filter((unit) => unit.included);
  return (
    <section
      aria-labelledby={headingId}
      className="flex flex-col gap-1 border-t pt-3 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 id={headingId} className="text-sm font-semibold">
          Line {line.lineNumber} · {lineTitle(line)}
        </h3>
        {line.amendmentId ? <StageTag variant="outline" label="Added by amendment" /> : null}
      </div>
      <p className="text-sm text-muted-foreground">
        {included.length === 0 ? (
          'No physical unit linked'
        ) : (
          <>
            Covers{' '}
            {included.map((unit, index) => (
              <span key={unit.storageUnitId}>
                {index > 0 ? ', ' : null}
                <Button variant="link" asChild className="h-auto p-0 font-mono">
                  <Link to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}>
                    {unit.readableId}
                  </Link>
                </Button>
              </span>
            ))}
            {line.coverage.length > included.length
              ? ` · ${line.coverage.length - included.length} excluded after review`
              : ''}
          </>
        )}
      </p>
      <ItemList className="request-list">
        {line.requests.map((request) => (
          <TestRow
            key={request.id}
            request={request}
            line={line}
            program={program}
            work={work}
            onDone={onDone}
          />
        ))}
      </ItemList>
      <Comments
        programId={program.id}
        lineId={line.id}
        comments={work.comments}
        onChanged={onDone}
      />
    </section>
  );
}

interface HistoryEntry {
  id: string;
  at: string;
  person: { userId: string | null; initials: string | null; name: string };
  text: string;
}

/** Everything that happened to the program, newest first, from what the work view carries. */
function historyOf(program: LabProgram, work: ProgramWork): HistoryEntry[] {
  const name = (id: string) => {
    for (const line of program.lines) {
      const request = line.requests.find((r) => r.id === id);
      if (request) return `${request.name ?? request.code} on L${line.lineNumber}`;
    }
    return 'a test';
  };
  const entries: HistoryEntry[] = [];
  if (program.submittedAt) {
    const by = program.submittedFor ?? program.requestedBy;
    entries.push({
      id: 'submitted',
      at: program.submittedAt,
      person: by,
      text: 'submitted it to the lab',
    });
  }
  entries.push({
    id: 'created',
    at: program.createdAt,
    person: program.requestedBy,
    text: 'started this draft',
  });
  for (const event of work.statusHistory) {
    const verb =
      event.toStatus === 'in_progress'
        ? 'started'
        : event.toStatus === 'completed'
          ? 'finished'
          : event.toStatus === 'review'
            ? 'sent to review'
            : 'changed';
    entries.push({
      id: `s-${event.id}`,
      at: event.changedAt,
      person: event.person,
      text: `${verb} ${name(event.testRequestId)}`,
    });
  }
  for (const event of work.reviewEvents) {
    entries.push({
      id: `r-${event.id}`,
      at: event.occurredAt,
      person: event.person,
      text: `${REVIEW_EVENT_LABEL[event.kind].toLowerCase()}: ${name(event.testRequestId)}${
        event.comment ? ` (“${event.comment}”)` : ''
      }`,
    });
  }
  for (const event of work.priorityHistory) {
    entries.push({
      id: `p-${event.id}`,
      at: event.changedAt,
      person: event.person,
      text: `marked it ${event.toPriority} priority (was ${event.fromPriority})`,
    });
  }
  for (const event of work.lifecycle.events) {
    entries.push({
      id: `l-${event.id}`,
      at: event.occurredAt,
      person: event.person,
      text: `${event.kind === 'closed' ? 'closed' : 'reopened'} the program${
        event.reason ? ` (“${event.reason}”)` : ''
      }`,
    });
  }
  for (const request of work.requests) {
    const life = request.lifecycle;
    if (life.cancelledAt && life.cancelledBy) {
      entries.push({
        id: `c-${request.testRequestId}`,
        at: life.cancelledAt,
        person: life.cancelledBy,
        text: `cancelled ${name(request.testRequestId)} (“${life.cancelReason ?? ''}”)`,
      });
    }
  }
  return entries.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.id.localeCompare(b.id)));
}

const HISTORY_PAGE = 8;

/** History beside the record, newest first, a page at a time. */
function ProgramHistory({ program, work }: { program: LabProgram; work: ProgramWork }) {
  const entries = historyOf(program, work);
  const [shown, setShown] = useState(HISTORY_PAGE);
  return (
    <section aria-labelledby="program-history" className="flex flex-col gap-2">
      <div className="flex items-baseline gap-2">
        <h2 id="program-history" className="text-base font-semibold">
          History
        </h2>
        <span className="text-sm text-muted-foreground">
          {entries.length} {entries.length === 1 ? 'event' : 'events'}
        </span>
      </div>
      <ItemList aria-label="Program history">
        {entries.slice(0, shown).map((entry) => (
          <Item key={entry.id} asChild size="sm" className="items-start px-0">
            <li>
              <PersonAvatar name={entry.person.name} userId={entry.person.userId} size="compact" />
              <ItemContent>
                <ItemTitle className="font-normal">
                  <span>
                    <span className="font-medium">{entry.person.name}</span> {entry.text}
                  </span>
                </ItemTitle>
                <ItemDescription>{activityTime(entry.at)}</ItemDescription>
              </ItemContent>
            </li>
          </Item>
        ))}
      </ItemList>
      {entries.length > shown ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="self-start"
          onClick={() => setShown((n) => n + HISTORY_PAGE)}
        >
          Show {Math.min(HISTORY_PAGE, entries.length - shown)} more
        </Button>
      ) : null}
    </section>
  );
}

/**
 * Printing sample ID tags (MM-T69): offered right after submission and kept on the program for
 * reprinting (Print tags). Optional; printing tags changes nothing in the program.
 */
function SampleTagsPrompt({ program }: { program: LabProgram }) {
  const location = useLocation();
  const justSubmitted = (location.state as { submitted?: boolean } | null)?.submitted === true;
  if (!justSubmitted) {
    return (
      <Button variant="link" asChild className="h-auto self-start p-0">
        <Link to={`/lab-testing/programs/${program.id}/tags`}>Print sample ID tags</Link>
      </Button>
    );
  }
  return (
    <Alert role="status">
      <AlertTitle>Program submitted. Print sample ID tags for the samples now?</AlertTitle>
      <AlertDescription>
        <p>You can also do it later from Print tags.</p>
        <Button asChild size="sm" className="mt-2">
          <Link to={`/lab-testing/programs/${program.id}/tags`}>Print sample ID tags</Link>
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function WorkedProgram({ program, reload }: { program: LabProgram; reload: () => void }) {
  const me = useMe();
  const [work, setWork] = useState<ProgramWork | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [units, setUnits] = useState<ProgramUnits | null>(null);
  const location = useLocation();
  // The Workboard's Review link lands on #review and starts reviewing here.
  const [reviewing, setReviewing] = useState(() => location.hash === '#review');
  const [changes, setChanges] = useState(0);
  const refresh = useCallback(() => {
    fetchWork(program.id).then(
      (loaded) => {
        setWork(loaded);
        setFailed(false);
      },
      () => setFailed(true),
    );
  }, [program.id]);
  useEffect(refresh, [refresh, program.version]);

  const after = (text: string | null) => {
    setMessage(text);
    setChanges((n) => n + 1);
    reload();
    refresh();
  };

  const statusOf = (request: TestRequest) =>
    work?.requests.find((r) => r.testRequestId === request.id)?.status ?? request.status;
  const counts: Partial<Record<TestRequest['status'], number>> = {};
  for (const request of program.lines.flatMap((line) => line.requests)) {
    const status = statusOf(request);
    counts[status] = (counts[status] ?? 0) + 1;
  }
  const progress = testProgress(counts);
  const status = work?.lifecycle.status ?? (program.status === 'closed' ? 'closed' : 'submitted');
  const phase = labProgramPhase({
    status,
    counts,
    cancelledWithoutReason: work?.lifecycle.closure.blockers.some(
      (blocker) => blocker.reason === 'cancelled_without_reason',
    ),
    unitsToPull: (units?.toPull ?? 0) > 0,
  });

  // Review on this page: tests in review that this account can decide or cancel.
  const reviewable = work
    ? work.requests.filter(
        (r) =>
          r.status === 'review' &&
          (r.reviewActions.canReview ||
            r.reviewActions.canAccept ||
            r.reviewActions.canCorrectionDone ||
            r.lifecycle.canCancel),
      )
    : [];
  const total = progress.done + progress.inProgress + progress.notStarted + progress.cancelled;
  const decided = (counts.accepted ?? 0) + (counts.cancelled ?? 0);
  const startReview = () => {
    const next = !reviewing;
    setReviewing(next);
    const first = reviewable[0];
    if (next && first) {
      document
        .getElementById(`request-${first.testRequestId}`)
        ?.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  };

  return (
    <article aria-labelledby="program-heading" className="lab-program flex flex-col gap-6">
      <ProgramHeader
        program={program}
        work={work}
        phase={phase}
        progress={progress}
        reviewing={reviewing}
        onReview={reviewable.length > 0 || reviewing ? startReview : null}
        onDone={after}
      />
      {failed ? (
        <Alert variant="destructive">
          <AlertTitle>Progress couldn’t be loaded.</AlertTitle>
          <AlertDescription>
            <Button variant="outline" size="sm" className="mt-2" onClick={refresh}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {message ? (
        <Alert variant="destructive">
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
      {reviewing && phase === 'review' ? (
        <Alert role="status">
          <AlertTitle>
            Reviewing{me.roles.includes('lab_manager') ? ' as Lab Manager' : ''}. Accept each test
            or cancel it with a reason.
          </AlertTitle>
          <AlertDescription>
            {decided} of {total} decided. Every test is accepted or cancelled with a reason before
            the program closes.
          </AlertDescription>
        </Alert>
      ) : null}
      <div className="grid min-w-0 gap-8 @container/record lg:grid-cols-[minmax(0,2fr)_minmax(16rem,1fr)]">
        <div className="flex min-w-0 flex-col gap-6">
          {work ? (
            <>
              <ProgramLifecycle program={program} work={work} />
              {status === 'submitted' ? <SampleTagsPrompt program={program} /> : null}
              <AmendProgram
                program={program}
                work={work}
                onDone={after}
                onRefresh={() => {
                  reload();
                  refresh();
                }}
              />
              <section
                id="review"
                aria-labelledby="program-lines"
                className="flex scroll-mt-20 flex-col gap-3"
              >
                <div className="flex items-baseline gap-2">
                  <h2 id="program-lines" className="text-base font-semibold">
                    Lines
                  </h2>
                  <span className="text-sm text-muted-foreground">
                    {program.lines.length} {program.lines.length === 1 ? 'line' : 'lines'} · {total}{' '}
                    {total === 1 ? 'test' : 'tests'} · progress only, no results
                  </span>
                </div>
                {program.lines.map((line) => (
                  <ProgramLine
                    key={line.id}
                    line={line}
                    program={program}
                    work={work}
                    onDone={after}
                  />
                ))}
              </section>
            </>
          ) : failed ? null : (
            <p aria-busy="true" className="text-sm text-muted-foreground">
              Loading progress…
            </p>
          )}
          <ProgramUnitsToPull
            programId={program.id}
            open={status === 'submitted'}
            version={program.version + changes}
            onLoaded={setUnits}
          />
          {work ? (
            <section
              aria-labelledby="program-comments"
              className="program-comments flex flex-col gap-2"
            >
              <h2 id="program-comments" className="text-base font-semibold">
                Comments
              </h2>
              <Comments
                programId={program.id}
                lineId={null}
                comments={work.comments}
                onChanged={after}
              />
            </section>
          ) : null}
        </div>
        <aside className="flex min-w-0 flex-col gap-6 lg:sticky lg:top-20 lg:self-start">
          {work ? <ProgramHistory program={program} work={work} /> : null}
          {program.notes ? (
            <section aria-labelledby="program-notes" className="flex flex-col gap-1">
              <h2 id="program-notes" className="text-base font-semibold">
                Notes
              </h2>
              <p className="text-sm whitespace-pre-wrap">{program.notes}</p>
            </section>
          ) : null}
        </aside>
      </div>
    </article>
  );
}
