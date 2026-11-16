import {
  DRAFT_AUTO_DELETE_MAX_DAYS,
  DRAFT_AUTO_DELETE_MIN_DAYS,
  type DraftSettings,
} from '@materialmule/shared';
import { CircleAlert, CircleCheck, Info, RefreshCw } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Field, FieldDescription, FieldError, FieldGroup, FieldLabel } from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { useMe } from '../../session/context';
import { SettingsGroup, SettingsPanel } from '../modal/SettingsPanel';
import { fetchDraftSettings, saveDraftSettings } from './api';
import { MANAGE_PERMISSION, NOT_ALLOWED_TEXT } from './constants';

// Settings › Lab › Receiving (MM-T45, STRATA-102; R9 board R9ReceivingPanel form/error/saved):
// draft auto-delete. Everyone may look; Admin and Lab Manager (`settings.drafts.manage`) may
// change it. The server enforces the same rule.

const DAYS_ERROR = `Enter a whole number of days from ${DRAFT_AUTO_DELETE_MIN_DAYS} to ${DRAFT_AUTO_DELETE_MAX_DAYS}`;
const GROUP_ID = 'receiving-drafts';

type Load =
  | { state: 'loading' }
  | { state: 'error'; message: string }
  | { state: 'ready'; settings: DraftSettings };

type Notice = { tone: 'saved' | 'changed'; text: string } | null;

/** The days field as typed; null when it isn't a whole number in range. */
function parseDays(text: string): number | null {
  if (!/^\d+$/.test(text.trim())) return null;
  const days = Number(text.trim());
  return days >= DRAFT_AUTO_DELETE_MIN_DAYS && days <= DRAFT_AUTO_DELETE_MAX_DAYS ? days : null;
}

function DraftAutoDeleteForm({
  settings,
  allowed,
  onSaved,
}: {
  settings: DraftSettings;
  allowed: boolean;
  onSaved: (settings: DraftSettings, notice: Notice) => void;
}) {
  const [enabled, setEnabled] = useState(settings.draftAutoDelete.enabled);
  const [days, setDays] = useState(String(settings.draftAutoDelete.afterDays));
  const [daysError, setDaysError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const afterDays = parseDays(days);
    if (afterDays === null) {
      setDaysError(DAYS_ERROR);
      return;
    }
    setDaysError(null);
    setError(null);
    setSaving(true);
    const result = await saveDraftSettings({
      draftAutoDelete: { enabled, afterDays },
      version: settings.version,
    });
    setSaving(false);
    if (result.ok) {
      onSaved(result.data, { tone: 'saved', text: 'Draft setting saved.' });
    } else if (result.kind === 'conflict') {
      onSaved(result.current, { tone: 'changed', text: result.message });
    } else if (result.kind === 'invalid') {
      const field = result.errors.find((e) => e.field === 'draftAutoDelete.afterDays');
      setDaysError(field ? field.message : null);
      setError(field ? null : result.message);
    } else {
      setError(result.message);
    }
  }

  return (
    <form aria-labelledby={GROUP_ID} noValidate onSubmit={(event) => void submit(event)}>
      <FieldGroup className="gap-5 pt-4">
        <p className="text-sm text-muted-foreground">
          Drafts of receipts are kept only on the computer or phone where they were started. When
          automatic clean-up is on, each computer deletes its own drafts that haven&apos;t been
          saved for the chosen number of days the next time Receive samples is opened there, and
          says how many it deleted. Drafts whose confirmation was interrupted are never deleted.
        </p>
        <Field orientation="horizontal">
          <Checkbox
            id="draft-auto-delete-on"
            checked={enabled}
            disabled={!allowed}
            onCheckedChange={(checked) => setEnabled(checked === true)}
          />
          <FieldLabel htmlFor="draft-auto-delete-on" className="font-normal">
            Delete drafts automatically
          </FieldLabel>
        </Field>
        <Field data-invalid={daysError ? true : undefined}>
          <FieldLabel htmlFor="draft-auto-delete-days">
            After this many days without changes
          </FieldLabel>
          <Input
            id="draft-auto-delete-days"
            className="w-32"
            type="number"
            inputMode="numeric"
            min={DRAFT_AUTO_DELETE_MIN_DAYS}
            max={DRAFT_AUTO_DELETE_MAX_DAYS}
            step={1}
            value={days}
            disabled={!allowed}
            aria-invalid={daysError ? true : undefined}
            aria-describedby={
              daysError
                ? 'draft-auto-delete-days-error draft-auto-delete-days-hint'
                : 'draft-auto-delete-days-hint'
            }
            onChange={(e) => setDays(e.target.value)}
          />
          {daysError ? (
            <FieldError id="draft-auto-delete-days-error">{daysError}</FieldError>
          ) : null}
          <FieldDescription id="draft-auto-delete-days-hint">
            {DRAFT_AUTO_DELETE_MIN_DAYS} to {DRAFT_AUTO_DELETE_MAX_DAYS} days
          </FieldDescription>
        </Field>
        {error ? (
          <Alert variant="destructive">
            <CircleAlert />
            <AlertDescription>
              <p>{error}</p>
            </AlertDescription>
          </Alert>
        ) : null}
        {allowed ? (
          <div>
            <Button type="submit" size="sm" disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </div>
        ) : null}
      </FieldGroup>
    </form>
  );
}

/** The saved or "changed meanwhile" line under the form (R9 board: saved). */
function NoticeLine({ notice }: { notice: Notice }) {
  return (
    <div role="status">
      {notice ? (
        <div className="flex items-start gap-3 rounded-lg border bg-card px-4 py-3 text-sm">
          {notice.tone === 'saved' ? (
            <CircleCheck
              className="mt-0.5 size-4 shrink-0 text-stage-storage-fg"
              aria-hidden="true"
            />
          ) : (
            <Info className="mt-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
          )}
          <div className="grid gap-0.5">
            <p className="font-medium">{notice.text}</p>
            {notice.tone === 'saved' ? (
              <p className="text-muted-foreground">
                Each computer applies it the next time Receive samples opens.
              </p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

/** Settings › Receiving (MM-T45). */
export function ReceivingPanel() {
  const me = useMe();
  const allowed = me.permissions.includes(MANAGE_PERMISSION);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [notice, setNotice] = useState<Notice>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchDraftSettings().then((result) => {
      if (cancelled) return;
      setLoad(
        result.ok
          ? { state: 'ready', settings: result.data }
          : { state: 'error', message: `The draft setting couldn't load. ${result.message}` },
      );
    });
    return () => {
      cancelled = true;
    };
  }, [attempt]);

  return (
    <SettingsPanel
      id="receiving"
      title="Receiving"
      description={
        allowed
          ? 'How long drafts of receipts stay on each computer. Only Lab Managers and administrators can change this.'
          : NOT_ALLOWED_TEXT
      }
    >
      <SettingsGroup id={GROUP_ID} title="Receiving drafts">
        {load.state === 'loading' ? (
          <div aria-busy="true" className="grid gap-3 pt-4">
            <span className="sr-only">Loading receiving settings…</span>
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-5 w-1/3" />
            <Skeleton className="h-9 w-32" />
          </div>
        ) : null}
        {load.state === 'error' ? (
          <div className="pt-4">
            <Alert variant="destructive">
              <CircleAlert />
              <AlertTitle>{load.message}</AlertTitle>
              <AlertDescription>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-2"
                  onClick={() => {
                    setLoad({ state: 'loading' });
                    setAttempt((a) => a + 1);
                  }}
                >
                  <RefreshCw aria-hidden="true" />
                  Try again
                </Button>
              </AlertDescription>
            </Alert>
          </div>
        ) : null}
        {load.state === 'ready' ? (
          <DraftAutoDeleteForm
            key={load.settings.version}
            settings={load.settings}
            allowed={allowed}
            onSaved={(settings, next) => {
              setLoad({ state: 'ready', settings });
              setNotice(next);
            }}
          />
        ) : null}
      </SettingsGroup>
      <NoticeLine notice={notice} />
    </SettingsPanel>
  );
}
