import type { ConcreteStrengthReportListItem } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge, TableScroll } from '../components/app-ui';
import { StrengthStateBadge } from './StrengthReportPage';
import { fetchStrengthReports, strengthProblemText } from './strength-api';

// MM-V2-C39: strength reports with their status, for the project Concrete → Reports tab (one
// project) and the Concrete Lab workspace (sets where the lab has something to submit).

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ConcreteStrengthReportListItem[]; truncated: boolean };

export function StrengthReportList({
  projectId,
  needsLab = false,
  caption,
  empty,
}: {
  projectId?: string;
  needsLab?: boolean;
  caption: string;
  empty: string;
}) {
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  useEffect(() => {
    let current = true;
    fetchStrengthReports({ projectId, needsLab })
      .then((list) => {
        if (current) setLoad({ state: 'ready', items: list.items, truncated: list.truncated });
      })
      .catch((error: unknown) => {
        if (current) setLoad({ state: 'error', message: strengthProblemText(error) });
      });
    return () => {
      current = false;
    };
  }, [projectId, needsLab, attempt]);

  if (load.state === 'loading') return <p role="status">Loading strength reports…</p>;
  if (load.state === 'error') {
    return <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />;
  }
  return (
    <>
      <TableScroll label={caption}>
        <DataTable<ConcreteStrengthReportListItem>
          caption={caption}
          rows={load.items}
          rowKey={(row) => row.setId}
          empty={empty}
          columns={[
            {
              header: 'Set',
              cell: (row) => (
                <Link className="mono" to={`/concrete/strength/${encodeURIComponent(row.setId)}`}>
                  {row.identity.permanentId ?? row.identity.temporaryId ?? 'Unnumbered set'}
                </Link>
              ),
            },
            ...(projectId
              ? []
              : [
                  {
                    header: 'Project',
                    cell: (row: ConcreteStrengthReportListItem) => row.projectNumber,
                  },
                ]),
            { header: 'Cast', cell: (row) => row.castingDate ?? '—' },
            { header: 'Report number', cell: (row) => row.reportNumber ?? '—' },
            {
              header: 'Ages reported',
              cell: (row) =>
                row.agesReported.length ? row.agesReported.map((a) => `${a} d`).join(', ') : '—',
            },
            {
              header: 'Status',
              cell: (row) => (
                <>
                  <StrengthStateBadge state={row.state} />
                  {row.issuedRevNo !== null ? ` Rev ${row.issuedRevNo}` : ''}
                  {row.newResults && row.state !== 'not_started' ? (
                    <>
                      {' '}
                      <StatusBadge tone="info">New results</StatusBadge>
                    </>
                  ) : null}
                </>
              ),
            },
          ]}
        />
      </TableScroll>
      {load.truncated ? (
        <p className="field-hint">Showing the first {load.items.length} sets.</p>
      ) : null}
    </>
  );
}
