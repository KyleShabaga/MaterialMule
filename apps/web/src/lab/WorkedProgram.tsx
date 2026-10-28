import {
  COMMENT_MAX_LENGTH,
  STATUS_TRANSITIONS,
  formatAttribution,
  formatLineDepth,
  formatPerson,
  programLabel,
  type LabComment,
  type LabLine,
  type LabProgram,
  type ProgramWork,
  type ReceiverOption,
  type TestRequest,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { ErrorState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import {
  addComment,
  changePriority,
  changeStatus,
  editComment,
  fetchWork,
  type WriteResult,
} from './api';
import { FrozenLine, ProgramSummary } from './ProgramDetailPage';
import { AmendProgram, ChangeAcceptedTest } from './AmendmentControls';
import { ProgramLifecycle, RequestLifecycle } from './LifecycleControls';
import { ReviewControls } from './ReviewControls';

// A submitted program being worked (MM-T24): per-test status buttons along the one path, the
// exact units used when completing, priority with history, and comment threads. A shared LAB
// station names "Who is doing this?" in each action's own panel: the choice belongs to that
// action on this station only, never to the account. Statuses are shared: after any action or
// conflict the program reloads; what someone was typing stays in its box.

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
  if (result.kind === 'forbidden') return 'You can’t do this from this account.';
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
      value={value}
      onChange={onChange}
      hint="Shared LAB station: attribution only; LAB gains none of this person’s permissions."
    />
  );
}

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
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(newKey);
  const id = useId();
  if (!next || !progress || !me.permissions.includes('test.progress')) return null;
  const completing = next.to === 'completed';
  const needsUnits = completing && progress.needsTestedUnits;
  const candidates = line.coverage.filter((unit) => unit.included);
  const ready = (!shared || person !== null) && (!needsUnits || units.length > 0 || noTracked);

  async function confirm() {
    setBusy(true);
    const result = await changeStatus(request.id, {
      to: next!.to,
      version: progress!.version,
      idempotencyKey: key,
      ...(shared && person ? { actingStaffUserId: person.id } : {}),
      ...(completing && (needsUnits || units.length > 0) ? { testedStorageUnitIds: units } : {}),
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
    onDone(result.ok ? null : problemText(result));
  }

  if (!open && !shared && !completing) {
    return (
      <button type="button" onClick={() => void confirm()} disabled={busy}>
        {next.action}
      </button>
    );
  }
  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)}>
        {next.action}
      </button>
    );
  }
  return (
    <div className="action-panel" role="group" aria-labelledby={`${id}-title`}>
      <p id={`${id}-title`} className="action-title">
        {next.action}: {request.code}
      </p>
      <WhoIsDoingThis value={person} onChange={setPerson} />
      {completing && candidates.length > 0 ? (
        <fieldset className="unit-choices">
          <legend>Units actually used{needsUnits ? ' (required)' : ' (optional)'}</legend>
          <p className="field-hint">
            Tick only the physical units this test used. Covered material isn’t marked tested unless
            it is ticked here.
          </p>
          {candidates.map((unit) => (
            <label key={unit.storageUnitId} className="unit-choice">
              <input
                type="checkbox"
                checked={units.includes(unit.storageUnitId)}
                onChange={(event) => {
                  setNoTracked(false);
                  setUnits((current) =>
                    event.target.checked
                      ? [...current, unit.storageUnitId]
                      : current.filter((other) => other !== unit.storageUnitId),
                  );
                }}
              />
              <span className="mono">{unit.readableId}</span> {unit.contents ?? ''}
            </label>
          ))}
          {needsUnits ? (
            <label className="unit-choice">
              <input
                type="checkbox"
                checked={noTracked}
                onChange={(event) => {
                  setNoTracked(event.target.checked);
                  if (event.target.checked) setUnits([]);
                }}
              />
              None of these units was used
            </label>
          ) : null}
        </fieldset>
      ) : null}
      <div className="form-actions">
        <button type="button" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="primary"
          disabled={!ready || busy}
          onClick={() => void confirm()}
        >
          {next.action}
        </button>
      </div>
    </div>
  );
}

function lastChange(work: ProgramWork, requestId: string): string | null {
  const events = work.statusHistory.filter((event) => event.testRequestId === requestId);
  const last = events[events.length - 1];
  return last
    ? `${formatAttribution(last.account, last.person)}, ${shortDateTime(last.changedAt)}`
    : null;
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
      className="comment-box"
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
      <label htmlFor={id}>{lineId ? 'Comment on this line' : 'Comment on the program'}</label>
      <textarea
        id={id}
        value={body}
        maxLength={COMMENT_MAX_LENGTH}
        onChange={(e) => setBody(e.target.value)}
      />
      <WhoIsDoingThis value={person} onChange={setPerson} />
      <button type="submit" disabled={busy || !body.trim() || (shared && !person)}>
        Post comment
      </button>
    </form>
  );
}

function CommentItem({
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
  const [now] = useState(() => Date.now());
  const mine = comment.account.userId === me.id;
  const canEdit = mine && new Date(comment.editableUntil).getTime() > now;
  return (
    <li className="comment">
      <p className="comment-meta">
        <strong>{formatAttribution(comment.account, comment.author)}</strong> ·{' '}
        {shortDateTime(comment.createdAt)}
        {comment.editedAt ? ` · edited ${shortDateTime(comment.editedAt)}` : ''}
      </p>
      {editing ? (
        <form
          onSubmit={async (event) => {
            event.preventDefault();
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
          <label htmlFor={`edit-${comment.id}`} className="visually-hidden">
            Edit comment
          </label>
          <textarea
            id={`edit-${comment.id}`}
            value={body}
            maxLength={COMMENT_MAX_LENGTH}
            onChange={(e) => setBody(e.target.value)}
          />
          <WhoIsDoingThis value={person} onChange={setPerson} />
          <div className="form-actions">
            <button type="button" onClick={() => setEditing(false)}>
              Cancel
            </button>
            <button
              type="submit"
              className="primary"
              disabled={!body.trim() || (shared && !person)}
            >
              Save comment
            </button>
          </div>
        </form>
      ) : (
        <p className="pre-wrap">{comment.body}</p>
      )}
      {canEdit && !editing ? (
        <button type="button" onClick={() => setEditing(true)}>
          Edit
        </button>
      ) : null}
      {comment.revisions.length > 1 ? (
        <details>
          <summary>Earlier versions ({comment.revisions.length - 1})</summary>
          <ol>
            {comment.revisions.slice(0, -1).map((revision) => (
              <li key={revision.revisionNumber}>
                <span className="field-hint">
                  {formatPerson(revision.person.initials, revision.person.name)},{' '}
                  {shortDateTime(revision.createdAt)}:
                </span>{' '}
                {revision.body}
              </li>
            ))}
          </ol>
        </details>
      ) : null}
    </li>
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
    <div className="comments">
      {mine.length > 0 ? (
        <ul className="comment-list" aria-label={lineId ? 'Line comments' : 'Program comments'}>
          {mine.map((comment) => (
            <CommentItem
              key={`${comment.id}:${comment.version}`}
              comment={comment}
              onChanged={onChanged}
            />
          ))}
        </ul>
      ) : null}
      <CommentBox programId={programId} lineId={lineId} onPosted={onChanged} />
    </div>
  );
}

function PriorityControl({
  program,
  work,
  onChanged,
}: {
  program: LabProgram;
  work: ProgramWork;
  onChanged: (message: string | null) => void;
}) {
  const [key, setKey] = useState(newKey);
  const [busy, setBusy] = useState(false);
  const other = program.priority === 'urgent' ? 'normal' : 'urgent';
  return (
    <div className="priority-control">
      {work.canChangePriority && program.status === 'submitted' ? (
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            const result = await changePriority(program.id, {
              priority: other,
              version: program.version,
              idempotencyKey: key,
            });
            setBusy(false);
            if (result.ok || result.kind !== 'network') setKey(newKey());
            onChanged(result.ok ? null : problemText(result));
          }}
        >
          {other === 'urgent' ? 'Mark urgent' : 'Mark normal'}
        </button>
      ) : null}
      {work.priorityHistory.length > 0 ? (
        <details className="priority-history">
          <summary>Priority history</summary>
          <ul>
            {work.priorityHistory.map((event) => (
              <li key={event.id}>
                {event.fromPriority} → {event.toPriority} by{' '}
                {formatPerson(event.person.initials, event.person.name)},{' '}
                {shortDateTime(event.changedAt)}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </div>
  );
}

export function WorkedProgram({ program, reload }: { program: LabProgram; reload: () => void }) {
  const [work, setWork] = useState<ProgramWork | null>(null);
  const [failed, setFailed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
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
    reload();
    refresh();
  };

  return (
    <article aria-labelledby="program-heading">
      <h2 id="program-heading" className="mono">
        {programLabel(program)}
      </h2>
      <ProgramSummary program={program} />
      {failed ? <ErrorState message="Progress couldn’t be loaded." onRetry={refresh} /> : null}
      {message ? (
        <p className="notice notice-warning" role="alert">
          {message}
        </p>
      ) : null}
      {work ? (
        <>
          <ProgramLifecycle program={program} work={work} onDone={after} />
          <AmendProgram program={program} work={work} onDone={after} />
          <PriorityControl program={program} work={work} onChanged={after} />
          {program.lines.map((line) => (
            <FrozenLine
              key={line.id}
              line={line}
              statusOf={(request) =>
                work.requests.find((r) => r.testRequestId === request.id)?.status ?? request.status
              }
              testActions={(request) => {
                const changed = lastChange(work, request.id);
                const tested = work.testedUnits.filter((unit) => unit.testRequestId === request.id);
                return (
                  <>
                    {changed ? <span className="field-hint">{changed}</span> : null}
                    {request.identity ? (
                      <span className="field-hint">
                        Sample now {request.identity.sampleLabel} at{' '}
                        {formatLineDepth(request.identity)}
                      </span>
                    ) : null}
                    {request.amendmentId ? (
                      <span className="field-hint">Added by amendment</span>
                    ) : null}
                    {tested.length > 0 ? (
                      <StatusBadge tone="info">
                        Used: {tested.map((unit) => unit.readableId).join(', ')}
                      </StatusBadge>
                    ) : null}
                    <StatusAction request={request} line={line} work={work} onDone={after} />
                    <ReviewControls testRequestId={request.id} work={work} onDone={after} />
                    <RequestLifecycle
                      request={request}
                      program={program}
                      work={work}
                      onDone={after}
                    />
                    <ChangeAcceptedTest request={request} line={line} work={work} onDone={after} />
                  </>
                );
              }}
            >
              <Comments
                programId={program.id}
                lineId={line.id}
                comments={work.comments}
                onChanged={after}
              />
            </FrozenLine>
          ))}
          <section aria-labelledby="program-comments" className="program-comments">
            <h3 id="program-comments">Program comments</h3>
            <Comments
              programId={program.id}
              lineId={null}
              comments={work.comments}
              onChanged={after}
            />
          </section>
        </>
      ) : failed ? null : (
        <p aria-busy="true">Loading progress…</p>
      )}
    </article>
  );
}
