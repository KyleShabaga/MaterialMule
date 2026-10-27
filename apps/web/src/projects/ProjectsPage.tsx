import {
  projectListSortDirection,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { DataTable, EmptyState, ErrorState, PageHeader } from '../components/ui';
import { useMe } from '../session/context';
import { fetchProjects, type LoadResult } from './api';
import './projects.css';
import {
  projectListSearchParams,
  readOnlyMine,
  readProjectListQuery,
  rememberOnlyMine,
} from './url-state';

/** Where the project detail page's "Back to Projects" link returns to. */
export interface ProjectLinkState {
  from?: string;
}

const SORT_OPTIONS = [
  { value: 'number:asc', label: 'Project number (A–Z)' },
  { value: 'number:desc', label: 'Project number (Z–A)' },
  { value: 'name:asc', label: 'Name (A–Z)' },
  { value: 'name:desc', label: 'Name (Z–A)' },
  { value: 'last_receipt:desc', label: 'Last receipt (newest first)' },
  { value: 'last_receipt:asc', label: 'Last receipt (oldest first)' },
] as const;

function countLabel(total: number): string {
  return `${total.toLocaleString('en-CA')} ${total === 1 ? 'project' : 'projects'}`;
}

/** Projects table (MM-T35): searched, filtered, sorted and paged on the server. */
export function ProjectsPage() {
  const me = useMe();
  const [params, setParams] = useSearchParams();
  const location = useLocation();
  const [rememberedMine, setRememberedMine] = useState(() => readOnlyMine(me.id));
  const query = useMemo(
    () => readProjectListQuery(params, rememberedMine),
    [params, rememberedMine],
  );
  const requestKey = projectListSearchParams(query).toString();

  const [result, setResult] = useState<(LoadResult<ProjectListPage> & { key: string }) | null>(
    null,
  );
  const [reloads, setReloads] = useState(0);
  useEffect(() => {
    let cancelled = false;
    void fetchProjects(new URLSearchParams(requestKey)).then((response) => {
      if (!cancelled) setResult({ ...response, key: requestKey });
    });
    return () => {
      cancelled = true;
    };
  }, [requestKey, reloads]);

  /** Applies changes; anything other than the page returns to page 1. */
  function update(changes: Partial<ProjectListQuery>) {
    setParams(projectListSearchParams({ ...query, page: 1, ...changes }));
  }

  const loading = !result || result.key !== requestKey;
  const page = result?.ok ? result.data : null;
  const totalPages = page ? Math.max(1, Math.ceil(page.total / page.pageSize)) : 1;
  const linkState: ProjectLinkState = { from: location.search };
  const mineId = useId();
  const sortId = useId();

  return (
    <>
      <PageHeader title="Projects" />

      <SearchForm
        key={query.search ?? ''}
        initial={query.search ?? ''}
        onSearch={(search) => update({ search: search || undefined })}
      />

      <div className="filters" role="group" aria-label="Filters">
        {me.accountType !== 'shared_lab' ? (
          <label className="checkbox only-mine" htmlFor={mineId}>
            <input
              id={mineId}
              type="checkbox"
              checked={query.mine}
              onChange={(event) => {
                const mine = event.target.checked;
                rememberOnlyMine(me.id, mine);
                setRememberedMine(mine);
                update({ mine });
              }}
            />
            Only mine
          </label>
        ) : null}
        <div className="form-field">
          <label htmlFor={sortId}>Sort by</label>
          <select
            id={sortId}
            value={`${query.sort}:${projectListSortDirection(query)}`}
            onChange={(event) => {
              const [sort, dir] = event.target.value.split(':') as [
                ProjectListQuery['sort'],
                ProjectListQuery['dir'],
              ];
              update({ sort, dir });
            }}
          >
            {SORT_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
      </div>

      <p role="status" aria-live="polite" aria-busy={loading}>
        {page ? countLabel(page.total) : 'Loading…'}
      </p>

      {result && !result.ok ? (
        <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
      ) : null}

      {page ? (
        page.total === 0 ? (
          <EmptyState>
            {query.search || query.mine
              ? 'No projects match this search.'
              : 'No projects yet. Projects are added while receiving samples.'}
          </EmptyState>
        ) : (
          <div className="projects-table">
            <DataTable
              rows={page.items}
              rowKey={(project) => project.id}
              caption="Projects"
              empty="No projects."
              columns={[
                {
                  header: 'Project',
                  cell: (project) => (
                    <Link
                      to={`/projects/${project.id}`}
                      state={linkState}
                      aria-label={`Open project ${project.projectNumber}`}
                    >
                      {project.projectNumber}
                    </Link>
                  ),
                },
                { header: 'Name', cell: (project) => project.name },
                { header: 'Client', cell: (project) => project.client },
                { header: 'PM/PE', cell: (project) => <PersonInitials project={project} /> },
                { header: 'Test holes', cell: (project) => project.testHoleCount },
                { header: 'In stock', cell: (project) => project.inStockUnitCount },
                { header: 'Last receipt', cell: (project) => project.lastReceiptDate ?? '—' },
              ]}
            />
          </div>
        )
      ) : null}

      {page && page.total > page.pageSize ? (
        <nav className="pager" aria-label="Pages">
          <button
            type="button"
            disabled={query.page <= 1}
            onClick={() => update({ page: query.page - 1 })}
          >
            Previous
          </button>
          <span>
            Page {query.page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={query.page >= totalPages}
            onClick={() => update({ page: query.page + 1 })}
          >
            Next
          </button>
        </nav>
      ) : null}
    </>
  );
}

function PersonInitials({ project }: { project: ProjectListItem }) {
  return (
    <abbr title={project.pmPe.displayName}>
      {project.pmPe.initials ?? project.pmPe.displayName}
    </abbr>
  );
}

function SearchForm({ initial, onSearch }: { initial: string; onSearch: (value: string) => void }) {
  const id = useId();
  const [text, setText] = useState(initial);
  function submit(event: FormEvent) {
    event.preventDefault();
    onSearch(text.trim());
  }
  return (
    <form role="search" aria-label="Search projects" className="projects-search" onSubmit={submit}>
      <label htmlFor={id}>Search</label>
      <div className="inline-input">
        <input
          id={id}
          type="search"
          value={text}
          placeholder="Project number, name or client"
          onChange={(event) => setText(event.target.value)}
        />
        <button type="submit">Search</button>
      </div>
    </form>
  );
}
