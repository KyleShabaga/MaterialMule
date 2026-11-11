import {
  formatAttribution,
  LAB_PROGRAM_PAGE_SIZE,
  programLabel,
  type LabProgramList,
  type LabProgramSummary,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import {
  DataTable,
  ErrorState,
  Segmented,
  StatusBadge,
  TableScroll,
  TableViewSelector,
} from '../components/ui';
import { useTableView } from '../components/useTableView';
import { shortDateTime } from '../dashboard/format';
import { fetchPrograms } from './api';
import { ProgressCells, ProgressKey } from './ProgressCells';

const STATUS_FILTERS: { value: string; label: string }[] = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Submitted' },
  { value: 'closed', label: 'Closed' },
];

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: LabProgramList };

function statusBadge(status: LabProgramSummary['status']) {
  if (status === 'draft') return <StatusBadge tone="waiting">Draft</StatusBadge>;
  // Same wording and tone as the program page header (MM-T26).
  if (status === 'closed') return <StatusBadge tone="closed">Closed</StatusBadge>;
  return <StatusBadge tone="lab">Open</StatusBadge>;
}

/**
 * Lab programs → Programs: this account's drafts first, then submitted programs (MM-T23). Field
 * Ledger: a Show filter, the table view selector and progress as counted cells, one per test.
 */
export function ProgramsPage() {
  const [status, setStatus] = useState('');
  const [view, setView] = useTableView('lab-programs');
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
    <section aria-labelledby="programs-heading" className="lab-list">
      <div className="lab-list-head">
        <h2 id="programs-heading">Programs</h2>
        <Segmented
          label="Show"
          options={STATUS_FILTERS}
          value={status}
          onChange={(value) => {
            setStatus(value);
            setPage(1);
          }}
        />
        <TableViewSelector value={view} onChange={setView} />
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
            <p className="section-meta" role="status">
              {total > LAB_PROGRAM_PAGE_SIZE
                ? `Showing ${first}–${first + shown - 1} of ${total} programs`
                : `${total} ${total === 1 ? 'program' : 'programs'}`}
            </p>
          ) : null}
          {shown > 0 ? (
            <TableScroll label="Testing programs">
              <ProgramTable rows={load.list.items} view={view} />
            </TableScroll>
          ) : (
            <ProgramTable rows={[]} view={view} />
          )}
          {shown > 0 ? <ProgressKey /> : null}
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

function ProgramTable({
  rows,
  view,
}: {
  rows: LabProgramSummary[];
  view: 'comfortable' | 'compact';
}) {
  return (
    <DataTable
      caption="Testing programs"
      view={view}
      rows={rows}
      rowKey={(row) => row.id}
      empty="No programs yet. Use New lab program to request tests."
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
          cell: (row) => (
            <>
              <span className="mono">{row.project.projectNumber}</span> · {row.project.name}
            </>
          ),
        },
        {
          header: 'Requested by',
          cell: (row) => formatAttribution(row.createdBy, row.requestedBy),
        },
        { header: 'Progress', cell: (row) => <ProgressCells progress={row.progress} /> },
        {
          header: 'Submitted',
          cell: (row) => (
            <span className="mono">
              {row.submittedAt
                ? shortDateTime(row.submittedAt)
                : `Saved ${shortDateTime(row.updatedAt)}`}
            </span>
          ),
        },
      ]}
    />
  );
}
