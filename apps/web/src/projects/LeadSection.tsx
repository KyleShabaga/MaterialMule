import {
  formatPerson,
  type LeadNomination,
  type ProjectLeadNominations,
  type StaffOption,
} from '@materialmule/shared';
import { useCallback, useEffect, useId, useState } from 'react';
import { listActiveStaff } from '../api/projects';
import { BandedCard, ConfirmDialog, ErrorState } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { decideLeadNomination, fetchLeadNominations, nominateLead } from './api';
import { StaffOptionGroups } from './StaffOptionGroups';

// "Lead Project Engineer" on the project page (MM-AO04, D01/D02). A project may wait for a lead:
// receiving carries on, and only decisions that need the lead wait. Anyone may suggest a lead when
// there is none; an admin confirms (which appoints them) or rejects; the person who nominated may
// withdraw. A nomination gives nobody any authority. Rejecting or withdrawing needs a reason;
// confirming doesn't (MISC-03), though one given is recorded.

type Decision = 'confirm' | 'reject' | 'withdraw';

const DECISION_LABEL: Record<Decision, string> = {
  confirm: 'Confirm as Lead Project Engineer',
  reject: 'Reject nomination',
  withdraw: 'Withdraw nomination',
};

const STATUS_LABEL: Record<LeadNomination['status'], string> = {
  pending: 'Waiting for an admin',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function LeadSection({
  projectId,
  lead,
  reloadKey,
  onChanged,
}: {
  projectId: string;
  lead: StaffOption | null;
  reloadKey: number;
  onChanged: (message: string) => void;
}) {
  const [data, setData] = useState<ProjectLeadNominations | null>(null);
  const [failed, setFailed] = useState(false);
  const [staff, setStaff] = useState<StaffOption[]>([]);
  const [nominee, setNominee] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<Decision | null>(null);
  const [reason, setReason] = useState('');
  const [reasonError, setReasonError] = useState<string | null>(null);
  const nomineeId = useId();
  const noteId = useId();
  const reasonId = useId();

  const load = useCallback(() => {
    fetchLeadNominations(projectId).then((result) => {
      if (result.ok) {
        setData(result.data);
        setFailed(false);
      } else {
        setFailed(true);
      }
    });
  }, [projectId]);
  useEffect(load, [load, reloadKey]);

  const canNominate = data?.canNominate ?? false;
  useEffect(() => {
    if (!canNominate) return;
    let cancelled = false;
    listActiveStaff().then(
      (list) => !cancelled && setStaff(list),
      () => !cancelled && setProblem("Couldn't load staff."),
    );
    return () => {
      cancelled = true;
    };
  }, [canNominate]);

  const after = (result: Awaited<ReturnType<typeof nominateLead>>, success: string) => {
    if (result.ok) {
      setData(result.value);
      setProblem(null);
      onChanged(success);
    } else {
      setProblem(result.message);
      load();
    }
  };

  if (lead && data && !data.pending && data.history.length === 0) return null;

  const pending = data?.pending ?? null;
  return (
    <BandedCard
      id="lead"
      className="project-section"
      title="Lead Project Engineer"
      tone={lead ? 'default' : 'attention'}
      aside={lead ? null : <span className="badge badge-warning">Waiting for a lead</span>}
    >
      {failed ? <ErrorState message="The lead details couldn’t be loaded." onRetry={load} /> : null}
      {problem ? (
        <p className="notice notice-warning" role="alert">
          {problem}
        </p>
      ) : null}
      {lead ? (
        <p>
          <strong>{formatPerson(lead.initials, lead.displayName)}</strong> leads this project.
        </p>
      ) : (
        <p className="field-hint">
          This project has no Lead Project Engineer yet. Receiving carries on as normal. Decisions
          only the lead can make, such as closing a program, wait until an admin appoints one.
        </p>
      )}
      {pending ? (
        <div className="lead-nomination" aria-label="Pending nomination" role="group">
          <p>
            <strong>{formatPerson(pending.nominee.initials, pending.nominee.name)}</strong> was
            nominated by {formatPerson(pending.nominatedBy.initials, pending.nominatedBy.name)},{' '}
            {shortDateTime(pending.nominatedAt)}. {STATUS_LABEL.pending}.
          </p>
          {pending.note ? <p className="field-hint">Note: {pending.note}</p> : null}
          <div className="page-actions">
            {data?.canDecide ? (
              <>
                <button
                  type="button"
                  className="primary"
                  disabled={busy}
                  onClick={() => open('confirm')}
                >
                  Confirm
                </button>
                <button type="button" disabled={busy} onClick={() => open('reject')}>
                  Reject
                </button>
              </>
            ) : null}
            {data?.canWithdraw ? (
              <button type="button" disabled={busy} onClick={() => open('withdraw')}>
                Withdraw
              </button>
            ) : null}
          </div>
        </div>
      ) : null}
      {canNominate ? (
        <form
          className="delegate-add"
          aria-label="Nominate a Lead Project Engineer"
          onSubmit={async (event) => {
            event.preventDefault();
            if (!nominee) return;
            setBusy(true);
            const result = await nominateLead(projectId, {
              nomineeUserId: nominee,
              note: note.trim() || null,
              idempotencyKey: key,
            });
            setBusy(false);
            setKey(crypto.randomUUID());
            if (result.ok) {
              setNominee('');
              setNote('');
            }
            after(result, 'Nomination sent to the admins.');
          }}
        >
          <div className="form-field">
            <label htmlFor={nomineeId}>Nominate a Lead Project Engineer</label>
            <select id={nomineeId} value={nominee} onChange={(e) => setNominee(e.target.value)}>
              <option value="">Choose a staff member</option>
              <StaffOptionGroups staff={staff} />
            </select>
            <p className="field-hint">An admin confirms it. Nominating gives nobody authority.</p>
          </div>
          <div className="form-field">
            <label htmlFor={noteId}>Note for the admin (optional)</label>
            <textarea
              id={noteId}
              rows={2}
              maxLength={2000}
              value={note}
              onChange={(e) => setNote(e.target.value)}
            />
          </div>
          <button type="submit" disabled={busy || !nominee}>
            Nominate
          </button>
        </form>
      ) : null}
      {data && data.history.length > 0 ? (
        <details className="delegate-history">
          <summary>Nomination history ({data.history.length})</summary>
          <ul className="delegate-list">
            {data.history.map((n) => (
              <li key={n.id}>
                {formatPerson(n.nominee.initials, n.nominee.name)}: {STATUS_LABEL[n.status]} by{' '}
                {n.decidedBy ? formatPerson(n.decidedBy.initials, n.decidedBy.name) : ''},{' '}
                {n.decidedAt ? shortDateTime(n.decidedAt) : ''}
                {n.decisionReason ? ` (${n.decisionReason})` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
      <ConfirmDialog
        open={deciding !== null}
        title={deciding ? `${DECISION_LABEL[deciding]}?` : ''}
        confirmLabel={
          deciding === 'confirm' ? 'Confirm' : deciding === 'reject' ? 'Reject' : 'Withdraw'
        }
        danger={deciding !== 'confirm'}
        onConfirm={async () => {
          if (!deciding || !pending) return;
          if (deciding !== 'confirm' && !reason.trim()) {
            setReasonError('Enter a reason.');
            return;
          }
          const action = deciding;
          setDeciding(null);
          setBusy(true);
          const result = await decideLeadNomination(projectId, pending.id, action, reason);
          setBusy(false);
          after(
            result,
            action === 'confirm'
              ? `${pending.nominee.name} is now the Lead Project Engineer.`
              : action === 'reject'
                ? 'Nomination rejected. The project is still waiting for a lead.'
                : 'Nomination withdrawn.',
          );
        }}
        onCancel={() => setDeciding(null)}
        cancelOnBackdrop
      >
        <p>
          {deciding === 'confirm'
            ? `${pending?.nominee.name ?? ''} becomes the project's Lead Project Engineer straight away.`
            : 'The project keeps waiting for a lead; anyone may nominate again.'}
        </p>
        <label htmlFor={reasonId}>{deciding === 'confirm' ? 'Reason (optional)' : 'Reason'}</label>
        <textarea
          id={reasonId}
          value={reason}
          maxLength={2000}
          aria-invalid={Boolean(reasonError)}
          onChange={(e) => setReason(e.target.value)}
        />
        {reasonError ? <p className="field-error">{reasonError}</p> : null}
      </ConfirmDialog>
    </BandedCard>
  );

  function open(decision: Decision) {
    setDeciding(decision);
    setReason('');
    setReasonError(null);
  }
}
