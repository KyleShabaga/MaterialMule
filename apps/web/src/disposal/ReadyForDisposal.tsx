import type { DisposalReady, DisposalReadyUnit } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { BandedCard, DataTable, ErrorState, StatusBadge, type Column } from '../components/ui';
import { fetchReady } from './api';

const columns: Column<DisposalReadyUnit>[] = [
  {
    header: 'Storage unit',
    cell: (unit) => <Link to={`/sample-storage/${unit.readableId}`}>{unit.readableId}</Link>,
  },
  {
    header: 'Project',
    cell: (unit) => (
      <Link to={`/disposal-retention?projectId=${unit.project.id}`}>
        {unit.project.projectNumber}
      </Link>
    ),
  },
  { header: 'Location', cell: (unit) => unit.location.name },
  { header: 'Retain until', cell: (unit) => unit.effectiveRetainUntil },
  { header: 'Why it is eligible', cell: (unit) => unit.reason.label },
  {
    header: 'Next step',
    cell: (unit) =>
      unit.stage === 'approved' ? (
        <>
          <StatusBadge tone="warning">Approved</StatusBadge>{' '}
          <Link to="/disposal-retention/scan">Scan to dispose</Link>
        </>
      ) : unit.canApprove ? (
        <Link to={`/disposal-retention?projectId=${unit.project.id}`}>Approve in project</Link>
      ) : (
        'Waiting for the Lead Project Engineer or a Lab Manager to approve'
      ),
  },
];

/**
 * MISC-13: storage units in every project that standard disposal can take now. The server decides
 * eligibility (holds, extensions, open programs, location conflicts); this only shows its rows.
 * Each row leads to the unit or to its project, where approval and the disposal scan continue.
 * `refresh` changes after an approval or revocation on the page, so the list reloads.
 */
export function ReadyForDisposal({ refresh }: { refresh: number }) {
  const [page, setPage] = useState(1);
  const [data, setData] = useState<DisposalReady | null>(null);
  const [failed, setFailed] = useState(false);
  const [retry, setRetry] = useState(0);

  useEffect(() => {
    let active = true;
    void fetchReady(page).then((next) => {
      if (!active) return;
      setFailed(next === null);
      if (next) setData(next);
    });
    return () => {
      active = false;
    };
  }, [page, refresh, retry]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  return (
    <BandedCard
      title="Ready for disposal"
      subtitle={
        data
          ? `As of ${data.asOf}, all projects: retain-until reached, no hold, programs closed. Tested units are removed after testing instead.`
          : 'All projects: retain-until reached, no hold, programs closed.'
      }
      aside={
        data ? (
          <span aria-label="Ready count">
            {data.total} {data.total === 1 ? 'unit' : 'units'}
          </span>
        ) : null
      }
    >
      {failed ? (
        <ErrorState
          message="The units ready for disposal couldn’t be loaded."
          onRetry={() => setRetry((n) => n + 1)}
        />
      ) : null}
      {!data && !failed ? <p className="field-hint">Loading…</p> : null}
      {data ? (
        <>
          <DataTable
            rows={data.units}
            columns={columns}
            rowKey={(unit) => unit.storageUnitId}
            caption="Storage units ready for disposal"
            empty="No storage units are ready for disposal right now."
          />
          {data.total > data.pageSize ? (
            <nav className="pager" aria-label="Ready for disposal pages">
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
    </BandedCard>
  );
}
