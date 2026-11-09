import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorState, PageHeader } from '../../components/ui';
import { fetchDashboardCounts, type ConcreteDashboardCounts, type LoadResult } from './api';
import { ConcreteSearchForm } from './ConcreteSearch';
import './concrete-lab.css';

interface Count {
  key: keyof ConcreteDashboardCounts;
  label: string;
  to: string;
  /** A count above zero needs attention now (shown with a marker and text, never colour alone). */
  urgent?: boolean;
}

/** Each count opens the list it was read from (AC3). */
const GROUPS: { title: string; counts: Count[] }[] = [
  {
    title: 'Receiving',
    counts: [
      { key: 'awaitingPickup', label: 'Awaiting pickup', to: '/concrete/receiving' },
      {
        key: 'awaitingReceiving',
        label: 'Awaiting receiving',
        to: '/concrete/receiving?stage=awaiting_receiving',
      },
    ],
  },
  {
    title: 'Testing',
    counts: [
      { key: 'testsToday', label: 'Tests due today', to: '/lab-testing/concrete' },
      {
        key: 'testsOverdue',
        label: 'Tests overdue',
        to: '/lab-testing/concrete?view=overdue',
        urgent: true,
      },
      {
        key: 'holdsDue',
        label: 'HOLDs due for review',
        to: '/lab-testing/concrete?view=hold&holdDue=true',
      },
    ],
  },
  {
    title: 'Reports',
    counts: [
      { key: 'awaitingReview', label: 'Awaiting review', to: '/concrete/review' },
      {
        key: 'awaitingIssue',
        label: 'Awaiting issuance',
        to: '/concrete/review?status=reviewed_awaiting_issue',
      },
    ],
  },
];

/**
 * The Concrete dashboard (MM-V2-C31, "Daily lab briefing" confirmed by Kyle): counts readable at a
 * glance, each opening its list; New field report and Open testing table shortcuts; Concrete
 * search. Lists are lab-wide; My reports come first in pickup and receiving.
 */
export function ConcreteDashboardPage() {
  const [attempt, setAttempt] = useState(0);
  // Each answer is kept with the attempt it answers; until it arrives the counts read as loading.
  const [answer, setAnswer] = useState<{
    attempt: number;
    load: LoadResult<ConcreteDashboardCounts>;
  } | null>(null);
  const load = answer?.attempt === attempt ? answer.load : null;
  const newReportHint = useId();

  useEffect(() => {
    let current = true;
    void fetchDashboardCounts().then((result) => current && setAnswer({ attempt, load: result }));
    return () => {
      current = false;
    };
  }, [attempt]);

  return (
    <div className="concrete-lab concrete-dashboard">
      <PageHeader
        title="Concrete"
        actions={
          <div className="concrete-shortcuts">
            <span className="concrete-shortcut-disabled">
              <button type="button" className="button" disabled aria-describedby={newReportHint}>
                New field report
              </button>
              <span id={newReportHint} className="field-hint">
                The field report form isn’t available yet.
              </span>
            </span>
            <Link className="button primary" to="/lab-testing/concrete">
              Open testing table
            </Link>
          </div>
        }
      />

      {load && !load.ok ? (
        <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

      <div className="concrete-count-groups">
        {GROUPS.map((group) => (
          <CountGroup key={group.title} title={group.title} counts={group.counts} load={load} />
        ))}
      </div>

      <section className="dash-panel concrete-dashboard-search" aria-labelledby="concrete-search">
        <h2 id="concrete-search">Find concrete records</h2>
        <ConcreteSearchForm />
      </section>
    </div>
  );
}

function CountGroup({
  title,
  counts,
  load,
}: {
  title: string;
  counts: Count[];
  load: LoadResult<ConcreteDashboardCounts> | null;
}) {
  const headingId = useId();
  const data = load?.ok ? load.data : null;
  return (
    <section className="concrete-count-group" aria-labelledby={headingId}>
      <h2 id={headingId}>{title}</h2>
      <ul className="concrete-counts" aria-busy={load === null}>
        {counts.map((count) => {
          const value = data ? data[count.key] : null;
          const urgent = count.urgent && value !== null && value > 0;
          return (
            <li key={count.key}>
              <Link
                to={count.to}
                className={urgent ? 'concrete-count concrete-count-urgent' : 'concrete-count'}
              >
                <span className="concrete-count-value">{value ?? '–'}</span>{' '}
                <span className="concrete-count-label">
                  {count.label}
                  {urgent ? (
                    <>
                      {' '}
                      <span className="concrete-count-flag">(needs attention)</span>
                    </>
                  ) : null}
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
