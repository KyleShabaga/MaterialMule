import {
  BLOCKED_REASON_LABEL,
  CAPABILITY_SOURCE_LABEL,
  GRANT_REVIEW_KIND_LABEL,
  PROJECT_CAPABILITY_ACTIONS,
  PROJECT_CAPABILITY_ACTION_LABEL,
  PROJECT_INVOLVEMENT_LABEL,
  formatPerson,
  type AcceptanceDelegates,
  type Capability,
  type ProjectCapabilities,
  type ProjectCapabilityAction,
  type ProjectDetail,
  type ProjectGrantReviews,
  type ProjectPeople,
  type ProjectPerson,
  type ProjectReportIssuers,
  type ProjectReviewers,
  type ProjectTeam,
  type ReviewScope,
} from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { BandedCard, DataTable, EmptyState, ErrorState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { useMe } from '../session/context';
import { fetchDelegates } from '../lab/api';
import { AcceptanceDelegatesSection } from './AcceptanceDelegates';
import { fetchProjectDetail, type LoadResult } from './api';
import { GrantReviewsSection, NEEDS_REVIEW } from './GrantReviewsSection';
import { LeadSection } from './LeadSection';
import { IssuersSection, ReviewersSection, TeamSection, type RunWrite } from './TeamSections';
import {
  fetchCapabilities,
  fetchGrantReviews,
  fetchIssuers,
  fetchPeople,
  fetchReviewers,
  fetchScopes,
  fetchTeam,
} from './team-api';
import '../inventory/inventory.css';
import './projects.css';

/**
 * Projects → project → Team & Permissions (MM-AO05). Leadership, the project team, review
 * responsibilities, scoped authorizations (acceptance delegates, report issuers), what the
 * signed-in person may do here and why, and the history of every change. Everything comes from
 * the MM-AO03/AO04 API: controls appear only where the server reports `canManage`, the
 * permissions table is the server's capability list, and nothing here infers access from labels.
 * After every change, and whenever the server refuses one, the capabilities are reloaded.
 */

interface Loaded {
  project: ProjectDetail;
  capabilities: ProjectCapabilities;
  team: ProjectTeam;
  reviewers: ProjectReviewers;
  issuers: ProjectReportIssuers;
  delegates: AcceptanceDelegates | null;
  scopes: ReviewScope[];
  /** MTR-21: null when it couldn't be loaded; the people list then shows no permissions. */
  people: ProjectPeople | null;
  /** MTR-25: inherited grants flagged for a new lead, and the lead changes; null if unloaded. */
  grantReviews: ProjectGrantReviews | null;
}

type PageState =
  | { state: 'loading' }
  | { state: 'failed'; notFound: boolean; message: string }
  | { state: 'ready'; data: Loaded };

function unwrap<T>(result: LoadResult<T>): T {
  if (!result.ok) throw result;
  return result.data;
}

async function loadAll(projectId: string): Promise<Loaded> {
  const [project, capabilities, team, reviewers, issuers, scopes, delegates, people, grantReviews] =
    await Promise.all([
      fetchProjectDetail(projectId),
      fetchCapabilities(projectId),
      fetchTeam(projectId),
      fetchReviewers(projectId),
      fetchIssuers(projectId),
      fetchScopes(),
      fetchDelegates(projectId).catch(() => null),
      fetchPeople(projectId).catch(() => null),
      fetchGrantReviews(projectId).catch(() => null),
    ]);
  return {
    project: unwrap(project),
    capabilities: unwrap(capabilities),
    team: unwrap(team),
    reviewers: unwrap(reviewers),
    issuers: unwrap(issuers),
    scopes: unwrap(scopes),
    delegates,
    people: people?.ok ? people.data : null,
    grantReviews: grantReviews?.ok ? grantReviews.data : null,
  };
}

export function TeamPermissionsPage() {
  const { projectId = '' } = useParams();
  const me = useMe();
  // MTR-2: the shared LAB account reads none of this; say so instead of six refused requests.
  if (!me.permissions.includes('project_access.read')) {
    return (
      <>
        <p className="back-link">
          <Link to={`/projects/${encodeURIComponent(projectId)}`}>← Back to project</Link>
        </p>
        <h1>Team &amp; Permissions</h1>
        <EmptyState>
          Team &amp; Permissions is for personal accounts. Sign in with your own account.
        </EmptyState>
      </>
    );
  }
  return <TeamPermissions projectId={projectId} />;
}

function TeamPermissions({ projectId }: { projectId: string }) {
  const [page, setPage] = useState<PageState>({ state: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [notice, setNotice] = useState<{ tone: 'success' | 'warning'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadAll(projectId).then(
      (data) => !cancelled && setPage({ state: 'ready', data }),
      (failure: { notFound?: boolean; message?: string }) =>
        !cancelled &&
        setPage({
          state: 'failed',
          notFound: Boolean(failure.notFound),
          message: failure.message ?? 'Material Mule had a problem loading this. Try again.',
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, reloads]);

  const reload = useCallback(() => setReloads((n) => n + 1), []);

  /** Reloads only the capability lists (and the people summary's delegate list). */
  const refreshCapabilities = useCallback(() => {
    void Promise.all([
      fetchCapabilities(projectId),
      fetchDelegates(projectId).catch(() => null),
      fetchPeople(projectId).catch(() => null),
      fetchGrantReviews(projectId).catch(() => null),
    ]).then(([capabilities, delegates, people, grantReviews]) => {
      if (!capabilities.ok) return;
      setPage((current) =>
        current.state === 'ready'
          ? {
              state: 'ready',
              data: {
                ...current.data,
                capabilities: capabilities.data,
                delegates,
                people: people?.ok ? people.data : null,
                grantReviews: grantReviews?.ok ? grantReviews.data : current.data.grantReviews,
              },
            }
          : current,
      );
    });
  }, [projectId]);

  const update = useCallback(
    (patch: Partial<Loaded>) =>
      setPage((current) =>
        current.state === 'ready'
          ? { state: 'ready', data: { ...current.data, ...patch } }
          : current,
      ),
    [],
  );

  const run: RunWrite = useCallback(
    async (write, success, apply) => {
      const outcome = await write;
      if (outcome.ok) {
        apply(outcome.value);
        setNotice({ tone: 'success', text: success });
        refreshCapabilities();
        return true;
      }
      setNotice({ tone: 'warning', text: outcome.message });
      // Authority or state changed under us: show the server's current view, never a guess.
      if (
        outcome.kind === 'forbidden' ||
        outcome.kind === 'conflict' ||
        outcome.kind === 'not_found'
      ) {
        reload();
      }
      return false;
    },
    [refreshCapabilities, reload],
  );

  const back = (
    <p className="back-link">
      <Link to={`/projects/${encodeURIComponent(projectId)}`}>← Back to project</Link>
    </p>
  );

  if (page.state === 'loading') {
    return (
      <>
        {back}
        <h1>Team &amp; Permissions</h1>
        <p role="status">Loading…</p>
      </>
    );
  }
  if (page.state === 'failed') {
    return (
      <>
        {back}
        <h1>Team &amp; Permissions</h1>
        {page.notFound ? (
          <EmptyState>Project not found.</EmptyState>
        ) : (
          <ErrorState message={page.message} onRetry={reload} />
        )}
      </>
    );
  }

  const {
    project,
    capabilities,
    team,
    reviewers,
    issuers,
    delegates,
    scopes,
    people,
    grantReviews,
  } = page.data;
  return (
    <>
      {back}
      <div className="project-header">
        <div>
          <h1>Team &amp; Permissions</h1>
          <p className="project-name">
            <span className="number">{project.projectNumber}</span> · {project.name}
          </p>
        </div>
      </div>
      <p className={notice ? `notice notice-${notice.tone}` : 'notice'} role="status">
        {notice?.text}
      </p>

      <BandedCard
        className="project-section"
        title="Leadership"
        tone={project.leadProjectEngineer ? 'default' : 'attention'}
        aside={
          project.leadProjectEngineer ? null : (
            <StatusBadge tone="warning">Waiting for a lead</StatusBadge>
          )
        }
      >
        <dl className="stat-tiles project-tiles">
          <div>
            <dt>Lead Project Engineer</dt>
            <dd>
              {project.leadProjectEngineer
                ? formatPerson(
                    project.leadProjectEngineer.initials,
                    project.leadProjectEngineer.displayName,
                  )
                : 'None yet'}
            </dd>
          </div>
        </dl>
        <p className="field-hint">
          An administrator appoints or removes the lead (Edit project on the project page).
        </p>
      </BandedCard>
      <LeadSection
        projectId={project.id}
        lead={project.leadProjectEngineer}
        reloadKey={reloads}
        onChanged={(message) => {
          setNotice({ tone: 'success', text: message });
          reload();
        }}
      />

      {grantReviews ? (
        <GrantReviewsSection
          projectId={project.id}
          data={grantReviews}
          run={run}
          onChange={(next) => update({ grantReviews: next })}
        />
      ) : null}

      <PeopleSummary
        project={project}
        team={team}
        reviewers={reviewers}
        issuers={issuers}
        delegates={delegates}
        people={people}
        grantReviews={grantReviews}
      />

      <TeamSection
        projectId={project.id}
        data={team}
        run={run}
        onChange={(next) => update({ team: next })}
      />
      <ReviewersSection
        projectId={project.id}
        data={reviewers}
        scopes={scopes}
        run={run}
        onChange={(next) => update({ reviewers: next })}
      />

      <h2 className="section-heading">Authorizations</h2>
      <AcceptanceDelegatesSection
        key={reloads}
        projectId={project.id}
        onChanged={refreshCapabilities}
      />
      <IssuersSection
        projectId={project.id}
        data={issuers}
        scopes={scopes}
        run={run}
        onChange={(next) => update({ issuers: next })}
      />

      <YourPermissions capabilities={capabilities} onRefresh={reload} />

      <HistorySection
        team={team}
        reviewers={reviewers}
        issuers={issuers}
        delegates={delegates}
        grantReviews={grantReviews}
      />
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// People on this project: responsibilities and grants side by side (AC1)
// ---------------------------------------------------------------------------------------------

interface PersonRow {
  id: string;
  name: string;
  responsibilities: string[];
  grants: string[];
}

/** MTR-21: what one person may do here, and why, as the server computes it for them. */
function PersonPermissions({ person }: { person: ProjectPerson }) {
  const known = new Set<string>(PROJECT_CAPABILITY_ACTIONS);
  const allowed = person.capabilities.filter((c) => known.has(c.action) && c.allowed);
  return (
    <details className="person-permissions">
      <summary>Permissions here ({allowed.length ? `${allowed.length} allowed` : 'none'})</summary>
      <ul aria-label={`Permissions of ${person.name}`}>
        {person.capabilities
          .filter((c) => known.has(c.action))
          .map((c) => (
            <li key={c.action}>
              <strong>
                {PROJECT_CAPABILITY_ACTION_LABEL[c.action as ProjectCapabilityAction]}:
              </strong>{' '}
              {c.allowed ? 'Yes' : 'No'} · {whyFor(c)}
            </li>
          ))}
      </ul>
    </details>
  );
}

function PeopleSummary({
  project,
  team,
  reviewers,
  issuers,
  delegates,
  people: peopleView,
  grantReviews,
}: {
  project: ProjectDetail;
  team: ProjectTeam;
  reviewers: ProjectReviewers;
  issuers: ProjectReportIssuers;
  delegates: AcceptanceDelegates | null;
  people: ProjectPeople | null;
  grantReviews: ProjectGrantReviews | null;
}) {
  const details = new Map((peopleView?.people ?? []).map((p) => [p.userId, p]));
  // MTR-25: grants still waiting for the new lead's review carry the badge text.
  const flagged = new Set((grantReviews?.pending ?? []).map((r) => r.grantId));
  const badge = (grantId: string) => (flagged.has(grantId) ? ` (${NEEDS_REVIEW})` : '');
  const people = new Map<string, PersonRow>();
  const person = (id: string, initials: string | null, name: string) => {
    let row = people.get(id);
    if (!row) {
      row = { id, name: formatPerson(initials, name), responsibilities: [], grants: [] };
      people.set(id, row);
    }
    return row;
  };
  const lead = project.leadProjectEngineer;
  if (lead)
    person(lead.id, lead.initials, lead.displayName).responsibilities.push('Lead Project Engineer');
  for (const member of team.active) {
    person(member.person.userId, member.person.initials, member.person.name).responsibilities.push(
      'Team member',
    );
  }
  for (const assignment of reviewers.active) {
    const r = assignment.reviewer;
    person(r.userId, r.initials, r.name).responsibilities.push(
      `Reviewer: ${assignment.scope.label}${assignment.effective ? '' : ' (not effective)'}${badge(
        assignment.id,
      )}`,
    );
  }
  for (const grant of delegates?.active ?? []) {
    const d = grant.delegate;
    person(d.userId, d.initials, d.name).grants.push(`Acceptance delegate${badge(grant.id)}`);
  }
  for (const grant of issuers.active) {
    const i = grant.issuer;
    person(i.userId, i.initials, i.name).grants.push(
      `Report issuer: ${grant.scope.label}${grant.effective ? '' : ' (not effective)'}${badge(
        grant.id,
      )}`,
    );
  }
  const rows = [...people.values()];
  return (
    <BandedCard
      className="project-section"
      title="People on this project"
      subtitle="Responsibilities and grants are separate. A job title or team place grants no approvals."
    >
      <DataTable
        rows={rows}
        rowKey={(row) => row.id}
        caption="People on this project"
        empty="Nobody is assigned to this project yet."
        columns={[
          { header: 'Person', cell: (row) => <strong>{row.name}</strong> },
          {
            header: 'Job title',
            cell: (row) => details.get(row.id)?.jobTitle?.value ?? '—',
          },
          {
            header: 'Responsibilities',
            cell: (row) => (row.responsibilities.length ? row.responsibilities.join('; ') : '—'),
          },
          {
            header: 'Grants',
            cell: (row) => (row.grants.length ? row.grants.join('; ') : '—'),
          },
          {
            header: 'Permissions',
            cell: (row) => {
              const person = details.get(row.id);
              return person ? <PersonPermissions person={person} /> : '—';
            },
          },
        ]}
      />
    </BandedCard>
  );
}

// ---------------------------------------------------------------------------------------------
// What the signed-in person may do here, and why (the server's capability list)
// ---------------------------------------------------------------------------------------------

/** The source of a permission held by someone else ("As …"), or who it's allowed for. */
function whyFor(capability: Capability): string {
  if (capability.allowed) {
    return `As ${capability.sources.map((s) => CAPABILITY_SOURCE_LABEL[s]).join(', ')}`;
  }
  const grantedBy = capability.blocked?.grantedBy.map((s) => CAPABILITY_SOURCE_LABEL[s]) ?? [];
  return grantedBy.length ? `Allowed for: ${grantedBy.join(', ')}` : 'Not allowed';
}

function why(capability: Capability): string {
  if (capability.allowed) {
    return `As ${capability.sources.map((s) => CAPABILITY_SOURCE_LABEL[s]).join(', ')}`;
  }
  if (!capability.blocked) return 'Not allowed';
  const grantedBy = capability.blocked.grantedBy.map((s) => CAPABILITY_SOURCE_LABEL[s]);
  return `${BLOCKED_REASON_LABEL[capability.blocked.code]}${
    grantedBy.length ? ` Allowed for: ${grantedBy.join(', ')}.` : ''
  }`;
}

function YourPermissions({
  capabilities,
  onRefresh,
}: {
  capabilities: ProjectCapabilities;
  onRefresh: () => void;
}) {
  const known = new Set<string>(PROJECT_CAPABILITY_ACTIONS);
  const rows = capabilities.capabilities.filter((c) => known.has(c.action));
  return (
    <BandedCard
      className="project-section"
      title="Your permissions here"
      subtitle="What you can do on this project and where it comes from, as the server reports it."
      aside={
        <button type="button" onClick={onRefresh}>
          Refresh
        </button>
      }
    >
      <p>
        {capabilities.involvement.length
          ? `Your part in this project: ${capabilities.involvement
              .map((i) => PROJECT_INVOLVEMENT_LABEL[i])
              .join(', ')}.`
          : 'You have no assignment on this project. You can still see it.'}
      </p>
      {capabilities.reviewerScopes.length ? (
        <p className="field-hint">
          You review: {capabilities.reviewerScopes.map((s) => s.label).join(', ')}.
        </p>
      ) : null}
      {capabilities.issuerScopes.length ? (
        <p className="field-hint">
          You may issue: {capabilities.issuerScopes.map((s) => s.label).join(', ')}.
        </p>
      ) : null}
      <DataTable
        rows={rows}
        rowKey={(row) => row.action}
        caption="Your permissions on this project"
        empty="No actions reported."
        columns={[
          {
            header: 'Action',
            cell: (row) => PROJECT_CAPABILITY_ACTION_LABEL[row.action as ProjectCapabilityAction],
          },
          {
            header: 'You can',
            cell: (row) =>
              row.allowed ? (
                <StatusBadge tone="success">Yes</StatusBadge>
              ) : (
                <StatusBadge tone="neutral">No</StatusBadge>
              ),
          },
          { header: 'Why', cell: why },
        ]}
      />
    </BandedCard>
  );
}

// ---------------------------------------------------------------------------------------------
// History: every start and end, newest first
// ---------------------------------------------------------------------------------------------

interface HistoryEvent {
  key: string;
  at: string;
  text: string;
}

/** Events shown; each list returns its newest rows, so this is the newest of those. */
const HISTORY_SHOWN = 100;

function HistorySection({
  team,
  reviewers,
  issuers,
  delegates,
  grantReviews,
}: {
  team: ProjectTeam;
  reviewers: ProjectReviewers;
  issuers: ProjectReportIssuers;
  delegates: AcceptanceDelegates | null;
  grantReviews: ProjectGrantReviews | null;
}) {
  const events: HistoryEvent[] = [];
  // MTR-25: lead changes and the new lead's review of inherited grants.
  for (const change of grantReviews?.leadChanges ?? []) {
    const by = change.by ? ` by ${formatPerson(change.by.initials, change.by.name)}` : '';
    const reason = change.reason ? ` (${change.reason})` : '';
    events.push({
      key: `lead:${change.at}`,
      at: change.at,
      text: change.lead
        ? `Lead Project Engineer changed to ${formatPerson(change.lead.initials, change.lead.name)}${by}${reason}`
        : `Lead Project Engineer removed${by}${reason}`,
    });
  }
  for (const review of grantReviews?.history ?? []) {
    if (!review.decidedAt || review.status === 'pending') continue;
    const by = review.decidedBy
      ? ` by ${formatPerson(review.decidedBy.initials, review.decidedBy.name)}`
      : '';
    events.push({
      key: `review:${review.id}`,
      at: review.decidedAt,
      text: `Inherited ${GRANT_REVIEW_KIND_LABEL[review.kind].toLowerCase()} grant of ${
        review.holder.name
      } ${review.status === 'kept' ? 'kept' : 'revoked'}${by}${
        review.reason ? ` (${review.reason})` : ''
      }`,
    });
  }
  const add = (
    id: string,
    what: string,
    row: {
      startedBy: { initials: string | null; name: string };
      startedAt: string;
      startReason: string | null;
      endedBy: { initials: string | null; name: string } | null;
      endedAt: string | null;
      endReason: string | null;
    },
    verbs: [string, string],
  ) => {
    events.push({
      key: `${id}:start`,
      at: row.startedAt,
      text: `${what} ${verbs[0]} by ${formatPerson(row.startedBy.initials, row.startedBy.name)}${
        row.startReason ? ` (${row.startReason})` : ''
      }`,
    });
    if (row.endedAt) {
      const by = row.endedBy ? formatPerson(row.endedBy.initials, row.endedBy.name) : 'someone';
      events.push({
        key: `${id}:end`,
        at: row.endedAt,
        text: `${what} ${verbs[1]} by ${by}${row.endReason ? ` (${row.endReason})` : ''}`,
      });
    }
  };
  for (const m of [...team.active, ...team.history]) {
    add(m.id, `Team member ${m.person.name}`, m, ['added', 'removed']);
  }
  for (const a of [...reviewers.active, ...reviewers.history]) {
    add(a.id, `${a.scope.label} reviewer ${a.reviewer.name}`, a, ['assigned', 'removed']);
  }
  for (const g of [...issuers.active, ...issuers.history]) {
    add(g.id, `${g.scope.label} issuer ${g.issuer.name}`, g, [
      'authorized',
      g.revocationKind === 'emergency' ? 'suspended (emergency)' : 'revoked',
    ]);
  }
  for (const d of [...(delegates?.active ?? []), ...(delegates?.history ?? [])]) {
    add(
      d.id,
      `Acceptance delegate ${d.delegate.name}`,
      {
        startedBy: d.grantedBy,
        startedAt: d.grantedAt,
        startReason: d.grantReason,
        endedBy: d.revokedBy,
        endedAt: d.revokedAt,
        endReason: d.revokeReason,
      },
      ['added', 'revoked'],
    );
  }
  events.sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.key.localeCompare(b.key)));
  const shown = events.slice(0, HISTORY_SHOWN);
  const hidden =
    events.length -
    shown.length +
    Math.max(0, team.historyTotal - team.history.length) +
    Math.max(0, reviewers.historyTotal - reviewers.history.length) +
    Math.max(0, issuers.historyTotal - issuers.history.length);
  return (
    <BandedCard
      className="project-section"
      title="History"
      subtitle="Assignments and grants as the server recorded them, with who and why."
    >
      {shown.length === 0 ? (
        <EmptyState>No changes recorded yet.</EmptyState>
      ) : (
        <ol className="delegate-list team-history" aria-label="Team and permissions history">
          {shown.map((event) => (
            <li key={event.key}>
              <span className="nowrap">{shortDateTime(event.at)}</span> {event.text}
            </li>
          ))}
        </ol>
      )}
      {hidden > 0 ? (
        <p className="field-hint">Older changes aren’t shown here ({hidden} more).</p>
      ) : null}
    </BandedCard>
  );
}
