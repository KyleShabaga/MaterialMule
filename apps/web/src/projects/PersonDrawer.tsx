import { type ReportIssuerGrant, type ReviewerAssignment } from '@materialmule/shared';
import { Check, Plus } from 'lucide-react';
import { useId, useState, type ReactNode } from 'react';
import { PeekToolbar } from '@/components/strata/peek';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Item, ItemActions, ItemContent, ItemDescription, ItemTitle } from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { AcceptanceDelegateSection } from './AcceptanceDelegates';
import { NEEDS_REVIEW } from './GrantReviewsSection';
import { ReasonForm } from './ReasonDialog';
import { HistoryList } from './TeamHistory';
import type { GrantApply, GrantKind, GrantTarget, RunWrite } from './TeamSections';
import { CapabilityList } from './YourPermissions';
import {
  approveReviewer,
  endDelegate,
  removeReviewer,
  removeTeamMember,
  revokeIssuer,
  withdrawApproval,
  type WriteOutcome,
} from './team-api';
import { isoDate } from './team-format';
import type { TeamData, TeamPersonRow } from './team-people';

// The person drawer (STRATA-85; board R4PersonDrawer): Inbox's drawer, with Close and
// Previous/Next (a person has no full page). Their responsibilities and grants with where each
// comes from, ending one with a reason ("The grant ends now. Earlier work keeps their name."),
// adding a grant, acceptance delegate (lead only), what the server says they may do here, and
// their history on this project. Every control appears only where the server's list says this
// viewer may manage it; the server checks again.

const REVIEWER_BLOCKED: Record<NonNullable<ReviewerAssignment['blockedReason']>, string> = {
  account_not_active: 'Not effective: account isn’t active',
  eligibility_revoked: 'Not effective: not eligible to review',
  not_accepted_member: 'Not effective: not an accepted team member',
  not_approved: 'Waiting for the lead’s review approval',
};

const ISSUER_BLOCKED: Record<NonNullable<ReportIssuerGrant['blockedReason']>, string> = {
  account_not_active: 'Not effective: account isn’t active',
  expired: 'Not effective: expired',
};

function Section({ title, children }: { title: string; children: ReactNode }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-2">
      <h3 id={id} className="text-sm font-semibold">
        {title}
      </h3>
      {children}
    </section>
  );
}

/** "Added by Alex Tester on 2026-02-03: “Receives the river samples.”" */
function Recorded({
  verb,
  by,
  at,
  reason,
}: {
  verb: string;
  by: { name: string };
  at: string;
  reason: string | null;
}) {
  return (
    <ItemDescription className="line-clamp-none">
      {verb} by {by.name} on <span className="font-mono">{isoDate(at)}</span>
      {reason ? `: “${reason}”` : ''}
    </ItemDescription>
  );
}

type Ending =
  | { kind: 'member' }
  | { kind: 'reviewer'; assignment: ReviewerAssignment }
  | { kind: 'approval'; assignment: ReviewerAssignment }
  | { kind: 'issuer'; grant: ReportIssuerGrant }
  | { kind: 'delegate' };

export function PersonDrawer({
  person,
  data,
  run,
  apply,
  meId,
  historyKey,
  position,
  onPrevious,
  onNext,
  onClose,
  onAddGrant,
}: {
  person: TeamPersonRow;
  data: TeamData;
  run: RunWrite;
  apply: GrantApply;
  meId: string;
  historyKey: number;
  position?: { index: number; total: number };
  onPrevious?: () => void;
  onNext?: () => void;
  onClose: () => void;
  onAddGrant: (kind: GrantKind, target: GrantTarget) => void;
}) {
  const nameId = useId();
  const [ending, setEnding] = useState<Ending | null>(null);
  const [emergency, setEmergency] = useState(false);
  const [busy, setBusy] = useState(false);
  const { project, team, reviewers, issuers } = data;
  const projectId = project.id;
  const name = person.name;
  const first = name.split(' ')[0] ?? name;
  const target: GrantTarget = { userId: person.userId, name, initials: person.initials };
  const flagged = (id: string) =>
    person.flagged.has(id) ? <Badge variant="due">{NEEDS_REVIEW}</Badge> : null;
  const isEnding = (e: Ending) =>
    ending !== null &&
    ending.kind === e.kind &&
    (e.kind === 'member' ||
      e.kind === 'delegate' ||
      ('assignment' in e && 'assignment' in ending && e.assignment.id === ending.assignment.id) ||
      ('grant' in e && 'grant' in ending && e.grant.id === ending.grant.id));

  const end = async <T,>(
    write: Promise<WriteOutcome<T>>,
    success: string,
    applyTo: (value: T) => void,
  ) => {
    setBusy(true);
    const ok = await run(write, success, applyTo);
    setBusy(false);
    if (ok) setEnding(null);
  };

  const addable: { kind: GrantKind; label: string; note: string }[] = [];
  if (!person.member && team.canManage) {
    addable.push({
      kind: 'team',
      label: 'Team member…',
      note: 'A team place grants no approvals.',
    });
  }
  if (reviewers.canManage) {
    addable.push({
      kind: 'reviewer',
      label: 'Reviewer…',
      note: 'For one scope they’re eligible for.',
    });
  }
  if (issuers.canManage) {
    addable.push({
      kind: 'issuer',
      label: 'Report issuer…',
      note: 'For one scope, with an optional expiry. Lead only.',
    });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <PeekToolbar onClose={onClose} position={position} onPrevious={onPrevious} onNext={onNext} />
      <div className="flex flex-col gap-6 overflow-y-auto p-5">
        <div className="flex items-start gap-3">
          <PersonAvatar name={name} userId={person.userId} size="lg" />
          <div className="flex min-w-0 flex-col gap-0.5">
            <h2 id={nameId} className="text-lg font-semibold">
              {name}
              {person.userId === meId ? ' (you)' : ''}
            </h2>
            {person.jobTitle ? (
              <p className="text-sm text-muted-foreground">{person.jobTitle.value}</p>
            ) : null}
            <p className="text-sm text-muted-foreground">
              On <span className="font-mono">{project.projectNumber}</span> {project.name}
            </p>
          </div>
        </div>

        <Section title="Responsibilities">
          {!person.lead && !person.member && person.reviews.length === 0 ? (
            <p className="text-sm text-muted-foreground">No responsibilities on this project.</p>
          ) : null}
          {person.lead ? (
            <Item variant="outline" size="sm">
              <ItemContent>
                <ItemTitle>Lead Project Engineer</ItemTitle>
                <ItemDescription>Only an admin changes the lead.</ItemDescription>
              </ItemContent>
            </Item>
          ) : null}
          {person.member ? (
            <Item variant="outline" size="sm">
              <ItemContent>
                <ItemTitle className="flex-wrap">
                  Team member
                  {person.pendingAcceptance ? (
                    <Badge variant="due">Pending LPE acceptance</Badge>
                  ) : null}
                </ItemTitle>
                <Recorded
                  verb="Added"
                  by={person.member.startedBy}
                  at={person.member.startedAt}
                  reason={person.member.startReason}
                />
              </ItemContent>
              {team.canManage && !isEnding({ kind: 'member' }) ? (
                <ItemActions>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={busy}
                    onClick={() => setEnding({ kind: 'member' })}
                  >
                    Remove from the team
                  </Button>
                </ItemActions>
              ) : null}
              {team.canManage && isEnding({ kind: 'member' }) ? (
                <ReasonForm
                  title={`Remove ${name} from the team?`}
                  confirmLabel="Remove from the team"
                  busy={busy}
                  onCancel={() => setEnding(null)}
                  onConfirm={(reason) =>
                    void end(
                      removeTeamMember(projectId, person.member!.id, reason),
                      `Removed ${name} from the team.`,
                      apply.team,
                    )
                  }
                >
                  Their earlier work keeps their name. Other grants they hold here aren’t changed.
                </ReasonForm>
              ) : null}
            </Item>
          ) : null}
          {person.reviews.map((assignment) => (
            <Item key={assignment.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle className="flex-wrap">
                  Reviewer · {assignment.scope.label}
                  {assignment.effective ? (
                    <Badge variant="storage">Effective</Badge>
                  ) : (
                    <Badge variant="due">
                      {assignment.blockedReason
                        ? REVIEWER_BLOCKED[assignment.blockedReason]
                        : 'Not effective'}
                    </Badge>
                  )}
                  {flagged(assignment.id)}
                </ItemTitle>
                <Recorded
                  verb="Assigned"
                  by={assignment.startedBy}
                  at={assignment.startedAt}
                  reason={assignment.startReason}
                />
                {/* MISC-08: eligibility, accepted membership and the lead's approval, apart. */}
                <ItemDescription className="line-clamp-none">
                  {assignment.eligible ? 'Eligible' : 'Not eligible'} ·{' '}
                  {assignment.acceptedMember
                    ? 'Accepted team member'
                    : 'Not an accepted team member'}{' '}
                  ·{' '}
                  {assignment.approval
                    ? `Approved to review by ${assignment.approval.approvedBy.name}`
                    : 'Not approved to review'}
                </ItemDescription>
              </ItemContent>
              {!isEnding({ kind: 'reviewer', assignment }) &&
              !isEnding({ kind: 'approval', assignment }) ? (
                <ItemActions className="flex-wrap">
                  {reviewers.canApprove && !assignment.approval ? (
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={busy || !assignment.eligible || !assignment.acceptedMember}
                      aria-label={`Approve ${name} to review (${assignment.scope.label})`}
                      onClick={async () => {
                        setBusy(true);
                        await run(
                          approveReviewer(projectId, assignment.id, crypto.randomUUID()),
                          `Approved ${name} to review ${assignment.scope.label}.`,
                          apply.reviewers,
                        );
                        setBusy(false);
                      }}
                    >
                      <Check aria-hidden="true" />
                      Approve to review
                    </Button>
                  ) : null}
                  {reviewers.canApprove && assignment.approval ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      onClick={() => setEnding({ kind: 'approval', assignment })}
                    >
                      Withdraw approval
                    </Button>
                  ) : null}
                  {reviewers.canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      disabled={busy}
                      aria-label={`Remove ${name} as reviewer (${assignment.scope.label})`}
                      onClick={() => setEnding({ kind: 'reviewer', assignment })}
                    >
                      Remove as reviewer
                    </Button>
                  ) : null}
                </ItemActions>
              ) : null}
              {reviewers.canManage && isEnding({ kind: 'reviewer', assignment }) ? (
                <ReasonForm
                  title={`Remove ${name} as ${assignment.scope.label} reviewer?`}
                  confirmLabel="Remove as reviewer"
                  busy={busy}
                  onCancel={() => setEnding(null)}
                  onConfirm={(reason) =>
                    void end(
                      removeReviewer(projectId, assignment.id, reason),
                      `Removed ${name} as ${assignment.scope.label} reviewer.`,
                      apply.reviewers,
                    )
                  }
                >
                  Reviews they already completed keep their name.
                </ReasonForm>
              ) : null}
              {reviewers.canApprove &&
              isEnding({ kind: 'approval', assignment }) &&
              assignment.approval ? (
                <ReasonForm
                  title={`Withdraw ${name}’s approval to review ${assignment.scope.label}?`}
                  confirmLabel="Withdraw approval"
                  busy={busy}
                  onCancel={() => setEnding(null)}
                  onConfirm={(reason) =>
                    void end(
                      withdrawApproval(projectId, assignment.approval!.id, reason),
                      `Withdrew ${name}’s approval to review ${assignment.scope.label}.`,
                      apply.reviewers,
                    )
                  }
                >
                  The assignment stays; they can review again only after a new approval.
                </ReasonForm>
              ) : null}
            </Item>
          ))}
        </Section>

        <Section title="Grants">
          {!person.delegation && person.issuing.length === 0 ? (
            <p className="text-sm text-muted-foreground">No grants on this project.</p>
          ) : null}
          {person.delegation ? (
            <Item variant="outline" size="sm">
              <ItemContent>
                <ItemTitle className="flex-wrap">
                  <Badge variant="secondary">Acceptance delegate</Badge>
                  <span className="font-normal text-muted-foreground">No expiry</span>
                  {flagged(person.delegation.id)}
                </ItemTitle>
                <Recorded
                  verb="Granted"
                  by={person.delegation.grantedBy}
                  at={person.delegation.grantedAt}
                  reason={person.delegation.grantReason}
                />
              </ItemContent>
              {data.delegates?.canManage && !isEnding({ kind: 'delegate' }) ? (
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`End ${name}’s acceptance delegate grant`}
                    onClick={() => setEnding({ kind: 'delegate' })}
                  >
                    End grant
                  </Button>
                </ItemActions>
              ) : null}
              {data.delegates?.canManage && isEnding({ kind: 'delegate' }) ? (
                <ReasonForm
                  title={`End ${name}’s acceptance delegate grant?`}
                  confirmLabel="End grant"
                  busy={busy}
                  onCancel={() => setEnding(null)}
                  onConfirm={(reason) =>
                    void end(
                      endDelegate(projectId, person.delegation!.id, reason),
                      `Ended ${name}’s acceptance delegate grant.`,
                      apply.delegates,
                    )
                  }
                >
                  The grant ends now. Earlier work keeps their name.
                </ReasonForm>
              ) : null}
            </Item>
          ) : null}
          {person.issuing.map((grant) => (
            <Item key={grant.id} variant="outline" size="sm">
              <ItemContent>
                <ItemTitle className="flex-wrap">
                  <Badge variant="secondary">Report issuer · {grant.scope.label}</Badge>
                  <span className="font-normal text-muted-foreground">
                    {grant.expiresAt ? `Until ${isoDate(grant.expiresAt)}` : 'No expiry'}
                  </span>
                  {grant.effective ? null : (
                    <Badge variant="due">
                      {grant.blockedReason ? ISSUER_BLOCKED[grant.blockedReason] : 'Not effective'}
                    </Badge>
                  )}
                  {flagged(grant.id)}
                </ItemTitle>
                <Recorded
                  verb="Granted"
                  by={grant.startedBy}
                  at={grant.startedAt}
                  reason={grant.startReason}
                />
                {grant.approvalReference ? (
                  <ItemDescription>Approval: {grant.approvalReference}</ItemDescription>
                ) : null}
              </ItemContent>
              {issuers.canManage && !isEnding({ kind: 'issuer', grant }) ? (
                <ItemActions>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={busy}
                    aria-label={`End ${name}’s report issuer grant (${grant.scope.label})`}
                    onClick={() => {
                      setEmergency(false);
                      setEnding({ kind: 'issuer', grant });
                    }}
                  >
                    End grant
                  </Button>
                </ItemActions>
              ) : null}
              {issuers.canManage && isEnding({ kind: 'issuer', grant }) ? (
                <ReasonForm
                  title={`End ${name}’s report issuer grant (${grant.scope.label})?`}
                  confirmLabel="End grant"
                  busy={busy}
                  onCancel={() => setEnding(null)}
                  onConfirm={(reason) =>
                    void end(
                      revokeIssuer(projectId, grant.id, {
                        reason,
                        kind: emergency ? 'emergency' : 'ordinary',
                      }),
                      `Ended ${name}’s ${grant.scope.label} issuing.`,
                      apply.issuers,
                    )
                  }
                >
                  <p>The grant ends now. Earlier work keeps their name.</p>
                  <div className="mt-2 flex items-center gap-2">
                    <Checkbox
                      id={`${grant.id}-emergency`}
                      checked={emergency}
                      onCheckedChange={(checked) => setEmergency(checked === true)}
                    />
                    <Label htmlFor={`${grant.id}-emergency`} className="font-normal">
                      Emergency suspension
                    </Label>
                  </div>
                </ReasonForm>
              ) : null}
            </Item>
          ))}
          {addable.length > 0 ? (
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button variant="outline" size="sm" className="self-start">
                  <Plus aria-hidden="true" />
                  Add a grant
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                {addable.map((option) => (
                  <DropdownMenuItem
                    key={option.kind}
                    onSelect={() => onAddGrant(option.kind, target)}
                  >
                    <span className="flex flex-col">
                      {option.label}
                      <span className="text-xs text-muted-foreground">{option.note}</span>
                    </span>
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </Section>

        <AcceptanceDelegateSection
          projectId={projectId}
          projectNumber={project.projectNumber}
          person={{ userId: person.userId, name }}
          delegates={data.delegates}
          run={run}
          onChange={apply.delegates}
        />

        <p className="text-[13px] text-muted-foreground">
          {person.jobTitle
            ? `${first}’s job title ${
                person.jobTitle.source === 'microsoft'
                  ? 'comes from Microsoft'
                  : 'is set by an administrator'
              }. `
            : ''}
          Job titles grant nothing here.
        </p>

        {person.permissions ? (
          <Section title="Permissions here">
            <CapabilityList
              capabilities={person.permissions.capabilities}
              own={false}
              label={`Permissions of ${name}`}
            />
          </Section>
        ) : null}

        <Section title="History on this project">
          <HistoryList
            projectId={projectId}
            userId={person.userId}
            reloadKey={historyKey}
            label={`History of ${name} on this project`}
            empty="Nothing recorded for them here yet."
          />
        </Section>
      </div>
    </div>
  );
}
