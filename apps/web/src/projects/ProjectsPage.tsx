import {
  PROJECT_INVOLVEMENT_LABEL,
  projectListSortDirection,
  type ProjectListItem,
  type ProjectListPage,
  type ProjectListQuery,
} from '@materialmule/shared';
import { useEffect, useId, useMemo, useState, type FormEvent } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader, Segmented, StatusBadge } from '../components/app-ui';
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
  const waitingId = useId();
  const sortId = useId();

  /** "Only mine" is remembered per person (MM-T35). */
  function setMine(mine: boolean) {
    rememberOnlyMine(me.id, mine);
    setRememberedMine(mine);
    update({ mine });
  }

  const showMine = me.accountType !== 'shared_lab';
  const filtered = Boolean(query.search || query.mine || query.waitingForLead);

  return (
    <>
      <PageHeader title="Projects" />

      <div className="project-filters">
        {/* Field Ledger: Mine / All. Projects have no closed state, so there is no Closed filter. */}
        {showMine ? (
          <Segmented
            label="Show"
            value={query.mine ? 'mine' : 'all'}
            options={[
              { value: 'mine', label: 'Mine' },
              { value: 'all', label: 'All projects' },
            ]}
            onChange={(value) => setMine(value === 'mine')}
          />
        ) : null}
        <p className="inventory-count" role="status" aria-live="polite" aria-busy={loading}>
          {page ? countLabel(page.total) : 'Loading…'}
        </p>
      </div>

      <div className="tool-card project-tools" role="group" aria-label="Filters">
        <SearchForm
          key={query.search ?? ''}
          initial={query.search ?? ''}
          onSearch={(search) => update({ search: search || undefined })}
        />
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

      {query.search || query.waitingForLead ? (
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
        </ul>
      ) : null}

      {result && !result.ok ? (
        <ErrorState message={result.message} onRetry={() => setReloads((count) => count + 1)} />
      ) : null}

      {page ? (
        page.total === 0 ? (
          <EmptyState
            title={filtered ? 'No projects match.' : 'No projects yet.'}
            action={
              filtered ? (
                <button
                  type="button"
                  onClick={() => {
                    rememberOnlyMine(me.id, false);
                    setRememberedMine(false);
                    update({ mine: false, search: undefined, waitingForLead: false });
                  }}
                >
                  Clear filters
                </button>
              ) : undefined
            }
          >
            {filtered
              ? 'No projects match this search.'
              : 'Projects are added while receiving samples.'}
          </EmptyState>
        ) : (
          <>
            <ul className="project-cards" aria-label="Projects">
              {page.items.map((project) => (
                <ProjectCard key={project.id} project={project} linkState={linkState} />
              ))}
            </ul>
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
          </>
        )
      ) : null}
    </>
  );
}

/** What the card says is next, from what the list already returns. */
function nextLine(project: ProjectListItem): string {
  if (!project.leadProjectEngineer)
    return 'Waiting for an admin to appoint a Lead Project Engineer.';
  if (project.lastReceiptDate) return `Last receipt ${project.lastReceiptDate}.`;
  return 'Nothing received yet.';
}

/**
 * One project card (canvas Projects): number and state in the head, name and lead, three counts,
 * one line on what is next. The number is the link; the whole card is its click target.
 */
function ProjectCard({
  project,
  linkState,
}: {
  project: ProjectListItem;
  linkState: ProjectLinkState;
}) {
  const state = !project.leadProjectEngineer ? (
    <StatusBadge tone="waiting">Waiting for a lead</StatusBadge>
  ) : project.inStockUnitCount > 0 ? (
    <StatusBadge tone="storage">In stock</StatusBadge>
  ) : (
    <StatusBadge tone="closed">Nothing in stock</StatusBadge>
  );
  return (
    <li className="project-card">
      <div className="project-card-head">
        <Link
          className="project-link"
          to={`/projects/${project.id}`}
          state={linkState}
          aria-label={`Open project ${project.projectNumber}`}
        >
          {project.projectNumber}
        </Link>
        {state}
      </div>
      <div className="project-card-body">
        <div>
          <p className="project-card-name">{project.name}</p>
          <p className="project-card-meta">
            {project.client}
            {' · Lead '}
            <PersonInitials project={project} />
          </p>
          {/* D12 (MM-AO03): why it is one of "my" projects. Relevance only. */}
          {project.involvement.length > 0 ? (
            <p className="project-card-meta project-involvement">
              You: {project.involvement.map((i) => PROJECT_INVOLVEMENT_LABEL[i]).join(', ')}
            </p>
          ) : null}
        </div>
        <dl className="project-card-counts">
          <div>
            <dt>In stock</dt>
            <dd className="number">{project.inStockUnitCount}</dd>
          </div>
          <div>
            <dt>Test holes</dt>
            <dd className="number">{project.testHoleCount}</dd>
          </div>
          <div>
            <dt>Last receipt</dt>
            <dd className="number project-card-date">{project.lastReceiptDate ?? '—'}</dd>
          </div>
        </dl>
        <p className="project-card-next">{nextLine(project)}</p>
      </div>
    </li>
  );
}
function PersonInitials({ project }: { project: ProjectListItem }) {
  const lead = project.leadProjectEngineer;
  // D02 (MM-AO04): a project can wait for a lead; receiving carries on meanwhile.
  if (!lead) return <>none yet</>;
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
