import {
  formatAttribution,
  LAB_PROGRAM_PAGE_SIZE,
  programLabel,
  type LabProgramList,
  type LabProgramSummary,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { fetchPrograms } from './api';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'closed', label: 'Closed' },
];

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: LabProgramList };

function statusBadge(status: LabProgramSummary['status']) {
  if (status === 'draft') return <StatusBadge tone="warning">Draft</StatusBadge>;
  // Same wording and tone as the program page header (MM-T26).
  if (status === 'closed') return <StatusBadge tone="neutral">Closed</StatusBadge>;
  return <StatusBadge tone="info">Open</StatusBadge>;
}

/** Lab Testing → Programs: this account's drafts first, then submitted programs (MM-T23). */
export function ProgramsPage() {
  const [status, setStatus] = useState('');
  const [page, setPage] = useState(1);
  const [attempt, setAttempt] = useState(0);
  // Each answer is kept with the request it answers; one for an earlier filter, page or retry
  // never fills the table (it reads as still loading until the current answer arrives).
  const requestKey = `${status}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };

  useEffect(() => {
    let current = true;
    fetchPrograms({ status: status || undefined, page }).then(
      (list) => {
        if (!current) return;
        const lastPage = Math.max(1, Math.ceil(list.total / LAB_PROGRAM_PAGE_SIZE));
        // Programs can disappear between pages (a draft deleted elsewhere): step back.
        if (list.items.length === 0 && page > lastPage) setPage(lastPage);
        else setAnswer({ key: requestKey, load: { state: 'ready', list } });
      },
      () => current && setAnswer({ key: requestKey, load: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [status, page, requestKey]);

  const total = load.state === 'ready' ? load.list.total : 0;
  const totalPages = Math.max(1, Math.ceil(total / LAB_PROGRAM_PAGE_SIZE));
  const first = (page - 1) * LAB_PROGRAM_PAGE_SIZE + 1;
  const shown = load.state === 'ready' ? load.list.items.length : 0;

  return (
    <section aria-labelledby="programs-heading">
      <div className="section-header">
        <h2 id="programs-heading">Programs</h2>
        <label className="inline-select">
          Show{' '}
          <select
            value={status}
            onChange={(event) => {
              setStatus(event.target.value);
              setPage(1);
            }}
          >
            {STATUS_FILTERS.map((filter) => (
              <option key={filter.value} value={filter.value}>
                {filter.label}
              </option>
            ))}
          </select>
        </label>
      </div>
      {load.state === 'loading' ? <p aria-busy="true">Loading programs…</p> : null}
      {load.state === 'error' ? (
        <ErrorState
          message="Programs couldn’t be loaded."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {load.state === 'ready' ? (
        <>
          {total > 0 && shown > 0 ? (
            <p className="field-hint" role="status">
              {total > LAB_PROGRAM_PAGE_SIZE
                ? `Showing ${first}–${first + shown - 1} of ${total} programs`
                : `${total} ${total === 1 ? 'program' : 'programs'}`}
            </p>
          ) : null}
          <DataTable
            caption="Testing programs"
            rows={load.list.items}
            rowKey={(row) => row.id}
            empty="No programs yet. Use New program to request tests."
            columns={[
              {
                header: 'Program',
                cell: (row) => (
                  <Link to={`/lab-testing/programs/${row.id}`} className="mono">
                    {programLabel(row)}
                  </Link>
                ),
              },
              { header: 'Status', cell: (row) => statusBadge(row.status) },
              {
                header: 'Project',
                cell: (row) => `${row.project.projectNumber} · ${row.project.name}`,
              },
              {
                header: 'Requested by',
                cell: (row) => formatAttribution(row.createdBy, row.requestedBy),
              },
              { header: 'Tests', cell: (row) => String(row.testCount) },
              {
                header: 'Submitted',
                cell: (row) =>
                  row.submittedAt
                    ? shortDateTime(row.submittedAt)
                    : `Saved ${shortDateTime(row.updatedAt)}`,
              },
            ]}
          />
          {total > LAB_PROGRAM_PAGE_SIZE ? (
            <nav className="pager" aria-label="Pages">
              <button type="button" disabled={page <= 1} onClick={() => setPage(page - 1)}>
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button type="button" disabled={page >= totalPages} onClick={() => setPage(page + 1)}>
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </section>
  );
}
