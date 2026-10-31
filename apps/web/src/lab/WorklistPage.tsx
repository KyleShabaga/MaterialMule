import { TEST_REQUEST_STATUS_LABEL, type TestCatalogue, type Worklist } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge, TableScroll } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { openAge } from './format';
import { fetchCatalogue, fetchWorklist } from './api';

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: Worklist };

/**
 * Lab Testing → Worklist (MM-T24, the default tab): open programs, Urgent first, then the oldest
 * submission (D52). Sorting is display only; it never changes a status.
 */
export function WorklistPage() {
  const [priority, setPriority] = useState('');
  const [open, setOpen] = useState(true);
  const [testTypeId, setTestTypeId] = useState('');
  const [projectId, setProjectId] = useState('');
  const [catalogue, setCatalogue] = useState<TestCatalogue | null>(null);
  const [attempt, setAttempt] = useState(0);
  const [page, setPage] = useState(1);
  // Every project with a matching program (BUG-006), kept while the next answer loads.
  const [projects, setProjects] = useState<Worklist['projects']>([]);
  // Each answer is kept with the request it answers; one for an earlier filter, page or retry
  // never fills the table (it reads as still loading until the current answer arrives).
  const filters = JSON.stringify([priority, open, testTypeId, projectId]);
  const requestKey = `${filters}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };
  // The last page count seen for these filters, so the pager can show where it is going while
  // the next page loads.
  const [shape, setShape] = useState<{ filters: string; total: number; pageSize: number } | null>(
    null,
  );

  useEffect(() => {
    fetchCatalogue().then(setCatalogue, () => setCatalogue(null));
  }, []);
  useEffect(() => {
    let current = true;
    fetchWorklist({ priority, open, testTypeId, projectId, page }).then(
      (list) => {
        if (!current) return;
        setProjects(list.projects);
        setShape({ filters, total: list.total, pageSize: list.pageSize });
        const lastPage = Math.max(1, Math.ceil(list.total / list.pageSize));
        // Programs can leave the worklist between pages: step back to the last page. An answer
        // kept for that page is from before the change, so it is dropped and fetched again.
        if (list.items.length === 0 && page > lastPage) {
          setAnswer({ key: '', load: { state: 'loading' } });
          setPage(lastPage);
        } else {
          setAnswer({ key: requestKey, load: { state: 'ready', list } });
        }
      },
      () => current && setAnswer({ key: requestKey, load: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [priority, open, testTypeId, projectId, page, filters, requestKey]);

  /** A filter change starts again at the first page. */
  function filter<T>(set: (value: T) => void) {
    return (value: T) => {
      set(value);
      setPage(1);
    };
  }
  const list = load.state === 'ready' ? load.list : null;
  // Paging: from the shown page once it is here; while a page loads, from the last answer for the
  // same filters, with both buttons off so a second click can't skip a page.
  const paging = list ?? (shape && shape.filters === filters ? shape : null);
  const totalPages = paging ? Math.max(1, Math.ceil(paging.total / paging.pageSize)) : 1;
  const busy = load.state === 'loading';
  const first = list ? (list.page - 1) * list.pageSize + 1 : 0;

  return (
    <section aria-labelledby="worklist-heading">
      <h2 id="worklist-heading">Worklist</h2>
      <div className="worklist-filters">
        <label>
          Priority{' '}
          <select value={priority} onChange={(event) => filter(setPriority)(event.target.value)}>
            <option value="">All</option>
            <option value="urgent">Urgent</option>
            <option value="normal">Normal</option>
          </select>
        </label>
        <label>
          Project{' '}
          <select value={projectId} onChange={(event) => filter(setProjectId)(event.target.value)}>
            <option value="">All</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.projectNumber}
              </option>
            ))}
          </select>
        </label>
        <label>
          Test{' '}
          <select
            value={testTypeId}
            onChange={(event) => filter(setTestTypeId)(event.target.value)}
          >
            <option value="">All</option>
            {(catalogue?.tests ?? []).map((test) => (
              <option key={test.id} value={test.id}>
                {test.code}
              </option>
            ))}
          </select>
        </label>
        <label className="checkbox-label">
          <input
            type="checkbox"
            checked={open}
            onChange={(event) => filter(setOpen)(event.target.checked)}
          />{' '}
          Only programs with open tests
        </label>
      </div>
      {load.state === 'loading' ? <p aria-busy="true">Loading the worklist…</p> : null}
      {load.state === 'error' ? (
        <ErrorState
          message="The worklist couldn’t be loaded."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {list && list.total > list.pageSize && list.items.length > 0 ? (
        <p className="field-hint" role="status">
          Showing {first}–{first + list.items.length - 1} of {list.total} programs
        </p>
      ) : null}
      {load.state === 'ready' ? (
        <TableScroll label="Lab worklist">
          <DataTable
            caption="Lab worklist"
            rows={load.list.items}
            rowKey={(item) => item.programId}
            empty="Nothing waiting. Submitted programs appear here."
            columns={[
              {
                header: 'Priority',
                cell: (item) =>
                  item.priority === 'urgent' ? (
                    <StatusBadge tone="danger">Urgent</StatusBadge>
                  ) : (
                    <StatusBadge>Normal</StatusBadge>
                  ),
              },
              {
                header: 'Program',
                cell: (item) => (
                  <Link className="mono" to={`/lab-testing/programs/${item.programId}`}>
                    {item.programNumber}
                  </Link>
                ),
              },
              {
                header: 'Project',
                cell: (item) => `${item.project.projectNumber} · ${item.project.name}`,
              },
              { header: 'Submitted', cell: (item) => shortDateTime(item.submittedAt) },
              {
                header: 'Tests',
                cell: (item) =>
                  (
                    Object.entries(item.counts) as [
                      keyof typeof TEST_REQUEST_STATUS_LABEL,
                      number,
                    ][]
                  )
                    .filter(([, n]) => n > 0)
                    .map(([status, n]) => `${n} ${TEST_REQUEST_STATUS_LABEL[status].toLowerCase()}`)
                    .join(', '),
              },
              {
                header: 'Oldest open',
                cell: (item) =>
                  item.oldestOpenSeconds === null ? '—' : openAge(item.oldestOpenSeconds),
              },
            ]}
          />
        </TableScroll>
      ) : null}
      {paging && paging.total > paging.pageSize && load.state !== 'error' ? (
        <nav className="pager" aria-label="Pages" aria-busy={busy}>
          <button type="button" disabled={busy || page <= 1} onClick={() => setPage(page - 1)}>
            Previous
          </button>
          <span>
            Page {page} of {totalPages}
          </span>
          <button
            type="button"
            disabled={busy || page >= totalPages}
            onClick={() => setPage(page + 1)}
          >
            Next
          </button>
        </nav>
      ) : null}
    </section>
  );
}
