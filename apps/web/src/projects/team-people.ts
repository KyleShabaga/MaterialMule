import type {
  AcceptanceDelegates,
  AcceptanceDelegation,
  EffectiveJobTitle,
  ProjectDetail,
  ProjectGrantReviews,
  ProjectPeople,
  ProjectPerson,
  ProjectReportIssuers,
  ProjectReviewers,
  ProjectTeam,
  ProjectTeamJoinRequests,
  ReportIssuerGrant,
  ReviewScope,
  ReviewerAssignment,
  TeamMember,
} from '@materialmule/shared';

// Team & permissions (STRATA-85): everything the server reported, regrouped by person for the
// People table and the person drawer. Responsibilities (lead, team place, reviewer) and grants
// (acceptance delegate, report issuer) stay apart; a job title describes a person and grants
// nothing. Nothing here infers a permission: the drawer shows the server's capability list.

/** Every list the tab loaded. A null list couldn't be loaded and simply shows nothing. */
export interface TeamData {
  project: ProjectDetail;
  team: ProjectTeam;
  reviewers: ProjectReviewers;
  issuers: ProjectReportIssuers;
  delegates: AcceptanceDelegates | null;
  scopes: ReviewScope[];
  people: ProjectPeople | null;
  grantReviews: ProjectGrantReviews | null;
  joinRequests: ProjectTeamJoinRequests | null;
}

export interface TeamPersonRow {
  userId: string;
  name: string;
  initials: string | null;
  jobTitle: EffectiveJobTitle;
  lead: boolean;
  member: TeamMember | null;
  /** MISC-07: self-joined, still waiting for the lead's acceptance. */
  pendingAcceptance: boolean;
  reviews: ReviewerAssignment[];
  delegation: AcceptanceDelegation | null;
  issuing: ReportIssuerGrant[];
  /** MTR-25: grant IDs (assignment, delegation, issuer grant) waiting for the new lead's review. */
  flagged: ReadonlySet<string>;
  /** MTR-21: what they may do here and why, computed by the server as for themselves. */
  permissions: ProjectPerson | null;
}

/** People in the order they first appear: the lead, the team, reviewers, delegates, issuers. */
export function teamPeople(data: TeamData): TeamPersonRow[] {
  const details = new Map((data.people?.people ?? []).map((p) => [p.userId, p]));
  const joining = new Set((data.joinRequests?.pending ?? []).map((r) => r.teamMemberId));
  const flagged = new Set((data.grantReviews?.pending ?? []).map((r) => r.grantId));
  const rows = new Map<string, TeamPersonRow>();
  const row = (userId: string, initials: string | null, name: string) => {
    let found = rows.get(userId);
    if (!found) {
      const detail = details.get(userId) ?? null;
      found = {
        userId,
        name,
        initials,
        jobTitle: detail?.jobTitle ?? null,
        lead: false,
        member: null,
        pendingAcceptance: false,
        reviews: [],
        delegation: null,
        issuing: [],
        flagged,
        permissions: detail,
      };
      rows.set(userId, found);
    }
    return found;
  };
  const lead = data.project.leadProjectEngineer;
  if (lead) row(lead.id, lead.initials, lead.displayName).lead = true;
  for (const member of data.team.active) {
    const r = row(member.person.userId, member.person.initials, member.person.name);
    r.member = member;
    r.pendingAcceptance = joining.has(member.id);
  }
  for (const assignment of data.reviewers.active) {
    const p = assignment.reviewer;
    row(p.userId, p.initials, p.name).reviews.push(assignment);
  }
  for (const grant of data.delegates?.active ?? []) {
    const p = grant.delegate;
    row(p.userId, p.initials, p.name).delegation = grant;
  }
  for (const grant of data.issuers.active) {
    const p = grant.issuer;
    row(p.userId, p.initials, p.name).issuing.push(grant);
  }
  return [...rows.values()];
}

/** The People table's Responsibilities cell, in words. */
export function responsibilityLabels(person: TeamPersonRow): string[] {
  const labels: string[] = [];
  if (person.lead) labels.push('Lead Project Engineer');
  if (person.member) {
    labels.push(person.pendingAcceptance ? 'Team member · Pending LPE acceptance' : 'Team member');
  }
  for (const review of person.reviews) {
    labels.push(`Reviewer, ${review.scope.label}${review.effective ? '' : ' (not effective)'}`);
  }
  return labels;
}

/** The People table's Grants tags, in words. */
export function grantLabels(person: TeamPersonRow, expiry: (iso: string) => string): string[] {
  const labels: string[] = [];
  if (person.delegation) labels.push('Acceptance delegate');
  for (const grant of person.issuing) {
    const until = grant.expiresAt ? ` · until ${expiry(grant.expiresAt)}` : '';
    labels.push(
      `Report issuer · ${grant.scope.label}${until}${grant.effective ? '' : ' (not effective)'}`,
    );
  }
  return labels;
}

/** Whether any of the person's grants or reviews waits for the new lead's review (MTR-25). */
export function needsLeadReview(person: TeamPersonRow): boolean {
  return (
    person.reviews.some((r) => person.flagged.has(r.id)) ||
    person.issuing.some((g) => person.flagged.has(g.id)) ||
    (person.delegation ? person.flagged.has(person.delegation.id) : false)
  );
}
