import {
  PENDING_LPE_ACCEPTANCE,
  type ProjectTeamJoinRequests,
  type TeamJoinRequest,
} from '@materialmule/shared';
import { Check, UserPlus } from 'lucide-react';
import { useState } from 'react';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { ReasonForm } from './ReasonDialog';
import { TeamCard } from './TeamCard';
import { decideJoinRequest, requestToJoin } from './team-api';
import { isoDate } from './team-format';
import type { RunWrite } from './TeamSections';

// MISC-07 (owner decision 2026-10-30), shipped in team-join.service.ts: any personal account joins
// the team itself, at once and with full team-member access, marked "Pending LPE acceptance"
// until the lead or an admin accepts (a reason is optional) or declines (a reason is required;
// it removes them, they see the reason and may ask again). Controls appear only where the server
// reports `canRequest` / `canDecide`.

/** One pending join request in Needs review (lead or admin only). */
export function JoinRequestItem({
  projectId,
  request,
  run,
  onChange,
}: {
  projectId: string;
  request: TeamJoinRequest;
  run: RunWrite;
  onChange: (next: ProjectTeamJoinRequests) => void;
}) {
  const [declining, setDeclining] = useState(false);
  const [busy, setBusy] = useState(false);
  const name = request.person.name;
  return (
    <Item role="listitem" size="sm" className="px-0">
      <ItemMedia>
        <PersonAvatar name={name} userId={request.person.userId} />
      </ItemMedia>
      <ItemContent>
        <ItemTitle className="flex-wrap">
          {name}{' '}
          <span className="font-normal text-muted-foreground">
            joined the team and is waiting for acceptance
          </span>
          <Badge variant="due">{PENDING_LPE_ACCEPTANCE}</Badge>
        </ItemTitle>
        <ItemDescription className="line-clamp-none">
          On the team since joining; accept, or decline with a reason ·{' '}
          <span className="font-mono">{isoDate(request.requestedAt)}</span>
        </ItemDescription>
      </ItemContent>
      {!declining ? (
        <ItemActions>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`Decline ${name}`}
            onClick={() => setDeclining(true)}
          >
            Decline
          </Button>
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            aria-label={`Accept ${name}`}
            onClick={async () => {
              setBusy(true);
              await run(
                decideJoinRequest(projectId, request.id, 'accept'),
                `${name} is accepted on the team.`,
                onChange,
              );
              setBusy(false);
            }}
          >
            <Check aria-hidden="true" />
            Accept
          </Button>
        </ItemActions>
      ) : (
        <ReasonForm
          title={`Decline ${name}?`}
          confirmLabel={`Decline ${name}`}
          placeholder="Say why. It’s kept with the decision."
          busy={busy}
          onCancel={() => setDeclining(false)}
          onConfirm={async (reason) => {
            setBusy(true);
            const ok = await run(
              decideJoinRequest(projectId, request.id, 'decline', reason),
              `Declined ${name}; they are no longer on the team.`,
              onChange,
            );
            setBusy(false);
            if (ok) setDeclining(false);
          }}
        >
          Declining takes {name} off the team. {name} sees your reason and may ask again.
        </ReasonForm>
      )}
    </Item>
  );
}

/**
 * The viewer's own side of joining (board R4TeamMember): ask to join, see that they are pending,
 * or see a decline and its reason. Hidden when none applies.
 */
export function JoinSelfSection({
  projectId,
  data,
  run,
  onChange,
}: {
  projectId: string;
  data: ProjectTeamJoinRequests;
  run: RunWrite;
  onChange: (next: ProjectTeamJoinRequests) => void;
}) {
  const [busy, setBusy] = useState(false);
  const [key, setKey] = useState(() => crypto.randomUUID());
  const mine = data.mine;
  if (!data.canRequest && mine?.status !== 'pending') return null;

  return (
    <TeamCard id="team-join" title="Joining the team">
      {mine?.status === 'pending' ? (
        <p role="note" className="flex flex-wrap items-center gap-2 text-sm">
          You’re on this team with full team-member access.
          <Badge variant="due">{PENDING_LPE_ACCEPTANCE}</Badge>
        </p>
      ) : null}
      {mine?.status === 'declined' && data.canRequest ? (
        <Alert role="note">
          <AlertDescription>
            Your request to join was declined
            {mine.decidedBy ? ` by ${mine.decidedBy.name}` : ''}
            {mine.decidedAt ? ` on ${isoDate(mine.decidedAt)}` : ''}
            {mine.reason ? `: ${mine.reason}` : ''}. You may ask again.
          </AlertDescription>
        </Alert>
      ) : null}
      {data.canRequest ? (
        <>
          <p className="text-[13px] text-muted-foreground">
            Joining adds you to the team straight away. The Lead Project Engineer is told and can
            accept or decline. Team membership grants no approvals.
          </p>
          <div>
            <Button
              variant="outline"
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
              <UserPlus aria-hidden="true" />
              Request to join this team
            </Button>
          </div>
        </>
      ) : null}
    </TeamCard>
  );
}
