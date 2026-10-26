import { activityResponseSchema, type ActivityItem } from '@trapezoid/shared';
import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { apiFetch } from '../api/client';
import { EmptyState, ErrorState, PageHeader } from '../components/ui';
import { SystemStatus } from './SystemStatus';

type Activity =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; items: ActivityItem[] };

async function loadActivity(): Promise<Activity> {
  try {
    const response = await apiFetch('/api/activity/recent?limit=20');
    if (!response.ok) {
      return {
        state: 'error',
        message: `Recent activity couldn't load (HTTP ${response.status}).`,
      };
    }
    return { state: 'ready', items: activityResponseSchema.parse(await response.json()) };
  } catch {
    return { state: 'error', message: "Recent activity couldn't load. Check the connection." };
  }
}

const timeFormat = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'America/Edmonton',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

export function DashboardPage() {
  const [attempt, setAttempt] = useState(0);
  const [latest, setLatest] = useState<{ attempt: number; activity: Activity } | null>(null);

  useEffect(() => {
    let active = true;
    void loadActivity().then((activity) => {
      if (active) setLatest({ attempt, activity });
    });
    return () => {
      active = false;
    };
  }, [attempt]);

  const activity: Activity = latest?.attempt === attempt ? latest.activity : { state: 'loading' };

  return (
    <>
      <PageHeader title="Dashboard" />
      <Link className="button primary receive-button" to="/receiving-log/new">
        Receive samples
      </Link>

      <section className="card" aria-labelledby="recent-activity">
        <h2 id="recent-activity">Recent activity</h2>
        {activity.state === 'loading' ? (
          <ul className="activity skeleton" aria-busy="true" aria-label="Loading recent activity">
            <li />
            <li />
            <li />
          </ul>
        ) : activity.state === 'error' ? (
          <ErrorState message={activity.message} onRetry={() => setAttempt((a) => a + 1)} />
        ) : activity.items.length === 0 ? (
          <EmptyState>No activity yet. Receive the first storage unit.</EmptyState>
        ) : (
          <ul className="activity">
            {activity.items.map((item) => (
              <li key={item.id}>
                {item.href ? <Link to={item.href}>{item.summary}</Link> : item.summary}
                <span className="activity-time">
                  {' · '}
                  <time dateTime={item.occurredAt}>
                    {timeFormat.format(new Date(item.occurredAt))}
                  </time>
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <SystemStatus />
    </>
  );
}
