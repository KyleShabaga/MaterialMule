import type { ProjectDetail } from '@materialmule/shared';
import {
  ArrowDownToLine,
  Ellipsis,
  FolderX,
  Link as LinkIcon,
  Lock,
  Pencil,
  Pin,
  PinOff,
} from 'lucide-react';
import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { Link, Outlet, useLocation, useParams } from 'react-router';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Skeleton } from '@/components/ui/skeleton';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { PersonAvatar } from '../components/strata/person-avatar';
import { StageTag } from '../components/strata/stage-tag';
import { notifyError, notifySuccess } from '../components/strata/toast';
import { concreteTabPath } from '../concrete/project/paths';
import { usePageTitle } from '../layout/page-title';
import { useRecordRecent } from '../layout/record-recent';
import { SessionContext } from '../session/context';
import { RecordingPersonContext } from '../session/recording-person-store';
import { fetchProjectDetail, fetchProjectPinned, setProjectPinned, type LoadResult } from './api';
import { EditProjectDialog } from './EditProjectDialog';
import type { ProjectLayoutContext } from './project-layout-context';
import { copyText, receiveForProjectPath } from './project-format';
import { LoadErrorAlert } from './project-ui';
import type { ProjectLinkState } from './ProjectsPage';

/** The project page's line tabs; each keeps its own URL (STRATA-84). */
export type ProjectTab = 'overview' | 'units' | 'programs' | 'concrete' | 'team';

const TAB_SUFFIX: Record<Exclude<ProjectTab, 'concrete'>, string> = {
  overview: '',
  units: '/units',
  programs: '/programs',
  team: '/team',
};

/** The tab a path under /projects/:id shows. */
function tabOf(pathname: string, base: string): ProjectTab {
  const rest = pathname.slice(base.length);
  if (rest.startsWith('/units')) return 'units';
  if (rest.startsWith('/programs')) return 'programs';
  if (rest.startsWith('/team')) return 'team';
  if (rest.startsWith('/concrete')) return 'concrete';
  return 'overview';
}

/**
 * The project page (STRATA-84, canvas R4Project): breadcrumb, header (number and name, lead or
 * "Waiting for a lead" with the nomination state, three counts, Receive for this project, Pin,
 * More), and line tabs that keep their own URL. Tabs render in the outlet and read the project
 * from `useProjectLayout()`.
 */
export function ProjectLayout() {
  const { projectId = '' } = useParams();
  const location = useLocation();
  const from = (location.state as ProjectLinkState | null)?.from;
  const session = useContext(SessionContext)?.session;
  const me = session?.status === 'active' ? session.me : null;
  const station = useContext(RecordingPersonContext)?.isStation ?? false;

  const [result, setResult] = useState<(LoadResult<ProjectDetail> & { key: string }) | null>(null);
  const [reloads, setReloads] = useState(0);
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  // Where the breadcrumb returns to: the list's query when we came from it.
  const [backSearch, setBackSearch] = useState(from ?? '');
  if (from !== undefined && from !== backSearch) setBackSearch(from);

  useEffect(() => {
    let cancelled = false;
    void fetchProjectDetail(projectId).then((response) => {
      if (!cancelled) setResult({ ...response, key: projectId });
    });
    return () => {
      cancelled = true;
    };
  }, [projectId, reloads]);

  const current = result?.key === projectId ? result : null;
  const project = current?.ok ? current.data : null;
  usePageTitle(project?.projectNumber ?? null);
  useRecordRecent('project', project?.id ?? null);

  const base = `/projects/${encodeURIComponent(projectId)}`;
  const tab = tabOf(location.pathname, base);

  // Each tab keeps its own query (filters, search, the open drawer) for when you come back.
  // Kept in state, updated during render when the location moves, per project.
  const [tabSearch, setTabSearch] = useState<{
    project: string;
    searches: Partial<Record<ProjectTab, string>>;
  }>({ project: projectId, searches: {} });
  let searches = tabSearch.project === projectId ? tabSearch.searches : {};
  if (tabSearch.project !== projectId || searches[tab] !== location.search) {
    searches = { ...searches, [tab]: location.search };
    setTabSearch({ project: projectId, searches });
  }
  const tabHref = (id: Exclude<ProjectTab, 'concrete'>) =>
    `${base}${TAB_SUFFIX[id]}${id === tab ? location.search : (searches[id] ?? '')}`;

  const reloadProject = useCallback(() => setReloads((n) => n + 1), []);
  const context = useMemo<ProjectLayoutContext | null>(
    () => (project ? { project, reloadProject, setFormOpen } : null),
    [project, reloadProject],
  );

  const breadcrumb = (label: string) => (
    <Breadcrumb>
      <BreadcrumbList>
        <BreadcrumbItem>
          <BreadcrumbLink asChild>
            <Link to={`/projects${backSearch}`}>Projects</Link>
          </BreadcrumbLink>
        </BreadcrumbItem>
        <BreadcrumbSeparator />
        <BreadcrumbItem>
          <BreadcrumbPage className="font-mono whitespace-nowrap">{label}</BreadcrumbPage>
        </BreadcrumbItem>
      </BreadcrumbList>
    </Breadcrumb>
  );

  const frame = 'mx-auto flex w-full max-w-[1280px] flex-col gap-6';

  if (!current) {
    return (
      <div aria-busy="true" aria-label="Loading project" className={`@container ${frame}`}>
        <Skeleton className="h-4 w-40" />
        <div className="flex flex-col gap-3">
          <Skeleton className="h-8 w-96 max-w-full" />
          <Skeleton className="h-4 w-48" />
        </div>
        <div className="flex gap-8">
          <Skeleton className="h-5 w-28" />
          <Skeleton className="h-5 w-32" />
          <Skeleton className="h-5 w-32" />
        </div>
        <Skeleton className="h-40 w-full" />
        <p className="sr-only" role="status">
          Loading…
        </p>
      </div>
    );
  }

  if (!current.ok) {
    return (
      <div className={frame}>
        {breadcrumb('Project')}
        <h1 className="sr-only">Project</h1>
        {current.notFound ? (
          <Empty>
            <EmptyHeader>
              <EmptyMedia variant="icon">
                <FolderX aria-hidden="true" />
              </EmptyMedia>
              <EmptyTitle>Project not found.</EmptyTitle>
              <EmptyDescription>
                The link may be wrong, or the project no longer exists. Find it in Projects or with
                Ctrl K.
              </EmptyDescription>
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
            message={current.message}
            onRetry={reloadProject}
          />
        )}
      </div>
    );
  }

  const data = current.data;
  const permissions = me?.permissions ?? [];
  const canReadTeam = permissions.includes('project_access.read');
  const lockedTeam = !canReadTeam && (station || me?.accountType === 'shared_lab');
  const showConcrete = Boolean(data.hasConcreteWork || data.canStartConcreteWork);
  const canPin =
    me !== null &&
    !station &&
    me.accountType !== 'shared_lab' &&
    permissions.includes('personal_settings.manage');
  const programTotal = (data.labProgramCounts?.open ?? 0) + (data.labProgramCounts?.closed ?? 0);

  return (
    <div className={`@container ${frame}`}>
      {breadcrumb(data.projectNumber)}

      <header className="flex flex-col gap-4">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex min-w-0 flex-col gap-2">
            <h1 className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
              <span className="font-mono text-[28px] leading-[34px] font-bold whitespace-nowrap">
                {data.projectNumber}
              </span>
              <span className="text-2xl font-bold">{data.name}</span>
            </h1>
            <LeadLine project={data} />
          </div>
          <div className="flex items-center gap-2">
            <Button asChild variant={formOpen ? 'outline' : 'default'}>
              <Link to={receiveForProjectPath(data.id)}>
                <ArrowDownToLine aria-hidden="true" />
                Receive for this project
              </Link>
            </Button>
            {canPin ? <PinButton project={data} /> : null}
            <DropdownMenu modal={false}>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="outline"
                  size="icon"
                  aria-label="More actions"
                  title="More actions"
                >
                  <Ellipsis aria-hidden="true" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="w-56">
                {data.canEdit ? (
                  <>
                    <DropdownMenuItem onSelect={() => setEditing(true)}>
                      <Pencil aria-hidden="true" />
                      Edit project
                    </DropdownMenuItem>
                    <DropdownMenuSeparator />
                  </>
                ) : null}
                <DropdownMenuItem
                  onSelect={() => {
                    const url = `${window.location.origin}/projects/${encodeURIComponent(data.id)}`;
                    void copyText(url).then((copied) =>
                      copied
                        ? notifySuccess('Link copied')
                        : notifyError("Couldn't copy the link. Copy it from the address bar."),
                    );
                  }}
                >
                  <LinkIcon aria-hidden="true" />
                  Copy link
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        </div>
        <ul aria-label="Counts" className="flex flex-wrap gap-x-8 gap-y-2 text-sm">
          <Count
            value={data.testHoles.length}
            label={data.testHoles.length === 1 ? 'test hole' : 'test holes'}
          />
          <Count
            value={data.inStockUnitCount}
            label={data.inStockUnitCount === 1 ? 'unit in stock' : 'units in stock'}
          />
          <Count
            value={data.unitCount}
            label={data.unitCount === 1 ? 'unit received' : 'units received'}
          />
        </ul>
      </header>

      <TooltipProvider>
        <nav aria-label="Project sections" className="-mt-2 border-b pb-1">
          <Tabs value={tab} activationMode="manual">
            <TabsList variant="line" className="h-auto flex-wrap justify-start">
              <TabsTrigger value="overview" asChild>
                <Link to={tabHref('overview')}>Overview</Link>
              </TabsTrigger>
              <TabsTrigger value="units" asChild>
                <Link to={tabHref('units')}>
                  Storage units{' '}
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {data.unitCount.toLocaleString('en-CA')}
                  </span>
                </Link>
              </TabsTrigger>
              <TabsTrigger value="programs" asChild>
                <Link to={tabHref('programs')}>
                  Lab programs{' '}
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                    {programTotal.toLocaleString('en-CA')}
                  </span>
                </Link>
              </TabsTrigger>
              {showConcrete ? (
                <TabsTrigger value="concrete" asChild>
                  <Link to={concreteTabPath(data.id)}>Concrete</Link>
                </TabsTrigger>
              ) : null}
              {canReadTeam ? (
                <TabsTrigger value="team" asChild>
                  <Link to={tabHref('team')}>Team &amp; permissions</Link>
                </TabsTrigger>
              ) : lockedTeam ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <span tabIndex={0} data-slot="tab-locked" className="inline-flex">
                      <TabsTrigger value="team" disabled>
                        Team &amp; permissions
                        <Lock aria-hidden="true" className="size-3.5" />
                      </TabsTrigger>
                    </span>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Needs a personal account</TooltipContent>
                </Tooltip>
              ) : null}
            </TabsList>
          </Tabs>
        </nav>
      </TooltipProvider>
      {lockedTeam ? (
        <p className="-mt-3 flex items-center gap-2 text-[13px] text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5" />
          Team &amp; permissions needs a personal account. Everything else works on this LAB
          station.
        </p>
      ) : null}

      {context ? <Outlet context={context} /> : null}

      {editing ? (
        <EditProjectDialog
          project={data}
          onClose={() => setEditing(false)}
          onSaved={(saved) => {
            setResult({ ok: true, data: saved, key: projectId });
            setEditing(false);
            notifySuccess('Project saved.');
          }}
          onStale={(latest) => setResult({ ok: true, data: latest, key: projectId })}
        />
      ) : null}
    </div>
  );
}

function Count({ value, label }: { value: number; label: string }) {
  return (
    <li className="flex items-baseline gap-2">
      <span className="font-mono text-lg font-semibold tabular-nums">
        {value.toLocaleString('en-CA')}
      </span>
      <span className="text-muted-foreground">{label}</span>
    </li>
  );
}

/** The lead with their avatar, or "Waiting for a lead" with the nomination state. */
function LeadLine({ project }: { project: ProjectDetail }) {
  const lead = project.leadProjectEngineer;
  if (lead) {
    return (
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
        <PersonAvatar name={lead.displayName} userId={lead.id} />
        <span className="font-medium">{lead.displayName}</span>
        <span className="text-muted-foreground">Lead Project Engineer</span>
      </p>
    );
  }
  const nomination = project.leadNomination;
  return (
    <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <StageTag stage="due" label="Waiting for a lead" />
      <span className="text-muted-foreground">
        {nomination
          ? `${nomination.nominatedBy.name} nominated ${nomination.nominee.name} · waiting for an admin`
          : 'No nomination yet'}
      </span>
    </p>
  );
}

/** Pin to the sidebar's Pinned list (STRATA-11), as the server reports it. */
function PinButton({ project }: { project: ProjectDetail }) {
  const [pinned, setPinned] = useState<{ id: string; value: boolean | null } | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let cancelled = false;
    void fetchProjectPinned(project.id).then((value) => {
      if (!cancelled) setPinned({ id: project.id, value });
    });
    return () => {
      cancelled = true;
    };
  }, [project.id]);
  const state = pinned?.id === project.id ? pinned.value : null;
  // This account keeps no pins, or the list couldn't load: no button rather than a wrong one.
  if (state === null) return null;
  const label = state ? 'Unpin from sidebar' : 'Pin to sidebar';
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="outline"
            size="icon"
            aria-label={label}
            aria-pressed={state}
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void setProjectPinned(project.id, !state).then((outcome) => {
                setBusy(false);
                if (!outcome.ok) {
                  notifyError(outcome.message);
                  return;
                }
                setPinned({ id: project.id, value: outcome.pinned });
                notifySuccess(
                  outcome.pinned
                    ? `Pinned ${project.projectNumber}`
                    : `Unpinned ${project.projectNumber}`,
                );
              });
            }}
          >
            {state ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}
          </Button>
        </TooltipTrigger>
        <TooltipContent side="bottom">{label}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
