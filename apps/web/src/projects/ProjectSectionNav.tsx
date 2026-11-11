import { Link } from 'react-router';
import { concreteTabPath } from '../concrete/project/paths';
import { useContext } from 'react';
import { SessionContext } from '../session/context';
import './projects.css';

/**
 * The project's section switch in the context row (MM-V2-C30; Field Ledger canvas Project,
 * ProjectTeam): "Overview" (details, test holes, receipts, storage units and retention),
 * "Concrete" (reports, specimens, summary, mixes and settings) and "Team" (Team & Permissions,
 * for accounts that may read project access). Links joined in one frame; the current one is
 * ink-filled with `aria-current`.
 */
export function ProjectSectionNav({
  projectId,
  current,
}: {
  projectId: string;
  current: 'overview' | 'concrete' | 'team';
}) {
  // Read the session softly: pages rendered without one (some route tests) show no Team link.
  const session = useContext(SessionContext)?.session;
  const canReadTeam =
    session?.status === 'active' && session.me.permissions.includes('project_access.read');
  const base = `/projects/${encodeURIComponent(projectId)}`;
  return (
    <nav className="project-switch" aria-label="Project sections">
      <Link to={base} aria-current={current === 'overview' ? 'page' : undefined}>
        Overview
      </Link>
      <Link
        to={concreteTabPath(projectId)}
        aria-current={current === 'concrete' ? 'page' : undefined}
      >
        Concrete
      </Link>
      {canReadTeam ? (
        <Link
          to={`${base}/team`}
          aria-label="Team & Permissions"
          aria-current={current === 'team' ? 'page' : undefined}
        >
          Team
        </Link>
      ) : null}
    </nav>
  );
}
