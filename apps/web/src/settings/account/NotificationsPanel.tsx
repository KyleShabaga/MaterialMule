import { Bell, Building2, Info, Lock, TriangleAlert } from 'lucide-react';
import { useId } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { useMe } from '../../session/context';
import { SettingsGroup, SettingsPanel, SettingsRow } from '../modal/SettingsPanel';
import { SaveStatusLine } from './PreferencesPanel';
import { usePersonPreferences } from './preferences-api';

// Settings › Account › Notifications (STRATA-101, STRATA-55; canvas R9AccountPanel notifications).
// Which Inbox items raise the bell's count: requests always do; updates are the person's
// `badgeUpdates` preference. In the app only: the old "Email me" switch is not shown (D39 stays
// gated) and /api/me/notification-preferences is left alone.

export const LAB_NOTIFICATIONS_NOTE =
  'The shared LAB account has no Inbox of its own, so nothing here applies to it. Each person sets their own bell count from their own computer.';

function InAppOnly() {
  return (
    <Alert>
      <Building2 />
      <AlertTitle>In the app only.</AlertTitle>
      <AlertDescription>
        <p>
          Material Mule doesn’t send email or messages. It runs on the office network, so
          notifications wait in your Inbox.
        </p>
      </AlertDescription>
    </Alert>
  );
}

export function NotificationsPanel() {
  const me = useMe();
  if (me.accountType === 'shared_lab') {
    return (
      <SettingsPanel
        id="notifications"
        title="Notifications"
        description="Which Inbox items raise the bell’s count."
      >
        <Alert>
          <Info />
          <AlertTitle>Nothing to set on this account.</AlertTitle>
          <AlertDescription>
            <p>{LAB_NOTIFICATIONS_NOTE}</p>
          </AlertDescription>
        </Alert>
      </SettingsPanel>
    );
  }
  return <PersonalNotifications />;
}

function PersonalNotifications() {
  const id = useId();
  const prefs = usePersonPreferences();
  const requestsId = `${id}-requests`;
  const updatesId = `${id}-updates`;
  return (
    <SettingsPanel
      id="notifications"
      title="Notifications"
      description="Which Inbox items raise the bell’s count. Every item still arrives in your Inbox."
      actions={<SaveStatusLine status={prefs.status} />}
    >
      {prefs.load === 'loading' ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {prefs.load === 'error' ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Your notification settings couldn’t load.</AlertTitle>
          <AlertDescription>
            <p>Check the connection, then try again.</p>
            <Button variant="outline" size="sm" onClick={prefs.reload}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {prefs.load === 'ready' ? (
        <SettingsGroup id={`${id}-bell`} title="Bell count">
          <SettingsRow
            labelId={requestsId}
            label={
              <span className="flex items-center gap-2">
                <Badge>Request</Badge>
                Requests
              </span>
            }
            description="Things waiting on you, such as a correction or a retention decision. Always counted."
            control={
              <span className="flex items-center gap-2">
                <Lock className="size-4 text-muted-foreground" aria-hidden="true" />
                <Switch aria-label="Requests, always on" checked disabled />
              </span>
            }
          />
          <SettingsRow
            labelId={updatesId}
            label={
              <span className="flex items-center gap-2">
                <Bell className="size-4 text-muted-foreground" aria-hidden="true" />
                Updates
              </span>
            }
            description="News about your work: your request was decided, a report was returned, a program is ready to close."
            control={
              <Switch
                aria-labelledby={updatesId}
                checked={prefs.preferences.badgeUpdates}
                disabled={prefs.readOnly}
                onCheckedChange={(badgeUpdates) => void prefs.update({ badgeUpdates })}
              />
            }
          />
        </SettingsGroup>
      ) : null}
      <InAppOnly />
    </SettingsPanel>
  );
}
