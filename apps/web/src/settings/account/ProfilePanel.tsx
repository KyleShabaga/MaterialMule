import {
  JOB_TITLE_SOURCE_LABEL,
  profileResponseSchema,
  type MeResponse,
  type ProfileResponse,
} from '@materialmule/shared';
import { Lock, RefreshCw, TriangleAlert, Users } from 'lucide-react';
import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { PersonAvatar } from '@/components/strata/person-avatar';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { apiFetch } from '../../api/client';
import { formatExpiry } from '../../lib/format';
import { useOptionalRecordingPerson } from '../../session/recording-person-store';
import { useMe, useSession } from '../../session/context';
import { SettingsPanel } from '../modal/SettingsPanel';

// Settings › Account › Profile (STRATA-101; canvas R9AccountPanel profile, profile-station,
// profile-manager). Read-only: Microsoft supplies the name and email, an administrator sets
// official initials and job title. On the shared LAB account it describes that account only and
// never the picked person's details or preferences (STRATA-119).

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

/** One read-only fact: label on the left, the value and where it comes from on the right. */
export function FactRow({
  label,
  hint,
  mono = false,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  mono?: boolean;
  children: ReactNode;
}) {
  return (
    <div
      data-slot="settings-fact"
      className="grid grid-cols-1 items-start gap-1 py-4 sm:grid-cols-[10rem_1fr] sm:gap-4"
    >
      <dt data-slot="settings-fact-label" className="text-sm font-medium">
        {label}
      </dt>
      <dd data-slot="settings-fact-value" className="m-0 grid min-w-0 gap-0.5">
        <span className={mono ? 'font-mono text-sm break-words' : 'text-sm break-words'}>
          {children}
        </span>
        {hint ? <span className="text-sm text-muted-foreground">{hint}</span> : null}
      </dd>
    </div>
  );
}

/** The `dl` around FactRows. */
export function FactList({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <dl data-slot="settings-facts" aria-label={label} className="m-0 divide-y">
      {children}
    </dl>
  );
}

const muted = (text: string) => <span className="text-muted-foreground">{text}</span>;
const orMissing = (value: string | null) => value ?? muted('Not provided');

function Header({
  me,
  title,
  subtitle,
  userId,
}: {
  me: MeResponse;
  title: string;
  subtitle: string;
  userId: string | null;
}) {
  return (
    <div data-slot="profile-header" className="flex items-center gap-4">
      <PersonAvatar
        name={me.displayName}
        userId={userId}
        size="lg"
        className="size-16 shrink-0 [&_[data-slot=avatar-fallback]]:text-xl"
      />
      <div className="grid min-w-0 gap-0.5">
        <p data-slot="profile-name" className="m-0 truncate text-lg font-semibold">
          {title}
        </p>
        <p data-slot="profile-subtitle" className="m-0 truncate text-sm text-muted-foreground">
          {subtitle}
        </p>
      </div>
    </div>
  );
}

function LoadingRows() {
  return (
    <div className="grid gap-3" aria-hidden="true">
      <Skeleton className="h-5 w-2/3" />
      <Skeleton className="h-5 w-1/2" />
      <Skeleton className="h-5 w-3/5" />
    </div>
  );
}

function LoadError({ onRetry }: { onRetry: () => void }) {
  return (
    <Alert variant="destructive">
      <TriangleAlert />
      <AlertTitle>Your profile couldn’t load.</AlertTitle>
      <AlertDescription>
        <p>Check the connection, then try again.</p>
        <Button variant="outline" size="sm" onClick={onRetry}>
          Try again
        </Button>
      </AlertDescription>
    </Alert>
  );
}

export function ProfilePanel() {
  const me = useMe();
  return me.accountType === 'shared_lab' ? <StationProfile me={me} /> : <PersonalProfile me={me} />;
}

function useProfileLoad() {
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const reload = useCallback(() => {
    setLoad({ state: 'loading' });
    void loadProfile().then(setLoad);
  }, []);
  useEffect(() => {
    let active = true;
    void loadProfile().then((next) => {
      if (active) setLoad(next);
    });
    return () => {
      active = false;
    };
  }, []);
  return [load, setLoad, reload] as const;
}

function PersonalProfile({ me }: { me: MeResponse }) {
  const { refresh: refreshSession } = useSession();
  const [load, setLoad, reload] = useProfileLoad();
  const [refreshing, setRefreshing] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function refreshFromMicrosoft() {
    setRefreshing(true);
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
      setRefreshing(false);
    }
  }

  const p = load.state === 'ready' ? load.profile : null;
  const accountLabel =
    me.accountType === 'test'
      ? 'Test account'
      : p?.source === 'microsoft_graph' || p?.source === 'microsoft_id_token'
        ? 'Personal account · Microsoft 365'
        : 'Personal account';
  const kind = me.accountType === 'test' ? 'Test account' : 'Personal account';
  const subtitle = p?.effectiveJobTitle ? `${p.effectiveJobTitle.value} · ${kind}` : kind;
  const initials = p?.officialInitials && p.initialsConfirmed ? p.officialInitials : null;

  return (
    <SettingsPanel
      id="profile"
      title="Profile"
      description="How your name appears on records. Your details come from your Microsoft account."
      notice={
        p?.refreshFailedAt ? (
          <Alert>
            <TriangleAlert />
            <AlertTitle>Your Microsoft profile couldn’t be refreshed.</AlertTitle>
            <AlertDescription>
              <p>Tried {formatExpiry(p.refreshFailedAt)}. These are your last known details.</p>
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      <div className="grid gap-6">
        <Header
          me={me}
          title={p?.displayName ?? me.displayName}
          subtitle={subtitle}
          userId={me.id}
        />
        {load.state === 'loading' ? <LoadingRows /> : null}
        {load.state === 'error' ? <LoadError onRetry={reload} /> : null}
        {p ? (
          <>
            <FactList label="Profile">
              <FactRow label="Name" hint="Comes from your Microsoft account.">
                {p.displayName}
              </FactRow>
              <FactRow
                label="Official initials"
                hint="Set in Staff by a Lab Manager or an administrator. Used on labels and records."
                mono={Boolean(initials)}
              >
                {initials ?? muted('Not confirmed yet: an administrator sets these')}
              </FactRow>
              <FactRow
                label="Job title"
                hint={
                  p.effectiveJobTitle
                    ? `${JOB_TITLE_SOURCE_LABEL[p.effectiveJobTitle.source]}. It describes your work and grants nothing.`
                    : 'It describes your work and grants nothing.'
                }
              >
                {p.effectiveJobTitle ? p.effectiveJobTitle.value : muted('Not set')}
              </FactRow>
              {p.jobTitleOverride ? (
                <FactRow label="Job title from Microsoft">{orMissing(p.jobTitle)}</FactRow>
              ) : null}
              <FactRow label="Work email" hint="Comes from your Microsoft account.">
                {p.workEmail ?? muted('No mailbox address from Microsoft')}
              </FactRow>
              <FactRow label="Sign-in username" hint="Your sign-in name." mono>
                {orMissing(p.signInUsername)}
              </FactRow>
              <FactRow label="Given name">{orMissing(p.givenName)}</FactRow>
              <FactRow label="Surname">{orMissing(p.surname)}</FactRow>
              <FactRow label="Department">{orMissing(p.department)}</FactRow>
              <FactRow label="Office">{orMissing(p.officeLocation)}</FactRow>
              <FactRow label="Account" hint="Shown for reference; it can’t be changed here.">
                <span className="inline-flex items-center gap-2">
                  <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
                  {accountLabel}
                </span>
              </FactRow>
              <FactRow
                label="Avatar"
                hint="Your photo from your Microsoft account when it has one; initials when it doesn’t. Refresh from Microsoft picks up a new photo."
              >
                <span className="inline-flex items-center gap-2">
                  <PersonAvatar name={p.displayName} userId={me.id} />
                  Photo or initials
                </span>
              </FactRow>
              <FactRow label="Profile source">
                {p.source ? SOURCE_LABELS[p.source] : muted('Not provided')}
              </FactRow>
            </FactList>
            <div
              data-slot="profile-refresh"
              className="flex flex-wrap items-center gap-3 border-t pt-5"
            >
              {p.canRefresh ? (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => void refreshFromMicrosoft()}
                  disabled={refreshing}
                >
                  <RefreshCw aria-hidden="true" />
                  {refreshing
                    ? 'Refreshing…'
                    : p.refreshFailedAt
                      ? 'Retry'
                      : 'Refresh from Microsoft'}
                </Button>
              ) : null}
              <span className="text-sm text-muted-foreground">
                {p.refreshedAt
                  ? `Last refreshed ${formatExpiry(p.refreshedAt)}`
                  : 'Never refreshed'}
              </span>
            </div>
            <p data-slot="profile-status" role="status" className="m-0 text-sm">
              {notice}
            </p>
            <p data-slot="profile-note" className="m-0 text-sm text-muted-foreground">
              A change to your name doesn’t change records you already signed; they keep the name
              you had then.
            </p>
          </>
        ) : null}
      </div>
    </SettingsPanel>
  );
}

const firstName = (name: string) => name.trim().split(/\s+/)[0] ?? name;

function StationProfile({ me }: { me: MeResponse }) {
  const station = useOptionalRecordingPerson();
  const person = station?.person ?? null;
  const [load, , reload] = useProfileLoad();
  const p = load.state === 'ready' ? load.profile : null;

  const first = person ? firstName(person.displayName) : null;
  return (
    <SettingsPanel
      id="profile"
      title="Profile"
      description="The account this computer is signed in with."
    >
      <div className="grid gap-6">
        <Header me={me} title={me.displayName} subtitle="Shared LAB account" userId={null} />
        <Alert>
          <Users />
          {person && first ? (
            <>
              <AlertTitle>Recording as {person.displayName} on this LAB station.</AlertTitle>
              <AlertDescription>
                <p>
                  {first}’s own profile and preferences are changed from {first}’s own computer.
                  Work here is still recorded under {first}’s name.
                </p>
              </AlertDescription>
            </>
          ) : (
            <>
              <AlertTitle>No one is picked on this LAB station.</AlertTitle>
              <AlertDescription>
                <p>
                  Whoever is picked changes their own profile and preferences from their own
                  computer.
                </p>
              </AlertDescription>
            </>
          )}
        </Alert>
        <FactList label="Shared LAB account">
          <FactRow
            label="Account"
            hint="A shared account for the receiving bench. It can’t hold roles."
          >
            <span className="inline-flex items-center gap-2">
              <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
              Shared LAB account
            </span>
          </FactRow>
          {p?.signInUsername ? (
            <FactRow label="Sign-in username" hint="Set by an administrator in Staff." mono>
              {p.signInUsername}
            </FactRow>
          ) : null}
          <FactRow
            label="Name on records"
            hint="Receipts, moves, breaks and labels name whoever is picked in Recording as, never the LAB account."
          >
            {person ? `The person picked: now ${person.displayName}` : 'The person picked'}
          </FactRow>
          <FactRow
            label="Password"
            hint="Ask an administrator if it needs to change. It is never shown here."
          >
            Changed by an administrator
          </FactRow>
        </FactList>
        {load.state === 'error' ? (
          <p data-slot="profile-status" className="m-0 text-sm text-muted-foreground">
            The sign-in username couldn’t load.{' '}
            <Button variant="link" size="xs" className="h-auto p-0" onClick={reload}>
              Try again
            </Button>
          </p>
        ) : null}
      </div>
    </SettingsPanel>
  );
}
