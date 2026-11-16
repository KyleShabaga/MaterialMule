import {
  CONCRETE_HOLD_KIND_LABEL,
  type ConcreteDisposalReady,
  type ConcreteDisposalReadyRow,
} from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import {
  BandedCard,
  DataTable,
  ErrorState,
  Notice,
  StatusBadge,
  type Column,
} from '../../components/app-ui';
import { SpecimenLabel } from '../worklist/specimen';
import { fetchConcreteReady } from './api';
import { HoldActionDialog } from './HoldActionDialog';
import './holds.css';

const label = (row: ConcreteDisposalReadyRow) =>
  row.identity.permanentId ?? row.identity.temporaryId ?? row.specimenId;

/**
 * MISC-13's Ready for disposal list, Concrete specimens filter (MM-V2-C26, owner decision
 * 2026-11-08: one list with a type filter). Specimens authorized for disposal and not yet removed;
 * lab staff select the ones physically removed and record the date/time and performer, in bulk.
 */
export function ConcreteReadyForDisposal({ filter }: { filter?: ReactNode }) {
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const [data, setData] = useState<ConcreteDisposalReady | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [recording, setRecording] = useState(false);
  const [notice, setNotice] = useState('');

  useEffect(() => {
    let active = true;
    void fetchConcreteReady(page).then((result) => {
      if (!active) return;
      if (!result.ok) {
        setFailed(result.message);
        return;
      }
      setFailed(null);
      const lastPage = Math.max(1, Math.ceil(result.data.total / result.data.pageSize));
      if (page > lastPage) {
        setPage(lastPage);
        return;
      }
      setData(result.data);
    });
    return () => {
      active = false;
    };
  }, [page, reload]);

  const rows = data?.specimens ?? [];
  const chosen = rows.filter((r) => selected.includes(r.specimenId));
  const columns: Column<ConcreteDisposalReadyRow>[] = [
    ...(data?.canRecord
      ? [
          {
            header: 'Select',
            cell: (r: ConcreteDisposalReadyRow) => (
              <input
                type="checkbox"
                aria-label={`Select ${label(r)}`}
                checked={selected.includes(r.specimenId)}
                onChange={() =>
                  setSelected((now) =>
                    now.includes(r.specimenId)
                      ? now.filter((x) => x !== r.specimenId)
                      : [...now, r.specimenId],
                  )
                }
              />
            ),
          },
        ]
      : []),
    {
      header: 'Specimen ID',
      cell: (r) =>
        r.identity.permanentId || r.identity.temporaryId ? (
          <SpecimenLabel identity={r.identity} />
        ) : (
          <span className="mono">{label(r)}</span>
        ),
    },
    { header: 'Project', cell: (r) => <span className="mono">{r.project.projectNumber}</span> },
    {
      header: 'Released from',
      cell: (r) => (
        <StatusBadge tone={r.holdKind === 'failed' ? 'danger' : 'closed'}>
          {CONCRETE_HOLD_KIND_LABEL[r.holdKind]}
        </StatusBadge>
      ),
    },
    {
      header: 'Authorized',
      cell: (r) => `${new Date(r.authorizedAt).toLocaleDateString()} by ${r.authorizedBy.name}`,
    },
    { header: 'Reason', cell: (r) => r.reason },
  ];
  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;
  const shownPage = data?.page ?? page;

  return (
    <BandedCard
      title="Ready for disposal"
      subtitle="Concrete specimens authorized for disposal and not yet removed. Disposal is recorded once they are physically removed."
      aside={
        data ? (
          <span aria-label="Ready count">
            {data.total} {data.total === 1 ? 'specimen' : 'specimens'}
          </span>
        ) : null
      }
    >
      {filter}
      {failed ? <ErrorState message={failed} onRetry={() => setReload((n) => n + 1)} /> : null}
      {!data && !failed ? <p className="field-hint">Loading…</p> : null}
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {data ? (
        <>
          {data.canRecord ? (
            <div className="hold-actions" role="toolbar" aria-label="Disposal actions">
              <span aria-live="polite">{chosen.length} selected</span>
              <button
                type="button"
                className="primary"
                disabled={chosen.length === 0}
                onClick={() => setRecording(true)}
              >
                Record disposal
              </button>
            </div>
          ) : (
            <p className="field-hint">Lab staff record the actual removal.</p>
          )}
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.specimenId}
            caption="Concrete specimens ready for disposal"
            empty="No concrete specimens are authorized for disposal right now."
          />
          {data.total > data.pageSize ? (
            <nav className="pager" aria-label="Concrete ready for disposal pages">
              <button
                type="button"
                disabled={shownPage <= 1}
                onClick={() => setPage(shownPage - 1)}
              >
                Previous
              </button>
              <span>
                Page {shownPage} of {totalPages}
              </span>
              <button
                type="button"
                disabled={shownPage >= totalPages}
                onClick={() => setPage(shownPage + 1)}
              >
                Next
              </button>
            </nav>
          ) : null}
        </>
      ) : null}
      {recording ? (
        <HoldActionDialog
          action="record_disposal"
          targets={chosen.map((r) => ({
            specimenId: r.specimenId,
            label: label(r),
            projectNumber: r.project.projectNumber,
            holdKind: r.holdKind,
            castingDate: r.castingDate,
            holdExpiresOn: null,
            version: 1,
          }))}
          sharedStation={data?.requiresPerformer ?? false}
          onClose={() => setRecording(false)}
          onDone={(message) => {
            setRecording(false);
            setNotice(message);
            setSelected([]);
            setReload((n) => n + 1);
          }}
        />
      ) : null}
    </BandedCard>
  );
}
