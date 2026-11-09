import {
  CONCRETE_HOLD_AGE,
  type ConcreteReceivingSpecimenState,
  type ConcreteRescheduleEntry,
} from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import {
  DataTable,
  ErrorState,
  PageHeader,
  StatusBadge,
  TableScroll,
  type BadgeTone,
} from '../../components/ui';
import { fetchScheduleHistory, fetchSetLookup, type LoadResult, type SetLookup } from './api';
import { ageLabel, labDateTime, setLabel, workflowLabel } from './format';
import './concrete-lab.css';

const STATE: Record<ConcreteReceivingSpecimenState, { label: string; tone: BadgeTone }> = {
  awaiting_pickup: { label: 'Awaiting pickup', tone: 'warning' },
  picked_up: { label: 'Awaiting receiving', tone: 'info' },
  received: { label: 'Received', tone: 'success' },
  missing_resolved: { label: 'Missing (resolved)', tone: 'neutral' },
};

interface HistoryEntry {
  at: string;
  text: string;
}

/** One time-ordered history from the set, receiving and schedule records (newest first). */
function historyOf(
  data: SetLookup,
  reschedules: Map<string, ConcreteRescheduleEntry[]>,
): HistoryEntry[] {
  const { set, receiving } = data;
  const letterOf = new Map(set.specimens.map((s) => [s.id, s.letter]));
  const letters = (ids: readonly string[]) =>
    ids
      .map((id) => letterOf.get(id))
      .filter(Boolean)
      .join(', ');
  const entries: HistoryEntry[] = [];
  entries.push({
    at: set.createdAt,
    text: `Set recorded${set.createdBy ? ` by ${set.createdBy.name}` : ''}`,
  });
  if (set.castAt) entries.push({ at: set.castAt, text: 'Cast' });
  for (const sp of receiving.specimens) {
    const p = sp.pickup;
    if (p?.completed && p.collectedAt) {
      entries.push({
        at: p.collectedAt,
        text: `${sp.letter} picked up by ${p.collectedBy?.name ?? 'someone'} (curing ${p.curingMinC}–${p.curingMaxC} °C${p.curingFlags?.length ? ', out of range' : ''})`,
      });
    }
    if (p?.curingResolution) {
      entries.push({
        at: p.curingResolution.at,
        text: `${sp.letter} curing flag resolved by ${p.curingResolution.by.name}: ${p.curingResolution.note}`,
      });
    }
    const r = sp.receipt;
    if (r) {
      entries.push({
        at: r.receivedAt,
        text: `${sp.letter} received by ${r.receivedBy.name}, ${r.massG} g`,
      });
      for (const c of r.corrections) {
        entries.push({
          at: c.at,
          text: `${sp.letter} mass corrected ${c.previousMassG} → ${c.newMassG} g by ${c.by.name}: ${c.reason}`,
        });
      }
    }
    for (const x of reschedules.get(sp.specimenId) ?? []) {
      entries.push({
        at: x.at,
        text: `${sp.letter} rescheduled ${x.previousAge} d → ${x.newAge} d (${x.previousTargetDate} → ${x.newTargetDate}) by ${x.by.name}: ${x.reason}`,
      });
    }
  }
  for (const m of receiving.markerConfirmations) {
    entries.push({
      at: m.confirmedAt,
      text: `Marker IDs confirmed on ${letters(m.specimenIds)} by ${m.confirmedBy.name}`,
    });
  }
  for (const e of receiving.exceptions) {
    const which = e.specimenId ? ` ${letterOf.get(e.specimenId) ?? ''}` : '';
    entries.push({
      at: e.createdAt,
      text: `${e.kind[0]!.toUpperCase()}${e.kind.slice(1)} specimen${which} reported by ${e.reportedBy.name}${e.note ? `: ${e.note}` : ''}`,
    });
    if (e.resolution) {
      entries.push({
        at: e.resolution.at,
        text: `${e.kind[0]!.toUpperCase()}${e.kind.slice(1)} specimen${which} resolved by ${e.resolution.by.name}: ${e.resolution.disposition}`,
      });
    }
  }
  if (set.void) entries.push({ at: set.void.voidedAt, text: `Set made Void: ${set.void.reason}` });
  return entries.sort((a, b) => b.at.localeCompare(a.at));
}

/**
 * Specimen lookup → one set (MM-V2-C31): the project shown prominently, the field report's cast
 * information, each specimen's schedule and receiving state, and one history. Read-only: it
 * reuses C05's set, C06's receiving and C22's schedule-history reads.
 */
export function SetLookupPage() {
  const { setId = '' } = useParams();
  const [params] = useSearchParams();
  const letter = params.get('letter');
  const [attempt, setAttempt] = useState(0);
  const [load, setLoad] = useState<LoadResult<SetLookup> | null>(null);
  const [reschedules, setReschedules] = useState(new Map<string, ConcreteRescheduleEntry[]>());

  useEffect(() => {
    let current = true;
    setLoad(null);
    void fetchSetLookup(setId).then(async (result) => {
      if (!current) return;
      setLoad(result);
      if (!result.ok) return;
      const histories = await Promise.all(
        result.data.set.specimens.map((s) => fetchScheduleHistory(s.id)),
      );
      if (!current) return;
      setReschedules(
        new Map(histories.flatMap((h) => (h.ok ? [[h.data.specimenId, h.data.history]] : []))),
      );
    });
    return () => {
      current = false;
    };
  }, [setId, attempt]);

  if (load === null) {
    return (
      <div className="concrete-lab">
        <PageHeader title="Specimen set" />
        <p className="field-hint" aria-busy="true">
          Loading…
        </p>
      </div>
    );
  }
  if (!load.ok) {
    return (
      <div className="concrete-lab">
        <PageHeader title="Specimen set" />
        <ErrorState
          message={load.message}
          onRetry={load.notFound ? undefined : () => setAttempt((n) => n + 1)}
        />
        <p>
          <Link to="/concrete/specimens">Look up another set</Link>
        </p>
      </div>
    );
  }

  const { set, receiving, report } = load.data;
  const stateOf = new Map(receiving.specimens.map((s) => [s.specimenId, s]));
  const f = report.fields;
  const facts: [string, string | null][] = [
    ['Cast', set.castAt ? labDateTime(set.castAt) : 'Casting time not recorded'],
    ['Report', workflowLabel(report.workflow.state)],
    ['Report date', f.reportDate],
    ['Field ID', f.paperFieldId],
    [
      'Ticket',
      f.ticketNumber ? `${f.ticketNumber}${f.supplierName ? ` (${f.supplierName})` : ''}` : null,
    ],
    ['Mix', f.mixNumber],
    ['Field technician', set.technician?.name ?? report.technician?.name ?? null],
    ['Specimen type', `${set.specimenType}${set.mouldSize ? `, ${set.mouldSize}` : ''}`],
    [
      'Pick up by (estimate)',
      receiving.pickupWindow.endsAt ? labDateTime(receiving.pickupWindow.endsAt) : null,
    ],
  ];
  const history = historyOf(load.data, reschedules);

  return (
    <div className="concrete-lab">
      <PageHeader title={`Set ${setLabel(set.identity)}`} />
      <p className="concrete-project-context">
        Project{' '}
        <Link to={`/projects/${report.projectId}`}>
          <strong>{report.projectNumber}</strong>
        </Link>{' '}
        {report.projectName}
        {report.client ? ` · ${report.client}` : ''}
      </p>
      <p className="concrete-aliases">
        Permanent ID: <strong>{set.identity.permanentId ?? 'not yet assigned'}</strong> · Temporary
        ID: <strong>{set.identity.temporaryId ?? 'none'}</strong>
        {set.void ? (
          <>
            {' '}
            <StatusBadge tone="danger">Void</StatusBadge>
          </>
        ) : null}
      </p>

      <section className="dash-panel" aria-labelledby="set-cast">
        <h2 id="set-cast">Field report</h2>
        <dl className="concrete-facts">
          {facts
            .filter(([, v]) => v)
            .map(([label, value]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd>{value}</dd>
              </div>
            ))}
        </dl>
      </section>

      <section aria-labelledby="set-specimens">
        <h2 id="set-specimens">Specimens</h2>
        <TableScroll label="Specimens">
          <DataTable
            rows={set.specimens}
            rowKey={(s) => s.id}
            caption={`Specimens in set ${setLabel(set.identity)}`}
            empty="No specimens recorded."
            columns={[
              {
                header: 'Specimen',
                cell: (s) => (
                  <span className={s.letter === letter ? 'concrete-set-matched' : undefined}>
                    <strong>{s.identity.permanentId ?? s.identity.temporaryId ?? s.letter}</strong>
                    {s.identity.permanentId && s.identity.temporaryId ? (
                      <span className="concrete-alias"> also {s.identity.temporaryId}</span>
                    ) : null}
                    {s.letter === letter ? (
                      <span className="visually-hidden"> (searched)</span>
                    ) : null}
                  </span>
                ),
              },
              { header: 'Age', cell: (s) => ageLabel(s.assignedAge) },
              {
                header: 'Test date',
                cell: (s) =>
                  s.assignedAge === CONCRETE_HOLD_AGE
                    ? s.holdExpiresOn
                      ? `Hold until ${s.holdExpiresOn}`
                      : '—'
                    : (s.targetDate ?? '—'),
              },
              {
                header: 'Receiving',
                cell: (s) => {
                  const r = stateOf.get(s.id);
                  if (!r) return '—';
                  const state = STATE[r.state];
                  return <StatusBadge tone={state.tone}>{state.label}</StatusBadge>;
                },
              },
              {
                header: 'Mass',
                cell: (s) => {
                  const r = stateOf.get(s.id)?.receipt;
                  return r ? `${r.massG} g` : '—';
                },
              },
              {
                header: 'Rescheduled',
                cell: (s) => {
                  const n = reschedules.get(s.id)?.length ?? 0;
                  return n === 0 ? 'No' : n === 1 ? 'Once' : `${n} times`;
                },
              },
            ]}
          />
        </TableScroll>
      </section>

      <section aria-labelledby="set-history">
        <h2 id="set-history">History</h2>
        <ol className="concrete-history">
          {history.map((entry, i) => (
            <li key={`${entry.at}-${i}`}>
              <time dateTime={entry.at}>{labDateTime(entry.at)}</time> <span>{entry.text}</span>
            </li>
          ))}
        </ol>
        <p className="field-hint">Test results appear here once strength testing is recorded.</p>
      </section>
    </div>
  );
}
