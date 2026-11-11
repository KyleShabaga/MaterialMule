import {
  formatPerson,
  type ConcreteFieldReportSummary,
  type ProjectDetail,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { DataTable, ErrorState, TableScroll, TableViewSelector } from '../../components/ui';
import { useTableView } from '../../components/useTableView';
import { StateBadge } from '../../concrete-review/ReviewReportPage';
import { StrengthReportList } from '../../concrete-review/StrengthReportList';
import { concreteProblem, fetchProjectReports } from './api';
import { Pager } from './Pager';
import { structureText } from './mix-format';
import { TabHead } from './TabHead';
import { useLoad } from './useLoad';

// MM-V2-C30 Reports tab: the project's field reports (date, Field ID, type, technician, structure
// / elements, location, status) with search and a status filter. A row opens the report.

const STATUS_FILTERS = [
  { value: '', label: 'All statuses' },
  { value: 'draft', label: 'Draft' },
  { value: 'ready_to_submit', label: 'Ready to submit' },
  { value: 'submitted', label: 'Awaiting review' },
  { value: 'returned', label: 'Returned for correction' },
  { value: 'reviewed', label: 'Reviewed awaiting issuance' },
  { value: 'issued', label: 'Issued' },
  { value: 'void', label: 'Void' },
] as const;

function filterQuery(status: string): { state?: string; issued?: string } {
  if (status === 'issued') return { issued: 'true' };
  if (status === 'reviewed') return { state: 'reviewed', issued: 'false' };
  return status ? { state: status } : {};
}

export function ReportsTab({ project }: { project: ProjectDetail }) {
  const searchId = useId();
  const statusId = useId();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [text, setText] = useState(q);
  const [view, setView] = useTableView('concrete-project-reports');
  const { load, reload } = useLoad(`${project.id}|${q}|${status}|${page}`, () =>
    fetchProjectReports(project.id, { search: q, ...filterQuery(status), page }),
  );

  function update(next: Record<string, string>) {
    const out = new URLSearchParams(params);
    for (const [key, value] of Object.entries(next)) {
      if (value) out.set(key, value);
      else out.delete(key);
    }
    if (!('page' in next)) out.delete('page');
    setParams(out, { replace: true });
  }

  function submit(event: FormEvent) {
    event.preventDefault();
    update({ q: text.trim() });
  }

  return (
    <>
      <section className="concrete-tab" aria-labelledby={`${searchId}-heading`}>
        <TabHead id={`${searchId}-heading`} title="Field reports">
          <form role="search" className="concrete-search" onSubmit={submit}>
            <label htmlFor={searchId}>Search reports</label>
            <div className="inline-input">
              <input
                id={searchId}
                type="search"
                value={text}
                maxLength={200}
                placeholder="Supplier, mix, ticket, Field ID, location or technician"
                onChange={(event) => setText(event.target.value)}
              />
              <button type="submit">Search</button>
            </div>
          </form>
          <div className="concrete-filter">
            <label htmlFor={statusId}>Status</label>
            <select
              id={statusId}
              value={status}
              onChange={(event) => update({ status: event.target.value })}
            >
              {STATUS_FILTERS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <TableViewSelector value={view} onChange={setView} />
          <div className="concrete-toolbar-action">
            <button type="button" className="primary" disabled aria-describedby={`${searchId}-new`}>
              New field report
            </button>
            <p id={`${searchId}-new`} className="field-hint">
              Technicians start field reports in the field form, which arrives with a later card.
            </p>
          </div>
        </TabHead>

        {load.state === 'loading' ? <p role="status">Loading…</p> : null}
        {load.state === 'error' ? (
          <ErrorState message={concreteProblem(load.error)} onRetry={reload} />
        ) : null}
        {load.state === 'ready' ? (
          <>
            <TableScroll label="Field reports">
              <DataTable<ConcreteFieldReportSummary>
                rows={load.data.items}
                rowKey={(row) => row.id}
                caption="Field reports"
                view={view}
                empty={
                  q || status
                    ? 'No field reports match these filters.'
                    : 'No field reports for this project yet.'
                }
                columns={[
                  {
                    header: 'Date',
                    cell: (row) => (
                      <Link
                        className="nowrap mono"
                        to={`/concrete/review/${encodeURIComponent(row.id)}`}
                        aria-label={`Open field report ${row.reportDate ?? 'with no date'}`}
                      >
                        {row.reportDate ?? 'No date'}
                      </Link>
                    ),
                  },
                  {
                    header: 'Field ID',
                    cell: (row) => <span className="mono">{row.paperFieldId ?? '—'}</span>,
                  },
                  { header: 'Type', cell: () => 'Field' },
                  {
                    header: 'Technician',
                    cell: (row) =>
                      row.technician
                        ? formatPerson(row.technician.initials, row.technician.name)
                        : '—',
                  },
                  {
                    header: 'Structure / elements',
                    cell: (row) =>
                      structureText(row.locationElements, row.locationElementOther) || '—',
                  },
                  { header: 'Location', cell: (row) => row.locationDescription ?? '—' },
                  {
                    header: 'Status',
                    cell: (row) => (
                      <StateBadge state={row.issueCount > 0 ? 'issued' : row.workflowState} />
                    ),
                  },
                ]}
              />
            </TableScroll>
            <Pager
              page={load.data.page}
              pageSize={load.data.pageSize}
              total={load.data.total}
              noun="reports"
              onPage={(next) => update({ page: next > 1 ? String(next) : '' })}
            />
          </>
        ) : null}
      </section>
      {/* MM-V2-C39: one strength report per specimen set, cumulative. */}
      <section className="concrete-tab" aria-labelledby="strength-reports-heading">
        <TabHead id="strength-reports-heading" title="Strength reports" />
        <StrengthReportList
          projectId={project.id}
          caption="Strength reports"
          empty="No strength reports for this project yet. A set appears once its results are entered."
        />
      </section>
    </>
  );
}
