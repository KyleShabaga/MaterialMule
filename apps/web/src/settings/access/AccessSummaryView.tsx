import {
  JOB_TITLE_SOURCE_LABEL,
  ROLE_LABELS,
  STAFF_CAPABILITY_LABEL,
  formatPerson,
  type AccessProject,
  type AccessSummary,
} from '@materialmule/shared';
import { Link } from 'react-router';
import { BandedCard, EmptyState, StatusBadge } from '../../components/ui';
import { shortDateTime } from '../../dashboard/format';

// One person's current access (MM-AO06), as the server reports it: app roles, what they hold
// anywhere (reviewer eligibility, "Can create and lead projects"), and per project their
// responsibilities and scoped grants, each with its source. Shared by My access and the admin's
// Staff drawer. Read-only; a job title and position are shown as description, never as access.

function started(row: { since: string; by: { initials: string | null; name: string } }) {
  return `since ${shortDateTime(row.since)}, by ${formatPerson(row.by.initials, row.by.name)}`;
}

const REVIEWER_BLOCKED = {
  account_not_active: 'not effective: account isn’t active',
  eligibility_revoked: 'not effective: eligibility revoked',
} as const;

const ISSUER_BLOCKED = {
  account_not_active: 'not effective: account isn’t active',
  expired: 'not effective: expired',
} as const;

function ProjectRow({ entry }: { entry: AccessProject }) {
  const responsibilities: string[] = [];
  if (entry.lead) responsibilities.push('Lead Project Engineer');
  if (entry.teamMember) responsibilities.push(`Team member (${started(entry.teamMember)})`);
  for (const r of entry.reviewer) {
    responsibilities.push(
      `Reviewer: ${r.scope.label} (${started(r)}${r.blockedReason ? `; ${REVIEWER_BLOCKED[r.blockedReason]}` : ''})`,
    );
  }
  if (entry.pendingLeadNomination) {
    responsibilities.push('Nominated as Lead Project Engineer, waiting for an admin');
  }
  const grants: string[] = [];
  if (entry.acceptanceDelegate) {
    grants.push(`Acceptance delegate (${started(entry.acceptanceDelegate)})`);
  }
  for (const g of entry.reportIssuer) {
    grants.push(
      `Report issuer: ${g.scope.label} (${started(g)}${
        g.expiresAt ? `; expires ${shortDateTime(g.expiresAt)}` : ''
      }${g.blockedReason ? `; ${ISSUER_BLOCKED[g.blockedReason]}` : ''})`,
    );
  }
  return (
    <li>
      <Link to={`/projects/${encodeURIComponent(entry.project.id)}`}>
        <span className="number">{entry.project.projectNumber}</span> · {entry.project.name}
      </Link>
      {responsibilities.length ? (
        <span>
          <strong>Responsibilities:</strong> {responsibilities.join('; ')}
        </span>
      ) : null}
      {grants.length ? (
        <span>
          <strong>Grants:</strong> {grants.join('; ')}
        </span>
      ) : null}
    </li>
  );
}

export function AccessSummaryView({
  summary,
  headingLevel = 2,
}: {
  summary: AccessSummary;
  headingLevel?: 2 | 3;
}) {
  return (
    <div className="access-summary">
      <BandedCard title="Who" headingLevel={headingLevel}>
        <dl className="details">
          <dt>Name</dt>
          <dd>{formatPerson(summary.initials, summary.displayName)}</dd>
          <dt>Job title</dt>
          <dd>
            {summary.effectiveJobTitle
              ? `${summary.effectiveJobTitle.value} (${JOB_TITLE_SOURCE_LABEL[summary.effectiveJobTitle.source]})`
              : 'Not set'}
          </dd>
        </dl>
        <p className="field-hint">A job title describes the work; it grants nothing.</p>
      </BandedCard>

      <BandedCard title="App roles" headingLevel={headingLevel}>
        {summary.roles.length ? (
          <ul className="access-list" aria-label="App roles">
            {summary.roles.map((role) => (
              <li key={role}>{ROLE_LABELS[role]}</li>
            ))}
          </ul>
        ) : (
          <EmptyState>No app roles. Staff without a role can still see everything.</EmptyState>
        )}
      </BandedCard>

      <BandedCard
        title="Held everywhere"
        subtitle="Granted by an administrator, with a reason."
        headingLevel={headingLevel}
      >
        {summary.capabilities.length || summary.reviewerEligibility.length ? (
          <ul className="access-list" aria-label="Held everywhere">
            {summary.capabilities.map((grant) => (
              <li key={grant.id}>
                {STAFF_CAPABILITY_LABEL[grant.capability]}{' '}
                <span className="field-hint">
                  since {shortDateTime(grant.startedAt)}, by{' '}
                  {formatPerson(grant.startedBy.initials, grant.startedBy.name)}
                </span>
              </li>
            ))}
            {summary.reviewerEligibility.map((grant) => (
              <li key={grant.id}>
                Eligible reviewer: {grant.scope.label}{' '}
                <span className="field-hint">
                  since {shortDateTime(grant.startedAt)}, by{' '}
                  {formatPerson(grant.startedBy.initials, grant.startedBy.name)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState>No reviewer eligibility or capabilities.</EmptyState>
        )}
      </BandedCard>

      <BandedCard
        title="Projects"
        subtitle="Responsibilities and scoped grants, per project. Open one for its team and history."
        headingLevel={headingLevel}
        aside={
          summary.projectsTotal > 0 ? (
            <StatusBadge>{summary.projectsTotal.toLocaleString('en-CA')}</StatusBadge>
          ) : null
        }
      >
        {summary.projects.length ? (
          <ul className="access-list access-projects" aria-label="Project access">
            {summary.projects.map((entry) => (
              <ProjectRow key={entry.project.id} entry={entry} />
            ))}
          </ul>
        ) : (
          <EmptyState>No project assignments.</EmptyState>
        )}
        {summary.projectsTotal > summary.projects.length ? (
          <p className="field-hint">
            Showing the first {summary.projects.length} of {summary.projectsTotal} projects.
          </p>
        ) : null}
      </BandedCard>
    </div>
  );
}
