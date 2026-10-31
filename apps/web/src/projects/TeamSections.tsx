import {
  formatPerson,
  type ProjectReportIssuers,
  type ProjectReviewers,
  type ProjectTeam,
  type ReceiverOption,
  type ReportIssuerGrant,
  type ReviewApproval,
  type ReviewerAssignment,
  type ReviewScope,
  type TeamMember,
} from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { ReceiverSelect } from '../components/ReceiverSelect';
import { BandedCard, EmptyState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { ReasonDialog } from './ReasonDialog';
import {
  addTeamMember,
  assignReviewer,
  fetchEligibleReviewers,
  grantIssuer,
  removeReviewer,
  approveReviewer,
  withdrawApproval,
  removeTeamMember,
  revokeIssuer,
  type WriteOutcome,
} from './team-api';

// The managed sections of Team & Permissions (MM-AO05). Each shows the server's list and offers
// controls only when the server says this person may manage it (`canManage`). Nothing here claims
// success before the server confirms it; a refused write keeps the form's entries.

/** Runs a write; on success applies the server's view. Resolves to whether it succeeded. */
export type RunWrite = <T>(
  write: Promise<WriteOutcome<T>>,
  success: string,
  apply: (value: T) => void,
) => Promise<boolean>;

function who(person: { initials: string | null; name: string }): string {
  return formatPerson(person.initials, person.name);
}

/** "Added by JS · Jordan Smith, 29 Oct 14:05" plus the reason, when there is one. */
function Started({
  row,
  verb,
}: {
  row: TeamMember | ReviewerAssignment | ReportIssuerGrant;
  verb: string;
}) {
  return (
    <>
      <span className="field-hint">
        {verb} by {who(row.startedBy)}, {shortDateTime(row.startedAt)}
      </span>
      {row.startReason ? <span className="field-hint">Reason: {row.startReason}</span> : null}
    </>
  );
}

function ReasonField({ value, onChange }: { value: string; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>Reason</label>
      <textarea
        id={id}
        rows={2}
        maxLength={2000}
        value={value}
        onChange={(event) => onChange(event.target.value)}
      />
    </div>
  );
}

function ManageForm({
  label,
  submitLabel,
  disabled,
  onSubmit,
  children,
}: {
  label: string;
  submitLabel: string;
  disabled: boolean;
  onSubmit: () => void;
  children: ReactNode;
}) {
  return (
    <form
      className="delegate-add"
      aria-label={label}
      onSubmit={(event: FormEvent) => {
        event.preventDefault();
        if (!disabled) onSubmit();
      }}
    >
      {children}
      <button type="submit" disabled={disabled}>
        {submitLabel}
      </button>
    </form>
  );
}

function ScopeSelect({
  scopes,
  value,
  onChange,
  label,
}: {
  scopes: ReviewScope[];
  value: string;
  onChange: (code: string) => void;
  label: string;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <select id={id} value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">Choose a scope</option>
        {scopes.map((scope) => (
          <option key={scope.code} value={scope.code}>
            {scope.label}
          </option>
        ))}
      </select>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Project team (D04)
// ---------------------------------------------------------------------------------------------

export function TeamSection({
  projectId,
  data,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectTeam;
  run: RunWrite;
  onChange: (next: ProjectTeam) => void;
}) {
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<TeamMember | null>(null);

  return (
    <BandedCard
      className="project-section"
      title="Project team"
      subtitle="Supporting engineers and others working on the project. Being on the team grants no approvals by itself."
    >
      {data.active.length === 0 ? (
        <EmptyState>No team members yet.</EmptyState>
      ) : (
        <ul className="delegate-list" aria-label="Team members">
          {data.active.map((member) => (
            <li key={member.id}>
              <strong>{who(member.person)}</strong>
              <Started row={member} verb="Added" />
              {data.canManage ? (
                <button type="button" disabled={busy} onClick={() => setRemoving(member)}>
                  Remove {member.person.name}
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data.canManage ? (
        <ManageForm
          label="Add team member"
          submitLabel="Add to team"
          disabled={busy || !person || !reason.trim()}
          onSubmit={async () => {
            if (!person) return;
            setBusy(true);
            const ok = await run(
              addTeamMember(projectId, { userId: person.id, reason, idempotencyKey: key }),
              `Added ${person.displayName} to the team.`,
              onChange,
            );
            setBusy(false);
            setKey(crypto.randomUUID());
            if (ok) {
              setPerson(null);
              setReason('');
            }
          }}
        >
          <ReceiverSelect
            label="Add a team member"
            value={person}
            onChange={setPerson}
            hint="Search by initials or name."
          />
          <ReasonField value={reason} onChange={setReason} />
        </ManageForm>
      ) : null}
      <ReasonDialog
        open={removing !== null}
        title={`Remove ${removing?.person.name ?? ''} from the team?`}
        confirmLabel="Remove"
        onConfirm={async (text) => {
          const member = removing;
          setRemoving(null);
          if (!member) return;
          setBusy(true);
          await run(
            removeTeamMember(projectId, member.id, text),
            `Removed ${member.person.name} from the team.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setRemoving(null)}
      >
        <p>Their earlier work keeps their name. Other grants they hold here aren’t changed.</p>
      </ReasonDialog>
    </BandedCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Review responsibilities (D04/D05)
// ---------------------------------------------------------------------------------------------

const REVIEWER_BLOCKED: Record<NonNullable<ReviewerAssignment['blockedReason']>, string> = {
  account_not_active: 'Not effective: account isn’t active',
  eligibility_revoked: 'Not effective: not eligible to review',
  not_accepted_member: 'Not effective: not an accepted team member',
  not_approved: 'Waiting for the lead’s review approval',
};

const APPROVAL_END: Record<NonNullable<ReviewApproval['endKind']>, string> = {
  withdrawn: 'Approval withdrawn',
  eligibility_lost: 'Eligibility lost',
  assignment_ended: 'Assignment removed',
};

export function ReviewersSection({
  projectId,
  data,
  scopes,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectReviewers;
  scopes: ReviewScope[];
  run: RunWrite;
  onChange: (next: ProjectReviewers) => void;
}) {
  const [scope, setScope] = useState('');
  const [lookup, setLookup] = useState<{
    scope: string;
    people: ReceiverOption[] | 'failed';
  } | null>(null);
  const [reviewer, setReviewer] = useState('');
  const [reason, setReason] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [removing, setRemoving] = useState<ReviewerAssignment | null>(null);
  const [withdrawing, setWithdrawing] = useState<ReviewerAssignment | null>(null);
  const reviewerId = useId();

  useEffect(() => {
    if (!scope || !data.canManage) return;
    let cancelled = false;
    void fetchEligibleReviewers(scope).then((result) => {
      if (!cancelled) setLookup({ scope, people: result.ok ? result.data : 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [scope, data.canManage]);
  const found = lookup?.scope === scope ? lookup.people : null;
  const lookupFailed = found === 'failed';
  const candidates = found === 'failed' ? null : found;

  const byScope = scopes
    .map((s) => ({ scope: s, rows: data.active.filter((row) => row.scope.code === s.code) }))
    .filter((group) => group.rows.length > 0);
  // Assignments to scopes no longer offered still show.
  const other = data.active.filter((row) => !scopes.some((s) => s.code === row.scope.code));

  const row = (assignment: ReviewerAssignment) => (
    <li key={assignment.id}>
      <strong>{who(assignment.reviewer)}</strong>
      {assignment.effective ? (
        <StatusBadge tone="success">Effective</StatusBadge>
      ) : (
        <StatusBadge tone="warning">
          {assignment.blockedReason ? REVIEWER_BLOCKED[assignment.blockedReason] : 'Not effective'}
        </StatusBadge>
      )}
      <Started row={assignment} verb="Assigned" />
      {/* MISC-08: eligibility, accepted membership and the lead's approval, each shown apart. */}
      <span className="field-hint">
        {assignment.eligible ? 'Eligible' : 'Not eligible'} ·{' '}
        {assignment.acceptedMember ? 'Accepted team member' : 'Not an accepted team member'} ·{' '}
        {assignment.approval
          ? `Approved to review by ${who(assignment.approval.approvedBy)}`
          : 'Not approved to review'}
      </span>
      {data.canApprove && !assignment.approval ? (
        <button
          type="button"
          disabled={busy || !assignment.eligible || !assignment.acceptedMember}
          onClick={async () => {
            setBusy(true);
            await run(
              approveReviewer(projectId, assignment.id, crypto.randomUUID()),
              `Approved ${assignment.reviewer.name} to review ${assignment.scope.label}.`,
              onChange,
            );
            setBusy(false);
          }}
        >
          Approve {assignment.reviewer.name} to review ({assignment.scope.label})
        </button>
      ) : null}
      {data.canApprove && assignment.approval ? (
        <button type="button" disabled={busy} onClick={() => setWithdrawing(assignment)}>
          Withdraw approval ({assignment.reviewer.name}, {assignment.scope.label})
        </button>
      ) : null}
      {data.canManage ? (
        <button type="button" disabled={busy} onClick={() => setRemoving(assignment)}>
          Remove {assignment.reviewer.name} ({assignment.scope.label})
        </button>
      ) : null}
    </li>
  );

  return (
    <BandedCard
      className="project-section"
      title="Review responsibilities"
      subtitle="Designated reviewers, each for an explicit scope. One eligible review is enough unless a workflow says otherwise."
    >
      {data.active.length === 0 ? (
        <EmptyState>No designated reviewers.</EmptyState>
      ) : (
        <>
          {byScope.map((group) => (
            <div key={group.scope.code} className="reviewer-scope">
              <h3>{group.scope.label}</h3>
              <ul className="delegate-list" aria-label={`Reviewers: ${group.scope.label}`}>
                {group.rows.map(row)}
              </ul>
            </div>
          ))}
          {other.length > 0 ? (
            <ul className="delegate-list" aria-label="Reviewers: other scopes">
              {other.map(row)}
            </ul>
          ) : null}
        </>
      )}
      {data.canManage ? (
        <ManageForm
          label="Assign reviewer"
          submitLabel="Assign reviewer"
          disabled={busy || !scope || !reviewer || !reason.trim()}
          onSubmit={async () => {
            const chosen = candidates?.find((c) => c.id === reviewer);
            setBusy(true);
            const ok = await run(
              assignReviewer(projectId, {
                reviewerUserId: reviewer,
                scopeCode: scope,
                reason,
                idempotencyKey: key,
              }),
              `Assigned ${chosen?.displayName ?? 'the reviewer'}.`,
              onChange,
            );
            setBusy(false);
            setKey(crypto.randomUUID());
            if (ok) {
              setReviewer('');
              setReason('');
            }
          }}
        >
          <ScopeSelect
            scopes={scopes}
            value={scope}
            onChange={(code) => {
              setScope(code);
              setReviewer('');
            }}
            label="Review scope"
          />
          <div className="form-field">
            <label htmlFor={reviewerId}>Reviewer</label>
            <select
              id={reviewerId}
              value={reviewer}
              disabled={!candidates || candidates.length === 0}
              onChange={(event) => setReviewer(event.target.value)}
            >
              <option value="">
                {!scope
                  ? 'Choose a scope first'
                  : lookupFailed
                    ? 'Couldn’t load eligible reviewers'
                    : !candidates
                      ? 'Loading…'
                      : candidates.length === 0
                        ? 'Nobody is eligible for this scope'
                        : 'Choose an eligible reviewer'}
              </option>
              {(candidates ?? []).map((person) => (
                <option key={person.id} value={person.id}>
                  {formatPerson(person.initials, person.displayName)}
                </option>
              ))}
            </select>
            <p className="field-hint">
              Only people an admin has made eligible for this scope are listed.
            </p>
          </div>
          <ReasonField value={reason} onChange={setReason} />
        </ManageForm>
      ) : null}
      <ReasonDialog
        open={removing !== null}
        title={`Remove ${removing?.reviewer.name ?? ''} as ${removing?.scope.label ?? ''} reviewer?`}
        confirmLabel="Remove"
        onConfirm={async (text) => {
          const assignment = removing;
          setRemoving(null);
          if (!assignment) return;
          setBusy(true);
          await run(
            removeReviewer(projectId, assignment.id, text),
            `Removed ${assignment.reviewer.name} as ${assignment.scope.label} reviewer.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setRemoving(null)}
      >
        <p>Reviews they already completed keep their name.</p>
      </ReasonDialog>
      <ReasonDialog
        open={withdrawing !== null}
        title={`Withdraw ${withdrawing?.reviewer.name ?? ''}’s approval to review ${withdrawing?.scope.label ?? ''}?`}
        confirmLabel="Withdraw approval"
        onConfirm={async (text) => {
          const assignment = withdrawing;
          setWithdrawing(null);
          if (!assignment?.approval) return;
          setBusy(true);
          await run(
            withdrawApproval(projectId, assignment.approval.id, text),
            `Withdrew ${assignment.reviewer.name}’s approval to review ${assignment.scope.label}.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setWithdrawing(null)}
      >
        <p>The assignment stays; they can review again only after a new approval.</p>
      </ReasonDialog>
      {data.approvalHistory.length > 0 ? (
        <details>
          <summary>Ended review approvals ({data.approvalHistory.length})</summary>
          <ul className="delegate-list" aria-label="Ended review approvals">
            {data.approvalHistory.map((approval) => (
              <li key={approval.id}>
                <strong>{who(approval.reviewer)}</strong> · {approval.scope.label} ·{' '}
                {APPROVAL_END[approval.endKind ?? 'withdrawn']}
                {approval.endReason ? `: ${approval.endReason}` : ''}
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </BandedCard>
  );
}

// ---------------------------------------------------------------------------------------------
// Authorized report issuers (D06/D07)
// ---------------------------------------------------------------------------------------------

const ISSUER_BLOCKED: Record<NonNullable<ReportIssuerGrant['blockedReason']>, string> = {
  account_not_active: 'Not effective: account isn’t active',
  expired: 'Not effective: expired',
};

export function IssuersSection({
  projectId,
  data,
  scopes,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectReportIssuers;
  scopes: ReviewScope[];
  run: RunWrite;
  onChange: (next: ProjectReportIssuers) => void;
}) {
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [scope, setScope] = useState('');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [expires, setExpires] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [revoking, setRevoking] = useState<ReportIssuerGrant | null>(null);
  const [emergency, setEmergency] = useState(false);
  const referenceId = useId();
  const expiresId = useId();

  return (
    <BandedCard
      className="project-section"
      title="Authorized report issuers"
      subtitle="People the Lead Project Engineer has authorized to issue reports of a scope on this project. Admin status doesn’t grant this."
    >
      {data.active.length === 0 ? (
        <EmptyState>
          No authorized issuers. The Lead Project Engineer can issue every scope.
        </EmptyState>
      ) : (
        <ul className="delegate-list" aria-label="Authorized report issuers">
          {data.active.map((grant) => (
            <li key={grant.id}>
              <strong>{who(grant.issuer)}</strong>
              <span>{grant.scope.label}</span>
              {grant.effective ? (
                <StatusBadge tone="success">Effective</StatusBadge>
              ) : (
                <StatusBadge tone="warning">
                  {grant.blockedReason ? ISSUER_BLOCKED[grant.blockedReason] : 'Not effective'}
                </StatusBadge>
              )}
              <Started row={grant} verb="Authorized" />
              {grant.approvalReference ? (
                <span className="field-hint">Approval: {grant.approvalReference}</span>
              ) : null}
              <span className="field-hint">
                {grant.expiresAt ? `Expires ${shortDateTime(grant.expiresAt)}` : 'No expiry'}
              </span>
              {data.canManage ? (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setEmergency(false);
                    setRevoking(grant);
                  }}
                >
                  Revoke {grant.issuer.name} ({grant.scope.label})
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {data.canManage ? (
        <ManageForm
          label="Authorize report issuer"
          submitLabel="Authorize issuer"
          disabled={busy || !person || !scope || !reason.trim()}
          onSubmit={async () => {
            if (!person) return;
            setBusy(true);
            const ok = await run(
              grantIssuer(projectId, {
                issuerUserId: person.id,
                scopeCode: scope,
                reason,
                approvalReference: reference.trim() || null,
                expiresAt: expires ? new Date(expires).toISOString() : null,
                idempotencyKey: key,
              }),
              `Authorized ${person.displayName} to issue reports.`,
              onChange,
            );
            setBusy(false);
            setKey(crypto.randomUUID());
            if (ok) {
              setPerson(null);
              setScope('');
              setReason('');
              setReference('');
              setExpires('');
            }
          }}
        >
          <ReceiverSelect
            label="Issuer"
            value={person}
            onChange={setPerson}
            hint="Search by initials or name."
          />
          <ScopeSelect scopes={scopes} value={scope} onChange={setScope} label="Report scope" />
          <ReasonField value={reason} onChange={setReason} />
          <div className="form-field">
            <label htmlFor={referenceId}>Approval reference (optional)</label>
            <input
              id={referenceId}
              type="text"
              maxLength={200}
              value={reference}
              onChange={(event) => setReference(event.target.value)}
            />
          </div>
          <div className="form-field">
            <label htmlFor={expiresId}>Expires (optional)</label>
            <input
              id={expiresId}
              type="datetime-local"
              value={expires}
              onChange={(event) => setExpires(event.target.value)}
            />
          </div>
        </ManageForm>
      ) : null}
      <ReasonDialog
        open={revoking !== null}
        title={`Revoke ${revoking?.issuer.name ?? ''} (${revoking?.scope.label ?? ''})?`}
        confirmLabel="Revoke"
        onConfirm={async (text) => {
          const grant = revoking;
          setRevoking(null);
          if (!grant) return;
          setBusy(true);
          await run(
            revokeIssuer(projectId, grant.id, {
              reason: text,
              kind: emergency ? 'emergency' : 'ordinary',
            }),
            `Revoked ${grant.issuer.name}’s ${grant.scope.label} issuing.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setRevoking(null)}
      >
        <p>They can no longer issue these reports here. Reports already issued keep their name.</p>
        <label className="checkbox">
          <input
            type="checkbox"
            checked={emergency}
            onChange={(event) => setEmergency(event.target.checked)}
          />
          Emergency suspension
        </label>
      </ReasonDialog>
    </BandedCard>
  );
}
