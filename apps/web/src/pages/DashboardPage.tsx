import { Link } from 'react-router';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { fetchRecentActivity } from '../dashboard/api';
import '../dashboard/dashboard.css';
import { DraftsCard } from '../dashboard/DashboardDrafts';
import { draftCountText, useDashboardDrafts } from '../dashboard/drafts';
import { shortDateTime } from '../dashboard/format';
import { LabelPrinterCard } from '../dashboard/LabelPrinterCard';
import { RecentlyReceived } from '../dashboard/RecentlyReceived';
import { useLoad } from '../dashboard/useLoad';
import { LookUpId } from '../inventory/LookUpId';
import { CameraScanButton } from '../scanning/CameraScanButton';
import { useMe } from '../session/context';

// Dashboard as approved by Kyle on 2026-10-27 (canvas artboard "APPROVED — Dashboard"):
// Receive samples and look-up on top, Recently received, then Recent activity, drafts on this
// computer and (admins only) the label printer.

export function DashboardPage() {
  const me = useMe();
  const drafts = useDashboardDrafts(me);
  const showPrinter = me.permissions.includes('system.status.read');

  return (
    <div className="dashboard">
      <PageHeader title="Dashboard" />

      <div className="dash-top">
        <section className="dash-panel dash-receive" aria-labelledby="dash-receive">
          <div className="dash-receive-intro">
            <span className="dash-receive-icon" aria-hidden="true">
              <svg
                width="22"
                height="22"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7l9-4 9 4-9 4-9-4z" />
                <path d="M3 7v10l9 4 9-4V7" />
                <path d="M12 11v10" />
              </svg>
            </span>
            <div>
              <h2 id="dash-receive">Receive samples</h2>
              <p>
                Record buckets for a project, print their labels, and they appear in Sample Storage.
              </p>
            </div>
          </div>
          <div className="dash-receive-actions">
            <Link className="button primary receive-button" to="/receiving-log/new">
              <span aria-hidden="true">+</span>
              Receive samples
            </Link>
            {drafts.state === 'ready' && drafts.drafts.length > 0 ? (
              <>
                <Link className="button" to="/receiving-log/new">
                  Resume a draft ({drafts.drafts.length})
                </Link>
                <span className="dash-receive-count">{draftCountText(drafts.drafts)}</span>
              </>
            ) : null}
          </div>
        </section>

        <div className="dash-panel dash-lookup">
          <LookUpId
            className="dash-lookup-form"
            heading="Look up a storage unit"
            label="Storage unit ID"
            hint="Scan the label or type the ID. On a phone, use Scan with camera."
          />
          <CameraScanButton />
        </div>
      </div>

      <RecentlyReceived />

      <div className={showPrinter ? 'dash-lower dash-lower-3' : 'dash-lower'}>
        <RecentActivity />
        <DraftsCard drafts={drafts} />
        {showPrinter ? <LabelPrinterCard /> : null}
      </div>
    </div>
  );
}

function RecentActivity() {
  const [activity, retry] = useLoad('activity', fetchRecentActivity);
  return (
    <section className="dash-panel" aria-labelledby="dash-activity">
      <div className="dash-head">
        <h2 id="dash-activity">Recent activity</h2>
      </div>
      <div className="dash-body">
        {activity.state === 'loading' ? (
          <ul className="activity skeleton" aria-busy="true" aria-label="Loading recent activity">
            <li />
            <li />
            <li />
          </ul>
        ) : activity.state === 'error' ? (
          <ErrorState message={activity.message} onRetry={retry} />
        ) : activity.data.length === 0 ? (
          <EmptyState>No activity yet. Receive the first storage unit.</EmptyState>
        ) : (
          <ul className="dash-activity">
            {activity.data.map((item) => (
              <li key={item.id}>
                <time dateTime={item.occurredAt}>{shortDateTime(item.occurredAt)}</time>
                <span>{item.href ? <Link to={item.href}>{item.summary}</Link> : item.summary}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
