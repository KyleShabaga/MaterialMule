import {
  CONCRETE_EXCEPTION_LABEL,
  concreteReviewOpenExceptions,
  type ConcreteChecklistItem,
  type ConcreteFieldReportDetail,
} from '@materialmule/shared';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  BandedCard,
  ErrorState,
  Notice,
  PageHeader,
  SidePanel,
  StatusBadge,
} from '../components/app-ui';
import { FactCells } from '../concrete/ledger';
import { shortDateTime } from '../dashboard/format';
import { ContextRow } from '../layout/ContextRow';
import { useMe } from '../session/context';
import { documentException, problemText, sendCommand, type ReviewCommand } from './api';
import { ReportPreview } from './ReportPreview';
import { documentBlock, markReviewedBlock, returnBlock, whoCanReview } from './rules';
import { useReviewData, type ReviewData } from './useReviewData';
import './review.css';

// MM-V2-C28: the review view (Combined Plan "Review interaction"): the report preview beside a
// checklist of its exceptions and the changes since the previous submitted version; Mark reviewed
// once every required exception is resolved or documented; Return for correction with a comment.
// Field Ledger (ConcreteReviewReport board): the exceptions first, then the report, with the
// decision in the side column (after the report on a phone).

const STATE_LABEL: Record<string, string> = {
  draft: 'Draft',
  ready_to_submit: 'Ready to submit',
  submitted: 'Awaiting review',
  returned: 'Returned for correction',
  reviewed: 'Reviewed awaiting issuance',
  issued: 'Issued',
  void: 'Void',
};

export function StateBadge({ state }: { state: string }) {
  const tone =
    state === 'issued'
      ? 'storage'
      : state === 'returned'
        ? 'danger'
        : state === 'submitted' || state === 'reviewed'
          ? 'waiting'
          : 'closed';
  return <StatusBadge tone={tone}>{STATE_LABEL[state] ?? state}</StatusBadge>;
}

/** A modal asking for a required comment (Return for correction, Start a revision). */
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
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const [comment, setComment] = useState('');
  const [missing, setMissing] = useState(false);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      setComment('');
      setMissing(false);
      dialog.showModal?.();
    }
    if (!open && dialog.open) dialog.close?.();
  }, [open]);
  const shown = missing ? 'Enter a comment explaining the changes needed.' : error;
  return (
    <dialog ref={ref} className="confirm-dialog" onCancel={onCancel} aria-labelledby={titleId}>
      <form
        onSubmit={(event) => {
          event.preventDefault();
          if (comment.trim() === '') {
            setMissing(true);
            return;
          }
          onConfirm(comment.trim());
        }}
      >
        <h2 id={titleId}>{title}</h2>
        <div className="form-field">
          <label htmlFor={fieldId}>
            {label}
            <span className="required-marker" aria-hidden="true">
              {' '}
              (required)
            </span>
          </label>
          <textarea
            id={fieldId}
            rows={4}
            maxLength={2000}
            aria-required="true"
            value={comment}
            aria-invalid={Boolean(shown)}
            aria-describedby={`${fieldId}-hint${shown ? ` ${fieldId}-error` : ''}`}
            onChange={(event) => {
              setComment(event.target.value);
              setMissing(false);
            }}
          />
          <p id={`${fieldId}-hint`} className="field-hint">
            {hint}
          </p>
          {shown ? (
            <p id={`${fieldId}-error`} className="field-error" role="alert">
              {shown}
            </p>
          ) : null}
        </div>
        <div className="dialog-actions">
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
          <button type="submit" className="primary" disabled={busy}>
            {busy ? 'Sending…' : confirmLabel}
          </button>
        </div>
      </form>
    </dialog>
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
    <div className="crv-action">
      <button
        type="button"
        className={primary ? 'primary' : undefined}
        disabled={block !== null || busy}
        aria-describedby={block ? reasonId : undefined}
        onClick={onClick}
      >
        {label}
      </button>
      {block ? (
        <p id={reasonId} className="crv-reason">
          {block}
        </p>
      ) : null}
    </div>
  );
}

function ChecklistEntry({
  item,
  canDocument,
  documentReason,
  onDocument,
}: {
  item: ConcreteChecklistItem;
  canDocument: boolean;
  documentReason: string | null;
  onDocument: (note: string) => Promise<string | null>;
}) {
  const [open, setOpen] = useState(false);
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const fieldId = useId();
  const status =
    item.status === 'documented' ? (
      <StatusBadge tone="storage">Documented</StatusBadge>
    ) : item.status === 'resolved' ? (
      <StatusBadge tone="storage">Resolved</StatusBadge>
    ) : (
      <StatusBadge tone="danger">Open</StatusBadge>
    );
  return (
    <li className={`crv-check-item crv-check-${item.status}`}>
      <div className="crv-check-head">
        {status} <strong>{CONCRETE_EXCEPTION_LABEL[item.code]}</strong>
        <span className="crv-muted"> Required</span>
      </div>
      <ul className="crv-messages">
        {item.messages.map((m, i) => (
          <li key={i}>{m}</li>
        ))}
      </ul>
      {item.status === 'resolved' ? (
        <p className="crv-muted">No longer raised by the report as it stands now.</p>
      ) : null}
      {item.note ? (
        <p className="crv-note">
          “{item.note.note}” — {item.note.documentedBy.name},{' '}
          {shortDateTime(item.note.documentedAt)}
        </p>
      ) : null}
      {item.status === 'open' && canDocument ? (
        open ? (
          <form
            className="crv-note-form"
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
              else setOpen(false);
            }}
          >
            <label htmlFor={fieldId}>
              How it was addressed
              <span className="required-marker" aria-hidden="true">
                {' '}
                (required)
              </span>
            </label>
            <textarea
              id={fieldId}
              rows={3}
              maxLength={2000}
              aria-required="true"
              value={note}
              aria-invalid={Boolean(error)}
              onChange={(event) => {
                setNote(event.target.value);
                setError(null);
              }}
            />
            {error ? (
              <p className="field-error" role="alert">
                {error}
              </p>
            ) : null}
            <div className="crv-inline-actions">
              <button type="submit" className="primary" disabled={busy}>
                {busy ? 'Saving…' : 'Save note'}
              </button>
              <button type="button" onClick={() => setOpen(false)}>
                Cancel
              </button>
            </div>
          </form>
        ) : (
          <button type="button" onClick={() => setOpen(true)}>
            Document exception
          </button>
        )
      ) : null}
      {item.status === 'open' && !canDocument && documentReason ? (
        <p className="crv-reason">{documentReason}</p>
      ) : null}
    </li>
  );
}

function Checklist({
  data,
  documentReason,
  onDocument,
}: {
  data: ReviewData;
  documentReason: string | null;
  onDocument: (item: ConcreteChecklistItem, note: string) => Promise<string | null>;
}) {
  const { checklist, detail, changes, previous, versions, version } = data;
  const open = concreteReviewOpenExceptions(checklist);
  const previousVersion = versions.versions.find((v) => v.versionNo === version.versionNo - 1);
  return (
    <aside className="crv-first" aria-label="Review checklist">
      <BandedCard
        title="Exceptions"
        className="crv-card"
        tone={open.length > 0 ? 'attention' : 'default'}
        subtitle={
          checklist.length === 0
            ? 'None on this version'
            : `${open.length} open of ${checklist.length}`
        }
      >
        {checklist.length === 0 ? (
          <p>This version was submitted without exceptions.</p>
        ) : (
          <ul className="crv-checklist">
            {checklist.map((item) => (
              <ChecklistEntry
                key={item.key}
                item={item}
                canDocument={documentReason === null && data.isLatest}
                documentReason={data.isLatest ? documentReason : null}
                onDocument={(note) => onDocument(item, note)}
              />
            ))}
          </ul>
        )}
        <h3 className="crv-subhead">Not yet checked</h3>
        <ul className="crv-messages">
          {detail.review.deferredChecks.map((c) => (
            <li key={c.code}>
              {c.code.replace(/_/g, ' ')} — arrives with {c.owner}
            </li>
          ))}
          <li>curing temperature — arrives with C06</li>
        </ul>
      </BandedCard>
      <BandedCard
        title="Changes since the previous version"
        className="crv-card"
        subtitle={previous ? `Version ${previous.versionNo} → ${version.versionNo}` : undefined}
      >
        {!previous ? (
          <p>This is the first submitted version.</p>
        ) : changes.length === 0 ? (
          <p>No report content changed.</p>
        ) : (
          <p>
            {changes.length} {changes.length === 1 ? 'field changed' : 'fields changed'}; each is
            marked “Changed” in the preview with its previous value. Everything else is as before.
          </p>
        )}
        {previousVersion?.closed ? (
          <p className="crv-note">
            {previousVersion.closed.kind === 'returned' ? 'Returned' : 'Recalled'} by{' '}
            {previousVersion.closed.by.name}, {shortDateTime(previousVersion.closed.at)}
            {previousVersion.closed.comment ? `: “${previousVersion.closed.comment}”` : ''}
          </p>
        ) : null}
      </BandedCard>
    </aside>
  );
}

function History({ data }: { data: ReviewData }) {
  return (
    <BandedCard title="History" className="crv-card">
      <ol className="crv-history">
        {data.versions.transitions.map((t) => (
          <li key={t.id}>
            <span className="mono">v{t.versionNo}</span> {t.action.replace(/_/g, ' ')} by{' '}
            {t.staff ? `${t.staff.name} (on ${t.actor.name})` : t.actor.name}, {shortDateTime(t.at)}
            {t.routedTo ? ` → routed to ${t.routedTo.name}` : ''}
            {t.comment ? `: “${t.comment}”` : ''}
          </li>
        ))}
      </ol>
    </BandedCard>
  );
}

export function ReviewReportPage() {
  const { reportId = '' } = useParams();
  const [params, setParams] = useSearchParams();
  const versionParam = Number(params.get('version'));
  const versionNo = Number.isInteger(versionParam) && versionParam > 0 ? versionParam : null;
  const { load, reload } = useReviewData(reportId, versionNo);
  const me = useMe();
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [dialog, setDialog] = useState<'return' | 'revise' | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (load.state === 'loading') {
    return <p aria-busy="true">Loading the report…</p>;
  }
  const back = (
    <ContextRow>
      <Link to="/concrete/review">Back to the review queue</Link>
    </ContextRow>
  );
  if (load.state === 'error') {
    return (
      <div className="crv-page">
        {back}
        <PageHeader title="Concrete review" />
        <ErrorState
          message={
            load.status === 404 ? 'This report doesn’t exist.' : 'The report couldn’t be loaded.'
          }
          onRetry={load.status === 404 ? undefined : reload}
        />
      </div>
    );
  }
  if (load.state === 'empty') {
    return (
      <div className="crv-page">
        {back}
        <PageHeader title={`Field report · ${load.detail.projectNumber}`} />
        <p>This report hasn’t been submitted for review yet.</p>
      </div>
    );
  }

  const { data } = load;
  const { detail, version } = data;
  const open = concreteReviewOpenExceptions(data.checklist);
  const common = { me, detail };
  const reviewReason = data.isLatest
    ? markReviewedBlock({ ...common, open })
    : 'You are looking at an earlier version.';
  const returnReason = data.isLatest
    ? returnBlock(common)
    : 'You are looking at an earlier version.';
  const documentReason = documentBlock(common);

  const run = async (
    action: ReviewCommand,
    extra: Record<string, unknown> = {},
  ): Promise<ConcreteFieldReportDetail | null> => {
    setBusy(true);
    setMessage(null);
    try {
      const next = await sendCommand(detail.id, action, {
        version: detail.version,
        // Review fix #139: the server refuses the command if this isn't the latest version.
        reportVersionNo: version.versionNo,
        idempotencyKey: crypto.randomUUID(),
        ...extra,
      });
      return next;
    } catch (error) {
      const text = problemText(error);
      if (dialog) setDialogError(text);
      else setMessage({ tone: 'error', text });
      if ((error as { code?: string }).code === 'version_conflict') reload();
      return null;
    } finally {
      setBusy(false);
    }
  };

  const heading = `Field report · ${detail.projectNumber} · ${detail.fields.reportDate ?? 'no date'}`;
  const state = detail.lifecycle.state;
  const decides = state === 'submitted' || state === 'reviewed' || state === 'issued';
  return (
    <div className="crv-page">
      <ContextRow>
        <Link to="/concrete/review">Back to the review queue</Link>
        <StateBadge state={state} />
        {detail.lifecycle.revised ? <StatusBadge tone="lab">Revised</StatusBadge> : null}
      </ContextRow>
      <PageHeader title={heading} />
      <FactCells
        label="Report"
        className="crv-facts"
        cells={[
          { key: 'technician', label: 'Technician', value: detail.technician?.name ?? '—' },
          { key: 'submitted', label: 'Submitted', value: shortDateTime(version.submittedAt) },
          ...(version.route.routedTo
            ? [{ key: 'routed', label: 'Routed to', value: version.route.routedTo.name }]
            : []),
          {
            key: 'version',
            label: 'Version',
            value: (
              <select
                className="crv-version-pick"
                aria-label="Version"
                value={version.versionNo}
                onChange={(event) => setParams({ version: event.target.value }, { replace: true })}
              >
                {data.versions.versions.map((v) => (
                  <option key={v.versionNo} value={v.versionNo}>
                    v{v.versionNo} · {STATE_LABEL[v.state] ?? v.state}
                  </option>
                ))}
              </select>
            ),
          },
        ]}
      />

      {message ? (
        <Notice tone={message.tone === 'ok' ? 'success' : 'danger'} className="crv-message">
          {message.text}
        </Notice>
      ) : null}

      <div className="crv-layout">
        <div className="crv-main">
          <Checklist
            data={data}
            documentReason={documentReason}
            onDocument={async (item, note) => {
              try {
                await documentException(detail.id, version.versionNo, {
                  code: item.code,
                  field: item.field,
                  note,
                });
                setMessage({
                  tone: 'ok',
                  text: `${CONCRETE_EXCEPTION_LABEL[item.code]} documented.`,
                });
                reload();
                return null;
              } catch (error) {
                return problemText(error);
              }
            }}
          />
          <ReportPreview
            snapshot={version.snapshot}
            changes={data.changes}
            versionNo={version.versionNo}
          />
        </div>
        {decides ? (
          <SidePanel title="Review actions" className="crv-decision">
            {state === 'submitted' || state === 'reviewed' ? (
              <p className="crv-who">
                Who can review or return it: {whoCanReview(detail)}. Never the report’s technician;
                personal accounts only.
              </p>
            ) : null}
            <div className="crv-action-stack">
              {detail.lifecycle.state === 'submitted' ? (
                <ActionButton
                  label="Mark reviewed"
                  primary
                  block={reviewReason}
                  busy={busy}
                  onClick={async () => {
                    const next = await run('review');
                    if (next) {
                      setMessage({ tone: 'ok', text: 'Marked reviewed. It now awaits issuance.' });
                      reload();
                    }
                  }}
                />
              ) : null}
              {detail.lifecycle.state === 'submitted' || detail.lifecycle.state === 'reviewed' ? (
                <ActionButton
                  label="Return for correction"
                  block={returnReason}
                  busy={busy}
                  onClick={() => {
                    setDialogError(null);
                    setDialog('return');
                  }}
                />
              ) : null}
              {detail.lifecycle.state === 'reviewed' ? (
                <Link className="button primary" to={`/concrete/review/${detail.id}/issue`}>
                  Go to issue
                </Link>
              ) : null}
              {detail.lifecycle.state === 'issued' &&
              detail.lifecycle.allowedActions.includes('revise') ? (
                <ActionButton
                  label="Start a revision"
                  block={null}
                  busy={busy}
                  onClick={() => {
                    setDialogError(null);
                    setDialog('revise');
                  }}
                />
              ) : null}
              {detail.lifecycle.state === 'issued' ? (
                <Link to={`/concrete/review/${detail.id}/issue`}>What was issued</Link>
              ) : null}
            </div>
          </SidePanel>
        ) : null}
      </div>
      <History data={data} />

      <CommentDialog
        open={dialog === 'return'}
        title="Return for correction"
        label="What needs correcting"
        hint="The technician sees this comment. Explain the changes needed."
        confirmLabel="Return report"
        busy={busy}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={async (comment) => {
          const next = await run('return', { comment });
          if (next) {
            setDialog(null);
            setMessage({ tone: 'ok', text: 'Returned for correction.' });
            reload();
          }
        }}
      />
      <CommentDialog
        open={dialog === 'revise'}
        title="Start a revision"
        label="Reason for the revision"
        hint="The issued version stays as issued. The report reopens for the technician to correct."
        confirmLabel="Start revision"
        busy={busy}
        error={dialogError}
        onCancel={() => setDialog(null)}
        onConfirm={async (comment) => {
          const next = await run('revise', { comment });
          if (next) {
            setDialog(null);
            setMessage({ tone: 'ok', text: 'Revision started. The report is a draft again.' });
            reload();
          }
        }}
      />
    </div>
  );
}

export function Labelled({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="crv-field">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}
