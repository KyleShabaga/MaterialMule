import { TEST_REQUEST_STATUS_LABEL, type TestCatalogue, type Worklist } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { DataTable, ErrorState, StatusBadge } from '../components/ui';
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
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    fetchCatalogue().then(setCatalogue, () => setCatalogue(null));
  }, []);
  useEffect(() => {
    let current = true;
    fetchWorklist({ priority, open, testTypeId, projectId }).then(
      (list) => current && setLoad({ state: 'ready', list }),
      () => current && setLoad({ state: 'error' }),
    );
    return () => {
      current = false;
    };
  }, [priority, open, testTypeId, projectId, attempt]);

  const projects =
    load.state === 'ready'
      ? [...new Map(load.list.items.map((item) => [item.project.id, item.project])).values()]
      : [];

  return (
    <section aria-labelledby="worklist-heading">
      <h2 id="worklist-heading">Worklist</h2>
      <div className="worklist-filters">
        <label>
          Priority{' '}
          <select value={priority} onChange={(event) => setPriority(event.target.value)}>
            <option value="">All</option>
            <option value="urgent">Urgent</option>
            <option value="normal">Normal</option>
          </select>
        </label>
        <label>
          Project{' '}
          <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
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
          <select value={testTypeId} onChange={(event) => setTestTypeId(event.target.value)}>
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
            onChange={(event) => setOpen(event.target.checked)}
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
      {load.state === 'ready' ? (
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
                (Object.entries(item.counts) as [keyof typeof TEST_REQUEST_STATUS_LABEL, number][])
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
      ) : null}
    </section>
  );
}
