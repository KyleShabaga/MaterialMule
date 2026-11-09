import { Link } from 'react-router';
import { concreteTabPath } from '../concrete/project/paths';

/**
 * The project's two sections (MM-V2-C30): "Overview" (details, test holes, receipts, storage units
 * and retention) and "Concrete" (reports, specimens, summary, mixes and settings), under the same
 * project header.
 */
export function ProjectSectionNav({
  projectId,
  current,
}: {
  projectId: string;
  current: 'overview' | 'concrete';
}) {
  return (
    <nav className="project-sections" aria-label="Project sections">
      <Link
        to={`/projects/${encodeURIComponent(projectId)}`}
        aria-current={current === 'overview' ? 'page' : undefined}
      >
        Overview
      </Link>
      <Link
        to={concreteTabPath(projectId)}
        aria-current={current === 'concrete' ? 'page' : undefined}
      >
        Concrete
      </Link>
    </nav>
  );
}
