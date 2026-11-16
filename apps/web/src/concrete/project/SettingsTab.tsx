import type {
  ConcreteProjectSettings,
  ConcreteSettingsChange,
  ConcreteSpecimenAge,
  ProjectDetail,
} from '@materialmule/shared';
import { CircleAlert, Lock } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Alert, AlertTitle } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
} from '@/components/ui/field';
import { Input } from '@/components/ui/input';
import {
  Item,
  ItemContent,
  ItemDescription,
  ItemGroup,
  ItemMedia,
  ItemTitle,
} from '@/components/ui/item';
import { Label } from '@/components/ui/label';
import { RadioGroup, RadioGroupItem } from '@/components/ui/radio-group';
import { Skeleton } from '@/components/ui/skeleton';
import { PersonAvatar } from '../../components/strata/person-avatar';
import { notifySuccess } from '../../components/strata/toast';
import { LoadErrorAlert } from '../../projects/project-ui';
import { fetchReviewers } from '../../projects/team-api';
import { useMe } from '../../session/context';
import { ConcreteApiError, concreteProblem, fetchSettings, saveSettings } from './api';
import { dateTime } from './concrete-format';
import { commaAges, parseAges } from './mix-format';
import { useLoad } from './useLoad';

// MM-V2-C30, STRATA-98 Settings sub-tab (canvas R8ProjectSettings): the project's concrete
// settings (C02: default test ages, HOLD duration, the testing-machine information default on
// issued reports: Include, Omit or Not set), editable with `project.edit` (the Lead or an admin,
// as the server reports it); who reviews concrete work, read from Team & permissions; and the
// settings history. Changes apply to sets and reports made from now on; issued output never
// changes.

type Machine = 'include' | 'omit' | 'unset';
const machineOf = (value: boolean | null): Machine =>
  value === null ? 'unset' : value ? 'include' : 'omit';
const MACHINE_LABEL: Record<Machine, string> = {
  include: 'Include',
  omit: 'Omit',
  unset: 'Not set',
};

const FIELD_LABEL: Record<string, string> = {
  defaultSpecimenAges: 'test ages',
  holdDurationDays: 'HOLD duration',
  includeMachineInfo: 'testing machine information',
};

function settingValue(field: string, value: unknown): string {
  if (field === 'defaultSpecimenAges' && Array.isArray(value)) {
    return commaAges(value as ConcreteSpecimenAge[]);
  }
  if (field === 'holdDurationDays') return `${String(value)} days`;
  if (field === 'includeMachineInfo') {
    return MACHINE_LABEL[machineOf(value === null ? null : Boolean(value))];
  }
  return String(value);
}

function changeTitle(change: ConcreteSettingsChange): string {
  const who = change.changedBy?.name ?? 'Material Mule';
  const parts = Object.keys(change.after).map(
    (field) => `${FIELD_LABEL[field] ?? field} to ${settingValue(field, change.after[field])}`,
  );
  return parts.length > 0 ? `${who} set ${parts.join(', ')}` : `${who} saved the settings`;
}

export function SettingsTab({ project }: { project: ProjectDetail }) {
  const { load, reload, replace } = useLoad(`settings|${project.id}`, () =>
    fetchSettings(project.id),
  );
  return (
    <div className="grid min-w-0 gap-8 @4xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
      <div className="flex min-w-0 flex-col gap-8">
        {load.state === 'loading' ? (
          <div aria-busy="true" className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <Skeleton className="h-40 w-full" />
            <p className="sr-only" role="status">
              Loading…
            </p>
          </div>
        ) : null}
        {load.state === 'error' ? (
          <LoadErrorAlert
            title={`Couldn’t load the concrete records for ${project.projectNumber}`}
            message={concreteProblem(load.error)}
            onRetry={reload}
          />
        ) : null}
        {load.state === 'ready' ? (
          <>
            <SettingsForm
              key={load.data.version}
              projectId={project.id}
              settings={load.data}
              onSaved={replace}
            />
            <SettingsHistory settings={load.data} />
          </>
        ) : null}
      </div>
      <ReviewSection project={project} />
    </div>
  );
}

function SettingsForm({
  projectId,
  settings,
  onSaved,
}: {
  projectId: string;
  settings: ConcreteProjectSettings;
  onSaved: (next: ConcreteProjectSettings) => void;
}) {
  const id = useId();
  const [ages, setAges] = useState(commaAges(settings.defaultSpecimenAges));
  const [hold, setHold] = useState(String(settings.holdDurationDays));
  const [machine, setMachine] = useState<Machine>(machineOf(settings.includeMachineInfo));
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const parsed = parseAges(ages);
    if (!parsed) {
      setError('Enter each age as a whole number of days or HOLD, separated by commas.');
      return;
    }
    const holdDays = Number(hold);
    if (!Number.isInteger(holdDays) || holdDays < 1 || holdDays > 999) {
      setError('HOLD duration must be a whole number of days from 1 to 999.');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const next = await saveSettings(projectId, {
        version: settings.version,
        defaultSpecimenAges: parsed,
        holdDurationDays: holdDays,
        includeMachineInfo: machine === 'unset' ? null : machine === 'include',
        reason: reason.trim() || null,
      });
      onSaved(next);
      notifySuccess('Concrete settings saved. Existing sets and schedules keep their dates.');
    } catch (caught) {
      if (caught instanceof ConcreteApiError && caught.code === 'version_conflict') {
        const current = (caught.body as { current?: ConcreteProjectSettings } | null)?.current;
        if (current) onSaved(current);
      }
      setError(concreteProblem(caught));
    } finally {
      setBusy(false);
    }
  }

  const heading = (
    <div className="flex flex-col gap-1">
      <h2 id={`${id}-heading`} className="text-lg font-semibold">
        Concrete settings
      </h2>
      <p className="text-sm text-muted-foreground">
        Starting values for sets and reports made from now on; existing sets, schedules and issued
        reports don’t change.
      </p>
    </div>
  );

  if (!settings.canEdit) {
    return (
      <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
        {heading}
        <dl className="grid grid-cols-[max-content_1fr] gap-x-6 gap-y-2 text-sm">
          <dt className="text-muted-foreground">Default test ages</dt>
          <dd className="font-mono">{commaAges(settings.defaultSpecimenAges)}</dd>
          <dt className="text-muted-foreground">HOLD duration</dt>
          <dd>
            <span className="font-mono">{settings.holdDurationDays}</span> days from casting
          </dd>
          <dt className="text-muted-foreground">Testing machine information on issued reports</dt>
          <dd>{MACHINE_LABEL[machineOf(settings.includeMachineInfo)]}</dd>
        </dl>
        <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
          <Lock aria-hidden="true" className="size-3.5" />
          Only the project’s Lead Project Engineer or an administrator can change these settings.
        </p>
      </section>
    );
  }

  return (
    <section aria-labelledby={`${id}-heading`} className="flex flex-col gap-4">
      {heading}
      <form
        aria-label="Concrete settings"
        className="flex flex-col gap-5"
        onSubmit={(e) => void submit(e)}
      >
        <FieldGroup className="gap-5">
          <Field>
            <FieldLabel htmlFor={`${id}-ages`}>Default test ages</FieldLabel>
            <Input
              id={`${id}-ages`}
              className="max-w-sm font-mono"
              value={ages}
              autoComplete="off"
              onChange={(event) => setAges(event.target.value)}
            />
            <FieldDescription>
              Days from casting or HOLD, one per specimen, e.g. 7, 28, 28, HOLD. A mix’s own ages
              win.
            </FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={`${id}-hold`}>HOLD duration (days from casting)</FieldLabel>
            <Input
              id={`${id}-hold`}
              className="w-32 font-mono"
              type="number"
              inputMode="numeric"
              min={1}
              max={999}
              value={hold}
              onChange={(event) => setHold(event.target.value)}
            />
          </Field>
          <FieldSet>
            <FieldLegend variant="label">Testing machine information on issued reports</FieldLegend>
            <FieldDescription>
              The issuer sees this as the default and can change it on each report. While it isn’t
              set, reports omit it unless the issuer chooses Include.
            </FieldDescription>
            <RadioGroup
              value={machine}
              onValueChange={(next) => setMachine(next as Machine)}
              className="flex flex-wrap gap-6"
            >
              {(['include', 'omit', 'unset'] as const).map((value) => (
                <div key={value} className="flex items-center gap-2">
                  <RadioGroupItem id={`${id}-machine-${value}`} value={value} />
                  <Label htmlFor={`${id}-machine-${value}`} className="font-normal">
                    {MACHINE_LABEL[value]}
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </FieldSet>
          <Field>
            <FieldLabel htmlFor={`${id}-reason`}>Reason (optional)</FieldLabel>
            <Input
              id={`${id}-reason`}
              value={reason}
              maxLength={2000}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </FieldGroup>
        {error ? (
          <Alert variant="destructive">
            <CircleAlert aria-hidden="true" />
            <AlertTitle>{error}</AlertTitle>
          </Alert>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button type="submit" disabled={busy}>
            Save settings
          </Button>
          <p className="text-[13px] text-muted-foreground">
            People who can edit the project change these settings.
          </p>
        </div>
      </form>
    </section>
  );
}

function SettingsHistory({ settings }: { settings: ConcreteProjectSettings }) {
  const id = useId();
  return (
    <section aria-labelledby={id} className="flex flex-col gap-3">
      <div className="flex items-baseline gap-2">
        <h2 id={id} className="text-lg font-semibold">
          History
        </h2>
        <span className="text-sm text-muted-foreground">
          {settings.historyTotal} {settings.historyTotal === 1 ? 'change' : 'changes'}
        </span>
      </div>
      {settings.history.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No changes yet. The defaults apply until someone saves these settings.
        </p>
      ) : (
        <ItemGroup aria-label="History, newest first" className="gap-1">
          {settings.history.map((change) => (
            <Item key={change.id} size="sm" className="items-start px-0">
              <ItemMedia>
                <PersonAvatar
                  name={change.changedBy?.name ?? 'Material Mule'}
                  userId={change.changedBy?.userId}
                />
              </ItemMedia>
              <ItemContent>
                <ItemTitle className="flex-wrap">{changeTitle(change)}</ItemTitle>
                <ItemDescription>{dateTime(change.occurredAt)}</ItemDescription>
                {change.reason ? (
                  <p className="text-[13px] text-muted-foreground">Reason: {change.reason}</p>
                ) : null}
              </ItemContent>
            </Item>
          ))}
        </ItemGroup>
      )}
    </section>
  );
}

function ReviewSection({ project }: { project: ProjectDetail }) {
  const id = useId();
  const me = useMe();
  const canSeeTeam = me.permissions.includes('project_access.read');
  const { load } = useLoad(`reviewers|${project.id}|${canSeeTeam}`, async () =>
    canSeeTeam ? fetchReviewers(project.id) : null,
  );
  const lead = project.leadProjectEngineer;
  const reviewers =
    load.state === 'ready' && load.data?.ok
      ? load.data.data.active.filter((a) => a.scope.code.startsWith('concrete_'))
      : null;
  return (
    <section aria-labelledby={id} className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={id} className="text-lg font-semibold">
          Who reviews concrete work
        </h2>
        {canSeeTeam ? (
          <Button variant="link" asChild className="h-auto p-0">
            <Link to={`/projects/${encodeURIComponent(project.id)}/team`}>
              Team &amp; permissions
            </Link>
          </Button>
        ) : null}
      </div>
      <ItemGroup className="gap-1">
        <Item size="sm" className="px-0">
          <ItemMedia>
            <PersonAvatar name={lead?.displayName ?? 'Waiting for a lead'} userId={lead?.id} />
          </ItemMedia>
          <ItemContent>
            <ItemTitle>{lead ? lead.displayName : 'Waiting for a lead'}</ItemTitle>
            <ItemDescription>Lead Project Engineer · reviews field reports</ItemDescription>
          </ItemContent>
        </Item>
        {reviewers?.map((a) => (
          <Item key={a.id} size="sm" className="px-0">
            <ItemMedia>
              <PersonAvatar name={a.reviewer.name} userId={a.reviewer.userId} />
            </ItemMedia>
            <ItemContent>
              <ItemTitle>{a.reviewer.name}</ItemTitle>
              <ItemDescription>
                Designated reviewer · {a.scope.label}
                {a.effective ? '' : ' (not active yet)'}
              </ItemDescription>
            </ItemContent>
          </Item>
        ))}
      </ItemGroup>
      <p className="text-[13px] text-muted-foreground">
        {reviewers === null
          ? canSeeTeam
            ? load.state === 'loading'
              ? 'Loading the designated reviewers…'
              : 'Couldn’t load the designated reviewers.'
            : 'Designated reviewers are listed in Team & permissions on a personal account.'
          : reviewers.length === 0
            ? 'No designated reviewers: field reports go to the lead.'
            : null}{' '}
        Designations are made in Team &amp; permissions. Nobody reviews their own report.
      </p>
    </section>
  );
}
