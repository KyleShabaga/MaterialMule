import {
  CONCRETE_HOLD_KIND_LABEL,
  CONCRETE_HOLD_STATUS_LABEL,
  type ConcreteHoldHistory,
  type ConcreteHoldList,
  type ConcreteHoldRow,
  type ConcreteHoldStatus,
  type ConcreteHoldStatusFilter,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { DataTable, ErrorState, StatusBadge, TableScroll, type Column } from '../../components/ui';
import { useMe } from '../../session/context';
import { fetchHoldHistory, fetchHolds } from './api';
import { HoldActionDialog, type HoldAction, type HoldTarget } from './HoldActionDialog';
import './holds.css';

type Kind = 'all' | 'ordinary' | 'failed';

const STATUS_TONE: Record<ConcreteHoldStatus, 'neutral' | 'warning' | 'info' | 'success'> = {
  held: 'neutral',
  review_due: 'warning',
  disposal_authorized: 'info',
  disposed: 'success',
};

const STATUS_FILTER_LABEL: Record<ConcreteHoldStatusFilter, string> = {
  open: 'On hold',
  disposal_authorized: 'Disposal authorized',
  disposed: 'Disposed',
  all: 'All',
};

const specimenLabel = (row: { identity: ConcreteHoldRow['identity']; letter?: string }) =>
  row.identity.permanentId ?? row.identity.temporaryId ?? `Unnumbered set, ${row.letter ?? ''}`;

const ACTION_KEY: Record<HoldAction, keyof ConcreteHoldRow['actions']> = {
  schedule_test: 'scheduleTest',
  authorize_disposal: 'authorizeDisposal',
  record_disposal: 'recordDisposal',
};

/**
 * Lab Testing → HOLD (MM-V2-C26): ordinary HOLD and failed-specimen holds in one table (project,
 * specimen ID, casting date, HOLD expiry, kind, status), told apart by kind. Select specimens and
 * choose Schedule test, Authorize disposal or Record disposal; a confirmation lists each specimen
 * and its change. A HOLD past its expiry is only flagged Review due: nothing happens on a date.
 */
export function HoldManagementPage() {
  const me = useMe();
  const [kind, setKind] = useState<Kind>('all');
  const [status, setStatus] = useState<ConcreteHoldStatusFilter>('open');
  const [projectId, setProjectId] = useState('');
  const [page, setPage] = useState(1);
  const [reload, setReload] = useState(0);
  const requestKey = `${kind}|${status}|${projectId}|${page}|${reload}`;
  const [answer, setAnswer] = useState<{
    key: string;
    list: ConcreteHoldList | null;
    error: string | null;
  }>({ key: '', list: null, error: null });
  const [selected, setSelected] = useState<string[]>([]);
  const [action, setAction] = useState<HoldAction | null>(null);
  const [notice, setNotice] = useState('');
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [history, setHistory] = useState<ConcreteHoldHistory | null>(null);

  useEffect(() => {
    let current = true;
    void fetchHolds({ kind, status, projectId, page }).then((result) => {
      if (!current) return;
      setAnswer({
        key: requestKey,
        list: result.ok ? result.data : null,
        error: result.ok ? null : result.message,
      });
    });
    return () => {
      current = false;
    };
  }, [kind, status, projectId, page, requestKey]);

  useEffect(() => {
    if (!historyOf) return;
    let current = true;
    void fetchHoldHistory(historyOf).then((result) => {
      if (current) setHistory(result.ok ? result.data : null);
    });
    return () => {
      current = false;
    };
  }, [historyOf]);

  const ready = answer.key === requestKey ? answer : null;
  const list = ready?.list ?? null;
  const rows = list?.rows ?? [];
  const chosen = rows.filter((r) => selected.includes(r.specimenId));
  const allowed = (a: HoldAction) =>
    chosen.length > 0 && chosen.every((r) => r.actions[ACTION_KEY[a]]);
  const targets: HoldTarget[] = chosen.map((r) => ({
    specimenId: r.specimenId,
    label: specimenLabel(r),
    projectNumber: r.project.projectNumber,
    holdKind: r.holdKind,
    castingDate: r.castingDate,
    holdExpiresOn: r.holdExpiresOn,
    version: r.version,
  }));
  const selectable = (r: ConcreteHoldRow) =>
    r.actions.scheduleTest || r.actions.authorizeDisposal || r.actions.recordDisposal;
  const toggle = (id: string) =>
    setSelected((now) => (now.includes(id) ? now.filter((x) => x !== id) : [...now, id]));
  const resetSelection = () => setSelected([]);

  const columns: Column<ConcreteHoldRow>[] = [
    {
      header: 'Select',
      cell: (r) => (
        <input
          type="checkbox"
          aria-label={`Select ${specimenLabel(r)}`}
          checked={selected.includes(r.specimenId)}
          disabled={!selectable(r)}
          onChange={() => toggle(r.specimenId)}
        />
      ),
    },
    { header: 'Project', cell: (r) => r.project.projectNumber },
    {
      header: 'Specimen ID',
      cell: (r) => (
        <button
          type="button"
          className="link-button"
          aria-label={`History of ${specimenLabel(r)}`}
          onClick={() => {
            setHistory(null);
            setHistoryOf(r.specimenId);
          }}
        >
          {specimenLabel(r)}
        </button>
      ),
    },
    { header: 'Casting date', cell: (r) => r.castingDate ?? 'Unknown' },
    {
      header: 'HOLD expiry',
      cell: (r) => (r.holdKind === 'failed' ? 'No expiry' : (r.holdExpiresOn ?? 'Unknown')),
    },
    {
      header: 'Kind',
      cell: (r) => (
        <StatusBadge tone={r.holdKind === 'failed' ? 'danger' : 'neutral'}>
          {CONCRETE_HOLD_KIND_LABEL[r.holdKind]}
        </StatusBadge>
      ),
    },
    {
      header: 'Status',
      cell: (r) => (
        <>
          <StatusBadge tone={STATUS_TONE[r.status]}>
            {CONCRETE_HOLD_STATUS_LABEL[r.status]}
          </StatusBadge>
          {r.disposal?.disposedAt ? (
            <span className="field-hint"> {new Date(r.disposal.disposedAt).toLocaleString()}</span>
          ) : null}
          {r.failureReason ? <span className="field-hint"> {r.failureReason}</span> : null}
        </>
      ),
    },
  ];

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  return (
    <section className="hold-page" aria-labelledby="hold-heading">
      <h2 id="hold-heading">HOLD management</h2>
      <p className="field-hint">
        Ordinary HOLD specimens are released by the Lead Project Engineer or a Lab Manager;
        failed-specimen holds by the Lead Project Engineer or a Lab Manager with the project’s
        concrete grant. Reaching a HOLD expiry only flags it for review.
      </p>
      <div className="hold-filters">
        <label>
          Kind{' '}
          <select
            value={kind}
            onChange={(e) => {
              setKind(e.target.value as Kind);
              setPage(1);
              resetSelection();
            }}
          >
            <option value="all">All holds</option>
            <option value="ordinary">{CONCRETE_HOLD_KIND_LABEL.ordinary}</option>
            <option value="failed">{CONCRETE_HOLD_KIND_LABEL.failed}</option>
          </select>
        </label>
        <label>
          Status{' '}
          <select
            value={status}
            onChange={(e) => {
              setStatus(e.target.value as ConcreteHoldStatusFilter);
              setPage(1);
              resetSelection();
            }}
          >
            {(Object.keys(STATUS_FILTER_LABEL) as ConcreteHoldStatusFilter[]).map((s) => (
              <option key={s} value={s}>
                {STATUS_FILTER_LABEL[s]}
                {list ? ` (${list.counts[s]})` : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Project{' '}
          <select
            value={projectId}
            onChange={(e) => {
              setProjectId(e.target.value);
              setPage(1);
              resetSelection();
            }}
          >
            <option value="">All projects</option>
            {(list?.projects ?? []).map((p) => (
              <option key={p.id} value={p.id}>
                {p.projectNumber}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="hold-actions" role="toolbar" aria-label="HOLD actions">
        <span aria-live="polite">{chosen.length} selected</span>
        {(['schedule_test', 'authorize_disposal', 'record_disposal'] as HoldAction[]).map((a) => (
          <button
            key={a}
            type="button"
            className={a === 'authorize_disposal' ? 'primary' : undefined}
            disabled={!allowed(a)}
            onClick={() => setAction(a)}
          >
            {a === 'schedule_test'
              ? 'Schedule test'
              : a === 'authorize_disposal'
                ? 'Authorize disposal'
                : 'Record disposal'}
          </button>
        ))}
      </div>
      {notice ? (
        <p role="status" className="hold-notice">
          {notice}
        </p>
      ) : null}
      {ready?.error ? (
        <ErrorState message={ready.error} onRetry={() => setReload((n) => n + 1)} />
      ) : null}
      {!ready ? <p className="field-hint">Loading…</p> : null}
      {list ? (
        <TableScroll label="HOLD specimens">
          <DataTable
            rows={rows}
            columns={columns}
            rowKey={(r) => r.specimenId}
            caption="HOLD specimens"
            empty="No specimens match these filters."
          />
        </TableScroll>
      ) : null}
      {list && list.total > list.pageSize ? (
        <nav className="pager" aria-label="HOLD pages">
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
      {historyOf ? (
        <aside className="hold-history" aria-label="HOLD history">
          <h3>History {history ? specimenLabel({ identity: history.identity }) : ''}</h3>
          {history ? (
            history.events.length === 0 ? (
              <p className="field-hint">No HOLD actions yet.</p>
            ) : (
              <ul>
                {history.events.map((e, i) => (
                  <li key={i}>
                    {new Date(e.at).toLocaleString()}:{' '}
                    {e.kind === 'test_scheduled'
                      ? `Test scheduled at ${e.newAge} d (target ${e.newTargetDate})`
                      : e.kind === 'disposal_authorized'
                        ? 'Disposal authorized'
                        : e.kind === 'disposed'
                          ? `Disposed (removed ${new Date(e.disposedAt!).toLocaleString()})`
                          : 'Failed-specimen hold'}{' '}
                    by {e.by.name}
                    {e.recordedBy ? `, recorded by ${e.recordedBy.name}` : ''}
                    {e.reason ? `: ${e.reason}` : ''}
                  </li>
                ))}
              </ul>
            )
          ) : (
            <p className="field-hint">Loading…</p>
          )}
          <button type="button" onClick={() => setHistoryOf(null)}>
            Close history
          </button>
        </aside>
      ) : null}
      <HoldActionDialog
        key={action ?? 'none'}
        action={action}
        targets={targets}
        sharedStation={me.accountType === 'shared_lab'}
        onClose={() => setAction(null)}
        onDone={(message) => {
          setAction(null);
          setNotice(message);
          resetSelection();
          setReload((n) => n + 1);
        }}
      />
    </section>
  );
}
