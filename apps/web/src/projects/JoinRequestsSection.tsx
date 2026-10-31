import {
  PENDING_LPE_ACCEPTANCE,
  formatPerson,
  type ProjectTeamJoinRequests,
  type TeamJoinRequest,
} from '@materialmule/shared';
import { useState } from 'react';
import { BandedCard, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { ReasonDialog } from './ReasonDialog';
import { decideJoinRequest, requestToJoin } from './team-api';
import type { RunWrite } from './TeamSections';

// MISC-07 (owner decision 2026-10-30): any personal account joins the team itself, at once and
// with full team-member access, marked "Pending LPE acceptance" until the lead or an admin
// accepts. A decline (with a reason) removes them; they see it here and may ask again. Controls
// appear only where the server reports `canRequest` / `canDecide`.

export function JoinRequestsSection({
  projectId,
  data,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectTeamJoinRequests;
  run: RunWrite;
  /** Called with the new state after any change; the team list needs reloading too. */
  onChange: (next: ProjectTeamJoinRequests) => void;
}) {
  const [declining, setDeclining] = useState<TeamJoinRequest | null>(null);
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mine = data.mine;
  const showPending = data.pending.length > 0;
  if (!data.canRequest && !showPending && mine?.status !== 'pending') return null;

  return (
    <BandedCard
      id="join-requests"
      className="project-section"
      title="Joining the team"
      tone={showPending && data.canDecide ? 'attention' : 'default'}
    >
      {mine?.status === 'pending' ? (
        <p role="note">
          You’re on this team with full team-member access,{' '}
          <StatusBadge tone="warning">{PENDING_LPE_ACCEPTANCE}</StatusBadge>
        </p>
      ) : null}
      {mine?.status === 'declined' && data.canRequest ? (
        <p role="note" className="notice notice-warning">
          Your request to join was declined
          {mine.decidedBy
            ? ` by ${formatPerson(mine.decidedBy.initials, mine.decidedBy.name)}`
            : ''}
          {mine.decidedAt ? ` on ${shortDateTime(mine.decidedAt)}` : ''}
          {mine.reason ? `: ${mine.reason}` : ''}. You may ask again.
        </p>
      ) : null}
      {data.canRequest ? (
        <>
          <p className="field-hint">
            Joining adds you to the team straight away. The Lead Project Engineer is told and can
            accept or decline. Team membership grants no approvals.
          </p>
          <p>
            <button
              type="button"
              className="primary"
              disabled={busy}
              onClick={async () => {
                setBusy(true);
                const ok = await run(
                  requestToJoin(projectId, key),
                  'You joined the team. The Lead Project Engineer has been asked to accept you.',
                  onChange,
                );
                if (ok) setKey(crypto.randomUUID());
                setBusy(false);
              }}
            >
              Request to join this team
            </button>
          </p>
        </>
      ) : null}
      {showPending ? (
        <ul className="grant-reviews" aria-label="Pending join requests">
          {data.pending.map((request) => (
            <li key={request.id}>
              <span>
                <strong>{formatPerson(request.person.initials, request.person.name)}</strong>{' '}
                <StatusBadge tone="warning">{PENDING_LPE_ACCEPTANCE}</StatusBadge>
                <span className="field-hint"> Joined {shortDateTime(request.requestedAt)}</span>
              </span>
              {data.canDecide ? (
                <span className="row-actions">
                  <button
                    type="button"
                    disabled={busy}
                    aria-label={`Accept ${request.person.name}`}
                    onClick={async () => {
                      setBusy(true);
                      await run(
                        decideJoinRequest(projectId, request.id, 'accept'),
                        `${request.person.name} is accepted on the team.`,
                        onChange,
                      );
                      setBusy(false);
                    }}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="danger"
                    disabled={busy}
                    aria-label={`Decline ${request.person.name}`}
                    onClick={() => setDeclining(request)}
                  >
                    Decline
                  </button>
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <ReasonDialog
        open={declining !== null}
        title={`Decline ${declining?.person.name ?? ''}?`}
        confirmLabel="Decline"
        onConfirm={async (text) => {
          const request = declining;
          setDeclining(null);
          if (!request) return;
          setBusy(true);
          await run(
            decideJoinRequest(projectId, request.id, 'decline', text),
            `Declined ${request.person.name}; they are no longer on the team.`,
            onChange,
          );
          setBusy(false);
        }}
        onCancel={() => setDeclining(null)}
      >
        <p>They’re removed from the team and see your reason. They may ask again later.</p>
      </ReasonDialog>
    </BandedCard>
  );
}
