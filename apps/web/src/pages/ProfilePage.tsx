import { POSITION_LABELS, profileResponseSchema, type ProfileResponse } from '@materialmule/shared';
import { useEffect, useState } from 'react';
import { NotificationPreferencesCard } from '../action-requests/NotificationPreferencesCard';
import { apiFetch } from '../api/client';
import { BandedCard, ErrorState } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useSession } from '../session/context';

type Load =
  { state: 'loading' } | { state: 'error' } | { state: 'ready'; profile: ProfileResponse };

async function loadProfile(): Promise<Load> {
  try {
    const response = await apiFetch('/api/me/profile');
    if (!response.ok) return { state: 'error' };
    return { state: 'ready', profile: profileResponseSchema.parse(await response.json()) };
  } catch {
    return { state: 'error' };
  }
}

const SOURCE_LABELS: Record<NonNullable<ProfileResponse['source']>, string> = {
  microsoft_graph: 'Microsoft 365 profile',
  microsoft_id_token: 'Microsoft sign-in only (profile not yet read)',
  seed: 'Test fixture',
};

const RETRY_START = '/api/auth/microsoft/start?returnTo=%2Fsettings%2Fprofile';

/** Settings → My profile (MM-T05): imported fields, their source and freshness, and Retry. */
export function ProfilePage() {
  const { refresh: refreshSession } = useSession();
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [retrying, setRetrying] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    void loadProfile().then((next) => {
      if (active) setLoad(next);
    });
    return () => {
      active = false;
    };
  }, []);

  async function retry() {
    setRetrying(true);
    setNotice(null);
    try {
      const response = await apiFetch('/api/me/profile/refresh', { method: 'POST' });
      if (response.status === 409) {
        // The Microsoft token from sign-in has lapsed: signing in again refreshes the profile.
        window.location.assign(RETRY_START);
        return;
      }
      if (!response.ok) {
        setNotice('The refresh didn’t work. Try again later.');
        return;
      }
      const profile = profileResponseSchema.parse(await response.json());
      setLoad({ state: 'ready', profile });
      setNotice(
        profile.refreshFailedAt
          ? 'Microsoft still isn’t answering. Your last known details are shown.'
          : 'Profile refreshed from Microsoft.',
      );
      await refreshSession();
    } catch {
      setNotice('Material Mule couldn’t be reached. Check the connection and try again later.');
    } finally {
      setRetrying(false);
    }
  }

  if (load.state === 'loading') return <p>Loading…</p>;
  if (load.state === 'error') {
    return (
      <ErrorState
        message="Your profile couldn't load."
        onRetry={() => void loadProfile().then(setLoad)}
      />
    );
  }
  const p = load.profile;
  const field = (value: string | null) => value ?? <span className="field-hint">Not provided</span>;

  const initials =
    (p.officialInitials && p.initialsConfirmed ? p.officialInitials : null) ??
    p.displayName
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 3)
      .toUpperCase();

  // Canvas layout (MM-T55): who is signed in beside the banded profile card.
  return (
    <div className="profile-page">
      {p.refreshFailedAt ? (
        <div className="notice profile-warning" role="alert">
          <p>
            Your Microsoft profile couldn’t be refreshed ({formatExpiry(p.refreshFailedAt)}). These
            are your last known details.
          </p>
          {p.canRefresh ? (
            <button type="button" onClick={() => void retry()} disabled={retrying}>
              {retrying ? 'Retrying…' : 'Retry'}
            </button>
          ) : null}
        </div>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <div className="profile-layout">
        <section className="profile-who" aria-label="Signed in as">
          <span className="profile-initials" aria-hidden="true">
            {initials}
          </span>
          <div>
            <p className="profile-name">{p.displayName}</p>
            {p.workEmail ? <p className="profile-email">{p.workEmail}</p> : null}
          </div>
          {p.position ? (
            <p className="profile-chips">
              <span className="profile-chip">{POSITION_LABELS[p.position].label}</span>
            </p>
          ) : null}
          {p.canRefresh && !p.refreshFailedAt ? (
            <button type="button" onClick={() => void retry()} disabled={retrying}>
              {retrying ? 'Refreshing…' : 'Refresh from Microsoft'}
            </button>
          ) : null}
        </section>
        <BandedCard
          className="profile-card"
          title="My profile"
          subtitle="From your Microsoft 365 profile. Official initials are set by an administrator."
        >
          <dl className="profile-fields">
            <dt>Name</dt>
            <dd>{p.displayName}</dd>
            <dt>Given name</dt>
            <dd>{field(p.givenName)}</dd>
            <dt>Surname</dt>
            <dd>{field(p.surname)}</dd>
            <dt>Work email</dt>
            <dd>
              {p.workEmail ?? <span className="field-hint">No mailbox address from Microsoft</span>}
            </dd>
            <dt>Sign-in username</dt>
            <dd>{field(p.signInUsername)}</dd>
            <dt>Job title (from Microsoft)</dt>
            <dd>{field(p.jobTitle)}</dd>
            <dt>Department</dt>
            <dd>{field(p.department)}</dd>
            <dt>Office</dt>
            <dd>{field(p.officeLocation)}</dd>
            <dt>Official initials</dt>
            <dd>
              {p.officialInitials && p.initialsConfirmed ? (
                p.officialInitials
              ) : (
                <span className="profile-unconfirmed">
                  Not confirmed yet: an administrator sets these
                </span>
              )}
            </dd>
            <dt>Position</dt>
            <dd>{p.position ? POSITION_LABELS[p.position].label : field(null)}</dd>
            <dt>Profile source</dt>
            <dd>{p.source ? SOURCE_LABELS[p.source] : field(null)}</dd>
            <dt>Last refreshed</dt>
            <dd>{p.refreshedAt ? formatExpiry(p.refreshedAt) : field(null)}</dd>
          </dl>
        </BandedCard>
        <NotificationPreferencesCard />
      </div>
    </div>
  );
}
