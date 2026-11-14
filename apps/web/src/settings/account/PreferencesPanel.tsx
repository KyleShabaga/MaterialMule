import {
  type AfterReceiptChoice,
  type InboxView,
  type TableDensity,
  type ThemeChoice,
  type UserPreferences,
} from '@materialmule/shared';
import { Check, Info, Lock, LoaderCircle, RotateCcw, TriangleAlert } from 'lucide-react';
import { useId, useState } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { Switch } from '@/components/ui/switch';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { useMe } from '../../session/context';
import { useThemeChoice } from '../../theme/theme';
import { SettingsGroup, SettingsPanel, SettingsRow } from '../modal/SettingsPanel';
import {
  resetSidebarLayout,
  usePersonPreferences,
  type PersonPreferences,
  type SaveStatus,
} from './preferences-api';

// Settings › Account › Preferences (STRATA-29; canvas R9AccountPanel preferences and
// preferences-lower). Saved per person on the server as they change, for every computer the
// person uses. The shared LAB account shows the defaults read-only and never saves (STRATA-119).

export const LAB_PREFERENCES_NOTE =
  'This is the shared LAB account, so these are the defaults and can’t be changed here. Whoever is picked changes their own preferences from their own computer.';

/** Saving / Saved / the error, read out politely. */
export function SaveStatusLine({ status }: { status: SaveStatus }) {
  return (
    <p
      data-slot="settings-save-status"
      role="status"
      aria-live="polite"
      className="m-0 flex min-h-5 items-center gap-1.5 text-sm text-muted-foreground"
    >
      {status.state === 'saving' ? (
        <>
          <LoaderCircle className="size-4 animate-spin" aria-hidden="true" />
          Saving…
        </>
      ) : null}
      {status.state === 'saved' ? (
        <>
          <Check className="size-4" aria-hidden="true" />
          Saved
        </>
      ) : null}
      {status.state === 'error' || status.state === 'conflict' ? (
        <span className={status.state === 'error' ? 'text-destructive-text' : undefined}>
          {status.message}
        </span>
      ) : null}
    </p>
  );
}

const THEME_LABELS: Record<ThemeChoice, string> = {
  system: 'Use system setting',
  light: 'Light',
  dark: 'Dark',
};
const INBOX_VIEW_LABELS: Record<InboxView, string> = {
  stream: 'One stream',
  grouped: 'Grouped',
  table: 'Table',
};
const DATE_FORMAT_LABELS: Record<UserPreferences['dateFormat'], string> = {
  iso: '2026-11-11',
  medium: 'Nov 11, 2026',
};

function ChoiceSelect<T extends string>({
  labelId,
  value,
  labels,
  disabled,
  onChange,
}: {
  labelId: string;
  value: T;
  labels: Record<T, string>;
  disabled: boolean;
  onChange: (value: T) => void;
}) {
  return (
    <Select value={value} disabled={disabled} onValueChange={(next) => onChange(next as T)}>
      <SelectTrigger aria-labelledby={labelId} className="w-56">
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        {(Object.keys(labels) as T[]).map((key) => (
          <SelectItem key={key} value={key}>
            {labels[key]}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

export function PreferencesPanel() {
  const me = useMe();
  const prefs = usePersonPreferences({ station: me.accountType === 'shared_lab' });
  const station = me.accountType === 'shared_lab';
  return (
    <SettingsPanel
      id="preferences"
      title="Preferences"
      description={
        station
          ? 'How Material Mule looks and behaves on this computer’s shared LAB account.'
          : 'How Material Mule looks and behaves for you. Changes save as you make them, for you on every computer.'
      }
      actions={station ? null : <SaveStatusLine status={prefs.status} />}
      notice={
        station ? (
          <Alert>
            <Info />
            <AlertTitle>Shown read-only.</AlertTitle>
            <AlertDescription>
              <p>{LAB_PREFERENCES_NOTE}</p>
            </AlertDescription>
          </Alert>
        ) : prefs.readOnly && prefs.load === 'ready' ? (
          <Alert>
            <Info />
            <AlertTitle>Shown read-only.</AlertTitle>
            <AlertDescription>
              <p>This account can’t change preferences. These are the defaults.</p>
            </AlertDescription>
          </Alert>
        ) : null
      }
    >
      {prefs.load === 'loading' ? (
        <div className="grid gap-3" aria-hidden="true">
          <Skeleton className="h-5 w-1/3" />
          <Skeleton className="h-9 w-full" />
          <Skeleton className="h-9 w-full" />
        </div>
      ) : null}
      {prefs.load === 'error' ? (
        <Alert variant="destructive">
          <TriangleAlert />
          <AlertTitle>Your preferences couldn’t load.</AlertTitle>
          <AlertDescription>
            <p>Check the connection, then try again.</p>
            <Button variant="outline" size="sm" onClick={prefs.reload}>
              Try again
            </Button>
          </AlertDescription>
        </Alert>
      ) : null}
      {prefs.load === 'ready' ? <PreferenceGroups prefs={prefs} station={station} /> : null}
    </SettingsPanel>
  );
}

function PreferenceGroups({ prefs, station }: { prefs: PersonPreferences; station: boolean }) {
  const id = useId();
  const [, applyTheme] = useThemeChoice();
  const [resetState, setResetState] = useState<'idle' | 'resetting' | 'done' | 'failed'>('idle');
  const p = prefs.preferences;
  const off = prefs.readOnly;
  const ids = {
    theme: `${id}-theme`,
    density: `${id}-density`,
    inboxView: `${id}-inbox-view`,
    share: `${id}-share`,
    after: `${id}-after`,
    date: `${id}-date`,
    week: `${id}-week`,
    zone: `${id}-zone`,
    scan: `${id}-scan-open`,
    collapsed: `${id}-collapsed`,
    layout: `${id}-layout`,
  };

  function changeTheme(theme: ThemeChoice) {
    // Applies at once on this computer; a failed save puts the saved theme back.
    applyTheme(theme);
    void prefs.update({ theme }).then((now) => {
      if (now.theme !== theme) applyTheme(now.theme);
    });
  }

  async function reset() {
    setResetState('resetting');
    setResetState((await resetSidebarLayout()) ? 'done' : 'failed');
  }

  return (
    <>
      <SettingsGroup id={`${id}-appearance`} title="Appearance">
        <SettingsRow
          labelId={ids.theme}
          label="Theme"
          description="Light, dark, or follow this computer’s setting."
          control={
            <ChoiceSelect
              labelId={ids.theme}
              value={p.theme}
              labels={THEME_LABELS}
              disabled={off}
              onChange={changeTheme}
            />
          }
        />
        <SettingsRow
          labelId={ids.density}
          label="Table rows"
          description="Compact fits more rows on screen. Tables remember their own choice too."
          control={
            <ToggleGroup
              type="single"
              variant="outline"
              value={p.tableDensity}
              disabled={off}
              aria-labelledby={ids.density}
              className="w-56"
              onValueChange={(value) => {
                if (value) void prefs.update({ tableDensity: value as TableDensity });
              }}
            >
              <ToggleGroupItem value="comfortable" className="h-9 flex-1">
                Comfortable
              </ToggleGroupItem>
              <ToggleGroupItem value="compact" className="h-9 flex-1">
                Compact
              </ToggleGroupItem>
            </ToggleGroup>
          }
        />
      </SettingsGroup>

      <SettingsGroup id={`${id}-inbox`} title="Inbox">
        <SettingsRow
          labelId={ids.inboxView}
          label="Inbox view"
          description="One stream, requests grouped above updates, or a compact table. Also on the Inbox page."
          control={
            <ChoiceSelect
              labelId={ids.inboxView}
              value={p.inboxView}
              labels={INBOX_VIEW_LABELS}
              disabled={off}
              onChange={(inboxView) => void prefs.update({ inboxView })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup id={`${id}-privacy`} title="Privacy">
        <SettingsRow
          labelId={ids.share}
          label="Show my Inbox on shared LAB computers"
          description="Off by default. When on, anyone at a shared LAB station can open your requests and updates there by picking you. They can’t act on them, and you can turn this off at any time."
          control={
            <Switch
              aria-labelledby={ids.share}
              checked={p.shareInboxOnStations}
              disabled={off}
              onCheckedChange={(shareInboxOnStations) =>
                void prefs.update({ shareInboxOnStations })
              }
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup id={`${id}-receiving`} title="Receiving">
        <div data-slot="settings-radio-row" className="grid gap-3 py-4">
          <div className="grid gap-1">
            <span id={ids.after} className="text-sm font-medium">
              After confirming a receipt
            </span>
            <span className="text-sm text-muted-foreground">
              What opens once the IDs are issued and the labels are sent.
            </span>
          </div>
          <RadioGroup
            aria-labelledby={ids.after}
            value={p.afterReceipt}
            disabled={off}
            className="grid gap-2"
            onValueChange={(value) =>
              void prefs.update({ afterReceipt: value as AfterReceiptChoice })
            }
          >
            {(
              [
                [
                  'done_page',
                  'Show the done page',
                  'The new IDs, then Put away, Print all labels again or Receive more.',
                ],
                [
                  'put_away',
                  'Go straight to Put away',
                  'Skip the done page and start scanning the units onto a shelf.',
                ],
              ] as const
            ).map(([value, label, hint]) => (
              <label
                key={value}
                data-slot="settings-radio-option"
                className="flex items-start gap-3 rounded-md border p-3 has-[[data-state=checked]]:border-primary"
              >
                <RadioGroupItem value={value} className="mt-0.5" />
                <span className="grid gap-0.5">
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-sm text-muted-foreground">{hint}</span>
                </span>
              </label>
            ))}
          </RadioGroup>
        </div>
      </SettingsGroup>

      <SettingsGroup id={`${id}-time`} title="Dates and time">
        <SettingsRow
          labelId={ids.date}
          label="Date format"
          description="How record dates appear in tables and history."
          control={
            <ChoiceSelect
              labelId={ids.date}
              value={p.dateFormat}
              labels={DATE_FORMAT_LABELS}
              disabled={off}
              onChange={(dateFormat) => void prefs.update({ dateFormat })}
            />
          }
        />
        <SettingsRow
          labelId={ids.week}
          label="Weeks start on Monday"
          description="Calendars and date pickers start the week on Monday instead of Sunday."
          control={
            <Switch
              aria-labelledby={ids.week}
              checked={p.weekStartsMonday}
              disabled={off}
              onCheckedChange={(weekStartsMonday) => void prefs.update({ weekStartsMonday })}
            />
          }
        />
        <SettingsRow
          labelId={ids.zone}
          label="Time zone"
          description="Set for the whole lab. Storage unit IDs and due dates use it."
          control={
            <span
              aria-labelledby={ids.zone}
              className="flex h-9 w-56 items-center justify-end gap-2 text-sm text-muted-foreground"
            >
              <Lock className="size-4" aria-hidden="true" />
              {prefs.labTimeZone}
            </span>
          }
        />
      </SettingsGroup>

      <SettingsGroup id={`${id}-scan`} title="Scanning">
        <SettingsRow
          labelId={ids.scan}
          label="Open a scanned label’s record"
          description="When a label is scanned outside a field, open its storage unit or shelf."
          control={
            <Switch
              aria-labelledby={ids.scan}
              checked={p.openScannedRecord}
              disabled={off}
              onCheckedChange={(openScannedRecord) => void prefs.update({ openScannedRecord })}
            />
          }
        />
      </SettingsGroup>

      <SettingsGroup id={`${id}-sidebar`} title="Sidebar">
        <SettingsRow
          labelId={ids.collapsed}
          label="Start with the sidebar collapsed"
          description="Icons only, with names on hover. Ctrl B switches it any time."
          control={
            <Switch
              aria-labelledby={ids.collapsed}
              checked={p.sidebarStartCollapsed}
              disabled={off}
              onCheckedChange={(sidebarStartCollapsed) =>
                void prefs.update({ sidebarStartCollapsed })
              }
            />
          }
        />
        <SettingsRow
          labelId={ids.layout}
          label="Sidebar layout"
          description={
            resetState === 'done'
              ? 'Reset. The sidebar shows the default sections, order and folds.'
              : resetState === 'failed'
                ? 'The layout wasn’t reset. Check the connection and try again.'
                : 'Puts the sections, their order and folds back as they started, on every computer you use.'
          }
          control={
            <Button
              variant="outline"
              size="sm"
              disabled={off || station || resetState === 'resetting'}
              onClick={() => void reset()}
            >
              <RotateCcw aria-hidden="true" />
              {resetState === 'resetting' ? 'Resetting…' : 'Reset sidebar layout'}
            </Button>
          }
        />
      </SettingsGroup>
    </>
  );
}
