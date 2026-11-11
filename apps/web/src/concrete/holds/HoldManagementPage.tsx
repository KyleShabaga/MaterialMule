import {
  CONCRETE_HOLD_KIND_LABEL,
  CONCRETE_HOLD_STATUS_LABEL,
  type ConcreteHoldHistory,
  type ConcreteHoldList,
  type ConcreteHoldRow,
  type ConcreteHoldStatus,
  type ConcreteHoldStatusFilter,
} from '@materialmule/shared';
import { useEffect, useId, useState } from 'react';
import {
  EmptyState,
  ErrorState,
  FormField,
  Notice,
  PageHeader,
  SidePanel,
  StatusBadge,
  TableScroll,
  type BadgeTone,
} from '../../components/ui';
import { useMe } from '../../session/context';
import { SpecimenLabel } from '../worklist/specimen';
import { specimenText } from '../worklist/specimen-text';
import { fetchHoldHistory, fetchHolds } from './api';
import { HoldActionDialog, type HoldAction, type HoldTarget } from './HoldActionDialog';
import './holds.css';

type Kind = 'all' | 'ordinary' | 'failed';

const STATUS_TONE: Record<ConcreteHoldStatus, BadgeTone> = {
  held: 'closed',
  review_due: 'waiting',
  disposal_authorized: 'lab',
  disposed: 'storage',
};

const STATUS_FILTER_LABEL: Record<ConcreteHoldStatusFilter, string> = {
  open: 'On hold',
  disposal_authorized: 'Disposal authorized',
  disposed: 'Disposed',
  all: 'All',
};

const specimenLabel = (row: { identity: ConcreteHoldRow['identity']; letter?: string }) =>
  specimenText(row.identity, row.letter);

const ACTION_KEY: Record<HoldAction, keyof ConcreteHoldRow['actions']> = {
  schedule_test: 'scheduleTest',
  authorize_disposal: 'authorizeDisposal',
  record_disposal: 'recordDisposal',
};

const ACTION_LABEL: Record<HoldAction, string> = {
  schedule_test: 'Schedule test',
  authorize_disposal: 'Authorize disposal',
  record_disposal: 'Record disposal',
};

/** Schedule test and Authorize disposal record the panel's reason; Record disposal takes none. */
const NEEDS_REASON: Record<HoldAction, boolean> = {
  schedule_test: true,
  authorize_disposal: true,
  record_disposal: false,
};

interface Band {
  key: string;
  title: string;
  tag: string;
  tone: BadgeTone;
  rows: ConcreteHoldRow[];
}

/**
 * The rows in bands, from the status and kind the server returns: "Review due" (the HOLD expiry
 * is reached) is "Hold period has ended". In the open view the two HOLD bands always show; the
 * others only when they have rows.
 */
function bandsOf(rows: ConcreteHoldRow[], status: ConcreteHoldStatusFilter): Band[] {
  const bands: Band[] = [
    {
      key: 'review_due',
      title: 'Hold period has ended',
      tag: CONCRETE_HOLD_STATUS_LABEL.review_due,
      tone: 'waiting',
      rows: rows.filter((r) => r.status === 'review_due'),
    },
    {
      key: 'held',
      title: 'Still inside the hold period',
      tag: CONCRETE_HOLD_STATUS_LABEL.held,
      tone: 'closed',
      rows: rows.filter((r) => r.status === 'held' && r.holdKind !== 'failed'),
    },
    {
      key: 'failed',
      title: 'Held after a failed result',
      tag: 'No expiry',
      tone: 'danger',
      rows: rows.filter((r) => r.status === 'held' && r.holdKind === 'failed'),
    },
    {
      key: 'disposal_authorized',
      title: 'Waiting for removal',
      tag: CONCRETE_HOLD_STATUS_LABEL.disposal_authorized,
      tone: 'lab',
      rows: rows.filter((r) => r.status === 'disposal_authorized'),
    },
    {
      key: 'disposed',
      title: 'Removed',
      tag: CONCRETE_HOLD_STATUS_LABEL.disposed,
      tone: 'storage',
      rows: rows.filter((r) => r.status === 'disposed'),
    },
  ];
  const always = status === 'open' ? ['review_due', 'held'] : [];
  return bands.filter((band) => band.rows.length > 0 || always.includes(band.key));
}

/**
 * Concrete → Holds (MM-V2-C26): ordinary HOLD and failed-specimen holds in bands (hold period
 * ended, still inside it, failed-result holds, and authorized / removed for the other filters),
 * told apart by kind. Select specimens, write the reason in the side panel and choose Schedule
 * test, Authorize disposal or Record disposal; a confirmation lists each specimen and its change.
 * A HOLD past its expiry is only flagged Review due: nothing happens on a date.
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
  const [reason, setReason] = useState('');
  const [action, setAction] = useState<HoldAction | null>(null);
  const [notice, setNotice] = useState('');
  const [historyOf, setHistoryOf] = useState<string | null>(null);
  const [history, setHistory] = useState<ConcreteHoldHistory | null>(null);
  const whyId = useId();

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
  const hasReason = reason.trim() !== '';
  const allowed = (a: HoldAction) =>
    chosen.length > 0 &&
    chosen.every((r) => r.actions[ACTION_KEY[a]]) &&
    (!NEEDS_REASON[a] || hasReason);
  const why =
    chosen.length === 0
      ? 'Select at least one specimen.'
      : !hasReason
        ? 'Write a reason to schedule a test or authorize disposal.'
        : 'Each action is offered when every selected specimen allows it.';
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
  const openHistory = (r: ConcreteHoldRow) => {
    setHistory(null);
    setHistoryOf(r.specimenId);
  };

  const totalPages = list ? Math.max(1, Math.ceil(list.total / list.pageSize)) : 1;
  const bands = list ? bandsOf(rows, status) : [];
  return (
    <div className="hold-page">
      <PageHeader title="Concrete holds" />
      {list ? (
        <p className="hold-dateline">
          {list.counts.open} {list.counts.open === 1 ? 'specimen' : 'specimens'} on hold · as of{' '}
          <span className="mono">{list.today}</span>
        </p>
      ) : null}
      <div className="hold-filters">
        <label>
          <span className="field-label">Kind</span>
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
          <span className="field-label">Status</span>
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
          <span className="field-label">Project</span>
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
      {notice ? <Notice tone="success">{notice}</Notice> : null}
      {ready?.error ? (
        <ErrorState message={ready.error} onRetry={() => setReload((n) => n + 1)} />
      ) : null}
      {!ready ? <p className="field-hint">Loading…</p> : null}
      <div className="hold-layout">
        <div className="hold-bands" role="region" aria-label="HOLD specimens">
          {list && bands.length === 0 ? (
            <EmptyState>No specimens match these filters.</EmptyState>
          ) : null}
          {bands.map((band) => (
            <HoldBand
              key={band.key}
              band={band}
              selected={selected}
              selectable={selectable}
              onToggle={toggle}
              onHistory={openHistory}
            />
          ))}
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
          <p className="hold-footnote">
            Nothing on hold is tested, released or disposed of automatically: reaching a HOLD expiry
            only flags it for review. Every action here needs a person, and scheduling or
            authorizing needs a reason.
          </p>
        </div>
        <SidePanel
          title="With the selected"
          className="hold-panel"
          aside={
            <span className="section-meta" aria-live="polite">
              {chosen.length} selected
            </span>
          }
        >
          {chosen.length === 0 ? (
            <p className="field-hint">Select specimens in the lists to act on them.</p>
          ) : (
            <ul className="hold-selected" aria-label="Selected specimens">
              {chosen.map((r) => (
                <li key={r.specimenId}>
                  <SpecimenLabel identity={r.identity} letter={r.letter} />
                  <span className="mono">{r.project.projectNumber}</span>
                </li>
              ))}
            </ul>
          )}
          <FormField
            label="Reason"
            required
            hint="Recorded with each specimen when you schedule a test or authorize disposal."
          >
            {(props) => (
              <textarea
                {...props}
                rows={3}
                value={reason}
                maxLength={2000}
                onChange={(e) => setReason(e.target.value)}
              />
            )}
          </FormField>
          <div className="hold-panel-actions" role="group" aria-label="HOLD actions">
            {(['schedule_test', 'authorize_disposal', 'record_disposal'] as HoldAction[]).map(
              (a) => (
                <button
                  key={a}
                  type="button"
                  className={
                    a === 'schedule_test'
                      ? 'primary'
                      : a === 'authorize_disposal'
                        ? 'danger'
                        : undefined
                  }
                  disabled={!allowed(a)}
                  aria-describedby={allowed(a) ? undefined : whyId}
                  onClick={() => setAction(a)}
                >
                  {ACTION_LABEL[a]}
                </button>
              ),
            )}
          </div>
          <p id={whyId} className="field-hint">
            {why}
          </p>
          <p className="field-hint">
            Ordinary HOLD specimens are released by the Lead Project Engineer or a Lab Manager;
            failed-specimen holds by the Lead Project Engineer or a Lab Manager with the project’s
            concrete grant. Lab staff record the removal.
          </p>
        </SidePanel>
      </div>
      {historyOf ? (
        <aside className="hold-history" aria-label="HOLD history">
          <h2>History {history ? specimenLabel({ identity: history.identity }) : ''}</h2>
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
        reason={reason.trim()}
        sharedStation={me.accountType === 'shared_lab'}
        onClose={() => setAction(null)}
        onDone={(message) => {
          setAction(null);
          setNotice(message);
          setReason('');
          resetSelection();
          setReload((n) => n + 1);
        }}
      />
    </div>
  );
}

/** One band: tag, title and count over a framed table with a checkbox per row. */
function HoldBand({
  band,
  selected,
  selectable,
  onToggle,
  onHistory,
}: {
  band: Band;
  selected: string[];
  selectable: (row: ConcreteHoldRow) => boolean;
  onToggle: (specimenId: string) => void;
  onHistory: (row: ConcreteHoldRow) => void;
}) {
  const headingId = useId();
  return (
    <section className="hold-band" aria-labelledby={headingId}>
      <div className="hold-band-head">
        <StatusBadge tone={band.tone}>{band.tag}</StatusBadge>
        <h2 id={headingId}>{band.title}</h2>
        <span className="section-meta">
          {band.rows.length} {band.rows.length === 1 ? 'specimen' : 'specimens'}
        </span>
      </div>
      {band.rows.length === 0 ? (
        <EmptyState>None right now.</EmptyState>
      ) : (
        <TableScroll label={band.title} className="table-frame">
          <table className="data-table">
            <caption className="visually-hidden">{band.title}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">Select</span>
                </th>
                <th scope="col">Specimen ID</th>
                <th scope="col">Project</th>
                <th scope="col">Casting date</th>
                <th scope="col">HOLD expiry</th>
                <th scope="col">Kind</th>
                <th scope="col">Status</th>
              </tr>
            </thead>
            <tbody>
              {band.rows.map((r) => {
                const isSelected = selected.includes(r.specimenId);
                return (
                  <tr key={r.specimenId} className={isSelected ? 'is-selected' : undefined}>
                    <td data-label="Select">
                      <input
                        type="checkbox"
                        aria-label={`Select ${specimenLabel(r)}`}
                        checked={isSelected}
                        disabled={!selectable(r)}
                        onChange={() => onToggle(r.specimenId)}
                      />
                    </td>
                    <td data-label="Specimen ID">
                      <button
                        type="button"
                        className="link-button"
                        aria-label={`History of ${specimenLabel(r)}`}
                        onClick={() => onHistory(r)}
                      >
                        <SpecimenLabel identity={r.identity} letter={r.letter} />
                      </button>
                    </td>
                    <td data-label="Project" className="mono">
                      {r.project.projectNumber}
                    </td>
                    <td data-label="Casting date" className="mono">
                      {r.castingDate ?? 'Unknown'}
                    </td>
                    <td data-label="HOLD expiry" className="mono">
                      {r.holdKind === 'failed' ? 'No expiry' : (r.holdExpiresOn ?? 'Unknown')}
                    </td>
                    <td data-label="Kind">
                      <StatusBadge tone={r.holdKind === 'failed' ? 'danger' : 'closed'}>
                        {CONCRETE_HOLD_KIND_LABEL[r.holdKind]}
                      </StatusBadge>
                    </td>
                    <td data-label="Status">
                      <StatusBadge tone={STATUS_TONE[r.status]}>
                        {CONCRETE_HOLD_STATUS_LABEL[r.status]}
                      </StatusBadge>
                      {r.disposal?.disposedAt ? (
                        <span className="field-hint">
                          {' '}
                          {new Date(r.disposal.disposedAt).toLocaleString()}
                        </span>
                      ) : null}
                      {r.failureReason ? (
                        <span className="field-hint"> {r.failureReason}</span>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </TableScroll>
      )}
    </section>
  );
}
