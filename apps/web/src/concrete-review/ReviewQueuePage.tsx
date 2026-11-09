import {
  CONCRETE_EXCEPTION_LABEL,
  CONCRETE_REPORT_KIND_LABEL,
  CONCRETE_REVIEW_QUEUE_STATUSES,
  CONCRETE_REVIEW_QUEUE_STATUS_LABEL,
  type ConcreteReviewQueue,
  type ConcreteReviewQueueRow,
  type ConcreteReviewQueueStatus,
  type ProjectSummary,
  type StaffOption,
} from '@materialmule/shared';
import { useEffect, useMemo, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { listActiveStaff, searchProjects } from '../api/projects';
import { DataTable, ErrorState, PageHeader, StatusBadge } from '../components/ui';
import { shortDateTime } from '../dashboard/format';
import { fetchReviewQueue } from './api';
import './review.css';

// MM-V2-C28: one review table with the four confirmed statuses (Combined Plan "Review queue
// structure"). Filters live in the address so a filtered view can be shared or reloaded.

type Load =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; queue: ConcreteReviewQueue };

const isStatus = (value: string | null): value is ConcreteReviewQueueStatus =>
  (CONCRETE_REVIEW_QUEUE_STATUSES as readonly string[]).includes(value ?? '');

function exceptionFlags(row: ConcreteReviewQueueRow) {
  if (row.exceptions.length === 0) return <span className="review-muted">None</span>;
  const total = row.exceptions.reduce((n, e) => n + e.count, 0);
  return (
    <span className="review-flags">
      {row.exceptions.map((e) => (
        <span key={e.code} className="review-flag">
          <span aria-hidden="true">⚠ </span>
          {CONCRETE_EXCEPTION_LABEL[e.code]}
          {e.count > 1 ? ` ×${e.count}` : ''}
        </span>
      ))}
      {row.status === 'awaiting_review' && row.documentedCount > 0 ? (
        <span className="review-muted">
          {row.documentedCount} of {total} documented
        </span>
      ) : null}
    </span>
  );
}

function routedText(row: ConcreteReviewQueueRow): string {
  switch (row.status) {
    case 'awaiting_review':
      return row.route.routedTo
        ? `Routed to ${row.route.routedTo.name}`
        : 'Any designated reviewer';
    case 'returned':
      return row.returnedBy
        ? `Returned by ${row.returnedBy.name}${row.returnedAt ? `, ${shortDateTime(row.returnedAt)}` : ''}`
        : 'Returned';
    case 'reviewed_awaiting_issue':
      return row.reviewedBy
        ? `Reviewed by ${row.reviewedBy.name}${row.reviewedAt ? `, ${shortDateTime(row.reviewedAt)}` : ''}`
        : 'Reviewed';
    case 'issued':
      return row.issuedBy
        ? `Issued by ${row.issuedBy.name}${row.issuedAt ? `, ${shortDateTime(row.issuedAt)}` : ''}`
        : 'Issued';
  }
}

export function ReviewQueuePage() {
  const [params, setParams] = useSearchParams();
  const status: ConcreteReviewQueueStatus = isStatus(params.get('status'))
    ? (params.get('status') as ConcreteReviewQueueStatus)
    : 'awaiting_review';
  const projectId = params.get('projectId') ?? '';
  const technicianUserId = params.get('technicianUserId') ?? '';
  const submittedFrom = params.get('submittedFrom') ?? '';
  const submittedTo = params.get('submittedTo') ?? '';
  const exceptions =
    (['with', 'without'] as const).find((e) => e === params.get('exceptions')) ?? 'any';
  const mine = params.get('mine') === 'true';
  const page = Math.max(1, Number(params.get('page')) || 1);

  const [attempt, setAttempt] = useState(0);
  const requestKey = params.toString() + `|${attempt}`;
  const [answer, setAnswer] = useState<{ key: string; load: Load }>({
    key: '',
    load: { state: 'loading' },
  });
  const load: Load = answer.key === requestKey ? answer.load : { state: 'loading' };

  useEffect(() => {
    let current = true;
    fetchReviewQueue({
      status,
      projectId: projectId || undefined,
      technicianUserId: technicianUserId || undefined,
      submittedFrom: submittedFrom || undefined,
      submittedTo: submittedTo || undefined,
      exceptions,
      mine: mine ? 'true' : undefined,
      page,
    }).then(
      (queue) => current && setAnswer({ key: requestKey, load: { state: 'ready', queue } }),
      () => current && setAnswer({ key: requestKey, load: { state: 'error' } }),
    );
    return () => {
      current = false;
    };
  }, [
    status,
    projectId,
    technicianUserId,
    submittedFrom,
    submittedTo,
    exceptions,
    mine,
    page,
    requestKey,
  ]);

  const update = (changes: Record<string, string | null>) => {
    const next = new URLSearchParams(params);
    for (const [key, value] of Object.entries(changes)) {
      if (value === null || value === '') next.delete(key);
      else next.set(key, value);
    }
    if (!('page' in changes)) next.delete('page');
    setParams(next, { replace: true });
  };

  // Filter choices: technicians from the staff list; projects found by number.
  const [staff, setStaff] = useState<StaffOption[]>([]);
  useEffect(() => {
    listActiveStaff().then(setStaff, () => setStaff([]));
  }, []);
  const [projectText, setProjectText] = useState('');
  const [projectOptions, setProjectOptions] = useState<ProjectSummary[]>([]);
  useEffect(() => {
    if (projectText.trim().length < 2) return;
    let current = true;
    const timer = window.setTimeout(() => {
      searchProjects(projectText.trim()).then(
        (found) => current && setProjectOptions(found),
        () => current && setProjectOptions([]),
      );
    }, 250);
    return () => {
      current = false;
      window.clearTimeout(timer);
    };
  }, [projectText]);
  const chosenProject = useMemo(
    () => projectOptions.find((p) => p.id === projectId) ?? null,
    [projectOptions, projectId],
  );

  const queue = load.state === 'ready' ? load.queue : null;
  const totalPages = queue ? Math.max(1, Math.ceil(queue.total / queue.pageSize)) : 1;

  return (
    <div className="review-queue">
      <PageHeader title="Concrete review" />
      <p className="field-hint">
        Field reports submitted for review and issue. Strength reports are added once their format
        is decided.
      </p>

      <div className="review-tabs" role="tablist" aria-label="Queue status">
        {CONCRETE_REVIEW_QUEUE_STATUSES.map((s) => (
          <button
            key={s}
            type="button"
            role="tab"
            aria-selected={s === status}
            className={s === status ? 'review-tab review-tab-active' : 'review-tab'}
            onClick={() => update({ status: s === 'awaiting_review' ? null : s })}
          >
            {CONCRETE_REVIEW_QUEUE_STATUS_LABEL[s]}
            {queue ? <span className="review-tab-count"> ({queue.counts[s]})</span> : null}
          </button>
        ))}
      </div>

      <form
        className="review-filters"
        aria-label="Filters"
        onSubmit={(event) => event.preventDefault()}
      >
        <label>
          Project
          <input
            type="search"
            list="review-project-options"
            placeholder="Project number"
            value={projectText || chosenProject?.projectNumber || ''}
            onChange={(event) => {
              const text = event.target.value;
              setProjectText(text);
              const match = projectOptions.find(
                (p) => p.projectNumber.toLowerCase() === text.trim().toLowerCase(),
              );
              if (match) update({ projectId: match.id });
              else if (text.trim() === '') update({ projectId: null });
            }}
          />
          <datalist id="review-project-options">
            {projectOptions.map((p) => (
              <option key={p.id} value={p.projectNumber}>
                {p.name}
              </option>
            ))}
          </datalist>
        </label>
        <label>
          Technician
          <select
            value={technicianUserId}
            onChange={(event) => update({ technicianUserId: event.target.value })}
          >
            <option value="">Anyone</option>
            {staff.map((s) => (
              <option key={s.id} value={s.id}>
                {s.displayName}
              </option>
            ))}
          </select>
        </label>
        <label>
          Submitted from
          <input
            type="date"
            value={submittedFrom}
            onChange={(event) => update({ submittedFrom: event.target.value })}
          />
        </label>
        <label>
          Submitted to
          <input
            type="date"
            value={submittedTo}
            onChange={(event) => update({ submittedTo: event.target.value })}
          />
        </label>
        <label>
          Exceptions
          <select
            value={exceptions}
            onChange={(event) =>
              update({ exceptions: event.target.value === 'any' ? null : event.target.value })
            }
          >
            <option value="any">Any</option>
            <option value="with">With exceptions</option>
            <option value="without">Without exceptions</option>
          </select>
        </label>
        <label className="review-check">
          <input
            type="checkbox"
            checked={mine}
            onChange={(event) => update({ mine: event.target.checked ? 'true' : null })}
          />
          Needs my action
        </label>
        {params.toString() && params.toString() !== `status=${status}` ? (
          <button
            type="button"
            onClick={() => {
              setProjectText('');
              setParams(status === 'awaiting_review' ? {} : { status }, { replace: true });
            }}
          >
            Clear filters
          </button>
        ) : null}
      </form>

      {load.state === 'loading' ? <p aria-busy="true">Loading the review queue…</p> : null}
      {load.state === 'error' ? (
        <ErrorState
          message="The review queue couldn’t be loaded."
          onRetry={() => setAttempt((n) => n + 1)}
        />
      ) : null}
      {queue ? (
        <>
          <p className="field-hint" role="status">
            {queue.total} {queue.total === 1 ? 'report' : 'reports'} ·{' '}
            {CONCRETE_REVIEW_QUEUE_STATUS_LABEL[status]}
          </p>
          <DataTable
            caption={`Concrete review: ${CONCRETE_REVIEW_QUEUE_STATUS_LABEL[status]}`}
            rows={queue.items}
            rowKey={(row) => row.reportId}
            empty={
              mine
                ? 'Nothing here needs your action.'
                : `No reports are ${CONCRETE_REVIEW_QUEUE_STATUS_LABEL[status].toLowerCase()}.`
            }
            columns={[
              {
                header: 'Project',
                cell: (row) => (
                  <Link
                    to={
                      row.reportType === 'strength' && row.setId
                        ? `/concrete/strength/${row.setId}`
                        : `/concrete/review/${row.reportId}`
                    }
                    className="mono"
                  >
                    {row.projectNumber}
                  </Link>
                ),
              },
              {
                header: 'Report type',
                cell: (row) => (
                  <>
                    {CONCRETE_REPORT_KIND_LABEL[row.reportType]}
                    {row.setLabel ? ` ${row.setLabel}` : ''} v{row.versionNo}
                    {row.revised ? (
                      <>
                        {' '}
                        <StatusBadge tone="info">Revised</StatusBadge>
                      </>
                    ) : null}
                  </>
                ),
              },
              { header: 'Report date', cell: (row) => row.reportDate ?? '—' },
              { header: 'Technician', cell: (row) => row.technician?.name ?? '—' },
              { header: 'Submitted', cell: (row) => shortDateTime(row.submittedAt) },
              { header: 'Exceptions', cell: exceptionFlags },
              {
                header: 'Status',
                cell: (row) => (
                  <>
                    {routedText(row)}
                    {row.canAct ? (
                      <>
                        {' '}
                        <StatusBadge tone="warning">Your action</StatusBadge>
                      </>
                    ) : null}
                  </>
                ),
              },
            ]}
          />
          {queue.total > queue.pageSize ? (
            <nav className="pager" aria-label="Pages">
              <button
                type="button"
                disabled={page <= 1}
                onClick={() => update({ page: String(page - 1) })}
              >
                Previous
              </button>
              <span>
                Page {page} of {totalPages}
              </span>
              <button
                type="button"
                disabled={page >= totalPages}
                onClick={() => update({ page: String(page + 1) })}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
