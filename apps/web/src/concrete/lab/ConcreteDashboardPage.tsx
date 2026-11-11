import { useEffect, useId, useState } from 'react';
import { Link } from 'react-router';
import { ErrorState, PageHeader, SectionHead } from '../../components/ui';
import { ContextRow } from '../../layout/ContextRow';
import { TileBody } from '../ledger';
import { fetchDashboardCounts, type ConcreteDashboardCounts, type LoadResult } from './api';
import { ConcreteSearchForm } from './ConcreteSearch';
import './concrete-lab.css';
import { StrengthReportList } from '../../concrete-review/StrengthReportList';

interface Count {
  key: keyof ConcreteDashboardCounts;
  label: string;
  to: string;
  /** A count above zero needs attention now (shown with a flag-wash tile and text, never colour alone). */
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
 * glance as view tiles, each opening its list; New field report and Open testing table shortcuts
 * in the context row; Concrete search. Lists are lab-wide; My reports come first in pickup and
 * receiving.
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
      <ContextRow align="end">
        <span className="concrete-shortcut-disabled">
          <button type="button" disabled aria-describedby={newReportHint}>
            New field report
          </button>
          <span id={newReportHint} className="field-hint">
            The field report form isn’t available yet.
          </span>
        </span>
        <Link className="button primary" to="/concrete/testing">
          Open testing table
        </Link>
      </ContextRow>
      <PageHeader title="Concrete" />

      {load && !load.ok ? (
        <ErrorState message={load.message} onRetry={() => setAttempt((n) => n + 1)} />
      ) : null}

      <div className="concrete-count-groups">
        {GROUPS.map((group) => (
          <CountGroup key={group.title} title={group.title} counts={group.counts} load={load} />
        ))}
      </div>

      <section className="concrete-lab-section" aria-labelledby="concrete-strength-reports">
        <SectionHead id="concrete-strength-reports" title="Strength reports for the lab" />
        <p className="field-hint">
          Sets with results to submit, a returned report to correct, or a new age after an issue.
        </p>
        <StrengthReportList
          needsLab
          caption="Strength reports for the lab"
          empty="No strength reports need the lab right now."
        />
      </section>

      <section className="concrete-lab-section" aria-labelledby="concrete-search">
        <SectionHead id="concrete-search" title="Find concrete records" />
        <ConcreteSearchForm primary={false} />
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
      <SectionHead id={headingId} title={title} />
      <div className="view-tiles" aria-busy={load === null}>
        {counts.map((count) => {
          const value = data ? data[count.key] : null;
          const urgent = Boolean(count.urgent && value !== null && value > 0);
          const shown = value ?? '–';
          return (
            <Link
              key={count.key}
              to={count.to}
              className={urgent ? 'view-tile-due' : undefined}
              // The tile shows the count over the label; the name reads them in one line.
              aria-label={`${shown} ${count.label}${urgent ? ' (needs attention)' : ''}`}
            >
              <TileBody
                count={shown}
                label={
                  <>
                    {count.label}
                    {urgent ? (
                      <span className="concrete-count-flag"> (needs attention)</span>
                    ) : null}
                  </>
                }
              />
            </Link>
          );
        })}
      </div>
    </section>
  );
}
