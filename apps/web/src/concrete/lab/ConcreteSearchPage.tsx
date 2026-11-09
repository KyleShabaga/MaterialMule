import type { ConcreteSearch } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router';
import { ErrorState, PageHeader } from '../../components/ui';
import { fetchConcreteSearch, type LoadResult } from './api';
import { ConcreteSearchForm, ConcreteSearchResults } from './ConcreteSearch';
import { setLookupPath } from './format';
import './concrete-lab.css';

function useConcreteSearch(q: string, page: number) {
  const [attempt, setAttempt] = useState(0);
  const key = `${q}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: LoadResult<ConcreteSearch> } | null>(
    null,
  );
  useEffect(() => {
    if (!q) return;
    let current = true;
    void fetchConcreteSearch(q, page).then((load) => current && setAnswer({ key, load }));
    return () => {
      current = false;
    };
  }, [q, page, key]);
  return {
    load: answer?.key === key ? answer.load : null,
    retry: () => setAttempt((n) => n + 1),
  };
}

function Pager({ result, onPage }: { result: ConcreteSearch; onPage: (page: number) => void }) {
  const pages = Math.max(1, Math.ceil(result.total / result.pageSize));
  if (pages <= 1) return null;
  return (
    <nav className="concrete-pager" aria-label="Pages">
      <button type="button" disabled={result.page <= 1} onClick={() => onPage(result.page - 1)}>
        Previous
      </button>
      <span>
        Page {result.page} of {pages}
      </span>
      <button type="button" disabled={result.page >= pages} onClick={() => onPage(result.page + 1)}>
        Next
      </button>
    </nav>
  );
}

/** Concrete search (MM-V2-C31): concrete content only, every match with its project. */
export function ConcreteSearchPage() {
  const [params, setParams] = useSearchParams();
  const q = (params.get('q') ?? '').trim();
  const page = Math.max(1, Number(params.get('page')) || 1);
  const { load, retry } = useConcreteSearch(q, page);
  return (
    <div className="concrete-lab">
      <PageHeader title="Concrete search" />
      <ConcreteSearchForm key={q} initial={q} />
      <section aria-label="Results" aria-busy={Boolean(q) && load === null}>
        {!q ? null : load === null ? (
          <p className="field-hint">Searching…</p>
        ) : !load.ok ? (
          <ErrorState message={load.message} onRetry={retry} />
        ) : (
          <>
            <ConcreteSearchResults result={load.data} />
            <Pager
              result={load.data}
              onPage={(next) => setParams({ q, ...(next > 1 ? { page: String(next) } : {}) })}
            />
          </>
        )}
      </section>
    </div>
  );
}

/**
 * Concrete Lab → Specimen lookup (MM-V2-C31): type or scan the marker-written set or specimen ID.
 * One matching set opens straight away; a number used in more than one project lists every
 * match with its project, and the user chooses.
 */
export function SpecimenLookupPage() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const q = (params.get('q') ?? '').trim();
  const { load, retry } = useConcreteSearch(q, 1);

  const only = (() => {
    if (!load?.ok || load.data.total !== 1) return null;
    const matched = load.data.items[0]!.sets.filter((s) => s.matched);
    return matched.length === 1 && load.data.items[0]!.matches[0] === 'set_id' ? matched[0]! : null;
  })();
  useEffect(() => {
    if (only && load?.ok)
      void navigate(setLookupPath(only.setId, load.data.letter), { replace: true });
  }, [only, load, navigate]);

  return (
    <div className="concrete-lab">
      <PageHeader title="Specimen lookup" />
      <ConcreteSearchForm
        key={q}
        initial={q}
        to="/concrete/specimens"
        label="Specimen or set ID"
        button="Look up"
      />
      <section aria-label="Matches" aria-busy={Boolean(q) && load === null}>
        {!q ? (
          <p className="field-hint">
            Set numbers repeat between projects, so the project is always shown with each match.
          </p>
        ) : load === null || only ? (
          <p className="field-hint">Looking up…</p>
        ) : !load.ok ? (
          <ErrorState message={load.message} onRetry={retry} />
        ) : (
          <ConcreteSearchResults result={load.data} />
        )}
      </section>
    </div>
  );
}
