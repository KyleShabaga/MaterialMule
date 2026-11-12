import {
  concreteReportFileUrl,
  type ConcreteSummaryFilters,
  type ConcreteSummaryReport,
  type ProjectDetail,
} from '@materialmule/shared';
import { useId, useState } from 'react';
import { ConfirmDialog, DataTable, ErrorState, TableScroll } from '../../components/app-ui';
import { shortDateTime } from '../../dashboard/format';
import {
  concreteProblem,
  fetchMixes,
  fetchSummaryReports,
  issueSummaryReport,
  summaryPreviewUrl,
} from './api';
import { TabHead } from './TabHead';
import { useLoad } from './useLoad';

// MM-V2-C30 Summary tab, completed by MM-V2-C32 (provisional design section 5): a date range
// (default All dates) and filters; Preview opens the server's unnumbered PDF (never stored);
// Generate summary report issues it with a CSR number (`report.issue` on the project, checked
// by the server). Issued summaries open the stored file, exactly as issued.

const WHO =
  'Only the project’s Lead Project Engineer or an Authorized report issuer can issue a summary report.';

function rangeText(filters: ConcreteSummaryReport['filters']): string {
  const range =
    filters.from || filters.to ? `${filters.from ?? '…'} to ${filters.to ?? '…'}` : 'All dates';
  const parts = [range];
  if (filters.element) parts.push(filters.element);
  if (filters.mixNumber) parts.push(`Mix ${filters.mixNumber}`);
  return parts.join(' · ');
}

export function SummaryTab({ project }: { project: ProjectDetail }) {
  const id = useId();
  const [range, setRange] = useState<'all' | 'between'>('all');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [element, setElement] = useState('');
  const [mixId, setMixId] = useState('');
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const { load, reload } = useLoad(`summaries|${project.id}`, () =>
    fetchSummaryReports(project.id),
  );
  const mixes = useLoad(`summary-mixes|${project.id}`, () => fetchMixes(project.id));

  const filters: ConcreteSummaryFilters = {
    from: range === 'between' && from ? from : null,
    to: range === 'between' && to ? to : null,
    element: element.trim() || null,
    mixId: mixId || null,
  };
  const rangeInvalid = filters.from !== null && filters.to !== null && filters.from > filters.to;
  const canIssue = load.state === 'ready' && load.data.canIssue;

  return (
    <div className="concrete-tab concrete-summary">
      <section className="concrete-summary-build" aria-labelledby={`${id}-heading`}>
        <TabHead
          id={`${id}-heading`}
          title="Summary report"
          hint="One document for the project’s specimen sets, by cast date."
        />
        <fieldset className="concrete-range">
          <legend>Date range (cast date)</legend>
          <label>
            <input
              type="radio"
              name={`${id}-range`}
              checked={range === 'all'}
              onChange={() => setRange('all')}
            />{' '}
            All dates
          </label>
          <label>
            <input
              type="radio"
              name={`${id}-range`}
              checked={range === 'between'}
              onChange={() => setRange('between')}
            />{' '}
            Between dates
          </label>
          {range === 'between' ? (
            <div className="concrete-fields">
              <div className="concrete-field">
                <label htmlFor={`${id}-from`}>From</label>
                <input
                  id={`${id}-from`}
                  type="date"
                  value={from}
                  onChange={(event) => setFrom(event.target.value)}
                />
              </div>
              <div className="concrete-field">
                <label htmlFor={`${id}-to`}>To</label>
                <input
                  id={`${id}-to`}
                  type="date"
                  value={to}
                  min={from || undefined}
                  onChange={(event) => setTo(event.target.value)}
                />
              </div>
            </div>
          ) : null}
        </fieldset>
        <div className="concrete-fields">
          <div className="concrete-field">
            <label htmlFor={`${id}-element`}>Structure / element</label>
            <input
              id={`${id}-element`}
              value={element}
              maxLength={100}
              placeholder="All"
              onChange={(event) => setElement(event.target.value)}
            />
          </div>
          <div className="concrete-field">
            <label htmlFor={`${id}-mix`}>Mix</label>
            <select
              id={`${id}-mix`}
              value={mixId}
              onChange={(event) => setMixId(event.target.value)}
            >
              <option value="">All mixes</option>
              {mixes.load.state === 'ready'
                ? mixes.load.data.items.map((mix) => (
                    <option key={mix.id} value={mix.id}>
                      {mix.supplierName} {mix.mixNumber}
                    </option>
                  ))
                : null}
            </select>
          </div>
        </div>
        {rangeInvalid ? (
          <p className="field-error" role="alert">
            The end date is before the start date.
          </p>
        ) : null}
        <p className="field-hint">
          Only issued strength values print. Tested results not yet issued show “Pending review”;
          untested ages “—”.
        </p>
        <div className="page-actions">
          {rangeInvalid ? (
            <button type="button" disabled>
              Preview summary report
            </button>
          ) : (
            <a
              className="button"
              href={summaryPreviewUrl(project.id, filters)}
              target="_blank"
              rel="noopener"
            >
              Preview summary report
            </a>
          )}
          <button
            type="button"
            className="primary"
            disabled={!canIssue || busy || rangeInvalid}
            aria-describedby={canIssue ? undefined : `${id}-who`}
            onClick={() => setConfirming(true)}
          >
            Generate summary report
          </button>
        </div>
        {load.state === 'ready' && !canIssue ? (
          <p id={`${id}-who`} className="field-hint">
            {WHO}
          </p>
        ) : null}
        {message ? (
          <p
            className={message.tone === 'ok' ? 'review-message' : 'field-error'}
            role={message.tone === 'ok' ? 'status' : 'alert'}
          >
            {message.text}
          </p>
        ) : null}
      </section>

      <section aria-labelledby={`${id}-issued`}>
        <TabHead id={`${id}-issued`} title="Issued summary reports" />
        {load.state === 'loading' ? <p role="status">Loading…</p> : null}
        {load.state === 'error' ? (
          <ErrorState message={concreteProblem(load.error)} onRetry={reload} />
        ) : null}
        {load.state === 'ready' ? (
          <TableScroll label="Issued summary reports">
            <DataTable<ConcreteSummaryReport>
              rows={load.data.items}
              rowKey={(r) => r.id}
              caption="Issued summary reports"
              empty="No summary report has been issued for this project."
              columns={[
                {
                  header: 'Report',
                  cell: (r) => (
                    <a
                      href={concreteReportFileUrl(r.file.id)}
                      target="_blank"
                      rel="noopener"
                      className="mono"
                      aria-label={`Open ${r.reportNumber} (PDF)`}
                    >
                      {r.reportNumber}
                    </a>
                  ),
                },
                { header: 'Issued', cell: (r) => shortDateTime(r.issuedAt) },
                { header: 'Issued by', cell: (r) => r.issuedBy.name },
                { header: 'Range and filters', cell: (r) => rangeText(r.filters) },
                {
                  header: 'Sets',
                  cell: (r) => `${r.totals.sets} (${r.totals.pending} pending)`,
                },
                {
                  header: 'Template',
                  cell: (r) =>
                    `${r.file.template.name} ${r.file.template.revision}${r.file.template.provisional ? ' (provisional)' : ''}`,
                },
              ]}
            />
          </TableScroll>
        ) : null}
      </section>

      <ConfirmDialog
        open={confirming}
        title="Issue this summary report?"
        confirmLabel="Issue summary report"
        onCancel={() => setConfirming(false)}
        onConfirm={() => {
          setConfirming(false);
          setBusy(true);
          setMessage(null);
          issueSummaryReport(project.id, filters)
            .then((issued) => {
              setMessage({ tone: 'ok', text: `${issued.reportNumber} issued.` });
              reload();
            })
            .catch((caught: unknown) =>
              setMessage({ tone: 'error', text: concreteProblem(caught) }),
            )
            .finally(() => setBusy(false));
        }}
      >
        <p>
          It gets the next summary report number and the PDF is stored exactly as issued. It lists{' '}
          {rangeText({ ...filters, mixNumber: null }).toLowerCase()} for {project.projectNumber}.
        </p>
      </ConfirmDialog>
    </div>
  );
}
