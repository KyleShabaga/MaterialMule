import {
  PROJECT_INVOLVEMENT_LABEL,
  projectListSortDirection,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { DataTable, EmptyState, ErrorState, PageHeader } from '../components/ui';
import '../inventory/inventory.css';
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
  const waitingId = useId();
  const sortId = useId();

  /** "Only mine" is remembered per person (MM-T35). */
  function setMine(mine: boolean) {
    rememberOnlyMine(me.id, mine);
    setRememberedMine(mine);
    update({ mine });
  }

  return (
    <>
      <PageHeader title="Projects" />

      <div className="tool-card project-tools" role="group" aria-label="Filters">
        <SearchForm
          key={query.search ?? ''}
          initial={query.search ?? ''}
          onSearch={(search) => update({ search: search || undefined })}
        />
        {me.accountType !== 'shared_lab' ? (
          <label className="checkbox only-mine" htmlFor={mineId}>
            <input
              id={mineId}
              type="checkbox"
              checked={query.mine}
              onChange={(event) => {
                setMine(event.target.checked);
              }}
            />
            Only mine
          </label>
        ) : null}
        <label className="checkbox only-mine" htmlFor={waitingId}>
          <input
            id={waitingId}
            type="checkbox"
            checked={query.waitingForLead}
            onChange={(event) => update({ waitingForLead: event.target.checked })}
          />
          Waiting for a lead
        </label>
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

      <div className="inventory-summary">
        {query.search || query.mine || query.waitingForLead ? (
          <ul className="chips" aria-label="Active filters">
            {query.search ? (
              <li>
                Search: {query.search}
                <button
                  type="button"
                  aria-label={`Remove filter Search: ${query.search}`}
                  onClick={() => update({ search: undefined })}
                >
                  ×
                </button>
              </li>
            ) : null}
            {query.waitingForLead ? (
              <li>
                Waiting for a lead
                <button
                  type="button"
                  aria-label="Remove filter Waiting for a lead"
                  onClick={() => update({ waitingForLead: false })}
                >
                  ×
                </button>
              </li>
            ) : null}
            {query.mine ? (
              <li>
                Only mine: {me.initials ?? me.displayName}
                <button
                  type="button"
                  aria-label="Remove filter Only mine"
                  onClick={() => setMine(false)}
                >
                  ×
                </button>
              </li>
            ) : null}
          </ul>
        ) : null}
        <p className="inventory-count" role="status" aria-live="polite" aria-busy={loading}>
          {page ? countLabel(page.total) : 'Loading…'}
        </p>
      </div>

      {result && !result.ok ? (
        <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
      ) : null}

      {page ? (
        page.total === 0 ? (
          <EmptyState>
            {query.search || query.mine || query.waitingForLead
              ? 'No projects match this search.'
              : 'No projects yet. Projects are added while receiving samples.'}
          </EmptyState>
        ) : (
          <div className="table-card projects-table table-stack">
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
                      className="project-link"
                      to={`/projects/${project.id}`}
                      state={linkState}
                      aria-label={`Open project ${project.projectNumber}`}
                    >
                      {project.projectNumber}
                    </Link>
                  ),
                },
                {
                  header: 'Name',
                  cell: (project) => (
                    <>
                      <strong>{project.name}</strong>
                      {/* D12 (MM-AO03): why it is one of "my" projects. Relevance only. */}
                      {project.involvement.length > 0 ? (
                        <span className="field-hint project-involvement">
                          {' '}
                          You:{' '}
                          {project.involvement.map((i) => PROJECT_INVOLVEMENT_LABEL[i]).join(', ')}
                        </span>
                      ) : null}
                    </>
                  ),
                },
                { header: 'Client', cell: (project) => project.client },
                {
                  header: 'Lead Project Engineer',
                  cell: (project) => <PersonInitials project={project} />,
                },
                {
                  header: 'Test holes',
                  cell: (project) => <span className="number">{project.testHoleCount}</span>,
                },
                {
                  header: 'In stock',
                  cell: (project) => (
                    <strong className="number">
                      {project.inStockUnitCount} {project.inStockUnitCount === 1 ? 'unit' : 'units'}
                    </strong>
                  ),
                },
                {
                  header: 'Last receipt',
                  cell: (project) => (
                    <span className="number nowrap">{project.lastReceiptDate ?? '—'}</span>
                  ),
                },
              ]}
            />
            {page.total > page.pageSize ? (
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
          </div>
        )
      ) : null}
    </>
  );
}

function PersonInitials({ project }: { project: ProjectListItem }) {
  const lead = project.leadProjectEngineer;
  // D02 (MM-AO04): a project can wait for a lead; receiving carries on meanwhile.
  if (!lead) return <span className="badge badge-warning">Waiting for a lead</span>;
  return (
    <>
      {lead.displayName}
      {lead.initials ? ` (${lead.initials})` : ''}
    </>
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
      <label htmlFor={id}>Search projects</label>
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
