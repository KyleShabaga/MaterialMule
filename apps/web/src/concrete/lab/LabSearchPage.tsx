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
 * for every lab area, labelled "Search" in the Field Ledger top bar. A text input with a search
 * hint (not a search box), so it never competes with a page's own Search field. Results open on
 * /search.
 */
export function LabSearchBox({ inert }: { inert?: boolean }) {
  const navigate = useNavigate();
  const [text, setText] = useState('');
  function submit(event: FormEvent) {
    event.preventDefault();
    const q = text.trim();
    if (q) void navigate(`/search?q=${encodeURIComponent(q)}`);
  }
  // Field Ledger top bar: one search field with the magnifier inside; Enter submits.
  return (
    <form className="lab-search" role="search" aria-label="Search" onSubmit={submit} inert={inert}>
      <svg
        className="lab-search-icon"
        aria-hidden="true"
        focusable="false"
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.2"
        strokeLinecap="round"
      >
        <circle cx="11" cy="11" r="6.5" />
        <path d="M16 16l4.5 4.5" />
      </svg>
      <input
        type="text"
        aria-label="Search"
        inputMode="search"
        enterKeyHint="search"
        autoComplete="off"
        spellCheck={false}
        maxLength={100}
        placeholder="Search units, samples, projects, programs…"
        title="Storage units, projects and concrete records"
        value={text}
        onChange={(event) => setText(event.target.value)}
      />
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
    <section className="concrete-lab-section" aria-labelledby={headingId} aria-busy={!result}>
      <div className="section-head lab-search-area-head">
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
                  <ul className="concrete-row-list">
                    {page.items.map((unit) => (
                      <li key={unit.id} className="concrete-row">
                        <span className="concrete-row-id">
                          <Link to={`/sample-storage/${encodeURIComponent(unit.readableId)}`}>
                            {unit.readableId}
                          </Link>
                        </span>{' '}
                        <span className="concrete-row-main concrete-muted">
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
                <ul className="concrete-row-list">
                  {list.map((project) => (
                    <li key={project.id} className="concrete-row">
                      <span className="concrete-row-id">
                        <Link to={`/projects/${project.id}`}>{project.projectNumber}</Link>
                      </span>{' '}
                      <span className="concrete-row-main concrete-muted">
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
