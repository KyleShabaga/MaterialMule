import type { ProjectDetail } from '@materialmule/shared';
import type { ReactNode } from 'react';
import { Link, Navigate, NavLink, useParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '../../components/ui';
import { usePageTitle } from '../../layout/page-title';
import '../../projects/projects.css';
import { ProjectSectionNav } from '../../projects/ProjectSectionNav';
import { CONCRETE_TABS, concreteTabPath } from './paths';
import { useProject } from './useProject';
import { MixesTab } from './MixesTab';
import { ReportsTab } from './ReportsTab';
import { SettingsTab } from './SettingsTab';
import { SpecimensTab } from './SpecimensTab';
import { SummaryTab } from './SummaryTab';
import './project-concrete.css';

// MM-V2-C30: the project's Concrete section. It sits beside the project's existing page as a
// second section ("Overview" | "Concrete") under the same project header, so storage-unit work
// and concrete work each keep a full page. Five tabs, each its own address so a link or Back
// lands on the same tab: Reports, Specimens, Summary, Mixes and Settings.

/** The project header and section nav around a Concrete screen. */
export function ConcreteFrame({
  projectId,
  title,
  back,
  children,
}: {
  projectId: string;
  /** Names the browser tab, e.g. "Mixes · DEMO-2601". */
  title: string;
  back?: ReactNode;
  children: (project: ProjectDetail) => ReactNode;
}) {
  const { project, reload } = useProject(projectId);
  usePageTitle(project?.ok ? `${title} · ${project.data.projectNumber}` : null);
  if (!project) return <p role="status">Loading…</p>;
  if (!project.ok) {
    return (
      <>
        <PageHeader title="Project" documentTitle={false} />
        {project.notFound ? (
          <EmptyState>Project not found.</EmptyState>
        ) : (
          <ErrorState message={project.message} onRetry={reload} />
        )}
      </>
    );
  }
  const data = project.data;
  return (
    <>
      <p className="back-link">{back ?? <Link to="/projects">← Back to Projects</Link>}</p>
      <div className="project-header">
        <div>
          <h1 className="project-number-heading">{data.projectNumber}</h1>
          <p className="project-name">{data.name}</p>
        </div>
      </div>
      <ProjectSectionNav projectId={data.id} current="concrete" />
      {children(data)}
    </>
  );
}

export function ProjectConcretePage() {
  const { projectId = '', tab = '' } = useParams();
  const current = CONCRETE_TABS.find((t) => t.key === tab);
  if (!current) return <Navigate to={concreteTabPath(projectId)} replace />;
  return (
    <ConcreteFrame projectId={projectId} title={current.label}>
      {(project) => (
        <>
          <nav className="concrete-section-tabs" aria-label="Concrete">
            {CONCRETE_TABS.map((t) => (
              <NavLink key={t.key} to={concreteTabPath(project.id, t.key)}>
                {t.label}
              </NavLink>
            ))}
          </nav>
          <h2 className="visually-hidden">{current.label}</h2>
          {current.key === 'reports' ? <ReportsTab project={project} /> : null}
          {current.key === 'specimens' ? <SpecimensTab project={project} /> : null}
          {current.key === 'summary' ? <SummaryTab /> : null}
          {current.key === 'mixes' ? <MixesTab project={project} /> : null}
          {current.key === 'settings' ? <SettingsTab project={project} /> : null}
        </>
      )}
    </ConcreteFrame>
  );
}

/** `/projects/:projectId/concrete` opens the Reports tab. */
export function ProjectConcreteRedirect() {
  const { projectId = '' } = useParams();
  return <Navigate to={concreteTabPath(projectId)} replace />;
}
