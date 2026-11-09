import {
  CONCRETE_PROJECT_SPECIMEN_STATUSES,
  CONCRETE_PROJECT_SPECIMEN_STATUS_LABEL,
  type ConcreteProjectSpecimenRow,
  type ConcreteProjectSpecimenStatus,
  type ProjectDetail,
} from '@materialmule/shared';
import { useId, useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  DataTable,
  ErrorState,
  StatusBadge,
  TableScroll,
  type BadgeTone,
} from '../../components/ui';
import { concreteProblem, fetchProjectSpecimens } from './api';
import { Pager } from './Pager';
import { useLoad } from './useLoad';

// MM-V2-C30 Specimens tab: one row per specimen (ID, casting date, structure, location, age or
// HOLD, test date, strength, status). A row opens its field report. Strength stays empty until
// test results exist (C07/C23).

const TONE: Record<ConcreteProjectSpecimenStatus, BadgeTone> = {
  awaiting_casting: 'neutral',
  scheduled: 'info',
  due_today: 'warning',
  overdue: 'danger',
  hold: 'neutral',
  void: 'neutral',
};

export function SpecimensTab({ project }: { project: ProjectDetail }) {
  const searchId = useId();
  const statusId = useId();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const status = params.get('status') ?? '';
  const page = Math.max(1, Number(params.get('page') ?? '1') || 1);
  const [text, setText] = useState(q);
  const { load, reload } = useLoad(`${project.id}|${q}|${status}|${page}`, () =>
    fetchProjectSpecimens(project.id, { search: q, status, page }),
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
    <section className="concrete-tab" aria-label="Specimens">
      <div className="concrete-toolbar">
        <form role="search" className="concrete-search" onSubmit={submit}>
          <label htmlFor={searchId}>Search specimens</label>
          <div className="inline-input">
            <input
              id={searchId}
              type="search"
              value={text}
              maxLength={200}
              placeholder="Specimen ID, structure or location"
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
            <option value="">All statuses</option>
            {CONCRETE_PROJECT_SPECIMEN_STATUSES.map((value) => (
              <option key={value} value={value}>
                {CONCRETE_PROJECT_SPECIMEN_STATUS_LABEL[value]}
              </option>
            ))}
          </select>
        </div>
      </div>

      {load.state === 'loading' ? <p role="status">Loading…</p> : null}
      {load.state === 'error' ? (
        <ErrorState message={concreteProblem(load.error)} onRetry={reload} />
      ) : null}
      {load.state === 'ready' ? (
        <>
          <TableScroll label="Specimens">
            <DataTable<ConcreteProjectSpecimenRow>
              rows={load.data.items}
              rowKey={(row) => row.specimenId}
              caption="Specimens"
              empty={
                q || status
                  ? 'No specimens match these filters.'
                  : 'No specimens for this project yet.'
              }
              columns={[
                {
                  header: 'Specimen',
                  cell: (row) => (
                    <Link
                      className="nowrap"
                      to={`/concrete/review/${encodeURIComponent(row.fieldReportId)}`}
                      aria-label={`Open the field report for specimen ${row.label}`}
                    >
                      {row.label}
                    </Link>
                  ),
                },
                { header: 'Cast', cell: (row) => row.castingDate ?? '—' },
                { header: 'Structure', cell: (row) => row.structure.join(', ') || '—' },
                { header: 'Location', cell: (row) => row.location ?? '—' },
                {
                  header: 'Age',
                  cell: (row) =>
                    row.assignedAge === null
                      ? '—'
                      : row.assignedAge === 'HOLD'
                        ? 'HOLD'
                        : `${row.assignedAge} d`,
                },
                {
                  header: 'Test date',
                  cell: (row) =>
                    row.testDate
                      ? row.assignedAge === 'HOLD'
                        ? `HOLD until ${row.testDate}`
                        : row.testDate
                      : '—',
                },
                {
                  header: 'Strength',
                  cell: (row) => (row.strengthMpa === null ? '—' : `${row.strengthMpa} MPa`),
                },
                {
                  header: 'Status',
                  cell: (row) => (
                    <StatusBadge tone={TONE[row.status]}>
                      {CONCRETE_PROJECT_SPECIMEN_STATUS_LABEL[row.status]}
                    </StatusBadge>
                  ),
                },
              ]}
            />
          </TableScroll>
          <Pager
            page={load.data.page}
            pageSize={load.data.pageSize}
            total={load.data.total}
            noun="specimens"
            onPage={(next) => update({ page: next > 1 ? String(next) : '' })}
          />
        </>
      ) : null}
    </section>
  );
}
