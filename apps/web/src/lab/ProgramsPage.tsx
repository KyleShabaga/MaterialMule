import { formatAttribution, programLabel, type LabProgramList } from '@materialmule/shared';
import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { fetchPrograms } from './api';

const STATUS_FILTERS = [
  { value: '', label: 'All' },
  { value: 'draft', label: 'Drafts' },
  { value: 'submitted', label: 'Submitted' },
];

type Load = { state: 'loading' } | { state: 'error' } | { state: 'ready'; list: LabProgramList };

/** Lab Testing → Programs: this account's drafts first, then submitted programs (MM-T23). */
export function ProgramsPage() {
  const [status, setStatus] = useState('');
  const [load, setLoad] = useState<Load>({ state: 'loading' });

  const reload = useCallback(() => {
    fetchPrograms(status || undefined).then(
      (list) => setLoad({ state: 'ready', list }),
      () => setLoad({ state: 'error' }),
    );
  }, [status]);
  useEffect(reload, [reload]);

  return (
    <section aria-labelledby="programs-heading">
      <div className="section-header">
        <h2 id="programs-heading">Programs</h2>
        <label className="inline-select">
          Show{' '}
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
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
        <ErrorState message="Programs couldn’t be loaded." onRetry={reload} />
      ) : null}
      {load.state === 'ready' ? (
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
            {
              header: 'Status',
              cell: (row) =>
                row.status === 'draft' ? (
                  <StatusBadge tone="warning">Draft</StatusBadge>
                ) : (
                  <StatusBadge tone="info">Open</StatusBadge>
                ),
            },
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
      ) : null}
    </section>
  );
}
