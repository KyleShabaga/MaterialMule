import { useContext } from 'react';
import { Link } from 'react-router';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { concreteTabPath } from '../concrete/project/paths';
import { SessionContext } from '../session/context';

/**
 * The project's line tabs for pages outside the project layout (the Concrete section, lane E's
 * routes): the same tabs as ProjectLayout (STRATA-84) without counts, so moving between the
 * Concrete section and the other tabs looks the same. Team & permissions shows to accounts that
 * may read project access.
 */
export function ProjectSectionNav({
  projectId,
  current,
}: {
  projectId: string;
  current: 'overview' | 'units' | 'programs' | 'concrete' | 'team';
}) {
  // Read the session softly: pages rendered without one (some route tests) show no Team tab.
  const session = useContext(SessionContext)?.session;
  const canReadTeam =
    session?.status === 'active' && session.me.permissions.includes('project_access.read');
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return (
    <nav aria-label="Project sections" className="border-b pb-1">
      <Tabs value={current} activationMode="manual">
        <TabsList variant="line" className="h-auto flex-wrap justify-start">
          <TabsTrigger value="overview" asChild>
            <Link to={base}>Overview</Link>
          </TabsTrigger>
          <TabsTrigger value="units" asChild>
            <Link to={`${base}/units`}>Storage units</Link>
          </TabsTrigger>
          <TabsTrigger value="programs" asChild>
            <Link to={`${base}/programs`}>Lab programs</Link>
          </TabsTrigger>
          <TabsTrigger value="concrete" asChild>
            <Link to={concreteTabPath(projectId)}>Concrete</Link>
          </TabsTrigger>
          {canReadTeam ? (
            <TabsTrigger value="team" asChild>
              <Link to={`${base}/team`}>Team &amp; permissions</Link>
            </TabsTrigger>
          ) : null}
        </TabsList>
      </Tabs>
    </nav>
  );
}
