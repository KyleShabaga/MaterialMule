import type {
  AcceptanceDelegates,
  ProjectCapabilities,
  ProjectGrantReviews,
  ProjectPeople,
  ProjectReportIssuers,
  ProjectReviewers,
  ProjectTeam,
  ProjectTeamJoinRequests,
  ReviewScope,
} from '@materialmule/shared';
import { Lock } from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { notifyError, notifySuccess } from '@/components/strata/toast';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { fetchDelegates } from '../lab/api';
import { useMe } from '../session/context';
import { NeedsReviewSection } from './GrantReviewsSection';
import { JoinSelfSection } from './JoinRequestsSection';
import { LeadSection } from './LeadSection';
import { useProjectLayout } from './project-layout-context';
import { TeamCard } from './TeamCard';
import { HistoryList } from './TeamHistory';
import { TeamPeopleSection } from './TeamPeopleTable';
import type { GrantApply, RunWrite } from './TeamSections';
import { YourPermissions } from './YourPermissions';
import {
  fetchCapabilities,
  fetchGrantReviews,
  fetchIssuers,
  fetchJoinRequests,
  fetchPeople,
  fetchReviewers,
  fetchScopes,
  fetchTeam,
} from './team-api';
import { TeamFormContext, type TeamFormRegistry } from './team-form-open';
import type { TeamData } from './team-people';
import type { LoadResult } from './api';

/**
 * Projects › project › Team & permissions tab (STRATA-85; MM-AO05; DESIGN.md › Briefs › Round 4,
 * boards R4Team*). Rendered by the project layout (header and line tabs, STRATA-84) as the child
 * route `/projects/:projectId/team`; the project comes from the layout. Sections: Leadership, Your
 * permissions here, Needs review (lead or admin), People (table and person drawer) and History.
 *
 * Everything comes from the MM-AO03/AO04 API: controls appear only where the server reports
 * `canManage` / `canDecide`, the permission lists are the server's capability lists, and nothing
 * here infers access from labels or job titles. After every change, and whenever the server
 * refuses one, the lists are read again.
 */

interface Loaded extends Omit<TeamData, 'project'> {
  capabilities: ProjectCapabilities;
  /** When the capabilities were last read ("checked 10:42"). */
  checkedAt: string;
}

type PageState =
  { state: 'loading' } | { state: 'failed'; message: string } | { state: 'ready'; data: Loaded };

function unwrap<T>(result: LoadResult<T>): T {
  if (!result.ok) throw result;
  return result.data;
}

const optional = <T,>(result: LoadResult<T> | null): T | null => (result?.ok ? result.data : null);

async function loadAll(projectId: string): Promise<Loaded> {
  const [capabilities, team, reviewers, issuers, scopes, delegates, people, grantReviews, joins] =
    await Promise.all([
      fetchCapabilities(projectId),
      fetchTeam(projectId),
      fetchReviewers(projectId),
      fetchIssuers(projectId),
      fetchScopes(),
      fetchDelegates(projectId).catch(() => null),
      fetchPeople(projectId).catch(() => null),
      fetchGrantReviews(projectId).catch(() => null),
      fetchJoinRequests(projectId).catch(() => null),
    ]);
  return {
    capabilities: unwrap(capabilities),
    checkedAt: new Date().toISOString(),
    team: unwrap(team),
    reviewers: unwrap(reviewers),
    issuers: unwrap(issuers),
    scopes: unwrap<ReviewScope[]>(scopes),
    delegates: delegates as AcceptanceDelegates | null,
    people: optional<ProjectPeople>(people),
    grantReviews: optional<ProjectGrantReviews>(grantReviews),
    joinRequests: optional<ProjectTeamJoinRequests>(joins),
  };
}

export function TeamPermissionsPage() {
  const me = useMe();
  // MTR-2: the shared LAB account reads none of this; say so instead of refused requests.
  if (!me.permissions.includes('project_access.read')) {
    return (
      <Empty className="border">
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Lock aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>Team &amp; permissions is for personal accounts</EmptyTitle>
          <EmptyDescription>Sign in with your own account to see it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }
  return <TeamPermissions meId={me.id} />;
}

function TeamPermissions({ meId }: { meId: string }) {
  const { project, reloadProject, setFormOpen } = useProjectLayout();
  const projectId = project.id;
  const [page, setPage] = useState<PageState>({ state: 'loading' });
  const [reloads, setReloads] = useState(0);
  const [historyKey, setHistoryKey] = useState(0);

  // One primary per screen: any open decision or form turns the header's primary outline.
  const openForms = useRef(new Set<string>());
  const registry = useMemo<TeamFormRegistry>(
    () => ({
      set(key, open) {
        if (open) openForms.current.add(key);
        else openForms.current.delete(key);
        setFormOpen(openForms.current.size > 0);
      },
    }),
    [setFormOpen],
  );
  useEffect(() => () => setFormOpen(false), [setFormOpen]);

  useEffect(() => {
    let cancelled = false;
    loadAll(projectId).then(
      (data) => !cancelled && setPage({ state: 'ready', data }),
      (failure: { message?: string }) =>
        !cancelled &&
        setPage({
          state: 'failed',
          message: failure.message ?? 'Material Mule had a problem loading this. Try again.',
        }),
    );
    return () => {
      cancelled = true;
    };
  }, [projectId, reloads]);

  const reload = useCallback(() => {
    setReloads((n) => n + 1);
    setHistoryKey((n) => n + 1);
  }, []);

  /** Reads the capability lists (and the people, delegate and review lists) again. */
  const refreshCapabilities = useCallback(() => {
    setHistoryKey((n) => n + 1);
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
                checkedAt: new Date().toISOString(),
                delegates: delegates ?? current.data.delegates,
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
        notifySuccess(success);
        refreshCapabilities();
        return true;
      }
      notifyError(outcome.message);
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

  const apply: GrantApply = useMemo(
    () => ({
      team: (team: ProjectTeam) => update({ team }),
      reviewers: (reviewers: ProjectReviewers) => update({ reviewers }),
      issuers: (issuers: ProjectReportIssuers) => update({ issuers }),
      delegates: (delegates: AcceptanceDelegates) => update({ delegates }),
    }),
    [update],
  );

  if (page.state === 'loading') {
    return (
      <div aria-busy="true" className="@container flex flex-col gap-6">
        <p className="sr-only" role="status">
          Loading team and permissions
        </p>
        <div className="grid gap-6 @min-[56rem]:grid-cols-2">
          <Skeleton className="h-40 w-full rounded-xl" />
          <Skeleton className="h-40 w-full rounded-xl" />
        </div>
        <Skeleton className="h-64 w-full rounded-xl" />
      </div>
    );
  }
  if (page.state === 'failed') {
    return (
      <Alert>
        <AlertTitle>Team &amp; permissions couldn’t be loaded</AlertTitle>
        <AlertDescription className="flex flex-wrap items-center gap-3">
          {page.message}
          <Button variant="outline" size="sm" onClick={reload}>
            Try again
          </Button>
        </AlertDescription>
      </Alert>
    );
  }

  const data: TeamData = { ...page.data, project };
  const { capabilities, joinRequests, grantReviews } = page.data;
  return (
    <TeamFormContext.Provider value={registry}>
      <div className="@container flex flex-col gap-6">
        <div className="grid items-start gap-6 @min-[56rem]:grid-cols-2">
          <LeadSection
            projectId={projectId}
            lead={project.leadProjectEngineer}
            meId={meId}
            leadChange={grantReviews?.leadChanges[0] ?? null}
            reloadKey={reloads}
            onChanged={(message) => {
              notifySuccess(message);
              reload();
              reloadProject();
            }}
          />
          <YourPermissions
            capabilities={capabilities}
            checkedAt={page.data.checkedAt}
            onRefresh={reload}
          />
        </div>

        <NeedsReviewSection
          projectId={projectId}
          joinRequests={joinRequests}
          grantReviews={grantReviews}
          run={run}
          onJoinChange={(next) => {
            update({ joinRequests: next });
            // The team itself changed too (a member accepted or removed).
            reload();
          }}
          onReviewChange={(next) => {
            update({ grantReviews: next });
            // Ending a grant ended a reviewer, issuer or delegate grant: read every list again.
            reload();
          }}
        />

        {joinRequests ? (
          <JoinSelfSection
            projectId={projectId}
            data={joinRequests}
            run={run}
            onChange={(next) => {
              update({ joinRequests: next });
              reload();
            }}
          />
        ) : null}

        <TeamPeopleSection
          data={data}
          meId={meId}
          run={run}
          apply={apply}
          historyKey={historyKey}
        />

        <TeamCard id="team-history" title="History" meta="Assignments and grants as recorded">
          <HistoryList
            projectId={projectId}
            reloadKey={historyKey}
            label="Team and permissions history"
          />
        </TeamCard>
      </div>
    </TeamFormContext.Provider>
  );
}
