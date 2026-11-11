import {
  JOB_TITLE_SOURCE_LABEL,
  profileResponseSchema,
  type ProfileResponse,
} from '@materialmule/shared';
import { useEffect, useState, type ReactNode } from 'react';
import { NotificationPreferencesCard } from '../action-requests/NotificationPreferencesCard';
import { apiFetch } from '../api/client';
import { ErrorState } from '../components/ui';
import { formatExpiry } from '../lib/format';
import { useSession } from '../session/context';
import './profile.css';

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

/** One read-only field cell: mono caps label, the value, and where it comes from. */
function Field({
  label,
  hint,
  mono = false,
  wide = false,
  children,
}: {
  label: string;
  hint?: string;
  mono?: boolean;
  wide?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={wide ? 'profile-field profile-field-wide' : 'profile-field'}>
      <dt>{label}</dt>
      <dd className={mono ? 'mono' : undefined}>{children}</dd>
      {hint ? <p className="profile-field-hint">{hint}</p> : null}
    </div>
  );
}

/**
 * Settings → My profile (MM-T05; Field Ledger "SettingsProfile"): the imported fields as
 * read-only cells, their source and freshness, Refresh from Microsoft, and (personal accounts)
 * notification preferences. Nothing here is edited by the person: Microsoft supplies the name
 * and email, and an administrator sets official initials.
 */
export function ProfilePage() {
  const { session, refresh: refreshSession } = useSession();
  const canReadActionItems =
    session.status === 'active' && session.me.permissions.includes('action_item.read');
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
  const missing = (value: string | null) =>
    value ?? <span className="field-hint">Not provided</span>;

  const initials =
    (p.officialInitials && p.initialsConfirmed ? p.officialInitials : null) ??
    p.displayName
      .split(/\s+/)
      .map((part) => part[0] ?? '')
      .join('')
      .slice(0, 3)
      .toUpperCase();

  return (
    <div className="profile-page">
      {p.refreshFailedAt ? (
        <div className="notice notice-warning profile-warning" role="alert">
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
      <section className="profile-section" aria-labelledby="profile-title">
        <div className="profile-head">
          <span className="profile-avatar" aria-hidden="true">
            {initials}
          </span>
          <div className="profile-head-text">
            <h2 id="profile-title">My profile</h2>
            <p>How your name appears on records, and how the app behaves for you.</p>
          </div>
          {p.canRefresh && !p.refreshFailedAt ? (
            <button type="button" onClick={() => void retry()} disabled={retrying}>
              {retrying ? 'Refreshing…' : 'Refresh from Microsoft'}
            </button>
          ) : null}
        </div>
        <dl className="profile-grid">
          <Field label="Name" hint="Comes from your Microsoft account.">
            {p.displayName}
          </Field>
          <Field label="Official initials" hint="Set by an administrator." mono>
            {p.officialInitials && p.initialsConfirmed ? (
              p.officialInitials
            ) : (
              <span className="profile-unconfirmed">
                Not confirmed yet: an administrator sets these
              </span>
            )}
          </Field>
          <Field label="Given name">{missing(p.givenName)}</Field>
          <Field label="Surname">{missing(p.surname)}</Field>
          <Field label="Work email" hint="Comes from your Microsoft account.">
            {p.workEmail ?? <span className="field-hint">No mailbox address from Microsoft</span>}
          </Field>
          <Field label="Sign-in username" mono>
            {missing(p.signInUsername)}
          </Field>
          <Field label="Job title">
            {p.effectiveJobTitle ? (
              <>
                <span>{p.effectiveJobTitle.value}</span>{' '}
                <span className="field-hint">
                  ({JOB_TITLE_SOURCE_LABEL[p.effectiveJobTitle.source]})
                </span>
              </>
            ) : (
              missing(null)
            )}
          </Field>
          {p.jobTitleOverride ? (
            <Field label="Job title (from Microsoft)">{missing(p.jobTitle)}</Field>
          ) : null}
          <Field label="Department">{missing(p.department)}</Field>
          <Field label="Office">{missing(p.officeLocation)}</Field>
          <Field label="Profile source">{p.source ? SOURCE_LABELS[p.source] : missing(null)}</Field>
          <Field label="Last refreshed" mono>
            {p.refreshedAt ? formatExpiry(p.refreshedAt) : missing(null)}
          </Field>
        </dl>
        <p className="profile-note">
          A change to your name does not change records you already signed; they keep the name you
          had then.
        </p>
      </section>
      {/* MTR-2: LAB has no notification preferences of its own. */}
      {canReadActionItems ? <NotificationPreferencesCard /> : null}
    </div>
  );
}
