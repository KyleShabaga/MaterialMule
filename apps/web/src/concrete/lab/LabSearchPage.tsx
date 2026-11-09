import type { ConcreteSearch, InventoryPage, ProjectSummary } from '@materialmule/shared';
import { useEffect, useId, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useSearchParams } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '../../components/ui';
import {
  fetchConcreteSearch,
  LAB_SEARCH_PREVIEW,
  searchProjectList,
  searchStorageUnits,
  type LoadResult,
} from './api';
import { ConcreteSearchResults } from './ConcreteSearch';
import './concrete-lab.css';

/**
 * Top-bar Lab search (MM-V2-C31, placement and scope confirmed by Kyle): one box in the header
 * for every lab area. A text input with a search hint (not a search box), so it never competes
 * with a page's own Search field. Results open on /search.
 */
export function LabSearchBox({ inert }: { inert?: boolean }) {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  const [text, setText] = useState('');
  const id = useId();
  useEffect(() => {
    if (window.location.pathname === '/search') setText(params.get('q') ?? '');
  }, [params]);
  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (q) void navigate(`/search?q=${encodeURIComponent(q)}`);
  }
  return (
    <form
      className="lab-search"
      role="search"
      aria-label="Lab search"
      onSubmit={submit}
      inert={inert}
    >
      <label htmlFor={id} className="visually-hidden">
        Lab search
      </label>
      <input
        id={id}
        type="text"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        placeholder="Lab search"
        title="Storage units, projects and concrete records"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
      <button type="submit" className="lab-search-button">
        Go<span className="visually-hidden"> to Lab search results</span>
      </button>
    </form>
  );
}

function useLoad<T>(q: string, load: (q: string) => Promise<LoadResult<T>>) {
  const [answer, setAnswer] = useState<{ q: string; result: LoadResult<T> } | null>(null);
  useEffect(() => {
    if (!q) return;
    let current = true;
    void load(q).then((result) => current && setAnswer({ q, result }));
    return () => {
      current = false;
    };
  }, [q, load]);
  return answer?.q === q ? answer.result : null;
}

const loadConcrete = (q: string) => fetchConcreteSearch(q, 1, LAB_SEARCH_PREVIEW);

function Area<T>({
  title,
  result,
  more,
  children,
}: {
  title: string;
  result: LoadResult<T> | null;
  more: ReactNode;
  children: (data: T) => ReactNode;
}) {
  const headingId = useId();
  return (
    <section className="dash-panel lab-search-area" aria-labelledby={headingId} aria-busy={!result}>
      <div className="lab-search-area-head">
        <h2 id={headingId}>{title}</h2>
        {result?.ok ? more : null}
      </div>
      {result === null ? (
        <p className="field-hint">Searching…</p>
      ) : !result.ok ? (
        <ErrorState message={result.message} />
      ) : (
        children(result.data)
      )}
    </section>
  );
}

/**
 * Lab search results (MM-V2-C31): every lab area within the caller's access, each area through
 * its own existing search — storage units (Sample Storage), projects, and Concrete search.
 */
export function LabSearchPage() {
  const [params] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const units = useLoad<InventoryPage>(q, searchStorageUnits);
  const projects = useLoad<ProjectSummary[]>(q, searchProjectList);
  const concrete = useLoad<ConcreteSearch>(q, loadConcrete);
  const encoded = encodeURIComponent(q);

  return (
    <div className="concrete-lab lab-search-page">
      <PageHeader title="Lab search" />
      {!q ? (
        <p>
          Type in Lab search at the top of the page to search storage units, projects and concrete
          records.
        </p>
      ) : (
        <>
          <p className="field-hint">Results for “{q}” in each lab area you can see.</p>
          <Area
            title="Storage units"
            result={units}
            more={<Link to={`/sample-storage?search=${encoded}`}>Show all in Sample Storage</Link>}
          >
            {(page) =>
              page.items.length === 0 ? (
                <EmptyState>No storage units match.</EmptyState>
              ) : (
                <>
                  <p className="field-hint">
                    {page.total === 1 ? '1 storage unit' : `${page.total} storage units`} match.
                  </p>
                  <ul className="lab-search-list">
                    {page.items.map((unit) => (
                      <li key={unit.id}>
                        <Link to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}>
                          {unit.readableId}
                        </Link>{' '}
                        <span className="field-hint">
                          {unit.project.projectNumber} {unit.project.name}
                          {unit.holes.length > 0
                            ? ` · ${unit.holes.map((h) => h.testHoleName).join(', ')}`
                            : ''}
                        </span>
                      </li>
                    ))}
                  </ul>
                </>
              )
            }
          </Area>
          <Area
            title="Projects"
            result={projects}
            more={<Link to={`/projects?search=${encoded}`}>Show all projects</Link>}
          >
            {(list) =>
              list.length === 0 ? (
                <EmptyState>No projects match.</EmptyState>
              ) : (
                <ul className="lab-search-list">
                  {list.map((project) => (
                    <li key={project.id}>
                      <Link to={`/projects/${project.id}`}>{project.projectNumber}</Link>{' '}
                      <span className="field-hint">
                        {project.name} · {project.client}
                      </span>
                    </li>
                  ))}
                </ul>
              )
            }
          </Area>
          <Area
            title="Concrete"
            result={concrete}
            more={<Link to={`/concrete/search?q=${encoded}`}>Show all concrete results</Link>}
          >
            {(result) => <ConcreteSearchResults result={result} headingLevel={3} />}
          </Area>
        </>
      )}
    </div>
  );
}
