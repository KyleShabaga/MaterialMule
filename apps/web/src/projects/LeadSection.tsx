import type {
  LeadChange,
  LeadNomination,
  ProjectLeadNominations,
  StaffOption,
} from '@materialmule/shared';
import { Check, Send, Undo2, UserPlus } from 'lucide-react';
import { useCallback, useEffect, useId, useState } from 'react';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible';
import { Field, FieldDescription, FieldError, FieldLabel } from '@/components/ui/field';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Select, SelectContent, SelectTrigger, SelectValue } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { listActiveStaff } from '../api/projects';
import { decideLeadNomination, fetchLeadNominations, nominateLead } from './api';
import { ReasonForm } from './ReasonDialog';
import { StaffSelectGroups } from './StaffOptionGroups';
import { TeamCard } from './TeamCard';
import { isoDate } from './team-format';
import { useTeamFormOpen } from './team-form-open';

// Team & permissions › Leadership (STRATA-85; MM-AO04, D01/D02; boards R4Team, R4TeamNominate,
// R4TeamPending, R4TeamAdmin). A project may wait for a lead: receiving carries on, only decisions
// that need the lead wait. Anyone with a personal account may nominate one when there is none; an
// admin confirms (which appoints them) or rejects; the person who nominated may withdraw. A
// nomination gives nobody any authority. Rejecting and withdrawing need a reason; confirming
// doesn't (MISC-03), though one given is recorded. Every control appears only where the server
// reports it (`canNominate`, `canDecide`, `canWithdraw`) and the server checks each again.

const STATUS_LABEL: Record<LeadNomination['status'], string> = {
  pending: 'Waiting for an admin',
  confirmed: 'Confirmed',
  rejected: 'Rejected',
  withdrawn: 'Withdrawn',
};

export function LeadSection({
  projectId,
  lead,
  meId,
  leadChange,
  reloadKey,
  onChanged,
}: {
  projectId: string;
  lead: StaffOption | null;
  meId: string;
  /** The newest lead change from the audit (MTR-25), for "Since … · appointed by …". */
  leadChange: LeadChange | null;
  reloadKey: number;
  /** After a confirmed change: say so, and reload the tab and the project header. */
  onChanged: (message: string) => void;
}) {
  const [data, setData] = useState<ProjectLeadNominations | null>(null);
  const [failed, setFailed] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [nominating, setNominating] = useState(false);
  const [withdrawing, setWithdrawing] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    void fetchLeadNominations(projectId).then((result) => {
      if (result.ok) {
        setData(result.data);
        setFailed(false);
      } else {
        setFailed(true);
      }
    });
  }, [projectId]);
  useEffect(load, [load, reloadKey]);

  const after = (result: Awaited<ReturnType<typeof nominateLead>>, success: string) => {
    if (result.ok) {
      setData(result.value);
      setProblem(null);
      onChanged(success);
      return true;
    }
    setProblem(result.message);
    load();
    return false;
  };

  const pending = data?.pending ?? null;
  const you = (person: { userId: string; name: string }) =>
    person.userId === meId ? 'you' : person.name;

  let state: string;
  if (lead) state = '';
  else if (!pending) state = 'No one has been nominated.';
  else if (data?.canDecide) state = 'Nomination waiting for you, as an admin';
  else state = 'Nomination waiting for an admin';

  return (
    <TeamCard id="team-lead" title="Leadership">
      {failed ? (
        <Alert>
          <AlertDescription className="flex flex-wrap items-center gap-3">
            The lead details couldn’t be loaded.
            <Button variant="outline" size="sm" onClick={load}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {problem ? (
        <Alert variant="destructive" role="alert">
          <AlertDescription>{problem}</AlertDescription>
        </Alert>
      ) : null}

      {lead ? (
        <>
          <Item size="sm" className="px-0">
            <ItemMedia>
              <PersonAvatar name={lead.displayName} userId={lead.id} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {lead.displayName}
                {lead.id === meId ? ' (you)' : ''}{' '}
                <span className="font-normal text-muted-foreground">· Lead Project Engineer</span>
              </ItemTitle>
              {leadChange?.lead?.userId === lead.id ? (
                <ItemDescription className="line-clamp-none">
                  Since <span className="font-mono">{isoDate(leadChange.at)}</span>
                  {leadChange.by ? ` · appointed by ${leadChange.by.name}` : ''}
                  {leadChange.reason ? (
                    <>
                      <br />“{leadChange.reason}”
                    </>
                  ) : null}
                </ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
          <p className="text-[13px] text-muted-foreground">Only an admin changes the lead.</p>
        </>
      ) : (
        <>
          <p className="flex flex-wrap items-center gap-2 text-sm">
            <Badge variant="due">Waiting for a lead</Badge>
            <span className="text-muted-foreground">{state}</span>
          </p>
          <p className="text-[13px] text-muted-foreground">
            Receiving carries on as normal. Decisions only the lead can make, such as closing a
            program, wait until an admin appoints one.
          </p>
        </>
      )}

      {pending ? (
        <div role="group" aria-label="Pending nomination" className="flex flex-col gap-3">
          <Item variant="muted" size="sm">
            <ItemMedia>
              <PersonAvatar name={pending.nominee.name} userId={pending.nominee.userId} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>
                {pending.nominee.name}{' '}
                <span className="font-normal text-muted-foreground">
                  nominated by {you(pending.nominatedBy)} on{' '}
                  <span className="font-mono">{isoDate(pending.nominatedAt)}</span>
                </span>
              </ItemTitle>
              {pending.note ? (
                <ItemDescription className="line-clamp-none">
                  Note for the admin: “{pending.note}”
                </ItemDescription>
              ) : null}
            </ItemContent>
          </Item>
          <p className="text-[13px] text-muted-foreground">
            An admin confirms it. Nominating gives nobody authority.
          </p>
          {data?.canDecide ? (
            <AdminDecision
              nomination={pending}
              busy={busy}
              onDecide={async (action, reason) => {
                setBusy(true);
                const result = await decideLeadNomination(projectId, pending.id, action, reason);
                setBusy(false);
                after(
                  result,
                  action === 'confirm'
                    ? `${pending.nominee.name} is now the Lead Project Engineer.`
                    : 'Nomination rejected. The project is still waiting for a lead.',
                );
              }}
            />
          ) : null}
          {data?.canWithdraw && !withdrawing ? (
            <div>
              <Button variant="outline" size="sm" onClick={() => setWithdrawing(true)}>
                <Undo2 aria-hidden="true" />
                Withdraw nomination
              </Button>
            </div>
          ) : null}
          {data?.canWithdraw && withdrawing ? (
            <ReasonForm
              title="Withdraw your nomination?"
              confirmLabel="Withdraw nomination"
              placeholder="Say why. It’s kept with the decision."
              busy={busy}
              onCancel={() => setWithdrawing(false)}
              onConfirm={async (reason) => {
                setBusy(true);
                const result = await decideLeadNomination(
                  projectId,
                  pending.id,
                  'withdraw',
                  reason,
                );
                setBusy(false);
                if (after(result, 'Nomination withdrawn.')) setWithdrawing(false);
              }}
            >
              The project keeps waiting for a lead; anyone may nominate again.
            </ReasonForm>
          ) : null}
        </div>
      ) : null}

      {data?.canNominate && !nominating ? (
        <div>
          <Button variant="outline" onClick={() => setNominating(true)}>
            <UserPlus aria-hidden="true" />
            Nominate a Lead Project Engineer
          </Button>
        </div>
      ) : null}
      {data?.canNominate && nominating ? (
        <NominateForm
          busy={busy}
          onCancel={() => setNominating(false)}
          onSubmit={async (nominee, note, key) => {
            setBusy(true);
            const result = await nominateLead(projectId, {
              nomineeUserId: nominee,
              note: note.trim() || null,
              idempotencyKey: key,
            });
            setBusy(false);
            const ok = after(result, 'Nomination sent to the admins.');
            if (ok) setNominating(false);
            return ok;
          }}
        />
      ) : null}

      {data && data.history.length > 0 ? (
        <Collapsible>
          <CollapsibleTrigger asChild>
            <Button variant="ghost" size="sm" className="self-start">
              Nomination history ({data.history.length})
            </Button>
          </CollapsibleTrigger>
          <CollapsibleContent>
            <ItemGroup aria-label="Nomination history">
              {data.history.map((n) => (
                <Item key={n.id} role="listitem" size="sm" className="px-0">
                  <ItemContent>
                    <ItemTitle className="font-normal">
                      {n.nominee.name}: {STATUS_LABEL[n.status]}
                      {n.decidedBy ? ` by ${n.decidedBy.name}` : ''}
                    </ItemTitle>
                    <ItemDescription className="line-clamp-none">
                      {n.decidedAt ? (
                        <span className="font-mono">{isoDate(n.decidedAt)}</span>
                      ) : null}
                      {n.decisionReason ? ` · “${n.decisionReason}”` : ''}
                    </ItemDescription>
                  </ItemContent>
                </Item>
              ))}
            </ItemGroup>
          </CollapsibleContent>
        </Collapsible>
      ) : null}
    </TeamCard>
  );
}

/**
 * The admin's decision, open whenever a nomination waits for them (board R4TeamAdmin). One reason
 * field: the server needs it to reject and takes it as optional to confirm (MISC-03), so the
 * label says exactly that instead of the board's "Reason (required)".
 */
function AdminDecision({
  nomination,
  busy,
  onDecide,
}: {
  nomination: LeadNomination;
  busy: boolean;
  onDecide: (action: 'confirm' | 'reject', reason: string) => void;
}) {
  const id = useId();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  useTeamFormOpen(true);
  return (
    <form
      aria-label="Decide the nomination"
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onDecide('confirm', reason);
      }}
    >
      <Field data-invalid={error ? true : undefined}>
        <FieldLabel htmlFor={id}>Reason</FieldLabel>
        <Textarea
          id={id}
          rows={2}
          maxLength={2000}
          value={reason}
          placeholder="Say why you confirm or reject. It’s kept with the decision."
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-hint`}
          onChange={(event) => {
            setReason(event.target.value);
            if (error) setError(null);
          }}
        />
        <FieldDescription id={`${id}-hint`}>
          Needed to reject. Optional when you confirm.
        </FieldDescription>
        {error ? <FieldError>{error}</FieldError> : null}
      </Field>
      <div className="flex flex-wrap justify-end gap-2">
        <Button
          type="button"
          variant="outline"
          disabled={busy}
          onClick={() => {
            if (!reason.trim()) {
              setError('Enter a reason to reject.');
              return;
            }
            onDecide('reject', reason);
          }}
        >
          Reject
        </Button>
        <Button type="submit" disabled={busy}>
          <Check aria-hidden="true" />
          Confirm {nomination.nominee.name} as lead
        </Button>
      </div>
    </form>
  );
}

function NominateForm({
  busy,
  onCancel,
  onSubmit,
}: {
  busy: boolean;
  onCancel: () => void;
  onSubmit: (nominee: string, note: string, key: string) => Promise<boolean>;
}) {
  const nomineeId = useId();
  const noteId = useId();
  const [staff, setStaff] = useState<StaffOption[] | 'failed' | null>(null);
  const [nominee, setNominee] = useState('');
  const [note, setNote] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  useTeamFormOpen(true);

  useEffect(() => {
    let cancelled = false;
    listActiveStaff().then(
      (list) => !cancelled && setStaff(list),
      () => !cancelled && setStaff('failed'),
    );
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <form
      aria-label="Nominate a Lead Project Engineer"
      className="flex flex-col gap-3 rounded-lg border bg-card p-4"
      onSubmit={async (event) => {
        event.preventDefault();
        if (!nominee) return;
        const ok = await onSubmit(nominee, note, key);
        setKey(crypto.randomUUID());
        if (ok) {
          setNominee('');
          setNote('');
        }
      }}
    >
      <p className="text-sm font-semibold">Nominate a Lead Project Engineer</p>
      <Field>
        <FieldLabel htmlFor={nomineeId}>Nominee</FieldLabel>
        <Select value={nominee} onValueChange={setNominee} disabled={!Array.isArray(staff)}>
          <SelectTrigger id={nomineeId} className="w-full">
            <SelectValue
              placeholder={
                staff === 'failed'
                  ? 'Couldn’t load staff'
                  : staff === null
                    ? 'Loading…'
                    : 'Choose a person'
              }
            />
          </SelectTrigger>
          <SelectContent>
            <StaffSelectGroups staff={Array.isArray(staff) ? staff : []} />
          </SelectContent>
        </Select>
      </Field>
      <Field>
        <FieldLabel htmlFor={noteId}>Note for the admin (optional)</FieldLabel>
        <Textarea
          id={noteId}
          rows={2}
          maxLength={2000}
          placeholder="Why this person"
          value={note}
          onChange={(event) => setNote(event.target.value)}
        />
      </Field>
      <p className="text-[13px] text-muted-foreground">
        An admin confirms it. Nominating gives nobody authority.
      </p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button type="button" variant="outline" onClick={onCancel}>
          Cancel
        </Button>
        <Button type="submit" disabled={busy || !nominee}>
          <Send aria-hidden="true" />
          Send nomination
        </Button>
      </div>
    </form>
  );
}
