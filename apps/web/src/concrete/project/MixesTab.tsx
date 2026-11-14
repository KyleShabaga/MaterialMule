import type { ConcreteMixSummary, ProjectDetail, ProjectSummary } from '@materialmule/shared';
import { Copy, Cylinder, Lock, Plus } from 'lucide-react';
import { useEffect, useId, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate } from 'react-router';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from '@/components/ui/empty';
import { Field, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemActions,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemTitle,
} from '@/components/ui/item';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { searchProjects } from '../../api/projects';
import {
  DataTable,
  DENSITY_VIEW_OPTIONS,
  useTableDensity,
  type DataTableColumn,
} from '../../components/strata/data-table';
import { StageTag } from '../../components/strata/stage-tag';
import { TableToolbar } from '../../components/strata/table-toolbar';
import { useTableQuery, type TableQuery } from '../../components/strata/table-query';
import { useDebounced } from '../../projects/project-format';
import { LoadErrorAlert } from '../../projects/project-ui';
import { concreteProblem, copyMix, createMix, fetchMixes } from './api';
import { MIX_STAGE } from './concrete-format';
import { MixForm } from './MixForm';
import { strengthText } from './mix-format';
import { mixPath } from './paths';
import { ConcreteNote, ConcreteSection } from './ui';
import { useLoad } from './useLoad';

// MM-V2-C30, STRATA-98 Mixes sub-tab (canvas R8ProjectMixes, R8ProjectMixesEmpty): each mix with
// the approved revision in effect and any draft. Add mix and Copy from another project are the
// project's Lead's only (CD-52); the controls follow the server's `canManage`, and the server
// refuses everyone else. A copy always starts Unapproved (AC2).

const STATUS_FILTERS = [
  { id: 'approved', label: 'Approved' },
  { id: 'revision_pending', label: 'Revision pending' },
  { id: 'unapproved', label: 'Unapproved' },
] as const;

function leadOnly(project: ProjectDetail): string {
  const lead = project.leadProjectEngineer?.displayName;
  return lead
    ? `Only the project’s lead, ${lead}, adds, changes and approves mixes. A field report keeps the mix values it was made with.`
    : 'Only the project’s lead adds, changes and approves mixes. A field report keeps the mix values it was made with.';
}

export function MixesTab({ project }: { project: ProjectDetail }) {
  const navigate = useNavigate();
  const headingId = useId();
  const [mode, setMode] = useState<'list' | 'add' | 'copy'>('list');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useTableQuery();
  const [density, setDensity] = useTableDensity('concrete-project-mixes');
  const search = useDebounced(query.search).trim();
  const status = query.filters[query.filters.length - 1] ?? '';
  const { load, reload } = useLoad(`mixes|${project.id}|${search}|${status}`, () =>
    fetchMixes(project.id, { search, status }),
  );

  const columns = useMemo<DataTableColumn<ConcreteMixSummary>[]>(
    () => [
      {
        id: 'mix',
        header: 'Mix',
        priority: 'identity',
        width: '16rem',
        cell: (mix) => (
          <span className="flex min-w-0 flex-col">
            <Button
              variant="link"
              asChild
              className="h-auto justify-start p-0 font-mono focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring focus-visible:outline-solid [&:hover]:underline"
            >
              <Link to={mixPath(project.id, mix.id)} aria-label={`Open mix ${mix.mixNumber}`}>
                {mix.mixNumber}
              </Link>
            </Button>
            <span className="truncate text-xs text-muted-foreground">
              {mix.supplierName}
              {mix.copiedFrom ? ` · copied from ${mix.copiedFrom.projectNumber}` : ''}
            </span>
          </span>
        ),
      },
      {
        id: 'strength',
        header: 'Strength',
        priority: 'attribute',
        mono: true,
        hideOrder: 2,
        cell: (mix) => {
          const spec = (mix.effectiveRevision ?? mix.draftRevision)?.spec;
          return spec ? strengthText(spec) : '—';
        },
      },
      {
        id: 'effective',
        header: 'In effect',
        priority: 'attribute',
        hideOrder: 3,
        cell: (mix) =>
          mix.effectiveRevision ? (
            `Revision ${mix.effectiveRevision.revisionNumber}`
          ) : (
            <span className="text-muted-foreground">None</span>
          ),
      },
      {
        id: 'draft',
        header: 'Draft',
        priority: 'identity',
        cell: (mix) => (mix.draftRevision ? `Revision ${mix.draftRevision.revisionNumber}` : '—'),
      },
      {
        id: 'status',
        header: 'Status',
        priority: 'state',
        width: '10rem',
        cell: (mix) => (
          <StageTag stage={MIX_STAGE[mix.status].stage} label={MIX_STAGE[mix.status].label} />
        ),
      },
      {
        id: 'updated',
        header: 'Updated',
        priority: 'attribute',
        mono: true,
        width: '11ch',
        hideOrder: 1,
        cell: (mix) => mix.updatedAt.slice(0, 10),
      },
    ],
    [project.id],
  );

  if (mode === 'add') {
    return (
      <ConcreteSection id={headingId} title="Add mix">
        <MixForm
          initial={null}
          title="Add mix"
          submitLabel="Add mix"
          busy={busy}
          error={error}
          onCancel={() => {
            setError(null);
            setMode('list');
          }}
          onSubmit={(input) => {
            setBusy(true);
            setError(null);
            createMix(project.id, { idempotencyKey: crypto.randomUUID(), spec: input })
              .then((created) => navigate(mixPath(project.id, created.id)))
              .catch((caught: unknown) => setError(concreteProblem(caught)))
              .finally(() => setBusy(false));
          }}
        />
      </ConcreteSection>
    );
  }

  if (mode === 'copy') {
    return (
      <CopyMix
        project={project}
        onCancel={() => setMode('list')}
        onCopied={(id) => navigate(mixPath(project.id, id))}
      />
    );
  }

  const canManage = load.state === 'ready' && load.data.canManage;
  const toolbarQuery: TableQuery = { ...query, view: density };
  const onQueryChange = (patch: Partial<TableQuery>) => {
    const { view, ...rest } = patch;
    if (view === 'comfortable' || view === 'compact') setDensity(view);
    // One status at a time: the server filters on one.
    if (rest.filters) rest.filters = rest.filters.slice(-1);
    if (Object.keys(rest).length > 0) setQuery(rest);
  };
  const filtered = Boolean(search || status);

  let body: ReactNode;
  if (load.state === 'error') {
    body = (
      <LoadErrorAlert
        title={`Couldn’t load the concrete records for ${project.projectNumber}`}
        message={concreteProblem(load.error)}
        onRetry={reload}
      />
    );
  } else if (load.state === 'ready' && load.data.items.length === 0) {
    body = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <Cylinder aria-hidden="true" />
          </EmptyMedia>
          <EmptyTitle>{filtered ? 'No mixes match these filters.' : 'No mixes yet.'}</EmptyTitle>
          {filtered ? null : (
            <EmptyDescription>
              Add the mixes this project uses so field reports can pick them. Only the project’s
              lead adds mixes.
            </EmptyDescription>
          )}
        </EmptyHeader>
        {!filtered && canManage ? (
          <EmptyContent>
            <Button onClick={() => setMode('add')}>
              <Plus aria-hidden="true" />
              Add mix
            </Button>
          </EmptyContent>
        ) : null}
      </Empty>
    );
  } else {
    body = (
      <DataTable
        columns={columns}
        data={load.state === 'ready' ? load.data.items : []}
        getRowId={(mix) => mix.id}
        rowLabel={(mix) => `Mix ${mix.mixNumber}`}
        density={density}
        stage={(mix) => MIX_STAGE[mix.status].stage}
        onOpenRow={(mix) => navigate(mixPath(project.id, mix.id))}
        caption={`Mixes, ${project.projectNumber}`}
        loading={load.state === 'loading'}
      />
    );
  }

  const hasRows = load.state === 'ready' && (load.data.items.length > 0 || filtered);

  return (
    <ConcreteSection
      id={headingId}
      title="Mixes"
      tools={
        hasRows || load.state !== 'ready' ? (
          <>
            {canManage ? (
              <TooltipProvider>
                <Tooltip>
                  <TooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      aria-label="Copy from another project"
                      className="text-muted-foreground hover:text-accent-foreground"
                      onClick={() => setMode('copy')}
                    >
                      <Copy aria-hidden="true" />
                    </Button>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">Copy a mix from another project</TooltipContent>
                </Tooltip>
              </TooltipProvider>
            ) : null}
            <TableToolbar
              label="Mixes tools"
              query={toolbarQuery}
              onQueryChange={onQueryChange}
              pageAction={
                canManage
                  ? { label: 'Add mix', icon: Plus, onClick: () => setMode('add') }
                  : undefined
              }
              filters={STATUS_FILTERS}
              views={DENSITY_VIEW_OPTIONS}
              searchPlaceholder="Search mixes…"
            />
          </>
        ) : null
      }
    >
      <div aria-busy={load.state === 'loading'} className="min-w-0">
        {body}
      </div>
      <ConcreteNote icon={Lock}>{leadOnly(project)}</ConcreteNote>
    </ConcreteSection>
  );
}

/** Pick a project, then one of its mixes; the copy lands here as Unapproved. */
function CopyMix({
  project,
  onCancel,
  onCopied,
}: {
  project: ProjectDetail;
  onCancel: () => void;
  onCopied: (mixId: string) => void;
}) {
  const id = useId();
  const [text, setText] = useState('');
  const [found, setFound] = useState<ProjectSummary[] | null>(null);
  const [source, setSource] = useState<ProjectSummary | null>(null);
  const [mixes, setMixes] = useState<ConcreteMixSummary[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!source) return;
    let cancelled = false;
    fetchMixes(source.id).then(
      (list) => {
        if (!cancelled) setMixes(list.items);
      },
      (caught: unknown) => {
        if (!cancelled) setError(concreteProblem(caught));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [source]);

  function find(event: FormEvent) {
    event.preventDefault();
    if (!text.trim()) return;
    setError(null);
    searchProjects(text.trim()).then(
      (list) => setFound(list.filter((p) => p.id !== project.id)),
      () => setError('Couldn’t search projects. Try again.'),
    );
  }

  function copy(mix: ConcreteMixSummary) {
    setBusy(true);
    setError(null);
    copyMix(project.id, { idempotencyKey: crypto.randomUUID(), sourceMixId: mix.id })
      .then((copied) => onCopied(copied.id))
      .catch((caught: unknown) => setError(concreteProblem(caught)))
      .finally(() => setBusy(false));
  }

  return (
    <ConcreteSection id={id} title="Copy a mix from another project">
      <p className="text-sm text-muted-foreground">
        The copy starts Unapproved in {project.projectNumber}. The source mix and its approval don’t
        change.
      </p>
      {!source ? (
        <>
          <form role="search" className="flex max-w-xl items-end gap-2" onSubmit={find}>
            <Field className="flex-1">
              <FieldLabel htmlFor={`${id}-q`}>Find the source project</FieldLabel>
              <Input
                id={`${id}-q`}
                type="search"
                value={text}
                placeholder="Project number or name"
                onChange={(e) => setText(e.target.value)}
              />
            </Field>
            <Button type="submit" variant="outline">
              Search
            </Button>
          </form>
          {found ? (
            found.length === 0 ? (
              <p className="text-sm">No other projects match.</p>
            ) : (
              <ul aria-label="Projects" className="flex max-w-xl flex-col gap-2">
                {found.map((p) => (
                  <li key={p.id}>
                    <Button
                      variant="outline"
                      className="w-full justify-start"
                      onClick={() => setSource(p)}
                    >
                      <span className="font-mono">{p.projectNumber}</span> · {p.name}
                    </Button>
                  </li>
                ))}
              </ul>
            )
          ) : null}
        </>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-sm">
            <span>
              Mixes in <strong className="font-mono">{source.projectNumber}</strong>
            </span>
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0"
              onClick={() => {
                setSource(null);
                setMixes(null);
              }}
            >
              Choose another project
            </Button>
          </div>
          {mixes === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              Loading…
            </p>
          ) : null}
          {mixes && mixes.length === 0 ? (
            <p className="text-sm">That project has no mixes.</p>
          ) : null}
          {mixes && mixes.length > 0 ? (
            <ItemGroup aria-label="Source mixes" className="max-w-xl gap-2">
              {mixes.map((mix) => (
                <Item key={mix.id} variant="outline" size="sm">
                  <ItemContent>
                    <ItemTitle>
                      <span className="font-mono">{mix.mixNumber}</span>
                    </ItemTitle>
                    <ItemDescription>{mix.supplierName}</ItemDescription>
                  </ItemContent>
                  <ItemActions>
                    <StageTag
                      stage={MIX_STAGE[mix.status].stage}
                      label={MIX_STAGE[mix.status].label}
                    />
                    <Button size="sm" variant="outline" disabled={busy} onClick={() => copy(mix)}>
                      Copy {mix.mixNumber}
                    </Button>
                  </ItemActions>
                </Item>
              ))}
            </ItemGroup>
          ) : null}
        </>
      )}
      {error ? (
        <Alert variant="destructive" className="max-w-xl">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <div>
        <Button variant="outline" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </ConcreteSection>
  );
}
