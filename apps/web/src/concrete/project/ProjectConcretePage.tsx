import type { ProjectDetail } from '@materialmule/shared';
import { FolderX } from 'lucide-react';
import type { ReactNode } from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import { Empty, EmptyContent, EmptyHeader, EmptyMedia, EmptyTitle } from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { usePageTitle } from '../../layout/page-title';
import { useProjectLayout } from '../../projects/project-layout-context';
import { LoadErrorAlert } from '../../projects/project-ui';
import { CONCRETE_TABS, LEGACY_CONCRETE_TABS, concreteTabPath, type ConcreteTab } from './paths';
import { useProject } from './useProject';
import { MixesTab } from './MixesTab';
import { ReportsTab } from './ReportsTab';
import { SetsTab } from './SetsTab';
import { SettingsTab } from './SettingsTab';
import { SummaryTab } from './SummaryTab';

// MM-V2-C30, STRATA-98: the project's Concrete tab, inside the project page (lane D's
// ProjectLayout: breadcrumb, header and the project's line tabs). Five sub-tabs (Kyle
// 2026-11-11), each its own address so a link or Back lands on the same one: Field reports, Sets,
// Mixes, Summary and Settings. A mix and its propagation review are pages of their own, with a
// breadcrumb back through the project (canvas R8Mix*, R8Prop*).

/** `/projects/:projectId/concrete/:tab`, rendered in the project page's outlet. */
export function ProjectConcreteTab() {
  const { tab = '' } = useParams();
  const { project } = useProjectLayout();
  const location = useLocation();
  const current = CONCRETE_TABS.find((t) => t.key === tab);
  if (!current) {
    const target: ConcreteTab = LEGACY_CONCRETE_TABS[tab] ?? 'reports';
    return <Navigate to={`${concreteTabPath(project.id, target)}${location.search}`} replace />;
  }
  return (
    <div className="flex min-w-0 flex-col gap-5">
      <nav aria-label="Concrete sections">
        <Tabs value={current.key} activationMode="manual">
          <TabsList variant="line" className="h-auto flex-wrap justify-start">
            {CONCRETE_TABS.map((t) => (
              <TabsTrigger key={t.key} value={t.key} asChild>
                <Link to={concreteTabPath(project.id, t.key)}>{t.label}</Link>
              </TabsTrigger>
            ))}
          </TabsList>
        </Tabs>
      </nav>
      <ConcreteSubTab tab={current.key} project={project} />
    </div>
  );
}

function ConcreteSubTab({ tab, project }: { tab: ConcreteTab; project: ProjectDetail }) {
  switch (tab) {
    case 'reports':
      return <ReportsTab project={project} />;
    case 'sets':
      return <SetsTab project={project} />;
    case 'mixes':
      return <MixesTab project={project} />;
    case 'summary':
      return <SummaryTab project={project} />;
    case 'settings':
      return <SettingsTab project={project} />;
  }
}

/** `/projects/:projectId/concrete` opens Field reports. */
export function ProjectConcreteRedirect() {
  const { projectId = '' } = useParams();
  return <Navigate to={concreteTabPath(projectId)} replace />;
}

/** `/projects/:projectId/concrete-mixes` (MM-V2-C37's former mixes screen) opens Mixes. */
export function ProjectConcreteMixesRedirect() {
  const { projectId = '' } = useParams();
  return <Navigate to={concreteTabPath(projectId, 'mixes')} replace />;
}

/** One step of a record page's breadcrumb after Projects › project number. */
export interface Crumb {
  label: string;
  to?: string;
  mono?: boolean;
}

/**
 * A page reached from a Concrete row (a mix, its propagation review): the breadcrumb Projects ›
 * project › Mixes › …, then the page. The project loads first, so the page never shows under a
 * project that doesn't exist.
 */
export function ConcreteRecordFrame({
  projectId,
  title,
  crumbs,
  children,
}: {
  projectId: string;
  /** Names the browser tab, e.g. "Mix"; the project number is added. */
  title: string;
  crumbs: Crumb[];
  children: (project: ProjectDetail) => ReactNode;
}) {
  const { project, reload } = useProject(projectId);
  usePageTitle(project?.ok ? `${title} · ${project.data.projectNumber}` : null);
  const frame = 'mx-auto flex w-full max-w-[1280px] min-w-0 flex-col gap-6';
  if (!project) {
    return (
      <div aria-busy="true" className={frame}>
        <Skeleton className="h-4 w-64" />
        <Skeleton className="h-8 w-80 max-w-full" />
        <Skeleton className="h-40 w-full" />
        <p className="sr-only" role="status">
          Loading…
        </p>
      </div>
    );
  }
  if (!project.ok) {
    return (
      <div className={frame}>
        <h1 className="sr-only">Project</h1>
        {project.notFound ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderX aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>Project not found.</EmptyTitle>
            </EmptyHeader>
            <EmptyContent>
              <Button asChild>
                <Link to="/projects">Go to Projects</Link>
              </Button>
            </EmptyContent>
          </Empty>
        ) : (
          <LoadErrorAlert
            title="This project couldn't load"
            message={project.message}
            onRetry={reload}
          />
        )}
      </div>
    );
  }
  const data = project.data;
  return (
    <div className={`@container ${frame}`}>
      <Breadcrumb>
        <BreadcrumbList>
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link to="/projects">Projects</Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbLink asChild>
              <Link
                className="font-mono whitespace-nowrap"
                to={`/projects/${encodeURIComponent(data.id)}`}
              >
                {data.projectNumber}
              </Link>
            </BreadcrumbLink>
          </BreadcrumbItem>
          {crumbs.map((crumb) => (
            <Crumbs key={crumb.label} crumb={crumb} />
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {children(data)}
    </div>
  );
}

function Crumbs({ crumb }: { crumb: Crumb }) {
  const mono = crumb.mono ? 'font-mono whitespace-nowrap' : undefined;
  return (
    <>
      <BreadcrumbSeparator />
      <BreadcrumbItem>
        {crumb.to ? (
          <BreadcrumbLink asChild>
            <Link className={mono} to={crumb.to}>
              {crumb.label}
            </Link>
          </BreadcrumbLink>
        ) : (
          <BreadcrumbPage className={mono}>{crumb.label}</BreadcrumbPage>
        )}
      </BreadcrumbItem>
    </>
  );
}
