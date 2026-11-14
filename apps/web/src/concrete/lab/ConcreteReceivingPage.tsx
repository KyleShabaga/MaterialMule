import {
  CONCRETE_RECEIVING_STAGES,
  CONCRETE_RECEIVING_STAGE_LABEL,
  type ConcreteReceivingQueue,
  type ConcreteReceivingQueueRow,
  type ConcreteReceivingStage,
} from '@materialmule/shared';
import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import {
  DataTable,
  EmptyState,
  ErrorState,
  PageHeader,
  SectionHead,
  StatusBadge,
  type Column,
} from '../../components/app-ui';
import { LetterCells, type LedgerTone } from '../ledger';
import { fetchReceivingQueue, type LoadResult } from './api';
import { labDateTime, setLabel, setLookupPath, workflowLabel, workflowTone } from './format';
import './concrete-lab.css';

const isStage = (value: string | null): value is ConcreteReceivingStage =>
  (CONCRETE_RECEIVING_STAGES as readonly string[]).includes(value ?? '');

const STAGE_TONE: Record<ConcreteReceivingStage, LedgerTone> = {
  awaiting_pickup: 'waiting',
  awaiting_receiving: 'lab',
};

const setsLabel = (n: number) => `${n} ${n === 1 ? 'set' : 'sets'}`;

function columnsFor(stage: ConcreteReceivingStage): Column<ConcreteReceivingQueueRow>[] {
  const state = CONCRETE_RECEIVING_STAGE_LABEL[stage];
  return [
    {
      header: 'Set',
      cell: (row) => (
        <span className="concrete-cell-stack">
          <Link className="concrete-set-link" to={setLookupPath(row.setId)}>
            {setLabel(row.identity)}
          </Link>
          {row.identity.permanentId && row.identity.temporaryId ? (
            <span className="concrete-alias">also {row.identity.temporaryId}</span>
          ) : null}
        </span>
      ),
    },
    {
      header: 'Project',
      cell: (row) => (
        <span className="concrete-cell-stack">
          <span className="mono concrete-strong">{row.projectNumber}</span>
          <span className="concrete-muted">{row.projectName}</span>
        </span>
      ),
    },
    {
      header: 'Specimens',
      cell: (row) => (
        <span className="concrete-cell-stack">
          <LetterCells
            label={`Specimens ${state.toLowerCase()}`}
            cells={row.letters.map((letter) => ({
              letter,
              state: state.toLowerCase(),
              tone: STAGE_TONE[stage],
            }))}
          />
          <span className="concrete-muted">
            {row.letters.length} of {row.specimenCount}
          </span>
        </span>
      ),
    },
    {
      header: 'Cast',
      cell: (row) =>
        row.castAt ? (
          <span className="mono concrete-nowrap">{labDateTime(row.castAt)}</span>
        ) : (
          'Casting time not recorded'
        ),
    },
    {
      header: 'Field technician',
      cell: (row) => row.technician?.name ?? 'Not recorded',
    },
    {
      header: 'Report',
      cell: (row) => (
        <StatusBadge tone={workflowTone(row.reportState)}>
          {workflowLabel(row.reportState)}
        </StatusBadge>
      ),
    },
  ];
}

/**
 * Concrete → Receiving (MM-V2-C31): sets with specimens awaiting pickup or awaiting receiving,
 * lab-wide. Personalization (confirmed by Kyle): the caller's own field tests are listed first
 * under My reports, clearly separated; everyone else's work stays listed below. Read-only: the
 * per-set receive screen (mass entry, marker check, exceptions) is not built here.
 */
export function ConcreteReceivingPage() {
  const [params, setParams] = useSearchParams();
  const stage: ConcreteReceivingStage = isStage(params.get('stage'))
    ? (params.get('stage') as ConcreteReceivingStage)
    : 'awaiting_pickup';
  const page = Math.max(1, Number(params.get('page')) || 1);
  const [attempt, setAttempt] = useState(0);
  const key = `${stage}|${page}|${attempt}`;
  const [answer, setAnswer] = useState<{
    key: string;
    load: LoadResult<ConcreteReceivingQueue>;
  } | null>(null);
  const [last, setLast] = useState<ConcreteReceivingQueue | null>(null);
  const tabRefs = useRef<Partial<Record<ConcreteReceivingStage, HTMLButtonElement | null>>>({});

  useEffect(() => {
    let current = true;
    void fetchReceivingQueue({ stage, page }).then((load) => {
      if (!current) return;
      if (load.ok) setLast(load.data);
      setAnswer({ key, load });
    });
    return () => {
      current = false;
    };
  }, [stage, page, key]);

  const load = answer?.key === key ? answer.load : null;
  const queue = load?.ok ? load.data : null;
  const counts = (queue ?? last)?.counts;

  function choose(next: ConcreteReceivingStage, focus = false) {
    const nextParams = new URLSearchParams();
    if (next !== 'awaiting_pickup') nextParams.set('stage', next);
    setParams(nextParams, { replace: true });
    if (focus) tabRefs.current[next]?.focus();
  }
  function onTabKey(event: KeyboardEvent<HTMLButtonElement>) {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    const index = CONCRETE_RECEIVING_STAGES.indexOf(stage);
    const last = CONCRETE_RECEIVING_STAGES.length - 1;
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? last
          : event.key === 'ArrowRight'
            ? index === last
              ? 0
              : index + 1
            : index === 0
              ? last
              : index - 1;
    choose(CONCRETE_RECEIVING_STAGES[next]!, true);
  }

  const mine = queue?.items.filter((r) => r.mine) ?? [];
  const others = queue?.items.filter((r) => !r.mine) ?? [];
  const pages = queue ? Math.max(1, Math.ceil(queue.total / queue.pageSize)) : 1;
  const panelId = 'concrete-receiving-panel';
  const columns = columnsFor(stage);

  return (
    <div className="concrete-lab">
      <PageHeader title="Specimen receiving" />
      <p className="concrete-intro">
        Specimens still to collect from site, and collected specimens still to receive in the lab.
        Your own field tests are listed first. Open a set to see its pickup and receipt records.
      </p>
      <div className="concrete-stage-tabs" role="tablist" aria-label="Receiving stage">
        {CONCRETE_RECEIVING_STAGES.map((s) => (
          <button
            key={s}
            ref={(el) => {
              tabRefs.current[s] = el;
            }}
            type="button"
            role="tab"
            id={`concrete-receiving-tab-${s}`}
            aria-selected={s === stage}
            aria-controls={panelId}
            tabIndex={s === stage ? 0 : -1}
            onClick={() => choose(s)}
            onKeyDown={onTabKey}
          >
            {CONCRETE_RECEIVING_STAGE_LABEL[s]}
            {counts ? <span className="concrete-tab-count"> ({counts[s]})</span> : null}
          </button>
        ))}
      </div>
      <div
        id={panelId}
        role="tabpanel"
        className="concrete-lab-section"
        aria-labelledby={`concrete-receiving-tab-${stage}`}
        aria-busy={load === null}
      >
        {load && !load.ok ? (
          <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
        ) : load === null ? (
          <p className="field-hint">Loading…</p>
        ) : queue && queue.total === 0 ? (
          <EmptyState>Nothing is {CONCRETE_RECEIVING_STAGE_LABEL[stage].toLowerCase()}.</EmptyState>
        ) : queue ? (
          <>
            <section className="concrete-lab-section" aria-labelledby="receiving-mine">
              <SectionHead
                id="receiving-mine"
                title="My reports"
                meta={setsLabel(queue.mineTotal)}
              />
              <DataTable
                rows={mine}
                columns={columns}
                rowKey={(row) => row.setId}
                caption={`My reports, ${CONCRETE_RECEIVING_STAGE_LABEL[stage]}`}
                empty={
                  queue.mineTotal === 0
                    ? 'None of your field tests are waiting here.'
                    : 'Your field tests are on an earlier page.'
                }
              />
            </section>
            <section className="concrete-lab-section" aria-labelledby="receiving-others">
              <SectionHead
                id="receiving-others"
                title="Other reports"
                meta={setsLabel(queue.total - queue.mineTotal)}
              />
              <DataTable
                rows={others}
                columns={columns}
                rowKey={(row) => row.setId}
                caption={`Other reports, ${CONCRETE_RECEIVING_STAGE_LABEL[stage]}`}
                empty={
                  queue.total - queue.mineTotal === 0
                    ? 'No one else’s field tests are waiting here.'
                    : 'Other reports continue on the next page.'
                }
              />
            </section>
            {pages > 1 ? (
              <nav className="concrete-pager" aria-label="Pages">
                <button
                  type="button"
                  disabled={page <= 1}
                  onClick={() => setParams(withPage(params, page - 1), { replace: true })}
                >
                  Previous
                </button>
                <span className="mono">
                  Page {page} of {pages}
                </span>
                <button
                  type="button"
                  disabled={page >= pages}
                  onClick={() => setParams(withPage(params, page + 1), { replace: true })}
                >
                  Next
                </button>
              </nav>
            ) : null}
          </>
        ) : null}
      </div>
    </div>
  );
}

function withPage(params: URLSearchParams, page: number) {
  const next = new URLSearchParams(params);
  if (page > 1) next.set('page', String(page));
  else next.delete('page');
  return next;
}
