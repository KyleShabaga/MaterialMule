import {
  formatPerson,
  type AcceptanceDelegates,
  type ProjectReportIssuers,
  type ProjectReviewers,
  type ProjectTeam,
  type ReceiverOption,
  type ReviewScope,
} from '@materialmule/shared';
import { useEffect, useId, useState, type ReactNode } from 'react';
import { PersonCell } from '@/components/strata/person-avatar';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Field, FieldDescription, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { ReceiverSelect } from '../components/ReceiverSelect';
import {
  addDelegate,
  addTeamMember,
  assignReviewer,
  fetchEligibleReviewers,
  grantIssuer,
  type WriteOutcome,
} from './team-api';
import { useTeamFormOpen } from './team-form-open';

// Adding someone to the project (STRATA-85, MM-AO05): a team place (D04), a scoped reviewer
// (D04/D05, from the people an admin made eligible), a report issuer grant (D06/D07, the lead
// only) or an acceptance delegate (MM-T25, the lead only). One dialog for all four, opened from
// the People table (choose a person) or the person drawer (the person is given). Every one needs
// a reason (D15). Nothing claims success before the server confirms it; a refused write keeps the
// entries. The server checks every permission again.

/** Runs a write; on success applies the server's view. Resolves to whether it succeeded. */
export type RunWrite = <T>(
  write: Promise<WriteOutcome<T>>,
  success: string,
  apply: (value: T) => void,
) => Promise<boolean>;

export type GrantKind = 'team' | 'reviewer' | 'issuer' | 'delegate';

const COPY: Record<
  GrantKind,
  { title: string; submit: string; person: string; description: string }
> = {
  team: {
    title: 'Add to the team',
    submit: 'Add to team',
    person: 'Add a team member',
    description:
      'Supporting engineers and others working on the project. Being on the team grants no approvals by itself.',
  },
  reviewer: {
    title: 'Assign a reviewer',
    submit: 'Assign reviewer',
    person: 'Reviewer',
    description:
      'A designated reviewer for one scope. Only people an admin has made eligible for the scope are listed; they review once they are an accepted team member and the lead approves them.',
  },
  issuer: {
    title: 'Authorize a report issuer',
    submit: 'Authorize issuer',
    person: 'Issuer',
    description:
      'They may issue reports of one scope on this project. Admin status doesn’t grant this.',
  },
  delegate: {
    title: 'Add an acceptance delegate',
    submit: 'Add delegate',
    person: 'Add a delegate',
    description:
      'Delegates may accept reviewed tests on this project. They can’t close programs or change priority.',
  },
};

export interface GrantTarget {
  userId: string;
  name: string;
  initials: string | null;
}

export interface GrantApply {
  team: (next: ProjectTeam) => void;
  reviewers: (next: ProjectReviewers) => void;
  issuers: (next: ProjectReportIssuers) => void;
  delegates: (next: AcceptanceDelegates) => void;
}

function ScopeSelect({
  id,
  scopes,
  value,
  onChange,
}: {
  id: string;
  scopes: ReviewScope[];
  value: string;
  onChange: (code: string) => void;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger id={id} className="w-full">
        <SelectValue placeholder="Choose a scope" />
      </SelectTrigger>
      <SelectContent>
        {scopes.map((scope) => (
          <SelectItem key={scope.code} value={scope.code}>
            {scope.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

function Labelled({
  id,
  label,
  hint,
  children,
}: {
  id: string;
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <Field>
      <FieldLabel htmlFor={id}>{label}</FieldLabel>
      {children}
      {hint ? <FieldDescription>{hint}</FieldDescription> : null}
    </Field>
  );
}

/**
 * The add dialog. Rendered only while open (so every opening starts empty); closing it, by Cancel,
 * Esc or after a confirmed write, calls `onClose`.
 */
export function AddGrantDialog({
  kind,
  projectId,
  scopes,
  target,
  run,
  apply,
  onClose,
}: {
  kind: GrantKind;
  projectId: string;
  scopes: ReviewScope[];
  /** The person, when opened from their drawer; otherwise the dialog asks for one. */
  target: GrantTarget | null;
  run: RunWrite;
  apply: GrantApply;
  onClose: () => void;
}) {
  const copy = COPY[kind];
  const ids = { person: useId(), scope: useId(), reason: useId(), reference: useId() };
  const expiresId = useId();
  const [person, setPerson] = useState<ReceiverOption | null>(null);
  const [scope, setScope] = useState('');
  const [reviewer, setReviewer] = useState(target?.userId ?? '');
  const [reason, setReason] = useState('');
  const [reference, setReference] = useState('');
  const [expires, setExpires] = useState('');
  const [key, setKey] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [lookup, setLookup] = useState<{
    scope: string;
    people: ReceiverOption[] | 'failed';
  } | null>(null);
  useTeamFormOpen(true);

  useEffect(() => {
    if (kind !== 'reviewer' || !scope) return;
    let cancelled = false;
    void fetchEligibleReviewers(scope).then((result) => {
      if (!cancelled) setLookup({ scope, people: result.ok ? result.data : 'failed' });
    });
    return () => {
      cancelled = true;
    };
  }, [kind, scope]);
  const found = lookup?.scope === scope ? lookup.people : null;
  const candidates = found === 'failed' ? null : found;
  const targetEligible = target ? (candidates?.some((c) => c.id === target.userId) ?? null) : null;

  const userId = kind === 'reviewer' ? reviewer : (target?.userId ?? person?.id ?? '');
  const shownName =
    target?.name ??
    (kind === 'reviewer'
      ? candidates?.find((c) => c.id === reviewer)?.displayName
      : person?.displayName) ??
    'them';
  const ready =
    !!userId &&
    !!reason.trim() &&
    ((kind !== 'reviewer' && kind !== 'issuer') || !!scope) &&
    (kind !== 'reviewer' || !target || targetEligible === true);

  async function submit() {
    if (!ready) return;
    setBusy(true);
    let ok: boolean;
    if (kind === 'team') {
      ok = await run(
        addTeamMember(projectId, { userId, reason, idempotencyKey: key }),
        `Added ${shownName} to the team.`,
        apply.team,
      );
    } else if (kind === 'reviewer') {
      ok = await run(
        assignReviewer(projectId, {
          reviewerUserId: userId,
          scopeCode: scope,
          reason,
          idempotencyKey: key,
        }),
        `Assigned ${shownName} as reviewer.`,
        apply.reviewers,
      );
    } else if (kind === 'issuer') {
      ok = await run(
        grantIssuer(projectId, {
          issuerUserId: userId,
          scopeCode: scope,
          reason,
          approvalReference: reference.trim() || null,
          expiresAt: expires ? new Date(expires).toISOString() : null,
          idempotencyKey: key,
        }),
        `Authorized ${shownName} to issue reports.`,
        apply.issuers,
      );
    } else {
      ok = await run(
        addDelegate(projectId, { delegateUserId: userId, reason, idempotencyKey: key }),
        `Added ${shownName} as an acceptance delegate.`,
        apply.delegates,
      );
    }
    setBusy(false);
    setKey(crypto.randomUUID());
    if (ok) onClose();
    else setProblem('Nothing was saved. Your entries are kept.');
  }

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <form
          aria-label={copy.title}
          className="flex flex-col gap-4"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <DialogHeader>
            <DialogTitle>{copy.title}</DialogTitle>
            <DialogDescription>{copy.description}</DialogDescription>
          </DialogHeader>
          {problem ? (
            <Alert variant="destructive">
              <AlertDescription>{problem}</AlertDescription>
            </Alert>
          ) : null}

          {target ? (
            <PersonCell name={target.name} userId={target.userId} />
          ) : kind !== 'reviewer' ? (
            <ReceiverSelect
              label={copy.person}
              value={person}
              onChange={setPerson}
              hint="Search by initials or name."
            />
          ) : null}

          {kind === 'reviewer' || kind === 'issuer' ? (
            <Labelled id={ids.scope} label={kind === 'reviewer' ? 'Review scope' : 'Report scope'}>
              <ScopeSelect
                id={ids.scope}
                scopes={scopes}
                value={scope}
                onChange={(code) => {
                  setScope(code);
                  if (!target) setReviewer('');
                }}
              />
            </Labelled>
          ) : null}

          {kind === 'reviewer' && !target ? (
            <Labelled
              id={ids.person}
              label="Reviewer"
              hint="Only people an admin has made eligible for this scope are listed."
            >
              <Select
                value={reviewer}
                onValueChange={setReviewer}
                disabled={!candidates || candidates.length === 0}
              >
                <SelectTrigger id={ids.person} className="w-full">
                  <SelectValue
                    placeholder={
                      !scope
                        ? 'Choose a scope first'
                        : found === 'failed'
                          ? 'Couldn’t load eligible reviewers'
                          : !candidates
                            ? 'Loading…'
                            : candidates.length === 0
                              ? 'Nobody is eligible for this scope'
                              : 'Choose an eligible reviewer'
                    }
                  />
                </SelectTrigger>
                <SelectContent>
                  {(candidates ?? []).map((c) => (
                    <SelectItem key={c.id} value={c.id}>
                      {formatPerson(c.initials, c.displayName)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </Labelled>
          ) : null}
          {kind === 'reviewer' && target && scope && targetEligible === false ? (
            <p role="note" className="text-sm text-destructive-text">
              {target.name} isn’t eligible to review this scope. An admin makes people eligible.
            </p>
          ) : null}

          <Labelled id={ids.reason} label="Reason (required)">
            <Textarea
              id={ids.reason}
              rows={2}
              maxLength={2000}
              value={reason}
              placeholder="Say why. It’s kept with the change."
              onChange={(event) => setReason(event.target.value)}
            />
          </Labelled>

          {kind === 'issuer' ? (
            <>
              <Labelled id={ids.reference} label="Approval reference (optional)">
                <Input
                  id={ids.reference}
                  maxLength={200}
                  value={reference}
                  onChange={(event) => setReference(event.target.value)}
                />
              </Labelled>
              <Labelled id={expiresId} label="Expires (optional)">
                <Input
                  id={expiresId}
                  type="datetime-local"
                  value={expires}
                  onChange={(event) => setExpires(event.target.value)}
                />
              </Labelled>
            </>
          ) : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !ready}>
              {copy.submit}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
